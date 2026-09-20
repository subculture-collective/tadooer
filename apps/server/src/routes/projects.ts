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

export const handleProjects: RouteHandler = async (
  request,
  response,
  url,
  ctx,
) => {
  const { stores: database, auth } = ctx;
  const method = request.method ?? "GET";

  if (await handleOrganization(request, response, url, ctx, "project"))
    return true;

  const taskOrganizationMatch = /^\/api\/tasks\/([0-9a-f-]{36})\/project$/.exec(
    url.pathname,
  );
  if (method === "PUT" && taskOrganizationMatch !== null) {
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
      projectId?: unknown;
    };
    const taskId = taskOrganizationMatch[1];
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
      (input.projectId === null ||
        (typeof input.projectId === "string" &&
          /^[0-9a-f-]{36}$/.test(input.projectId))) &&
      database.assignTaskProject(
        session.owner.id,
        taskId,
        input.projectId ?? null,
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
