import type {
  AutomationConfirmationResponse,
  AutomationPreviewCommand,
} from "@suite/contracts";
import {
  formatClockDuration,
  incrementedCounterValue,
  validateCounterDayValue,
} from "@suite/domain";
import type {
  CounterRecord,
  CounterWriteResult,
  SuiteDatabase,
} from "@suite/persistence";
import { randomUUID } from "node:crypto";
import {
  counterMutationBody,
  counterViolationError,
  evaluationResponse,
} from "./counters.ts";

// Assistant counter and daily evaluation writes (issue #64, ADR 0025).
// automation.ts keeps the shared preview/confirm protocol; this module
// supplies the domain checks. Definition writes and stopwatch control freeze
// the counter revision; day writes and evaluations carry the revision the
// assistant read, which the store checks again at confirmation.

export type CounterCommand = Extract<
  AutomationPreviewCommand,
  { operation: "counters.mutate" | "counters.record" | "evaluations.write" }
>;

interface Affected {
  readonly entityKind: "counter" | "daily_evaluation";
  readonly entityId: string;
}
interface BaseRevision extends Affected {
  readonly revision: number;
}
export type CounterPreview =
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

export const isCounterCommand = (
  command: AutomationPreviewCommand,
): command is CounterCommand =>
  command.operation === "counters.mutate" ||
  command.operation === "counters.record" ||
  command.operation === "evaluations.write";

const quoted = (value: string): string =>
  `"${value.length > 60 ? `${value.slice(0, 57)}...` : value}"`;

const failure = (
  status: number,
  code: string,
  message: string,
): CounterPreview => ({ ok: false, status, code, message });

const amount = (counter: CounterRecord, value: number): string =>
  counter.kind === "stopwatch"
    ? formatClockDuration(value)
    : value.toLocaleString("en-US");

const live = (database: SuiteDatabase, ownerId: string, id: string) => {
  const counter = database.counters.get(ownerId, id);
  return counter?.deletedAt === null ? counter : undefined;
};

const notFound = () => failure(404, "COUNTER_NOT_FOUND", "Counter not found");
const stale = (what: string) =>
  failure(412, "REVISION_CONFLICT", `${what} changed before preview`);

const frozen = (counter: CounterRecord) => ({
  affected: [{ entityKind: "counter" as const, entityId: counter.id }],
  baseRevisions: [
    {
      entityKind: "counter" as const,
      entityId: counter.id,
      revision: counter.revision,
    },
  ],
});

export const previewCounter = (
  database: SuiteDatabase,
  ownerId: string,
  command: CounterCommand,
): CounterPreview => {
  const timeZone = database.getPlanningPreferences(ownerId).timeZone;
  if (command.operation === "evaluations.write") {
    const input = command.input;
    const current = database.counters.getEvaluation(ownerId, input.day);
    if ((current?.revision ?? 0) !== input.expectedRevision)
      return stale("The evaluation");
    const changes = [
      input.notes === undefined ? null : "notes",
      input.reflection === undefined ? null : "reflection",
      input.impact === undefined
        ? null
        : `impact ${input.impact === null ? "cleared" : `${String(input.impact)} of 4`}`,
      input.energy === undefined
        ? null
        : `energy ${input.energy === null ? "cleared" : `${String(input.energy)} of 3`}`,
      input.remindTomorrow === undefined
        ? null
        : `remind tomorrow ${input.remindTomorrow ? "on" : "off"}`,
    ].filter((change): change is string => change !== null);
    return {
      ok: true,
      summary: `${current === undefined ? "Create" : "Edit"} the daily evaluation for ${input.day}: ${changes.join(", ")}`,
      affected:
        current === undefined
          ? []
          : [{ entityKind: "daily_evaluation", entityId: current.id }],
      baseRevisions:
        current === undefined
          ? []
          : [
              {
                entityKind: "daily_evaluation",
                entityId: current.id,
                revision: current.revision,
              },
            ],
    };
  }
  if (command.operation === "counters.mutate") {
    const input = command.input;
    if (input.action === "create") {
      if (database.counters.get(ownerId, input.id) !== undefined)
        return failure(412, "REVISION_CONFLICT", "Counter already exists");
      if (input.countdownMs !== null && input.kind !== "repeated_countdown")
        return { ok: false, ...counterViolationError("countdown_invalid") };
      return {
        ok: true,
        summary: `Create the ${input.kind.replace("_", " ")} counter ${quoted(input.title)}`,
        affected: [{ entityKind: "counter", entityId: input.id }],
        baseRevisions: [],
      };
    }
    const counter = live(database, ownerId, input.id);
    if (counter === undefined) return notFound();
    if (counter.revision !== input.expectedRevision) return stale("Counter");
    if (input.action === "delete")
      return {
        ok: true,
        summary: `Permanently delete the counter ${quoted(counter.title)} and all of its recorded days`,
        ...frozen(counter),
      };
    const patch = input.patch;
    if (
      patch.countdownMs !== undefined &&
      patch.countdownMs !== null &&
      counter.kind !== "repeated_countdown"
    )
      return { ok: false, ...counterViolationError("countdown_invalid") };
    if (patch.enabled === false && counter.runningSince !== null)
      return { ok: false, ...counterViolationError("stopwatch_running") };
    const changes = [
      patch.title === undefined ? null : `title to ${quoted(patch.title)}`,
      patch.icon === undefined ? null : "icon",
      patch.enabled === undefined
        ? null
        : patch.enabled
          ? "enable it"
          : "disable it",
      patch.hidden === undefined ? null : patch.hidden ? "hide it" : "show it",
      patch.streak === undefined ? null : "streak settings",
      patch.countdownMs === undefined ? null : "countdown length",
    ].filter((change): change is string => change !== null);
    return {
      ok: true,
      summary: `Edit the counter ${quoted(counter.title)}: ${changes.join(", ")}`,
      ...frozen(counter),
    };
  }
  const input = command.input;
  const counter = live(database, ownerId, input.counterId);
  if (counter === undefined) return notFound();
  if (input.action !== "set" && input.action !== "increment") {
    if (counter.revision !== input.expectedRevision) return stale("Counter");
    if (counter.kind !== "stopwatch")
      return { ok: false, ...counterViolationError("not_stopwatch") };
    if (input.action === "start") {
      if (!counter.enabled)
        return { ok: false, ...counterViolationError("counter_disabled") };
      if (counter.runningSince !== null)
        return { ok: false, ...counterViolationError("stopwatch_running") };
      return {
        ok: true,
        summary: `Start the stopwatch ${quoted(counter.title)} now`,
        ...frozen(counter),
      };
    }
    if (counter.runningSince === null)
      return { ok: false, ...counterViolationError("stopwatch_stopped") };
    return {
      ok: true,
      summary: `Stop the stopwatch ${quoted(counter.title)}, running since ${counter.runningSince}; the elapsed time is added to each day it covered`,
      ...frozen(counter),
    };
  }
  if (!counter.enabled)
    return { ok: false, ...counterViolationError("counter_disabled") };
  const current = database.counters.dayValue(ownerId, counter.id, input.day);
  if ((current?.revision ?? 0) !== input.expectedRevision)
    return stale("The counter day");
  const before = current?.value ?? 0;
  const after =
    input.action === "set"
      ? input.value
      : incrementedCounterValue(before, input.delta);
  const violation = validateCounterDayValue({
    kind: counter.kind,
    day: input.day,
    value: after,
    timeZone,
  });
  if (violation !== null)
    return { ok: false, ...counterViolationError(violation) };
  return {
    ok: true,
    summary: `${input.action === "set" ? "Set" : input.delta < 0 ? "Decrease" : "Increase"} the counter ${quoted(counter.title)} on ${input.day} from ${amount(counter, before)} to ${amount(counter, after)}`,
    affected: [{ entityKind: "counter", entityId: counter.id }],
    baseRevisions: [],
  };
};

