import { randomUUID } from "node:crypto";
import type {
  AutomationConfirmationResponse,
  AutomationPreviewCommand,
} from "@suite/contracts";
import {
  isOccurrence,
  upcomingOccurrences,
  zonedCalendarDate,
} from "@suite/domain";
import type {
  RecurringSeriesFields,
  RecurringSeriesRecord,
  SuiteDatabase,
} from "@suite/persistence";
import {
  recurrenceMutationBody,
  recurrenceViolationError,
  storedSeriesFields,
} from "./recurrence.ts";

// Recurring series assistant operations (issue #42, ADR 0023).
// automation.ts keeps the shared preview/confirm protocol; this module supplies
// the domain checks. Each write freezes the series revision, and deleting an
// instance also freezes that task's revision.

export type RecurrenceCommand = Extract<
  AutomationPreviewCommand,
  {
    operation:
      | "recurrence.create"
      | "recurrence.update"
      | "recurrence.set_state"
      | "recurrence.occurrence";
  }
>;

interface Affected {
  readonly entityKind: "recurring_series" | "task";
  readonly entityId: string;
}
interface BaseRevision extends Affected {
  readonly revision: number;
}
export type RecurrencePreview =
  | {
      readonly ok: true;
      readonly summary: string;
      readonly affected: readonly Affected[];
      readonly baseRevisions: readonly BaseRevision[];
    }
  | {
      readonly ok: false;
      readonly status: number;
      readonly code: string;
      readonly message: string;
    };
type Result = AutomationConfirmationResponse["result"];

export const isRecurrenceCommand = (
  command: AutomationPreviewCommand,
): command is RecurrenceCommand => command.operation.startsWith("recurrence.");

const describeRule = (fields: RecurringSeriesFields): string => {
  const { rule } = fields;
  const unit = {
    daily: "day",
    weekly: "week",
    monthly: "month",
    yearly: "year",
  }[rule.cycle];
  const every =
    rule.interval === 1
      ? `every ${unit}`
      : `every ${String(rule.interval)} ${unit}s`;
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const detail =
    rule.cycle === "weekly"
      ? ` on ${rule.weekdays.map((day) => days[day]).join(", ")}`
      : rule.monthly?.kind === "last_day"
        ? " on the last day"
        : rule.monthly?.kind === "nth_weekday"
          ? ` on the ${rule.monthly.week === -1 ? "last" : `#${String(rule.monthly.week)}`} ${days[rule.monthly.weekday] ?? ""}`
          : "";
  return `${every}${detail} from ${fields.startDate}${fields.startTime === null ? "" : ` at ${fields.startTime}`}`;
};

const failure = (
  status: number,
  code: string,
  message: string,
): Extract<RecurrencePreview, { ok: false }> => ({
  ok: false,
  status,
  code,
  message,
});

type Planned =
  | {
      readonly ok: true;
      readonly summary: string;
      readonly series: RecurringSeriesRecord | null;
      readonly frozenTasks: readonly { id: string; revision: number }[];
    }
  | Extract<RecurrencePreview, { ok: false }>;

