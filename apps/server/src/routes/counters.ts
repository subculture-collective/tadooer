import {
  counterCreateRequestSchema,
  counterDayWriteRequestSchema,
  counterHistoryQuerySchema,
  counterPatchRequestSchema,
  counterStopwatchRequestSchema,
  evaluationListQuerySchema,
  evaluationWriteRequestSchema,
  type Counter,
  type CounterDayValue,
  type CounterHistory,
  type CounterMutationResponse,
  type DailyEvaluation,
  type EvaluationList,
} from "@suite/contracts";
import { zonedCalendarDate } from "@suite/domain";
import type {
  CounterDayValueRecord,
  CounterRecord,
  CounterViolation,
  CounterWriteResult,
  DailyEvaluationRecord,
  EvaluationWriteResult,
  SuiteDatabase,
} from "@suite/persistence";
import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import {
  expectedRevision,
  readJson,
  sameOrigin,
  sendError,
  sendJson,
} from "../http-utils.ts";
import type { RouteHandler } from "./shared.ts";

/** HTTP status and stable code for each counter rule (ADR 0025). */
export const counterViolationError = (
  code: CounterViolation,
): {
  readonly status: number;
  readonly code: string;
  readonly message: string;
} =>
  ({
    day_invalid: {
      status: 400,
      code: "INVALID_COUNTER_DAY",
      message: "Use a calendar date",
    },
    value_invalid: {
      status: 400,
      code: "INVALID_COUNTER_VALUE",
      message: "A counter value is a nonnegative whole number",
    },
    value_exceeds_day: {
      status: 409,
      code: "COUNTER_VALUE_EXCEEDS_DAY",
      message:
        "The value is larger than one day allows: a stopwatch day cannot exceed the day's length, and a count cannot exceed 1,000,000",
    },
    counter_disabled: {
      status: 409,
      code: "COUNTER_DISABLED",
      message: "Enable the counter before recording values",
    },
    not_stopwatch: {
      status: 409,
      code: "COUNTER_NOT_STOPWATCH",
      message: "Only a stopwatch counter can be started or stopped",
    },
    stopwatch_running: {
      status: 409,
      code: "COUNTER_RUNNING",
      message: "The stopwatch is running; stop it first",
    },
    stopwatch_stopped: {
      status: 409,
      code: "COUNTER_NOT_RUNNING",
      message: "The stopwatch is not running",
    },
    countdown_invalid: {
      status: 400,
      code: "INVALID_COUNTER",
      message: "Only a repeated countdown has a countdown length",
    },
  })[code];

export const counterResponse = (
  counter: CounterRecord,
  currentStreak: number | null,
): Counter => ({
  id: counter.id,
  title: counter.title,
  kind: counter.kind,
  icon: counter.icon,
  enabled: counter.enabled,
  hidden: counter.hidden,
  position: counter.position,
  streak: { ...counter.streak, weekdays: [...counter.streak.weekdays] },
  countdownMs: counter.countdownMs,
  runningSince: counter.runningSince,
  currentStreak,
  revision: counter.revision,
  createdAt: counter.createdAt,
  updatedAt: counter.updatedAt,
  deletedAt: counter.deletedAt,
  provenance: counter.provenance === null ? null : { ...counter.provenance },
});

export const counterDayValueResponse = (
  value: CounterDayValueRecord,
): CounterDayValue => ({ ...value });

export const evaluationResponse = (
  evaluation: DailyEvaluationRecord,
): DailyEvaluation => ({
  id: evaluation.id,
  day: evaluation.day,
  notes: evaluation.notes,
  reflection: evaluation.reflection,
  impact: evaluation.impact,
  energy: evaluation.energy,
  remindTomorrow: evaluation.remindTomorrow,
  importedFocusSessionsMs: [...evaluation.importedFocusSessionsMs],
  revision: evaluation.revision,
  createdAt: evaluation.createdAt,
  updatedAt: evaluation.updatedAt,
  provenance: evaluation.imported
    ? { source: "super_productivity", sourceDay: evaluation.day }
    : null,
});

const ownerZone = (database: SuiteDatabase, ownerId: string) =>
  database.getPlanningPreferences(ownerId).timeZone;

/** Counters with streaks and day values for a validated range. */
export const counterHistoryBody = (
  database: SuiteDatabase,
  ownerId: string,
  range: { readonly from: string; readonly to: string },
  now: string,
): CounterHistory => {
  const timeZone = ownerZone(database, ownerId);
  const history = database.counters.history({
    ownerId,
    ...range,
    timeZone,
    now,
  });
  return {
    ...range,
    today: history.today,
    timeZone,
    generatedAt: now,
    counters: history.counters.map((counter) =>
      counterResponse(counter, counter.currentStreak),
    ),
    values: history.values.map(counterDayValueResponse),
  };
};

