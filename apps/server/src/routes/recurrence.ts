import { createHash, randomUUID } from "node:crypto";
import {
  idempotencyKeySchema,
  recurrenceDateSchema,
  recurrenceOccurrenceRequestSchema,
  recurringSeriesCreateRequestSchema,
  recurringSeriesPatchRequestSchema,
  recurringSeriesStateRequestSchema,
  type RecurrenceRuleInput,
  type RecurringSeries,
  type RecurringSeriesMutationResponse,
} from "@suite/contracts";
import { zonedCalendarDate, type RecurrenceRule } from "@suite/domain";
import type {
  RecurrenceMutationResult,
  RecurrenceViolation,
  RecurringSeriesFields,
  RecurringSeriesRecord,
  SuiteDatabase,
} from "@suite/persistence";
import {
  expectedRevision,
  readJson,
  sameOrigin,
  sendError,
  sendJson,
} from "../http-utils.ts";
import type { RouteHandler } from "./shared.ts";

// Recurring series over HTTP (issue #42, ADR 0023). Series writes are
// online-only owner-session requests; generated instances reach clients as
// ordinary tasks through the sync feed.

/** Contract rule to the stored form, which always carries every field. */
export const storedRule = (rule: RecurrenceRuleInput): RecurrenceRule => ({
  cycle: rule.cycle,
  interval: rule.interval,
  weekdays: rule.cycle === "weekly" ? [...rule.weekdays] : [],
  monthly: rule.cycle === "monthly" ? rule.monthly : null,
});

const contractRule = (rule: RecurrenceRule): RecurrenceRuleInput => {
  switch (rule.cycle) {
    case "weekly":
      return {
        cycle: "weekly",
        interval: rule.interval,
        weekdays: [...rule.weekdays],
      };
    case "monthly":
      return {
        cycle: "monthly",
        interval: rule.interval,
        monthly: rule.monthly ?? { kind: "day_of_month" },
      };
    default:
      return { cycle: rule.cycle, interval: rule.interval };
  }
};

type FieldInput = {
  readonly [K in keyof RecurringSeriesFields]?:
    | (K extends "rule" ? RecurrenceRuleInput : RecurringSeriesFields[K])
    | undefined;
};
/** Converts contract fields to store fields; absent keys stay absent. */
export const storedSeriesFields = (
  input: FieldInput,
): Partial<RecurringSeriesFields> => {
  const { rule, ...rest } = input;
  return Object.fromEntries(
    Object.entries({
      ...rest,
      ...(rule === undefined ? {} : { rule: storedRule(rule) }),
    }).filter(([, value]) => value !== undefined),
  ) as Partial<RecurringSeriesFields>;
};

export const ownerToday = (
  database: SuiteDatabase,
  ownerId: string,
  now: Date,
): { readonly timeZone: string; readonly today: string } => {
  const { timeZone } = database.getPlanningPreferences(ownerId);
  return { timeZone, today: zonedCalendarDate(now, timeZone) };
};

export const recurringSeriesResponse = (
  database: SuiteDatabase,
  series: RecurringSeriesRecord,
  today: string,
): RecurringSeries => ({
  id: series.id,
  title: series.title,
  notes: series.notes,
  projectId: series.projectId,
  tagIds: [...series.tagIds],
  estimateMinutes: series.estimateMinutes,
  rule: contractRule(series.rule),
  startDate: series.startDate,
  endDate: series.endDate,
  startTime: series.startTime,
  // The database CHECK limits stored offsets to the contract values.
  startReminder: series.startReminder as RecurringSeries["startReminder"],
  anchor: series.anchor,
  waitForCompletion: series.waitForCompletion,
  missedOccurrences: series.missedOccurrences,
  childTemplates: series.childTemplates.map((template) => ({ ...template })),
  state: series.state,
  anchorDate: series.anchorDate,
  cursorDate: series.cursorDate,
  floorDate: series.floorDate,
  revision: series.revision,
  createdAt: series.createdAt,
  updatedAt: series.updatedAt,
  pausedAt: series.pausedAt,
  endedAt: series.endedAt,
  upcoming: database.recurrence
    .upcoming(series, today)
    .map((entry) => ({ ...entry })),
  exceptions: database.recurrence
    .exceptions(series.ownerId, series.id)
    .map((entry) => ({ ...entry })),
  instanceCount: database.recurrence.instanceCount(series.ownerId, series.id),
  source: series.source,
});

