import { StructuredCaptureError } from "@suite/domain";
import { createCapturedTask } from "../task-capture.ts";
import { randomUUID, createHash } from "node:crypto";
import type {
  TaskListResponse,
  TaskMutationResponse,
  TaskTimeBlockMutationResponse,
} from "@suite/contracts";
import {
  createTaskRequestSchema,
  taskPatchRequestSchema,
  createTaskTimeBlockRequestSchema,
  idempotencyKeySchema,
} from "@suite/contracts";
import type { CalendarEventResource } from "@suite/caldav";
import type { CalendarOperationResult } from "../connector.ts";
import {
  sendJson,
  sendError,
  readJson,
  sameOrigin,
  expectedRevision,
  sendConditionalTask,
} from "../http-utils.ts";
import type { RouteHandler } from "./shared.ts";
import { taskResponse } from "./shared.ts";

export const handleTasks: RouteHandler = async (
  request,
  response,
  url,
  ctx,
) => {
  const { stores: database, auth, baikal: connector } = ctx;
  const method = request.method ?? "GET";

  if (method === "GET" && url.pathname === "/api/tasks") {
    const session = auth.authenticate(request, false);
    if (session === undefined) {
      sendError(response, 401, "AUTH_REQUIRED", "Authentication required");
      return true;
    }
    const body: TaskListResponse = {
      tasks: database.listTasks(session.owner.id).map(taskResponse),
    };
    sendJson(response, 200, body);
    return true;
  }

  if (method === "POST" && url.pathname === "/api/tasks") {
    if (!sameOrigin(request)) {
      sendError(
        response,
        403,
        "ORIGIN_REQUIRED",
        "Same-origin request required",
      );
      return true;
    }
    const session = auth.authenticate(request, true);
    if (session === undefined) {
      sendError(response, 401, "AUTH_REQUIRED", "Authentication required");
      return true;
    }
    if (
      !auth.csrfMatches(
        session,
        request.headers["x-csrf-token"] as string | undefined,
      )
    ) {
      sendError(response, 403, "CSRF_INVALID", "Valid CSRF token required");
      return true;
    }
    const idempotencyKey = request.headers["idempotency-key"];
    const parsedKey = idempotencyKeySchema.safeParse(idempotencyKey);
    if (!parsedKey.success) {
      sendError(
        response,
        400,
        "IDEMPOTENCY_KEY_REQUIRED",
        "A valid Idempotency-Key header is required",
      );
      return true;
    }
    const parsed = createTaskRequestSchema.safeParse(await readJson(request));
    if (!parsed.success) {
      sendError(response, 400, "INVALID_TASK", "Task input is invalid");
      return true;
    }
    const requestHash = createHash("sha256")
      .update(JSON.stringify(parsed.data))
      .digest("hex");
    const now = new Date().toISOString();
    let result;
    try {
      result = createCapturedTask(
        database,
        session.owner.id,
        parsedKey.data,
        requestHash,
        parsed.data,
        now,
      );
    } catch (error) {
      if (!(error instanceof StructuredCaptureError)) throw error;
      sendError(response, 400, "INVALID_TASK", error.message);
      return true;
    }
    if (result.kind === "conflict") {
      sendError(
        response,
        409,
        "IDEMPOTENCY_CONFLICT",
        "The idempotency key was already used for a different request",
      );
      return true;
    }
    const body: TaskMutationResponse = {
      replayed: result.kind === "replayed",
      task: taskResponse(result.task),
    };
    console.info(
      result.kind === "replayed"
        ? "task.create.replayed"
        : "task.create.completed",
    );
    sendJson(response, result.kind === "created" ? 201 : 200, body, {
      ETag: `"${String(body.task.revision)}"`,
    });
    return true;
  }

  if (method === "GET" && url.pathname === "/api/tasks/recovery") {
    const session = auth.authenticate(request, false);
    if (session === undefined) {
      sendError(response, 401, "AUTH_REQUIRED", "Authentication required");
      return true;
    }
    const body: TaskListResponse = {
      tasks: database.listDeletedTasks(session.owner.id).map(taskResponse),
    };
    sendJson(response, 200, body);
    return true;
  }

  const taskRoute =
    /^\/api\/tasks\/([0-9a-f-]{36})(?:\/(complete|reopen|restore|time-block))?$/.exec(
      url.pathname,
    );
  if (taskRoute !== null && ["PATCH", "POST", "DELETE"].includes(method)) {
    if (!sameOrigin(request)) {
      sendError(
        response,
        403,
        "ORIGIN_REQUIRED",
        "Same-origin request required",
      );
      return true;
    }
    const session = auth.authenticate(request, true);
    if (session === undefined) {
      sendError(response, 401, "AUTH_REQUIRED", "Authentication required");
      return true;
    }
    if (
      !auth.csrfMatches(
        session,
        request.headers["x-csrf-token"] as string | undefined,
      )
    ) {
      sendError(response, 403, "CSRF_INVALID", "Valid CSRF token required");
      return true;
    }
    const revision = expectedRevision(request, response);
    if (revision === undefined) return true;
    const taskId = taskRoute[1] ?? "";
    const action = taskRoute[2];

    if (method === "PATCH" && action === undefined) {
      const parsed = taskPatchRequestSchema.safeParse(await readJson(request));
      if (!parsed.success) {
        sendError(response, 400, "INVALID_TASK", "Task input is invalid");
        return true;
      }
      sendConditionalTask(
        response,
        database.patchTask(
          session.owner.id,
          taskId,
          revision,
          {
            ...(parsed.data.title === undefined
              ? {}
              : { title: parsed.data.title }),
            ...(parsed.data.notes === undefined
              ? {}
              : { notes: parsed.data.notes }),
            ...(parsed.data.plannedStart === undefined
              ? {}
              : { plannedStart: parsed.data.plannedStart }),
            ...(parsed.data.estimateMinutes === undefined
              ? {}
              : { estimateMinutes: parsed.data.estimateMinutes }),
            ...(parsed.data.deadline === undefined
              ? {}
              : parsed.data.deadline === null
                ? { deadlineDate: null, deadlineAt: null }
                : parsed.data.deadline.kind === "date"
                  ? {
                      deadlineDate: parsed.data.deadline.value,
                      deadlineAt: null,
                    }
                  : {
                      deadlineDate: null,
                      deadlineAt: parsed.data.deadline.value,
                    }),
          },
          new Date().toISOString(),
        ),
      );
      return true;
    }

    if (method === "POST" && (action === "complete" || action === "reopen")) {
      sendConditionalTask(
        response,
        database.setTaskCompleted(
          session.owner.id,
          taskId,
          revision,
          action === "complete",
          new Date().toISOString(),
        ),
      );
      return true;
    }

    if (method === "DELETE" && action === undefined) {
      const active = database.getActiveSession(session.owner.id);
      if (active?.endedAt === null && active.taskId === taskId) {
        sendError(
          response,
          409,
          "ACTIVE_SESSION_COMPLETE_REQUIRED",
          "Complete the active focus session before deleting this task",
        );
        return true;
      }
      if (
        database.getTaskCalendarBlock(session.owner.id, taskId) !== undefined
      ) {
        sendError(
          response,
          409,
          "TIME_BLOCK_REMOVE_REQUIRED",
          "Remove the calendar block before deleting this task",
        );
        return true;
      }
      sendConditionalTask(
        response,
        database.deleteTask(
          session.owner.id,
          taskId,
          revision,
          new Date().toISOString(),
        ),
      );
      return true;
    }

    if (method === "DELETE" && action === "time-block") {
      const task = database.getTask(session.owner.id, taskId);
      if (task === undefined) {
        sendError(response, 404, "TASK_NOT_FOUND", "Task not found");
        return true;
      }
      if (task.revision !== revision) {
        sendError(
          response,
          412,
          "TASK_REVISION_CONFLICT",
          "The task changed; reload it before removing its block",
        );
        return true;
      }
      const block = database.getTaskCalendarBlock(session.owner.id, taskId);
      if (block === undefined) {
        sendError(
          response,
          404,
          "TIME_BLOCK_NOT_FOUND",
          "Task time block not found",
        );
        return true;
      }
      const remote = await connector.deleteTaskBlock({
        ownerId: session.owner.id,
        calendarId: block.calendarId,
        href: block.eventHref,
        expectedEtag: block.remoteEtag,
      });
      if (!remote.ok && remote.reason !== "not-found") {
        const conflict = remote.reason === "precondition-failed";
        database.markTaskCalendarBlockState(
          session.owner.id,
          taskId,
          conflict ? "conflict" : "needs_reconciliation",
          new Date().toISOString(),
        );
        if (conflict) {
          sendJson(response, 409, {
            code: "CALENDAR_EVENT_CONFLICT",
            message: "The calendar event changed; refresh before removing it",
            requestId: randomUUID(),
            action: "refresh_and_replan",
            mappingId: block.id,
          });
        } else {
          sendError(
            response,
            502,
            "CALENDAR_DELETE_UNCERTAIN",
            "Calendar deletion is uncertain and needs reconciliation",
          );
        }
        return true;
      }
      const released = database.releaseTaskCalendarBlock({
        ownerId: session.owner.id,
        taskId,
        expectedTaskRevision: revision,
        expectedBlockRevision: block.revision,
        now: new Date().toISOString(),
      });
      if (released === undefined) {
        sendError(
          response,
          409,
          "CALENDAR_DELETE_RECONCILIATION_REQUIRED",
          "Calendar block was removed remotely but local state changed",
        );
        return true;
      }
      sendJson(
        response,
        200,
        { task: taskResponse(released) },
        {
          ETag: `"${String(released.revision)}"`,
        },
      );
      return true;
    }

    if (method === "POST" && action === "restore") {
      const input = await readJson(request);
      if (
        typeof input !== "object" ||
        input === null ||
        Object.keys(input).length !== 0
      ) {
        sendError(
          response,
          400,
          "INVALID_RESTORE",
          "Restore input must be empty",
        );
        return true;
      }
      sendConditionalTask(
        response,
        database.restoreTask(
          session.owner.id,
          taskId,
          revision,
          new Date().toISOString(),
        ),
      );
      return true;
    }

    if (method === "POST" && action === "time-block") {
      const idempotencyKey = idempotencyKeySchema.safeParse(
        request.headers["idempotency-key"],
      );
      const input = createTaskTimeBlockRequestSchema.safeParse(
        await readJson(request),
      );
      if (!idempotencyKey.success || !input.success) {
        sendError(
          response,
          400,
          "INVALID_TIME_BLOCK",
          "Time-block input and idempotency key are required",
        );
        return true;
      }
      const existingBlock = database.getTaskCalendarBlock(
        session.owner.id,
        taskId,
      );
      if (
        existingBlock !== undefined &&
        existingBlock.calendarId !== input.data.calendarId
      ) {
        sendError(
          response,
          409,
          "TIME_BLOCK_CALENDAR_FIXED",
          "Remove the current block before choosing another calendar",
        );
        return true;
      }
      const calendar = database.getOwnedCalendar(
        session.owner.id,
        input.data.calendarId,
      );
      if (calendar?.supportsEvents !== true) {
        sendError(response, 404, "CALENDAR_NOT_FOUND", "Calendar not found");
        return true;
      }
      const uid = existingBlock?.eventUid ?? `${randomUUID()}@suite.local`;
      const href =
        existingBlock?.eventHref ??
        `${calendar.href.replace(/\/$/, "")}/${randomUUID()}.ics`;
      const normalized = {
        taskId,
        calendarId: input.data.calendarId,
        startsAt: input.data.startsAt,
        durationMinutes: input.data.durationMinutes,
      };
      const requestHash = createHash("sha256")
        .update(JSON.stringify(normalized))
        .digest("hex");
      const now = new Date().toISOString();
      const reservation = database.reserveCalendarWrite({
        ownerId: session.owner.id,
        taskId,
        expectedTaskRevision: revision,
        idempotencyKey: idempotencyKey.data,
        requestHash,
        calendarId: input.data.calendarId,
        reservedHref: href,
        reservedUid: uid,
        now,
      });
      if (reservation.kind === "conflict") {
        sendError(
          response,
          409,
          "IDEMPOTENCY_CONFLICT",
          "The idempotency key was used for another request",
        );
        return true;
      }
      if (reservation.kind === "task-not-found") {
        sendError(response, 404, "TASK_NOT_FOUND", "Task not found");
        return true;
      }
      if (reservation.kind === "task-precondition-failed") {
        sendError(
          response,
          412,
          "TASK_REVISION_CONFLICT",
          "The task changed; reload it before planning",
        );
        return true;
      }
      if (reservation.kind === "calendar-not-found") {
        sendError(response, 404, "CALENDAR_NOT_FOUND", "Calendar not found");
        return true;
      }
      if (
        reservation.kind === "replayed" &&
        reservation.operation.state === "completed"
      ) {
        const task = database.getTask(session.owner.id, taskId);
        const block = database.getTaskCalendarBlock(session.owner.id, taskId);
        if (block === undefined) {
          sendError(
            response,
            409,
            "TIME_BLOCK_RELEASED",
            "This completed planning operation was subsequently released",
          );
          return true;
        }
        if (task === undefined) {
          sendError(response, 404, "TASK_NOT_FOUND", "Task not found");
          return true;
        }
        const body: TaskTimeBlockMutationResponse = {
          task: taskResponse(task),
          replayed: true,
          mapping: {
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
          },
        };
        sendJson(response, 200, body, {
          ETag: `"${String(task.revision)}"`,
        });
        return true;
      }
      const operation = reservation.operation;
      const task = database.getTask(session.owner.id, taskId);
      if (task === undefined)
        throw new Error("Reserved planning task is missing");
      const endsAt = new Date(
        Date.parse(input.data.startsAt) +
          input.data.durationMinutes * 60 * 1000,
      ).toISOString();
      let remote: CalendarOperationResult<CalendarEventResource>;
      if (reservation.kind === "replayed") {
        const projection = await connector.projectEvents(
          session.owner.id,
          operation.calendarId,
          new Date(
            Date.parse(input.data.startsAt) - 60 * 60 * 1000,
          ).toISOString(),
          new Date(Date.parse(endsAt) + 60 * 60 * 1000).toISOString(),
        );
        if (!projection.ok) {
          remote = projection;
        } else {
          const reconciled = projection.value.find(
            (candidate) =>
              candidate.href === operation.reservedHref &&
              candidate.event.uid === operation.reservedUid &&
              candidate.event.summary === task.title &&
              Date.parse(candidate.event.startsAt) ===
                Date.parse(input.data.startsAt) &&
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
          ownerId: session.owner.id,
          calendarId: operation.calendarId,
          href: operation.reservedHref,
          uid: operation.reservedUid,
          summary: task.title,
          startsAt: input.data.startsAt,
          endsAt,
          ...(existingBlock === undefined
            ? {}
            : { expectedEtag: existingBlock.remoteEtag }),
        });
      }
      if (reservation.kind === "replayed" && !remote.ok) {
        database.markCalendarWriteConflict(
          session.owner.id,
          idempotencyKey.data,
          new Date().toISOString(),
        );
        sendError(
          response,
          409,
          "CALENDAR_WRITE_RECONCILIATION_REQUIRED",
          "The prior calendar write could not be safely reconciled",
        );
        return true;
      }
      if (!remote.ok) {
        if (remote.reason === "precondition-failed") {
          database.markCalendarWriteConflict(
            session.owner.id,
            idempotencyKey.data,
            new Date().toISOString(),
          );
          sendJson(response, 409, {
            code: "CALENDAR_EVENT_CONFLICT",
            message: "The calendar event changed; refresh before replanning",
            requestId: randomUUID(),
            action: "refresh_and_replan",
            mappingId: existingBlock?.id ?? null,
          });
          return true;
        }
        database.markCalendarWriteConflict(
          session.owner.id,
          idempotencyKey.data,
          new Date().toISOString(),
        );
        sendError(
          response,
          502,
          "CALENDAR_WRITE_UNCERTAIN",
          "Calendar outcome is uncertain and needs reconciliation",
        );
        return true;
      }
      const remoteEvent = remote.value;
      const completed = database.completeCalendarWrite({
        ownerId: session.owner.id,
        idempotencyKey: idempotencyKey.data,
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
        plannedStart: input.data.startsAt,
        estimateMinutes: input.data.durationMinutes,
        now: new Date().toISOString(),
      });
      if (completed === undefined)
        throw new Error("Planning operation could not be completed");
      const body: TaskTimeBlockMutationResponse = {
        task: taskResponse(completed.task),
        replayed: reservation.kind === "replayed",
        mapping: {
          id: completed.block.id,
          taskId: completed.block.taskId,
          event: {
            providerId: completed.block.providerId,
            calendarId: completed.block.calendarId,
            eventId: completed.block.eventHref,
          },
          href: completed.block.eventHref,
          uid: completed.block.eventUid,
          etag: completed.block.remoteEtag,
          state: "active",
          createdBySuite: true,
          createdAt: completed.block.createdAt,
          updatedAt: completed.block.updatedAt,
        },
      };
      sendJson(response, 201, body, {
        ETag: `"${String(completed.task.revision)}"`,
      });
      return true;
    }

    sendError(response, 405, "METHOD_NOT_ALLOWED", "Method not allowed");
    return true;
  }

  return false;
};