/**
 * Evaluations in the range, with Tadooer focus time per day derived from
 * active-session intervals. Imported focus session durations stay on the
 * evaluation and are not added here, so nothing is counted twice.
 */
export const evaluationListBody = (
  database: SuiteDatabase,
  ownerId: string,
  range: { readonly from: string; readonly to: string },
  now: string,
): EvaluationList => {
  const timeZone = ownerZone(database, ownerId);
  const report = database.timeEntries.report({
    ownerId,
    ...range,
    timeZone,
    now,
  });
  const focus = new Map<string, { ms: number; intervals: Set<string> }>();
  for (const entry of report.entries) {
    if ("source" in entry) continue;
    const day = focus.get(entry.workDate) ?? { ms: 0, intervals: new Set() };
    day.ms += entry.durationMs;
    day.intervals.add(entry.id);
    focus.set(entry.workDate, day);
  }
  return {
    ...range,
    timeZone,
    evaluations: database.counters
      .listEvaluations(ownerId, range.from, range.to)
      .map(evaluationResponse),
    focus: [...focus.entries()]
      .toSorted(([left], [right]) => (left < right ? -1 : 1))
      .map(([day, value]) => ({
        day,
        ms: value.ms,
        intervals: value.intervals.size,
      })),
  };
};

export const counterMutationBody = (
  database: SuiteDatabase,
  result: Extract<CounterWriteResult, { kind: "applied" | "replayed" }>,
  now: string,
): CounterMutationResponse => {
  const today = zonedCalendarDate(
    now,
    ownerZone(database, result.counter.ownerId),
  );
  return {
    counter: counterResponse(
      result.counter,
      database.counters.currentStreak(result.counter, today),
    ),
    values: result.values.map(counterDayValueResponse),
    clampedMs: result.clampedMs,
  };
};

export const counterFailure = (
  result: Exclude<CounterWriteResult, { kind: "applied" | "replayed" }>,
): {
  readonly status: number;
  readonly code: string;
  readonly message: string;
} =>
  result.kind === "not-found"
    ? { status: 404, code: "COUNTER_NOT_FOUND", message: "Counter not found" }
    : result.kind === "precondition-failed"
      ? {
          status: 412,
          code: "COUNTER_REVISION_CONFLICT",
          message: "The counter or day changed; reload it before trying again",
        }
      : result.kind === "exists"
        ? {
            status: 409,
            code: "COUNTER_EXISTS",
            message: "A different counter already uses this ID",
          }
        : counterViolationError(result.code);

export const isWritten = (
  result: CounterWriteResult,
): result is Extract<CounterWriteResult, { kind: "applied" | "replayed" }> =>
  result.kind === "applied" || result.kind === "replayed";

const sendCounter = (
  response: ServerResponse,
  database: SuiteDatabase,
  result: CounterWriteResult,
  now: string,
  created = false,
) => {
  if (isWritten(result))
    sendJson(
      response,
      created && result.kind === "applied" ? 201 : 200,
      counterMutationBody(database, result, now),
      { ETag: `"${String(result.counter.revision)}"` },
    );
  else {
    const error = counterFailure(result);
    sendError(response, error.status, error.code, error.message);
  }
};

const sendEvaluation = (
  response: ServerResponse,
  result: EvaluationWriteResult,
) => {
  if (result.kind === "precondition-failed")
    sendError(
      response,
      412,
      "EVALUATION_REVISION_CONFLICT",
      "The evaluation changed; reload it before trying again",
    );
  else
    sendJson(
      response,
      200,
      { evaluation: evaluationResponse(result.evaluation) },
      { ETag: `"${String(result.evaluation.revision)}"` },
    );
};

/**
 * Counters and daily evaluations (ADR 0025). Online-only: they are not in the
 * sync change feed or the offline cache, and every write carries a revision.
 */