const runCounterWrite = (
  database: SuiteDatabase,
  ownerId: string,
  command: Exclude<CounterCommand, { operation: "evaluations.write" }>,
  timeZone: string,
  now: string,
): CounterWriteResult => {
  if (command.operation === "counters.mutate") {
    const input = command.input;
    if (input.action === "create") {
      return database.counters.create({
        ownerId,
        id: input.id,
        counter: {
          title: input.title,
          kind: input.kind,
          icon: input.icon,
          enabled: input.enabled,
          hidden: input.hidden,
          streak: input.streak,
          countdownMs: input.countdownMs,
        },
        now,
      });
    }
    return input.action === "update"
      ? database.counters.update({
          ownerId,
          id: input.id,
          expectedRevision: input.expectedRevision,
          patch: input.patch,
          now,
        })
      : database.counters.delete({
          ownerId,
          id: input.id,
          expectedRevision: input.expectedRevision,
          now,
        });
  }
  const input = command.input;
  if (input.action === "set" || input.action === "increment")
    return database.counters.recordDay({
      ownerId,
      counterId: input.counterId,
      day: input.day,
      action: input.action,
      amount: input.action === "set" ? input.value : input.delta,
      expectedRevision: input.expectedRevision,
      timeZone,
      now,
    });
  const target = {
    ownerId,
    id: input.counterId,
    expectedRevision: input.expectedRevision,
    now,
  };
  return input.action === "start"
    ? database.counters.startStopwatch(target)
    : database.counters.stopStopwatch({ ...target, timeZone });
};

/**
 * Returns the mutation run inside the confirmation transaction. The frozen
 * base revisions are checked by automation.ts first; day and evaluation
 * revisions and the value bounds are checked again here.
 */
export const confirmCounter = (
  database: SuiteDatabase,
  ownerId: string,
  command: CounterCommand,
  now: () => string,
):
  | { readonly ok: true; readonly apply: () => Result }
  | {
      readonly ok: false;
      readonly status: number;
      readonly message: string;
    } => {
  const current = previewCounter(database, ownerId, command);
  if (!current.ok)
    return { ok: false, status: current.status, message: current.message };
  return {
    ok: true,
    apply: () => {
      const at = now();
      const timeZone = database.getPlanningPreferences(ownerId).timeZone;
      if (command.operation === "evaluations.write") {
        const { day, expectedRevision, ...patch } = command.input;
        const result = database.counters.writeEvaluation({
          ownerId,
          day,
          expectedRevision,
          patch,
          newId: randomUUID,
          now: at,
        });
        if (result.kind !== "applied")
          throw new Error("Evaluation changed during atomic confirmation");
        return { evaluation: evaluationResponse(result.evaluation) };
      }
      const result = runCounterWrite(database, ownerId, command, timeZone, at);
      if (result.kind !== "applied")
        throw new Error(
          `Counter changed during atomic confirmation: ${result.kind}`,
        );
      return counterMutationBody(database, result, at);
    },
  };
};
