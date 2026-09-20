import { handleOrganization } from "./organization.ts";
import {
  sendJson,
  sendError,
  readJson,
  sameOrigin,
  expectedRevision,
} from "../http-utils.ts";
import type { RouteHandler } from "./shared.ts";
import { taskResponse } from "./shared.ts";

export const handleTags: RouteHandler = async (request, response, url, ctx) => {
  const { stores: database, auth } = ctx;
  const method = request.method ?? "GET";

  if (await handleOrganization(request, response, url, ctx, "tag")) return true;

  const taskTagsMatch = /^\/api\/tasks\/([0-9a-f-]{36})\/tags$/.exec(
    url.pathname,
  );
  if (method === "PUT" && taskTagsMatch !== null) {
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
    const input = (await readJson(request)) as {
      tagIds?: unknown;
    };
    const taskId = taskTagsMatch[1];
    if (taskId === undefined) {
      sendError(
        response,
        404,
        "NOT_FOUND",
        "Task organization route not found",
      );
      return true;
    }
    const now = new Date().toISOString();
    const result =
      Array.isArray(input.tagIds) &&
      input.tagIds.every(
        (tagId) => typeof tagId === "string" && /^[0-9a-f-]{36}$/.test(tagId),
      ) &&
      database.setTaskTags(
        session.owner.id,
        taskId,
        input.tagIds,
        revision,
        now,
      );
    const task = database.getTask(session.owner.id, taskId);
    if (!result || task === undefined) {
      sendError(
        response,
        409,
        "TASK_ORGANIZATION_CONFLICT",
        "Task, revision, or organization assignment is invalid",
      );
      return true;
    }
    sendJson(
      response,
      200,
      { task: taskResponse(task) },
      {
        ETag: `"${String(task.revision)}"`,
      },
    );
    return true;
  }

  return false;
};
