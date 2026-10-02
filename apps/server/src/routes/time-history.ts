import {
  timeEntryCreateRequestSchema,
  timeEntryPatchRequestSchema,
  timeReportQuerySchema,
  type TimeEntry,
  type TimeEntryMutationResponse,
  type TimeReport,
} from "@suite/contracts";
import type { TimeEntryViolation } from "@suite/domain";
import type {
  FocusEntryRecord,
  SuiteDatabase,
  TimeEntryRecord,
  TimeEntryWriteResult,
} from "@suite/persistence";
import type { ServerResponse } from "node:http";
import {
  expectedRevision,
  readJson,
  sameOrigin,
  sendError,
  sendJson,
} from "../http-utils.ts";
import type { RouteHandler } from "./shared.ts";

/** HTTP status and stable code for each time entry rule (ADR 0024). */
export const timeEntryViolationError = (
  code: TimeEntryViolation,
): {
  readonly status: number;
  readonly code: string;
  readonly message: string;
} =>
  ({
    task_unavailable: {
      status: 409,
      code: "TIME_ENTRY_TASK_UNAVAILABLE",
      message:
        "Time can be recorded only on active tasks; archived history and deleted tasks are read-only",
    },
    entry_read_only: {
      status: 409,
      code: "TIME_ENTRY_READ_ONLY",
      message:
        "Focus time belongs to its session; add a manual correction for the day instead",
    },
    duration_invalid: {
      status: 400,
      code: "INVALID_TIME_ENTRY",
      message:
        "Duration must be a nonzero whole number of milliseconds within one day; imported entries stay positive",
    },
    day_total_negative: {
      status: 409,
      code: "TIME_ENTRY_DAY_NEGATIVE",
      message: "The task's time for that day would drop below zero",
    },
    day_total_exceeds_day: {
      status: 409,
      code: "TIME_ENTRY_DAY_FULL",
      message: "The task's time for that day would exceed 24 hours",
    },
    focus_running: {
      status: 409,
      code: "TIME_ENTRY_FOCUS_RUNNING",
      message:
        "A focus session is running on this task today; stop it before lowering the day's time",
    },
  })[code];

export const timeEntryResponse = (
  entry: TimeEntryRecord | FocusEntryRecord,
): TimeEntry =>
  "source" in entry
    ? {
        id: entry.id,
        taskId: entry.taskId,
        workDate: entry.workDate,
        durationMs: entry.durationMs,
        source: entry.source,
        revision: entry.revision,
        note: entry.note,
        startedAt: null,
        endedAt: null,
        running: false,
        provenance: entry.provenance === null ? null : { ...entry.provenance },
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
      }
    : {
        id: entry.id,
        taskId: entry.taskId,
        workDate: entry.workDate,
        durationMs: entry.durationMs,
        source: "focus",
        revision: null,
        note: "",
        startedAt: entry.startedAt,
        endedAt: entry.endedAt,
        running: entry.running,
        provenance: null,
        createdAt: null,
        updatedAt: null,
      };

/** Worklog for a validated range in the owner's planning zone. */
export const timeReportBody = (
  database: SuiteDatabase,
  ownerId: string,
  range: { readonly from: string; readonly to: string },
  now: string,
): TimeReport => {
  const report = database.timeEntries.report({
    ownerId,
    ...range,
    timeZone: database.getPlanningPreferences(ownerId).timeZone,
    now,
  });
  return {
    ...report,
    bySource: { ...report.bySource },
    days: report.days.map((day) => ({
      ...day,
      tasks: day.tasks.map((task) => ({
        ...task,
        bySource: { ...task.bySource },
      })),
    })),
    weeks: report.weeks.map((week) => ({ ...week })),
    tasks: report.tasks.map((task) => ({
      ...task,
      bySource: { ...task.bySource },
    })),
    projects: report.projects.map((project) => ({ ...project })),
    entries: report.entries.map(timeEntryResponse),
  };
};

export const timeEntryMutationBody = (
  result: Extract<TimeEntryWriteResult, { kind: "applied" | "replayed" }>,
): TimeEntryMutationResponse => ({
  timeEntry: result.entry === null ? null : timeEntryResponse(result.entry),
  deletedId: result.deletedId,
  dayTotalMs: result.dayTotalMs,
});