/** Validates the command against current state without writing. */
const plan = (
  database: SuiteDatabase,
  ownerId: string,
  command: RecurrenceCommand,
  now: Date,
): Planned => {
  const { timeZone } = database.getPlanningPreferences(ownerId);
  const today = zonedCalendarDate(now, timeZone);
  if (command.operation === "recurrence.create") {
    const { sourceTaskId, ...input } = command.input;
    const fields = storedSeriesFields(input) as RecurringSeriesFields;
    const violation = database.recurrence.check(ownerId, fields);
    if (violation !== null)
      return { ok: false, ...recurrenceViolationError(violation) };
    const frozenTasks: { id: string; revision: number }[] = [];
    if (sourceTaskId !== undefined) {
      const task = database.getTask(ownerId, sourceTaskId);
      if (
        task === undefined ||
        task.parentId != null ||
        task.recurrence != null
      )
        return {
          ok: false,
          ...recurrenceViolationError("source_task_invalid"),
        };
      frozenTasks.push({ id: task.id, revision: task.revision });
    }
    const next = upcomingOccurrences(
      fields.rule,
      {
        startDate: fields.startDate,
        endDate: fields.endDate,
        anchorDate: fields.startDate,
      },
      fields.startDate > today ? fields.startDate : today,
      3,
    );
    return {
      ok: true,
      series: null,
      frozenTasks,
      summary: `Create recurring series "${fields.title}" repeating ${describeRule(fields)}; next dates ${next.join(", ") || "none"}`,
    };
  }
  const series = database.recurrence.get(ownerId, command.input.seriesId);
  if (series === undefined)
    return failure(404, "RECURRENCE_NOT_FOUND", "Series not found");
  if (series.revision !== command.input.expectedRevision)
    return failure(412, "REVISION_CONFLICT", "Series changed before preview");
  if (command.operation === "recurrence.update") {
    const next = {
      ...series,
      ...storedSeriesFields(command.input.patch),
    };
    const violation =
      series.state === "ended"
        ? "series_ended"
        : database.recurrence.check(ownerId, next, series);
    if (violation !== null)
      return { ok: false, ...recurrenceViolationError(violation) };
    return {
      ok: true,
      series,
      frozenTasks: [],
      summary: `Change recurring series "${series.title}": ${Object.keys(command.input.patch).join(", ")}; open instances that still match the old values are updated`,
    };
  }
  if (command.operation === "recurrence.set_state") {
    const target = {
      pause: "paused",
      resume: "active",
      end: "ended",
    }[command.input.action];
    if (series.state === "ended")
      return { ok: false, ...recurrenceViolationError("series_ended") };
    if (series.state === target)
      return { ok: false, ...recurrenceViolationError("state_unchanged") };
    return {
      ok: true,
      series,
      frozenTasks: [],
      summary: {
        pause: `Pause recurring series "${series.title}"; no instances are created until it resumes`,
        resume: `Resume recurring series "${series.title}"; no instance is created for dates before today`,
        end: `End recurring series "${series.title}" permanently; existing instances stay`,
      }[command.input.action],
    };
  }
  const { date, action } = command.input;
  if (action === "delete_instance") {
    const task = database
      .listTasks(ownerId)
      .find(
        (candidate) =>
          candidate.recurrence?.seriesId === series.id &&
          candidate.recurrence.occurrenceDate === date,
      );
    if (task === undefined)
      return { ok: false, ...recurrenceViolationError("instance_missing") };
    return {
      ok: true,
      series,
      frozenTasks: [{ id: task.id, revision: task.revision }],
      summary: `Delete the ${date} instance "${task.title}" of recurring series "${series.title}"; the date is never recreated`,
    };
  }
  if (series.state === "ended")
    return { ok: false, ...recurrenceViolationError("series_ended") };
  if (
    !isOccurrence(series.rule, series, date) ||
    (series.cursorDate !== null && date <= series.cursorDate)
  )
    return {
      ok: false,
      ...recurrenceViolationError(
        isOccurrence(series.rule, series, date)
          ? "occurrence_processed"
          : "occurrence_invalid",
      ),
    };
  return {
    ok: true,
    series,
    frozenTasks: [],
    summary:
      action === "skip"
        ? `Skip the ${date} occurrence of recurring series "${series.title}"`
        : `Restore the skipped ${date} occurrence of recurring series "${series.title}"`,
  };
};

export const previewRecurrence = (
  database: SuiteDatabase,
  ownerId: string,
  command: RecurrenceCommand,
): RecurrencePreview => {
  const planned = plan(database, ownerId, command, new Date());
  if (!planned.ok) return planned;
  const series =
    planned.series === null
      ? []
      : [
          {
            entityKind: "recurring_series" as const,
            entityId: planned.series.id,
            revision: planned.series.revision,
          },
        ];
  const tasks = planned.frozenTasks.map(({ id, revision }) => ({
    entityKind: "task" as const,
    entityId: id,
    revision,
  }));
  const frozen = [...series, ...tasks];
  return {
    ok: true,
    summary: planned.summary,
    affected: frozen.map(({ entityKind, entityId }) => ({
      entityKind,
      entityId,
    })),
    baseRevisions: frozen,
  };
};

/**
 * Confirmation re-plans inside the confirmation transaction; the shared
 * protocol has already compared every frozen revision.
 */
export const confirmRecurrence = (
  database: SuiteDatabase,
  ownerId: string,
  command: RecurrenceCommand,
  previewId: string,
):
  | { readonly ok: true; readonly apply: () => Result }
  | {
      readonly ok: false;
      readonly status: number;
      readonly message: string;
    } => {
  const clock = new Date();
  const planned = plan(database, ownerId, command, clock);
  if (!planned.ok)
    return { ok: false, status: planned.status, message: planned.message };
  return {
    ok: true,
    apply: () => {
      const now = clock.toISOString();
      const { timeZone } = database.getPlanningPreferences(ownerId);
      const today = zonedCalendarDate(clock, timeZone);
      const result =
        command.operation === "recurrence.create"
          ? (() => {
              const { sourceTaskId, ...input } = command.input;
              return database.recurrence.create({
                ownerId,
                id: randomUUID(),
                idempotencyKey: `automation:${previewId}`,
                requestHash: previewId,
                fields: storedSeriesFields(input) as RecurringSeriesFields,
                sourceTaskId,
                timeZone,
                now,
              });
            })()
          : command.operation === "recurrence.update"
            ? database.recurrence.update({
                ownerId,
                seriesId: command.input.seriesId,
                expectedRevision: command.input.expectedRevision,
                patch: storedSeriesFields(command.input.patch),
                timeZone,
                now,
              })
            : command.operation === "recurrence.set_state"
              ? database.recurrence.setState({
                  ownerId,
                  seriesId: command.input.seriesId,
                  expectedRevision: command.input.expectedRevision,
                  action: command.input.action,
                  timeZone,
                  now,
                })
              : database.recurrence.occurrence({
                  ownerId,
                  seriesId: command.input.seriesId,
                  expectedRevision: command.input.expectedRevision,
                  date: command.input.date,
                  action: command.input.action,
                  now,
                });
      if (
        result.kind !== "created" &&
        result.kind !== "updated" &&
        result.kind !== "replayed"
      )
        throw new Error("Recurring series changed during atomic confirmation");
      return recurrenceMutationBody(database, result, today);
    },
  };
};