export const handleCounters: RouteHandler = async (
  request,
  response,
  url,
  { auth, stores, sessionClock },
) => {
  const method = request.method ?? "GET";
  const path = url.pathname;
  const counter = /^\/api\/counters\/([0-9a-f-]{36})$/.exec(path);
  const day =
    /^\/api\/counters\/([0-9a-f-]{36})\/days\/(\d{4}-\d{2}-\d{2})$/.exec(path);
  const stopwatch = /^\/api\/counters\/([0-9a-f-]{36})\/stopwatch$/.exec(path);
  const evaluation = /^\/api\/evaluations\/(\d{4}-\d{2}-\d{2})$/.exec(path);
  const read =
    method === "GET" &&
    (path === "/api/counters" || path === "/api/evaluations");
  const write =
    (method === "POST" && path === "/api/counters") ||
    ((method === "PATCH" || method === "DELETE") && counter !== null) ||
    (method === "POST" && (day !== null || stopwatch !== null)) ||
    (method === "PUT" && evaluation !== null);
  if (!read && !write) return false;
  const session = auth.authenticate(request, !read);
  if (session === undefined) {
    sendError(response, 401, "AUTH_REQUIRED", "Authentication required");
    return true;
  }
  const ownerId = session.owner.id;
  const now = sessionClock.now().toISOString();
  if (read) {
    const schema =
      path === "/api/counters"
        ? counterHistoryQuerySchema
        : evaluationListQuerySchema;
    const parsed = schema.safeParse(
      Object.fromEntries(url.searchParams.entries()),
    );
    if (!parsed.success)
      sendError(
        response,
        400,
        "INVALID_RANGE",
        "Provide from and to calendar dates at most 366 days apart",
      );
    else
      sendJson(
        response,
        200,
        path === "/api/counters"
          ? counterHistoryBody(stores, ownerId, parsed.data, now)
          : evaluationListBody(stores, ownerId, parsed.data, now),
      );
    return true;
  }
  if (
    !sameOrigin(request) ||
    !auth.csrfMatches(
      session,
      request.headers["x-csrf-token"] as string | undefined,
    )
  ) {
    sendError(
      response,
      403,
      "CSRF_REQUIRED",
      "Same-origin session and CSRF token required",
    );
    return true;
  }
  const timeZone = ownerZone(stores, ownerId);
  if (evaluation !== null) {
    const parsed = evaluationWriteRequestSchema.safeParse(
      await readJson(request),
    );
    if (!parsed.success) {
      sendError(
        response,
        400,
        "INVALID_EVALUATION",
        "Provide the evaluation revision you read (0 for a new day) and at least one field: notes and reflection up to 5,000 characters, impact 1 to 4, energy 1 to 3",
      );
      return true;
    }
    const { expectedRevision: revision, ...patch } = parsed.data;
    sendEvaluation(
      response,
      stores.counters.writeEvaluation({
        ownerId,
        day: evaluation[1] ?? "",
        expectedRevision: revision,
        patch,
        newId: randomUUID,
        now,
      }),
    );
    return true;
  }
  if (method === "POST" && path === "/api/counters") {
    const parsed = counterCreateRequestSchema.safeParse(
      await readJson(request),
    );
    if (!parsed.success) {
      sendError(
        response,
        400,
        "INVALID_COUNTER",
        "Provide a counter ID, a title up to 200 characters, a kind and valid streak settings",
      );
      return true;
    }
    const { id, ...definition } = parsed.data;
    sendCounter(
      response,
      stores,
      stores.counters.create({ ownerId, id, counter: definition, now }),
      now,
      true,
    );
    return true;
  }
  if (day !== null) {
    const parsed = counterDayWriteRequestSchema.safeParse(
      await readJson(request),
    );
    if (!parsed.success) {
      sendError(
        response,
        400,
        "INVALID_COUNTER_VALUE",
        "Set a nonnegative value or increment by a nonzero whole number, with the day revision you read (0 for an empty day)",
      );
      return true;
    }
    sendCounter(
      response,
      stores,
      stores.counters.recordDay({
        ownerId,
        counterId: day[1] ?? "",
        day: day[2] ?? "",
        action: parsed.data.action,
        amount:
          parsed.data.action === "set" ? parsed.data.value : parsed.data.delta,
        expectedRevision: parsed.data.expectedRevision,
        timeZone,
        now,
      }),
      now,
    );
    return true;
  }
  const id = counter?.[1] ?? stopwatch?.[1] ?? "";
  const revision = expectedRevision(request, response);
  if (revision === undefined) return true;
  if (stopwatch !== null) {
    const parsed = counterStopwatchRequestSchema.safeParse(
      await readJson(request),
    );
    if (!parsed.success) {
      sendError(response, 400, "INVALID_COUNTER", "Choose start or stop");
      return true;
    }
    sendCounter(
      response,
      stores,
      parsed.data.action === "start"
        ? stores.counters.startStopwatch({
            ownerId,
            id,
            expectedRevision: revision,
            now,
          })
        : stores.counters.stopStopwatch({
            ownerId,
            id,
            expectedRevision: revision,
            timeZone,
            now,
          }),
      now,
    );
    return true;
  }
  if (method === "DELETE") {
    sendCounter(
      response,
      stores,
      stores.counters.delete({ ownerId, id, expectedRevision: revision, now }),
      now,
    );
    return true;
  }
  const parsed = counterPatchRequestSchema.safeParse(await readJson(request));
  if (!parsed.success) {
    sendError(
      response,
      400,
      "INVALID_COUNTER",
      "Change the title, icon, enabled or hidden state, streak settings or countdown length",
    );
    return true;
  }
  sendCounter(
    response,
    stores,
    stores.counters.update({
      ownerId,
      id,
      expectedRevision: revision,
      patch: parsed.data,
      now,
    }),
    now,
  );
  return true;
};
