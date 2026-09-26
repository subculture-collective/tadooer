import { createHash, randomUUID } from "node:crypto";
import type {
  AutomationConfirmationResponse,
  AutomationPreviewCommand,
  TaskTimeBlockMutationResponse,
} from "@suite/contracts";
import type { CalendarEventResource } from "@suite/caldav";
import type {
  SuiteDatabase,
  TaskCalendarBlockRecord,
  TaskRecord,
} from "@suite/persistence";
import type {
  BaikalConnectorService,
  CalendarOperationResult,
} from "../connector.ts";
import { taskResponse } from "./shared.ts";

// Time-block assistant operations (issue #58, ADR 0037). automation.ts keeps
// the shared preview/confirm protocol; this module supplies the checks, the
// preview text and the CalDAV write and delete paths shared with the browser
// routes in tasks.ts.

export type TimeBlockCommand = Extract<
  AutomationPreviewCommand,
  {
    operation:
      | "schedule.create_time_block"
      | "schedule.move_time_block"
      | "schedule.remove_time_block";
  }
>;
type WriteCommand = Exclude<
  TimeBlockCommand,
  { operation: "schedule.remove_time_block" }
>;

interface Affected {
  readonly entityKind: "task" | "calendar";
  readonly entityId: string;
}
interface BaseRevision {
  readonly entityKind: "task";
  readonly entityId: string;
  readonly revision: number;
}
export interface TimeBlockFailure {
  readonly ok: false;
  readonly status: number;
  readonly code: string;
  readonly message: string;
  /** Extra JSON fields for `CALENDAR_EVENT_CONFLICT` responses. */
  readonly body?: Readonly<Record<string, unknown>>;
}
export type TimeBlockPreview =
  | {
      readonly ok: true;
      readonly summary: string;
      readonly affected: readonly Affected[];
      readonly baseRevisions: readonly BaseRevision[];
    }
  | TimeBlockFailure;
type Result = AutomationConfirmationResponse["result"];

export const isTimeBlockCommand = (
  command: AutomationPreviewCommand,
): command is TimeBlockCommand =>
  command.operation === "schedule.create_time_block" ||
  command.operation === "schedule.move_time_block" ||
  command.operation === "schedule.remove_time_block";

const failure = (
  status: number,
  code: string,
  message: string,
): TimeBlockFailure => ({ ok: false, status, code, message });

const quoted = (value: string): string =>
  `"${value.replace(/"/g, "'").trim() || "untitled"}"`;

const clock = (iso: string): string =>
  new Date(iso).toISOString().replace(".000Z", "Z");

const interval = (startsAt: string, durationMinutes: number): string =>
  `${clock(startsAt)} to ${clock(
    new Date(Date.parse(startsAt) + durationMinutes * 60_000).toISOString(),
  )} (${String(durationMinutes)} min)`;

/** The block's current interval as the task records it, if known. */
const currentInterval = (task: TaskRecord): string =>
  task.plannedStart === null || task.estimateMinutes === null
    ? "its current time"
    : interval(task.plannedStart, task.estimateMinutes);

const mappingResponse = (
  block: TaskCalendarBlockRecord,
): TaskTimeBlockMutationResponse["mapping"] => ({
  id: block.id,
  taskId: block.taskId,
  event: {
    providerId: block.providerId,
    calendarId: block.calendarId,
    eventId: block.eventHref,
  },
  href: block.eventHref,
  uid: block.eventUid,
  etag: block.remoteEtag,
  state: "active",
  createdBySuite: true,
  createdAt: block.createdAt,
  updatedAt: block.updatedAt,
});

/**
 * Resolves the task, its block and the target calendar for any of the three
 * operations, applying the browser routes' checks in the same order.
 */
const resolve = (
  database: SuiteDatabase,
  ownerId: string,
  command: TimeBlockCommand,
):
  | {
      readonly ok: true;
      readonly task: TaskRecord;
      readonly block: TaskCalendarBlockRecord | undefined;
      readonly calendarId: string;
      readonly calendarName: string;
    }
  | TimeBlockFailure => {
  const task = database.getTask(ownerId, command.input.taskId);
  if (task === undefined)
    return failure(404, "TASK_NOT_FOUND", "Task not found");
  const block = database.getTaskCalendarBlock(ownerId, task.id);
  if (command.operation !== "schedule.create_time_block") {
    if (task.revision !== command.input.expectedRevision)
      return failure(
        412,
        "TASK_REVISION_CONFLICT",
        "The task changed; read it again before changing its block",
      );
    if (block === undefined)
      return failure(404, "TIME_BLOCK_NOT_FOUND", "Task time block not found");
  }
  const requested =
    command.operation === "schedule.remove_time_block"
      ? undefined
      : command.input.calendarId;
  if (
    block !== undefined &&
    requested !== undefined &&
    requested !== block.calendarId
  )
    return failure(
      409,
      "TIME_BLOCK_CALENDAR_FIXED",
      "Remove the current block before choosing another calendar",
    );
  const calendarId = block?.calendarId ?? requested;
  const calendar =
    calendarId === undefined
      ? undefined
      : database.getOwnedCalendar(ownerId, calendarId);
  if (calendar?.supportsEvents !== true)
    return failure(404, "CALENDAR_NOT_FOUND", "Calendar not found");
  return {
    ok: true,
    task,
    block,
    calendarId: calendar.id,
    calendarName: calendar.displayName,
  };
};

