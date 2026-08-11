import { randomUUID } from "node:crypto";
import { sendJson, sendError, readJson, sameOrigin, expectedRevision } from "../http-utils.ts";
import type { RouteHandler } from "./shared.ts";
import { projectResponse, taskResponse } from "./shared.ts";

export const handleProjects: RouteHandler = async (request, response, url, ctx) => {
  const { stores: database, auth } = ctx;
  const method = request.method ?? "GET";

  if (
    method === "GET" &&
    url.pathname === "/api/projects"
  ) {
    const session = auth.authenticate(request, false);
    if (session === undefined) {
      sendError(
        response,
        401,
        "AUTH_REQUIRED",
        "Authentication required",
      );
      return true;
    }
    sendJson(
      response,
      200,
      {
        projects: database
          .listProjects(session.owner.id)
          .map(projectResponse),
      },
    );
    return true;
  }

  if (
    method === "POST" &&
    url.pathname === "/api/projects"
  ) {
    const session = auth.authenticate(request, true);
    if (
      session === undefined ||
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
    const input = (await readJson(request)) as {
      title?: unknown;
    };
    if (
      typeof input.title !== "string" ||
      input.title.trim().length === 0 ||
      input.title.trim().length > 240
    ) {
      sendError(
        response,
        400,
        "INVALID_ORGANIZATION",
        "A title is required",
      );
      return true;
    }
    const now = new Date().toISOString();
    const project = {
      id: randomUUID(),
      ownerId: session.owner.id,
      title: input.title.trim(),
      revision: 1,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    };
    database.createProject(project);
    database.appendSyncChange(
      session.owner.id,
      "project",
      project.id,
      "upsert",
      project.revision,
      now,
    );
    sendJson(response, 201, { project: projectResponse(project) });
    return true;
  }

  const organizationMatch =
    /^\/api\/projects\/([0-9a-f-]{36})$/.exec(url.pathname);
  if (method === "PATCH" && organizationMatch !== null) {
    const session = auth.authenticate(request, true);
    if (
      session === undefined ||
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
    const revision = expectedRevision(request, response);
    if (revision === undefined) return true;
    const input = (await readJson(request)) as {
      title?: unknown;
      archived?: unknown;
    };
    const wantsArchive = input.archived === true;
    const title =
      typeof input.title === "string" ? input.title.trim() : undefined;
    if ((!wantsArchive && !title) || input.archived === false) {
      sendError(
        response,
        400,
        "INVALID_ORGANIZATION",
        "Provide a title or archive the record",
      );
      return true;
    }
    const now = new Date().toISOString();
    const id = organizationMatch[1];
    if (id === undefined) {
      sendError(
        response,
        404,
        "NOT_FOUND",
        "Organization record not found",
      );
      return true;
    }
    let result;
    try {
      result = wantsArchive
        ? database.archiveProject(session.owner.id, id, revision, now)
        : database.renameProject(
            session.owner.id,
            id,
            revision,
            title ?? "",
            now,
          );
    } catch {
      sendError(
        response,
        409,
        "ORGANIZATION_NAME_CONFLICT",
        "That name is already in use",
      );
      return true;
    }
    if (result === undefined) {
      sendError(
        response,
        412,
        "ORGANIZATION_REVISION_CONFLICT",
        "The record changed; reload it before trying again",
      );
      return true;
    }
    database.appendSyncChange(
      session.owner.id,
      "project",
      result.id,
      "upsert",
      result.revision,
      now,
    );
    sendJson(
      response,
      200,
      { project: projectResponse(result) },
      { ETag: `"${String(result.revision)}"` },
    );
    return true;
  }

  const taskOrganizationMatch =
    /^\/api\/tasks\/([0-9a-f-]{36})\/project$/.exec(url.pathname);
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
