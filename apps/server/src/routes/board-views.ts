import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import {
  menuFolderCreateRequestSchema,
  menuFolderOrderRequestSchema,
  menuFolderUpdateRequestSchema,
  sectionContextSchema,
  sectionCreateRequestSchema,
  sectionOrderRequestSchema,
  sectionUpdateRequestSchema,
  taskViewSetRequestSchema,
} from "@suite/contracts";
import type {
  MenuFolderMutationResult,
  SectionMutationResult,
} from "@suite/persistence";
import {
  expectedRevision,
  readJson,
  sameOrigin,
  sendError,
  sendJson,
} from "../http-utils.ts";
import type { RouteHandler } from "./shared.ts";

/**
 * Sections, saved task views and sidebar folders (issue #63, ADR 0028).
 * Online-only HTTP records with revisions.
 *
 * - GET    /api/sections?contextKind=&contextId=   sections of one context
 * - POST   /api/sections                           create in a context
 * - PUT    /api/sections/order                     full-list reorder of a context
 * - PUT    /api/sections/{id}                      rename, collapse or set members
 * - DELETE /api/sections/{id}                      with If-Match
 * - GET    /api/task-views                         every saved view
 * - PUT    /api/task-views                         set one context's view
 * - GET    /api/menu-folders                       every folder
 * - POST   /api/menu-folders                       create
 * - PUT    /api/menu-folders/order                 full-list reorder of one kind
 * - PUT    /api/menu-folders/{id}                  rename, collapse or set items
 * - DELETE /api/menu-folders/{id}                  with If-Match
 */

export const sectionConflictMessage =
  "The section changed; reload before trying again";
export const menuFolderConflictMessage =
  "The folder changed; reload before trying again";

const sendSections = (
  response: ServerResponse,
  result: SectionMutationResult,
  status = 200,
): void => {
  if (result.kind === "conflict")
    sendError(
      response,
      412,
      "SECTION_REVISION_CONFLICT",
      sectionConflictMessage,
    );
  else if (result.kind === "invalid")
    sendError(response, 400, "INVALID_SECTION", result.detail);
  else sendJson(response, status, { sections: result.sections });
};

const sendFolders = (
  response: ServerResponse,
  result: MenuFolderMutationResult,
  status = 200,
): void => {
  if (result.kind === "conflict")
    sendError(
      response,
      412,
      "MENU_FOLDER_REVISION_CONFLICT",
      menuFolderConflictMessage,
    );
  else if (result.kind === "invalid")
    sendError(response, 400, "INVALID_MENU_FOLDER", result.detail);
  else sendJson(response, status, { folders: result.folders });
};

