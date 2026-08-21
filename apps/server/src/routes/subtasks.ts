import { randomUUID } from "node:crypto";
import {
  sendJson,
  sendError,
  readJson,
  sameOrigin,
  expectedRevision,
} from "../http-utils.ts";
import type { RouteHandler } from "./shared.ts";
import { subtaskResponse, sendEmpty } from "./shared.ts";

export const handleSubtasks: RouteHandler = async (
  request,
  response,
  url,
  ctx,
) => {
  const { stores: database, auth } = ctx;
  const method = request.method ?? "GET";

  const taskSubtasksMatch = /^\/api\/tasks\/([0-9a-f-]{36})\/subtasks$/.exec(
    url.pathname,
  );
  if (taskSubtasksMatch !== null && (method === "GET" || method === "POST")) {
    const session = auth.authenticate(request, method === "POST");
    if (
      session === undefined ||
      (method === "POST" &&
        (!sameOrigin(request) ||
          !auth.csrfMatches(
            session,
            request.headers["x-csrf-token"] as string | undefined,
          )))
    ) {
      sendError(response, 403, "AUTH_REQUIRED", "Authentication required");
      return true;
    }
    const taskId = taskSubtasksMatch[1];
    if (taskId === undefined) {
      sendError(response, 404, "NOT_FOUND", "Task subtask route not found");
      return true;
    }
    if (database.getTask(session.owner.id, taskId) === undefined) {
      sendError(response, 404, "TASK_NOT_FOUND", "Task not found");
      return true;
    }
    if (method === "GET") {
      sendJson(response, 200, {
        subtasks: database
          .listSubtasks(session.owner.id, taskId)
          .map(subtaskResponse),
      });
      return true;
    }
    const input = (await readJson(request)) as {
      title?: unknown;
      position?: unknown;
    };
    if (
      typeof input.title !== "string" ||
      input.title.trim().length === 0 ||
      !Number.isInteger(input.position) ||
      Number(input.position) < 0
    ) {
      sendError(response, 400, "INVALID_SUBTASK", "Subtask input is invalid");
      return true;
    }
    const now = new Date().toISOString();
    const subtask = {
      id: randomUUID(),
      ownerId: session.owner.id,
      taskId,
      title: input.title.trim(),
      completed: false,
      position: Number(input.position),
      revision: 1,
      createdAt: now,
      updatedAt: now,
    };
    database.createSubtask(subtask);
    database.appendSyncChange(
      session.owner.id,
      "subtask",
      subtask.id,
      "upsert",
      1,
      now,
    );
    sendJson(response, 201, { subtask: subtaskResponse(subtask) });
    return true;
  }

  const subtaskMatch = /^\/api\/subtasks\/([0-9a-f-]{36})$/.exec(url.pathname);
  if (subtaskMatch !== null && (method === "PATCH" || method === "DELETE")) {
    const session = auth.authenticate(request, true);
    if (
      session === undefined ||
      !sameOrigin(request) ||
      !auth.csrfMatches(
        session,
        request.headers["x-csrf-token"] as string | undefined,
      )
    ) {
      sendError(response, 403, "CSRF_REQUIRED", "Valid CSRF required");
      return true;
    }
    const revision = expectedRevision(request, response);
    if (revision === undefined) return true;
    const id = subtaskMatch[1];
    if (id === undefined) {
      sendError(response, 404, "NOT_FOUND", "Subtask route not found");
      return true;
    }
    const now = new Date().toISOString();
    if (method === "DELETE") {
      if (!database.deleteSubtask(session.owner.id, id, revision)) {
        sendError(
          response,
          412,
          "SUBTASK_REVISION_CONFLICT",
          "Subtask changed",
        );
        return true;
      }
      database.appendSyncChange(
        session.owner.id,
        "subtask",
        id,
        "deleted",
        revision + 1,
        now,
      );
      sendEmpty(response, 204);
      return true;
    }
    const input = (await readJson(request)) as {
      title?: unknown;
      completed?: unknown;
      position?: unknown;
    };
    const patch = {
      ...(typeof input.title === "string" && input.title.trim().length > 0
        ? { title: input.title.trim() }
        : {}),
      ...(typeof input.completed === "boolean"
        ? { completed: input.completed }
        : {}),
      ...(Number.isInteger(input.position) && Number(input.position) >= 0
        ? { position: Number(input.position) }
        : {}),
    };
    if (Object.keys(patch).length === 0) {
      sendError(response, 400, "INVALID_SUBTASK", "Subtask patch is empty");
      return true;
    }
    const updated = database.updateSubtask(
      session.owner.id,
      id,
      revision,
      patch,
      now,
    );
    if (updated === undefined) {
      sendError(response, 412, "SUBTASK_REVISION_CONFLICT", "Subtask changed");
      return true;
    }
    database.appendSyncChange(
      session.owner.id,
      "subtask",
      id,
      "upsert",
      updated.revision,
      now,
    );
    sendJson(
      response,
      200,
      { subtask: subtaskResponse(updated) },
      {
        ETag: `"${String(updated.revision)}"`,
      },
    );
    return true;
  }

  return false;
};