const sendOutcome = (
  response: ServerResponse,
  result: TimeEntryWriteResult,
  created = false,
) => {
  if (result.kind === "not-found")
    sendError(response, 404, "TIME_ENTRY_NOT_FOUND", "Time entry not found");
  else if (result.kind === "precondition-failed")
    sendError(
      response,
      412,
      "TIME_ENTRY_REVISION_CONFLICT",
      "The time entry changed; reload the worklog before trying again",
    );
  else if (result.kind === "exists")
    sendError(
      response,
      409,
      "TIME_ENTRY_EXISTS",
      "A different time entry already uses this ID",
    );
  else if (result.kind === "invalid") {
    const error = timeEntryViolationError(result.code);
    sendError(response, error.status, error.code, error.message);
  } else
    sendJson(
      response,
      created && result.kind === "applied" ? 201 : 200,
      timeEntryMutationBody(result),
      result.entry === null
        ? {}
        : { ETag: `"${String(result.entry.revision)}"` },
    );
};

/**
 * Worklog reports and manual time entries over HTTP (ADR 0024). Stored
 * entries are sync feed records (ADR 0050): the store appends a feed change
 * with every write here, so other devices receive it in their next round.
 * With a connection the web app writes through these routes, so a broken
 * day rule is reported at once; offline it queues the same write in the
 * sync outbox. The report stays online: it adds focus time and imported
 * work context, which are not in the feed.
 */
export const handleTimeHistory: RouteHandler = async (
  request,
  response,
  url,
  { auth, stores, sessionClock },
) => {
  const method = request.method ?? "GET";
  const match = /^\/api\/time\/entries\/([0-9a-f-]{36})$/.exec(url.pathname);
  const report = method === "GET" && url.pathname === "/api/time/report";
  const create = method === "POST" && url.pathname === "/api/time/entries";
  const patch = method === "PATCH" && match !== null;
  const remove = method === "DELETE" && match !== null;
  if (!report && !create && !patch && !remove) return false;
  const session = auth.authenticate(request, !report);
  if (session === undefined) {
    sendError(response, 401, "AUTH_REQUIRED", "Authentication required");
    return true;
  }
  const ownerId = session.owner.id;
  const now = sessionClock.now().toISOString();
  if (report) {
    const parsed = timeReportQuerySchema.safeParse(
      Object.fromEntries(url.searchParams.entries()),
    );
    if (!parsed.success)
      sendError(
        response,
        400,
        "INVALID_TIME_REPORT",
        "Provide from and to calendar dates at most 366 days apart",
      );
    else
      sendJson(
        response,
        200,
        timeReportBody(stores, ownerId, parsed.data, now),
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
  const timeZone = stores.getPlanningPreferences(ownerId).timeZone;
  if (create) {
    const parsed = timeEntryCreateRequestSchema.safeParse(
      await readJson(request),
    );
    if (!parsed.success) {
      sendError(
        response,
        400,
        "INVALID_TIME_ENTRY",
        "Provide an entry ID, task, calendar date and a nonzero duration within one day",
      );
      return true;
    }
    sendOutcome(
      response,
      stores.timeEntries.create({ ownerId, ...parsed.data, timeZone, now }),
      true,
    );
    return true;
  }
  const id = match?.[1];
  const revision = expectedRevision(request, response);
  if (revision === undefined || id === undefined) return true;
  if (remove) {
    sendOutcome(
      response,
      stores.timeEntries.delete({
        ownerId,
        id,
        expectedRevision: revision,
        timeZone,
        now,
      }),
    );
    return true;
  }
  const parsed = timeEntryPatchRequestSchema.safeParse(await readJson(request));
  if (!parsed.success) {
    sendError(
      response,
      400,
      "INVALID_TIME_ENTRY",
      "Change the date, duration or note of the entry",
    );
    return true;
  }
  sendOutcome(
    response,
    stores.timeEntries.update({
      ownerId,
      id,
      expectedRevision: revision,
      patch: parsed.data,
      timeZone,
      now,
    }),
  );
  return true;
};