export const previewTimeBlock = (
  database: SuiteDatabase,
  ownerId: string,
  command: TimeBlockCommand,
): TimeBlockPreview => {
  const resolved = resolve(database, ownerId, command);
  if (!resolved.ok) return resolved;
  const { task, calendarId, calendarName } = resolved;
  const title = quoted(task.title);
  const calendar = quoted(calendarName);
  const summary =
    command.operation === "schedule.remove_time_block"
      ? `Remove the time block for task ${title} at ${currentInterval(task)} from calendar ${calendar}; the task keeps its title and notes but loses its planned start and estimate`
      : command.operation === "schedule.move_time_block"
        ? `Move the time block for task ${title} on calendar ${calendar} from ${currentInterval(task)} to ${interval(command.input.startsAt, command.input.durationMinutes)}`
        : resolved.block === undefined
          ? `Schedule task ${title} on calendar ${calendar} at ${interval(command.input.startsAt, command.input.durationMinutes)}`
          : `Replace the time block for task ${title} on calendar ${calendar}: ${currentInterval(task)} becomes ${interval(command.input.startsAt, command.input.durationMinutes)}`;
  return {
    ok: true,
    summary,
    affected: [
      { entityKind: "task", entityId: task.id },
      { entityKind: "calendar", entityId: calendarId },
    ],
    baseRevisions: [
      { entityKind: "task", entityId: task.id, revision: task.revision },
    ],
  };
};

const eventConflict = (mappingId: string | null): TimeBlockFailure => ({
  ok: false,
  status: 409,
  code: "CALENDAR_EVENT_CONFLICT",
  message: "The calendar event changed; refresh before replanning",
  body: { action: "refresh_and_replan", mappingId },
});

/**
 * Create or move: reserves a durable write record under the confirmation key,
 * issues the conditional PUT (or reconciles a replayed record by reading the
 * calendar) and completes the block. Mirrors the browser POST route.
 */
export const confirmTimeBlockWrite = async (
  database: SuiteDatabase,
  connector: BaikalConnectorService,
  ownerId: string,
  internalKey: string,
  command: WriteCommand,
  taskRevision: number,
): Promise<
  | { readonly ok: true; readonly result: Result; readonly apply?: undefined }
  | TimeBlockFailure
