import type {
  AutomationConfirmationResponse,
  AutomationPreviewCommand,
} from "@suite/contracts";
import { formatClockDuration, validateTimeEntryWrite } from "@suite/domain";
import type { SuiteDatabase } from "@suite/persistence";
import {
  timeEntryMutationBody,
  timeEntryViolationError,
} from "./time-history.ts";

// Assistant add, edit and delete of work history (issue #41, ADR 0024).
// automation.ts keeps the shared preview/confirm protocol; this module
// supplies the domain checks. The preview freezes the entry revision, or for
// an add the task revision and the new entry ID.

export type TimeEntryCommand = Extract<
  AutomationPreviewCommand,
  { operation: "time_entries.mutate" }
>;

interface Affected {
  readonly entityKind: "task" | "time_entry";
  readonly entityId: string;
}
interface BaseRevision extends Affected {
  readonly revision: number;
}
export type TimeEntryPreview =
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

export const isTimeEntryCommand = (
  command: AutomationPreviewCommand,
): command is TimeEntryCommand => command.operation === "time_entries.mutate";

const quoted = (value: string): string =>
  `"${value.length > 60 ? `${value.slice(0, 57)}...` : value}"`;

const failure = (
  status: number,
  code: string,
  message: string,
): TimeEntryPreview => ({ ok: false, status, code, message });

export const previewTimeEntry = (
  database: SuiteDatabase,
  ownerId: string,
  command: TimeEntryCommand,
  now: string,
): TimeEntryPreview => {
  const input = command.input;
  const timeZone = database.getPlanningPreferences(ownerId).timeZone;
  if (input.action === "add") {
    const task = database.getTask(ownerId, input.taskId, true);
    if (database.timeEntries.get(ownerId, input.id) !== undefined)
      return failure(412, "REVISION_CONFLICT", "Time entry already exists");
    const day = database.timeEntries.dayTotal(
      ownerId,
      input.taskId,
      input.workDate,
      timeZone,
      now,
    );
    const after = day.totalMs + input.durationMs;
    const violation = validateTimeEntryWrite({
      task,
      source: "manual",
      durationMs: input.durationMs,
      days: [{ before: day.totalMs, after, focusRunning: day.focusRunning }],
    });
    if (violation !== null || task === undefined)
      return {
        ok: false,
        ...timeEntryViolationError(violation ?? "task_unavailable"),
      };
    return {
      ok: true,
      summary: `${input.durationMs < 0 ? "Subtract" : "Add"} ${formatClockDuration(Math.abs(input.durationMs))} ${input.durationMs < 0 ? "from" : "to"} task ${quoted(task.title)} on ${input.workDate}; the day's total becomes ${formatClockDuration(after)}`,
      affected: [
        { entityKind: "task", entityId: task.id },
        { entityKind: "time_entry", entityId: input.id },
      ],
      baseRevisions: [
        { entityKind: "task", entityId: task.id, revision: task.revision },
      ],
    };
  }
  const entry = database.timeEntries.get(ownerId, input.id);
  if (entry === undefined)
    return database.timeEntries.isFocusInterval(ownerId, input.id)
      ? { ok: false, ...timeEntryViolationError("entry_read_only") }
      : failure(404, "TIME_ENTRY_NOT_FOUND", "Time entry not found");
  if (entry.revision !== input.expectedRevision)
    return failure(
      412,
      "REVISION_CONFLICT",
      "Time entry changed before preview",
    );
  const task = database.getTask(ownerId, entry.taskId, true);
  const title = task === undefined ? "an unavailable task" : quoted(task.title);
  const label = `${entry.source} entry of ${formatClockDuration(entry.durationMs)} on ${entry.workDate} for task ${title}`;
  const changes =
    input.action === "update"
      ? [
          input.patch.workDate === undefined
            ? null
            : `date ${entry.workDate} to ${input.patch.workDate}`,
          input.patch.durationMs === undefined
            ? null
            : `duration ${formatClockDuration(entry.durationMs)} to ${formatClockDuration(input.patch.durationMs)}`,
          input.patch.note === undefined ? null : "note",
        ].filter((change): change is string => change !== null)
      : [];
  return {
    ok: true,
    summary:
      input.action === "delete"
        ? `Permanently delete the ${label}`
        : `Edit the ${label}: ${changes.join(", ")}`,
    affected: [{ entityKind: "time_entry", entityId: entry.id }],
    baseRevisions: [
      {
        entityKind: "time_entry",
        entityId: entry.id,
        revision: entry.revision,
      },
    ],
  };
};

/**
 * Returns the mutation run inside the confirmation transaction. The frozen
 * base revisions are checked by automation.ts first; the store re-checks the
 * day totals and the running focus rule at confirmation time.
 */
export const confirmTimeEntry = (
  database: SuiteDatabase,
  ownerId: string,
  command: TimeEntryCommand,
  now: () => string,
):
  | { readonly ok: true; readonly apply: () => Result }
  | {
      readonly ok: false;
      readonly status: number;
      readonly message: string;
    } => {
  const input = command.input;
  // Day totals and running focus may have changed since the preview.
  const current = previewTimeEntry(database, ownerId, command, now());
  if (!current.ok)
    return { ok: false, status: current.status, message: current.message };
  return {
    ok: true,
    apply: () => {
      const timeZone = database.getPlanningPreferences(ownerId).timeZone;
      const at = now();
      const result =
        input.action === "add"
          ? database.timeEntries.create({
              ownerId,
              id: input.id,
              taskId: input.taskId,
              workDate: input.workDate,
              durationMs: input.durationMs,
              note: input.note,
              timeZone,
              now: at,
            })
          : input.action === "update"
            ? database.timeEntries.update({
                ownerId,
                id: input.id,
                expectedRevision: input.expectedRevision,
                patch: input.patch,
                timeZone,
                now: at,
              })
            : database.timeEntries.delete({
                ownerId,
                id: input.id,
                expectedRevision: input.expectedRevision,
                timeZone,
                now: at,
              });
      if (result.kind !== "applied")
        throw new Error("Time entry changed during atomic confirmation");
      return timeEntryMutationBody(result);
    },
  };
};