/** HTTP status and stable code for each recurrence rule (ADR 0023). */
export const recurrenceViolationError = (
  code: RecurrenceViolation,
): {
  readonly status: number;
  readonly code: string;
  readonly message: string;
} => {
  switch (code) {
    case "project_unavailable":
      return {
        status: 400,
        code: "INVALID_RECURRENCE",
        message: "Project is unknown or archived",
      };
    case "tag_unavailable":
      return {
        status: 400,
        code: "INVALID_RECURRENCE",
        message: "Tag is unknown or archived",
      };
    case "reminder_needs_time":
      return {
        status: 400,
        code: "INVALID_RECURRENCE",
        message: "A start reminder needs a start time",
      };
    case "source_task_invalid":
      return {
        status: 409,
        code: "RECURRENCE_SOURCE_TASK_INVALID",
        message:
          "Only an active top-level task that is not already recurring can start a series",
      };
    case "no_occurrence":
      return {
        status: 400,
        code: "INVALID_RECURRENCE",
        message: "The rule has no occurrence on or after today",
      };
    case "series_ended":
      return {
        status: 409,
        code: "RECURRENCE_SERIES_ENDED",
        message: "This series has ended and cannot change",
      };
    case "state_unchanged":
      return {
        status: 409,
        code: "RECURRENCE_STATE_UNCHANGED",
        message: "The series is already in that state",
      };
    case "occurrence_invalid":
      return {
        status: 400,
        code: "RECURRENCE_NOT_AN_OCCURRENCE",
        message: "The rule has no occurrence on that date",
      };
    case "occurrence_processed":
      return {
        status: 409,
        code: "RECURRENCE_OCCURRENCE_PROCESSED",
        message:
          "That occurrence was already created, skipped or passed; delete its instance instead",
      };
    case "occurrence_not_skipped":
      return {
        status: 409,
        code: "RECURRENCE_OCCURRENCE_NOT_SKIPPED",
        message: "That occurrence is not skipped",
      };
    case "instance_missing":
      return {
        status: 404,
        code: "RECURRENCE_INSTANCE_NOT_FOUND",
        message: "No active instance exists for that occurrence",
      };
    case "instance_blocked":
      return {
        status: 409,
        code: "RECURRENCE_INSTANCE_BLOCKED",
        message:
          "Complete the focus session and remove calendar blocks before deleting this instance",
      };
    default:
      return {
        status: 400,
        code: "INVALID_RECURRENCE_RULE",
        message: `The recurrence rule is invalid (${code})`,
      };
  }
};

export const recurrenceMutationBody = (
  database: SuiteDatabase,
  result: Extract<
    RecurrenceMutationResult,
    { kind: "created" | "replayed" | "updated" }
  >,
  today: string,
): RecurringSeriesMutationResponse => ({
  series: recurringSeriesResponse(database, result.series, today),
  generatedTaskIds: [...result.generatedTaskIds],
  updatedTaskIds: [...result.updatedTaskIds],
  replayed: result.kind === "replayed",
});