> => {
  const resolved = resolve(database, ownerId, command);
  if (!resolved.ok) return resolved;
  const { task, block: existingBlock, calendarId } = resolved;
  const calendar = database.getOwnedCalendar(ownerId, calendarId);
  if (calendar === undefined)
    return failure(404, "CALENDAR_NOT_FOUND", "Calendar not found");
  const input = command.input;
  const uid = existingBlock?.eventUid ?? `${randomUUID()}@suite.local`;
  const href =
    existingBlock?.eventHref ??
    `${calendar.href.replace(/\/$/, "")}/${randomUUID()}.ics`;
  const reservation = database.reserveCalendarWrite({
    ownerId,
    taskId: task.id,
    expectedTaskRevision: taskRevision,
    idempotencyKey: internalKey,
    requestHash: createHash("sha256")
      .update(JSON.stringify(input))
      .digest("hex"),
    calendarId,
    reservedHref: href,
    reservedUid: uid,
    now: new Date().toISOString(),
  });
  if (reservation.kind === "conflict")
    return failure(
      409,
      "IDEMPOTENCY_CONFLICT",
      "Scheduling operation conflicted",
    );
  if (reservation.kind === "task-precondition-failed")
    return failure(
      409,
      "AUTOMATION_PREVIEW_STALE",
      "Scheduling operation conflicted",
    );
  if (reservation.kind === "task-not-found")
    return failure(404, "TASK_NOT_FOUND", "Scheduling resource not found");
  if (reservation.kind === "calendar-not-found")
    return failure(404, "CALENDAR_NOT_FOUND", "Scheduling resource not found");
  if (
    reservation.kind === "replayed" &&
    reservation.operation.state === "completed"
  ) {
    const replayedTask = database.getTask(ownerId, task.id);
    const block = database.getTaskCalendarBlock(ownerId, task.id);
    if (replayedTask === undefined || block === undefined)
      return failure(
        409,
        "CALENDAR_WRITE_RECONCILIATION_REQUIRED",
        "Completed scheduling state could not be reconstructed",
      );
    return {
      ok: true,
      result: {
        task: taskResponse(replayedTask),
        replayed: true,
        mapping: mappingResponse(block),
      },
    };
  }
  const operation = reservation.operation;
  const endsAt = new Date(
    Date.parse(input.startsAt) + input.durationMinutes * 60_000,
  ).toISOString();
  let remote: CalendarOperationResult<CalendarEventResource>;
  if (reservation.kind === "replayed") {
    // A prior attempt's outcome is unknown: read the calendar and accept
    // only the exact intended event at the reserved href.
    const projection = await connector.projectEvents(
      ownerId,
      operation.calendarId,
      new Date(Date.parse(input.startsAt) - 3_600_000).toISOString(),
      new Date(Date.parse(endsAt) + 3_600_000).toISOString(),
    );
    if (!projection.ok) remote = projection;
    else {
      const reconciled = projection.value.find(
        (candidate) =>
          candidate.href === operation.reservedHref &&
          candidate.event.uid === operation.reservedUid &&
          candidate.event.summary === task.title &&
          Date.parse(candidate.event.startsAt) === Date.parse(input.startsAt) &&
          Date.parse(candidate.event.endsAt) === Date.parse(endsAt) &&
          !candidate.event.allDay,
      );
      remote =
        reconciled === undefined
          ? { ok: false, reason: "outcome-unknown" }
          : { ok: true, value: reconciled };
    }
  } else {
    remote = await connector.putTaskBlock({
      ownerId,
      calendarId: operation.calendarId,
      href: operation.reservedHref,
      uid: operation.reservedUid,
      summary: task.title,
      startsAt: input.startsAt,
      endsAt,
      ...(existingBlock === undefined
        ? {}
        : { expectedEtag: existingBlock.remoteEtag }),
    });
  }
  if (!remote.ok) {
    database.markCalendarWriteConflict(
      ownerId,
      internalKey,
      new Date().toISOString(),
    );
    return reservation.kind !== "replayed" &&
      remote.reason === "precondition-failed"
      ? eventConflict(existingBlock?.id ?? null)
      : failure(
          409,
          "CALENDAR_WRITE_RECONCILIATION_REQUIRED",
          "Calendar write could not be safely reconciled",
        );
  }
  const remoteEvent = remote.value;
  const completed = database.completeCalendarWrite({
    ownerId,
    idempotencyKey: internalKey,
    event: {
      id: randomUUID(),
      providerId: operation.providerId,
      calendarId: operation.calendarId,
      href: remoteEvent.href,
      uid: remoteEvent.event.uid,
      etag: remoteEvent.etag,
      rawIcs: remoteEvent.rawIcs,
      summary: remoteEvent.event.summary,
      startsAt: new Date(remoteEvent.event.startsAt).toISOString(),
      endsAt: new Date(remoteEvent.event.endsAt).toISOString(),
      allDay: false,
      freshness: "current",
      mutable: true,
      revision: 1,
      projectedAt: new Date().toISOString(),
    },
    plannedStart: input.startsAt,
    estimateMinutes: input.durationMinutes,
    now: new Date().toISOString(),
  });
  if (completed === undefined)
    throw new Error("Automation scheduling could not be completed");
  return {
    ok: true,
    result: {
      task: taskResponse(completed.task),
      replayed: reservation.kind === "replayed",
      mapping: mappingResponse(completed.block),
    },
  };
};

/**
 * Remove: conditional DELETE first (a network call), then the local release
 * runs inside the confirmation transaction through `apply`. Mirrors the
 * browser DELETE route, including its conflict and uncertainty outcomes.
 */
export const confirmTimeBlockRemove = async (
  database: SuiteDatabase,
  connector: BaikalConnectorService,
  ownerId: string,
  command: Extract<
    TimeBlockCommand,
    { operation: "schedule.remove_time_block" }
  >,
  taskRevision: number,
): Promise<
  | {
      readonly ok: true;
      readonly result: Result;
      readonly apply: () => Result;
    }
  | TimeBlockFailure
> => {
  const resolved = resolve(database, ownerId, command);
  if (!resolved.ok) return resolved;
  const { task, block } = resolved;
  if (block === undefined || task.revision !== taskRevision)
    return failure(
      409,
      "AUTOMATION_PREVIEW_STALE",
      "The task changed before confirmation",
    );
  const remote = await connector.deleteTaskBlock({
    ownerId,
    calendarId: block.calendarId,
    href: block.eventHref,
    expectedEtag: block.remoteEtag,
  });
  if (!remote.ok && remote.reason !== "not-found") {
    const conflict = remote.reason === "precondition-failed";
    database.markTaskCalendarBlockState(
      ownerId,
      task.id,
      conflict ? "conflict" : "needs_reconciliation",
      new Date().toISOString(),
    );
    return conflict
      ? {
          ...eventConflict(block.id),
          message: "The calendar event changed; refresh before removing it",
        }
      : failure(
          502,
          "CALENDAR_DELETE_UNCERTAIN",
          "Calendar deletion is uncertain and needs reconciliation",
        );
  }
  return {
    ok: true,
    result: { task: taskResponse(task), replayed: false },
    apply: () => {
      const released = database.releaseTaskCalendarBlock({
        ownerId,
        taskId: task.id,
        expectedTaskRevision: taskRevision,
        expectedBlockRevision: block.revision,
        now: new Date().toISOString(),
      });
      if (released === undefined)
        throw new Error("Task block changed during atomic confirmation");
      return { task: taskResponse(released), replayed: false };
    },
  };
};