export const handleBoardViews: RouteHandler = async (
  request,
  response,
  url,
  { auth, stores },
) => {
  const method = request.method ?? "GET";
  const match =
    /^\/api\/(sections|task-views|menu-folders)(?:\/(order|[0-9a-f-]{36}))?$/.exec(
      url.pathname,
    );
  if (match === null) return false;
  const kind = match[1] as "sections" | "task-views" | "menu-folders";
  const tail = match[2];
  const list = method === "GET" && tail === undefined;
  const create =
    method === "POST" && tail === undefined && kind !== "task-views";
  const set = method === "PUT" && tail === undefined && kind === "task-views";
  const order = method === "PUT" && tail === "order" && kind !== "task-views";
  const id = tail !== undefined && tail !== "order" ? tail : undefined;
  const update = method === "PUT" && id !== undefined && kind !== "task-views";
  const remove =
    method === "DELETE" && id !== undefined && kind !== "task-views";
  if (!list && !create && !set && !order && !update && !remove) return false;
  const session = auth.authenticate(request, !list);
  if (session === undefined) {
    sendError(response, 401, "AUTH_REQUIRED", "Authentication required");
    return true;
  }
  const ownerId = session.owner.id;
  if (list) {
    if (kind === "task-views")
      sendJson(response, 200, { views: stores.boards.listTaskViews(ownerId) });
    else if (kind === "menu-folders")
      sendJson(response, 200, {
        folders: stores.boards.listMenuFolders(ownerId),
      });
    else {
      const context = sectionContextSchema.safeParse(
        Object.fromEntries(url.searchParams.entries()),
      );
      if (!context.success) {
        sendError(
          response,
          400,
          "INVALID_SECTION_CONTEXT",
          "Provide contextKind (project or tag) and contextId",
        );
        return true;
      }
      sendJson(response, 200, {
        sections: stores.boards.listSections(ownerId, context.data),
      });
    }
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
  const now = new Date().toISOString();
  const body: unknown = await readJson(request).catch(() => undefined);
  if (kind === "task-views") {
    const parsed = taskViewSetRequestSchema.safeParse(body);
    if (!parsed.success) {
      sendError(
        response,
        400,
        "INVALID_TASK_VIEW",
        "Provide the view context, its revision and the sort, group and filter options",
      );
      return true;
    }
    const result = stores.boards.setTaskView(ownerId, parsed.data, now);
    if (result.kind === "conflict")
      sendError(
        response,
        412,
        "TASK_VIEW_REVISION_CONFLICT",
        "The saved view changed; reload before trying again",
      );
    else if (result.kind === "invalid")
      sendError(response, 400, "INVALID_TASK_VIEW", result.detail);
    else sendJson(response, 200, { view: result.view });
    return true;
  }
  if (kind === "sections") {
    if (create) {
      const parsed = sectionCreateRequestSchema.safeParse(body);
      if (!parsed.success) {
        sendError(
          response,
          400,
          "INVALID_SECTION",
          "Provide a project or tag context and a title",
        );
        return true;
      }
      sendSections(
        response,
        stores.boards.createSection(ownerId, parsed.data, randomUUID, now),
        201,
      );
      return true;
    }
    if (order) {
      const parsed = sectionOrderRequestSchema.safeParse(body);
      if (!parsed.success) {
        sendError(
          response,
          400,
          "INVALID_SECTION_ORDER",
          "Provide the context and every section once with its revision",
        );
        return true;
      }
      sendSections(
        response,
        stores.boards.reorderSections(
          ownerId,
          parsed.data,
          parsed.data.items,
          now,
        ),
      );
      return true;
    }
    if (id === undefined) return false;
    if (remove) {
      const revision = expectedRevision(request, response);
      if (revision === undefined) return true;
      sendSections(
        response,
        stores.boards.deleteSection(ownerId, id, revision),
      );
      return true;
    }
    const parsed = sectionUpdateRequestSchema.safeParse(body);
    if (!parsed.success) {
      sendError(
        response,
        400,
        "INVALID_SECTION",
        "Provide the section's revision and a title, expanded state or task list",
      );
      return true;
    }
    sendSections(
      response,
      stores.boards.updateSection(
        ownerId,
        id,
        parsed.data.expectedRevision,
        parsed.data,
        now,
      ),
    );
    return true;
  }
  if (create) {
    const parsed = menuFolderCreateRequestSchema.safeParse(body);
    if (!parsed.success) {
      sendError(
        response,
        400,
        "INVALID_MENU_FOLDER",
        "Provide a folder kind (project or tag), a title and optional items",
      );
      return true;
    }
    sendFolders(
      response,
      stores.boards.createMenuFolder(ownerId, parsed.data, randomUUID, now),
      201,
    );
    return true;
  }
  if (order) {
    const parsed = menuFolderOrderRequestSchema.safeParse(body);
    if (!parsed.success) {
      sendError(
        response,
        400,
        "INVALID_MENU_FOLDER_ORDER",
        "Provide the folder kind and every folder once with its revision",
      );
      return true;
    }
    sendFolders(
      response,
      stores.boards.reorderMenuFolders(
        ownerId,
        parsed.data.kind,
        parsed.data.parentId,
        parsed.data.items,
        now,
      ),
    );
    return true;
  }
  if (id === undefined) return false;
  if (remove) {
    const revision = expectedRevision(request, response);
    if (revision === undefined) return true;
    sendFolders(
      response,
      stores.boards.deleteMenuFolder(ownerId, id, revision),
    );
    return true;
  }
  const parsed = menuFolderUpdateRequestSchema.safeParse(body);
  if (!parsed.success) {
    sendError(
      response,
      400,
      "INVALID_MENU_FOLDER",
      "Provide the folder's revision and a title, expanded state or item list",
    );
    return true;
  }
  sendFolders(
    response,
    stores.boards.updateMenuFolder(
      ownerId,
      id,
      parsed.data.expectedRevision,
      parsed.data,
      now,
    ),
  );
  return true;
};