export const handleRecurrence: RouteHandler = async (
  request,
  response,
  url,
  { stores: database, auth, sessionClock },
) => {
  const method = request.method ?? "GET";
  const collection = url.pathname === "/api/recurring-series";
  const item = /^\/api\/recurring-series\/([0-9a-f-]{36})$/.exec(url.pathname);
  const state = /^\/api\/recurring-series\/([0-9a-f-]{36})\/state$/.exec(
    url.pathname,
  );
  const occurrence =
    /^\/api\/recurring-series\/([0-9a-f-]{36})\/occurrences\/([0-9-]{10})$/.exec(
      url.pathname,
    );
  const routed =
    (collection && (method === "GET" || method === "POST")) ||
    (item !== null && method === "PATCH") ||
    ((state !== null || occurrence !== null) && method === "POST");
  if (!routed) return false;
  const read = method === "GET";
  const session = auth.authenticate(request, !read);
  if (session === undefined) {
    sendError(response, 401, "AUTH_REQUIRED", "Authentication required");
    return true;
  }
  const ownerId = session.owner.id;
  const clock = sessionClock.now();
  const { timeZone, today } = ownerToday(database, ownerId, clock);
  if (read) {
    sendJson(response, 200, {
      series: database.recurrence
        .list(ownerId)
        .map((series) => recurringSeriesResponse(database, series, today)),
    });
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
  const now = clock.toISOString();
  let result: RecurrenceMutationResult;
  if (collection) {
    const key = idempotencyKeySchema.safeParse(
      request.headers["idempotency-key"],
    );
    if (!key.success) {
      sendError(
        response,
        400,
        "IDEMPOTENCY_KEY_REQUIRED",
        "A valid Idempotency-Key header is required",
      );
      return true;
    }
    const parsed = recurringSeriesCreateRequestSchema.safeParse(
      await readJson(request),
    );
    if (!parsed.success) {
      sendError(
        response,
        400,
        "INVALID_RECURRENCE",
        parsed.error.issues[0]?.message ?? "Series input is invalid",
      );
      return true;
    }
    const { sourceTaskId, ...fields } = parsed.data;
    result = database.recurrence.create({
      ownerId,
      id: randomUUID(),
      idempotencyKey: key.data,
      requestHash: createHash("sha256")
        .update(JSON.stringify(parsed.data))
        .digest("hex"),
      fields: storedSeriesFields(fields) as RecurringSeriesFields,
      sourceTaskId,
      timeZone,
      now,
    });
  } else {
    const revision = expectedRevision(request, response);
    if (revision === undefined) return true;
    const seriesId = (item ?? state ?? occurrence)?.[1] ?? "";
    const body = await readJson(request);
    if (item !== null) {
      const parsed = recurringSeriesPatchRequestSchema.safeParse(body);
      if (!parsed.success) {
        sendError(
          response,
          400,
          "INVALID_RECURRENCE",
          parsed.error.issues[0]?.message ?? "Series patch is invalid",
        );
        return true;
      }
      result = database.recurrence.update({
        ownerId,
        seriesId,
        expectedRevision: revision,
        patch: storedSeriesFields(parsed.data),
        timeZone,
        now,
      });
    } else if (state !== null) {
      const parsed = recurringSeriesStateRequestSchema.safeParse(body);
      if (!parsed.success) {
        sendError(response, 400, "INVALID_RECURRENCE", "Unknown action");
        return true;
      }
      result = database.recurrence.setState({
        ownerId,
        seriesId,
        expectedRevision: revision,
        action: parsed.data.action,
        timeZone,
        now,
      });
    } else {
      const parsed = recurrenceOccurrenceRequestSchema.safeParse(body);
      const date = recurrenceDateSchema.safeParse(occurrence?.[2]);
      if (!parsed.success || !date.success) {
        sendError(
          response,
          400,
          "INVALID_RECURRENCE",
          "Occurrence date or action is invalid",
        );
        return true;
      }
      result = database.recurrence.occurrence({
        ownerId,
        seriesId,
        expectedRevision: revision,
        date: date.data,
        action: parsed.data.action,
        now,
      });
    }
  }
  sendRecurrenceResult(response, database, result, today);
  return true;
};

const sendRecurrenceResult = (
  response: Parameters<RouteHandler>[1],
  database: SuiteDatabase,
  result: RecurrenceMutationResult,
  today: string,
): void => {
  switch (result.kind) {
    case "not-found":
      sendError(response, 404, "RECURRENCE_NOT_FOUND", "Series not found");
      return;
    case "conflict":
      sendError(
        response,
        409,
        "IDEMPOTENCY_CONFLICT",
        "The idempotency key was already used for a different request",
      );
      return;
    case "precondition-failed":
      sendError(
        response,
        412,
        "RECURRENCE_REVISION_CONFLICT",
        "The series changed; reload it before trying again",
      );
      return;
    case "invalid": {
      const error = recurrenceViolationError(result.code);
      sendError(response, error.status, error.code, error.message);
      return;
    }
    default:
      sendJson(
        response,
        result.kind === "created" ? 201 : 200,
        recurrenceMutationBody(database, result, today),
        { ETag: `"${String(result.series.revision)}"` },
      );
  }
};
