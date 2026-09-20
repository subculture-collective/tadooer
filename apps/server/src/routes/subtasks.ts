import { randomUUID } from "node:crypto";
import {
  subtaskCreateRequestSchema,
  subtaskPatchRequestSchema,
  subtaskOrderRequestSchema,
  type ChecklistCommand,
} from "@suite/contracts";
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
  const taskMatch = /^\/api\/tasks\/([0-9a-f-]{36})\/subtasks$/.exec(
    url.pathname,
  );
  const itemMatch = /^\/api\/subtasks\/([0-9a-f-]{36})$/.exec(url.pathname);
  if (!(
    (taskMatch !== null && ["GET", "POST", "PUT"].includes(method)) ||
    (itemMatch !== null && ["PATCH", "DELETE"].includes(method))
  ))
    return false;
  const session = auth.authenticate(request, method !== "GET");
  if (
    session === undefined ||
    (method !== "GET" &&
      (!sameOrigin(request) ||
        !auth.csrfMatches(
          session,
          request.headers["x-csrf-token"] as string | undefined,
        )))
  ) {
    sendError(
      response,
      403,
      "AUTH_REQUIRED",
      "Same-origin session and CSRF token required",
    );
    return true;
  }
  const existing =
    itemMatch?.[1] === undefined
      ? undefined
      : database.getSubtask(session.owner.id, itemMatch[1]);
  const taskId = taskMatch?.[1] ?? existing?.taskId;
  if (
    taskId === undefined ||
    database.getTask(session.owner.id, taskId) === undefined
  ) {
    sendError(
      response,
      itemMatch === null ? 404 : 412,
      itemMatch === null ? "TASK_NOT_FOUND" : "SUBTASK_REVISION_CONFLICT",
      "Task or checklist item is unavailable",
    );
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
  let command: ChecklistCommand;
  if (method === "PUT") {
    const parsed = subtaskOrderRequestSchema.safeParse(await readJson(request));
    if (!parsed.success) {
      sendError(
        response,
        400,
        "INVALID_SUBTASK_ORDER",
        "Checklist order is invalid",
      );
      return true;
    }
    command = { action: "reorder", taskId, items: parsed.data.items };
  } else if (method === "POST") {
    const parsed = subtaskCreateRequestSchema.safeParse(
      await readJson(request),
    );
    if (!parsed.success) {
      sendError(response, 400, "INVALID_SUBTASK", "Subtask input is invalid");
      return true;
    }
    command = { action: "create", taskId, id: randomUUID(), ...parsed.data };
  } else {
    const revision = expectedRevision(request, response);
    if (revision === undefined) return true;
    if (existing === undefined) throw new Error("Checklist item disappeared");
    if (method === "DELETE")
      command = {
        action: "delete",
        taskId,
        id: existing.id,
        expectedRevision: revision,
      };
    else {
      const parsed = subtaskPatchRequestSchema.safeParse(
        await readJson(request),
      );
      if (!parsed.success) {
        sendError(response, 400, "INVALID_SUBTASK", "Subtask patch is invalid");
        return true;
      }
      command = {
        action: "update",
        taskId,
        id: existing.id,
        expectedRevision: revision,
        patch: parsed.data,
      };
    }
  }
  const items = database.mutateChecklist(
    session.owner.id,
    command,
    new Date().toISOString(),
  );
  if (items === undefined) {
    sendError(response, 412, "SUBTASK_REVISION_CONFLICT", "Checklist changed");
    return true;
  }
  if (command.action === "delete") sendEmpty(response, 204);
  else if (command.action === "reorder")
    sendJson(response, 200, { subtasks: items.map(subtaskResponse) });
  else {
    const result = items.find((item) => item.id === command.id);
    if (result === undefined) throw new Error("Checklist result missing");
    sendJson(
      response,
      command.action === "create" ? 201 : 200,
      { subtask: subtaskResponse(result) },
      { ETag: `"${String(result.revision)}"` },
    );
  }
  return true;
};
