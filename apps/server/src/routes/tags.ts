import { randomUUID } from "node:crypto";
import {
  sendJson,
  sendError,
  readJson,
  sameOrigin,
  expectedRevision,
} from "../http-utils.ts";
import type { RouteHandler } from "./shared.ts";
import { taskResponse, tagResponse } from "./shared.ts";

export const handleTags: RouteHandler = async (request, response, url, ctx) => {
  const { stores: database, auth } = ctx;
  const method = request.method ?? "GET";

  if (method === "GET" && url.pathname === "/api/tags") {
    const session = auth.authenticate(request, false);
    if (session === undefined) {
      sendError(response, 401, "AUTH_REQUIRED", "Authentication required");
      return true;
    }
    sendJson(response, 200, {
      tags: database.listTags(session.owner.id).map(tagResponse),
    });
    return true;
  }

  if (method === "POST" && url.pathname === "/api/tags") {
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
      input.title.trim().length > 100
    ) {
      sendError(response, 400, "INVALID_ORGANIZATION", "A title is required");
      return true;
    }
    const now = new Date().toISOString();
    const normalizedName = input.title
      .trim()
      .normalize("NFKC")
      .toLocaleLowerCase();
    const tag = {
      id: randomUUID(),
      ownerId: session.owner.id,
      title: input.title.trim(),
      normalizedName,
      revision: 1,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    };
    try {
      database.createTag(tag);
    } catch {
      sendError(
        response,
        409,
        "ORGANIZATION_NAME_CONFLICT",
        "That tag name is already in use",
      );
      return true;
    }
    database.appendSyncChange(
      session.owner.id,
      "tag",
      tag.id,
      "upsert",
      tag.revision,
      now,
    );
    sendJson(response, 201, { tag: tagResponse(tag) });
    return true;
  }

  const tagMatch = /^\/api\/tags\/([0-9a-f-]{36})$/.exec(url.pathname);
  if (method === "PATCH" && tagMatch !== null) {
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
    const id = tagMatch[1];
    if (id === undefined) {
      sendError(response, 404, "NOT_FOUND", "Organization record not found");
      return true;
    }
    let result;
    try {
      result = wantsArchive
        ? database.archiveTag(session.owner.id, id, revision, now)
        : database.renameTag(
            session.owner.id,
            id,
            revision,
            title ?? "",
            (title ?? "").normalize("NFKC").toLocaleLowerCase(),
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
      "tag",
      result.id,
      "upsert",
      result.revision,
      now,
    );
    sendJson(
      response,
      200,
      { tag: tagResponse(result) },
      { ETag: `"${String(result.revision)}"` },
    );
    return true;
  }

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
