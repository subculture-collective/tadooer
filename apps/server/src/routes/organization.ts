import { randomUUID } from "node:crypto";
import {
  organizationOrderRequestSchema,
  projectBacklogRequestSchema,
  projectCreateRequestSchema,
  projectPatchRequestSchema,
  tagCreateRequestSchema,
  tagPatchRequestSchema,
} from "@suite/contracts";
import type { ProjectRecord, TagRecord } from "@suite/persistence";
import {
  expectedRevision,
  readJson,
  sameOrigin,
  sendError,
  sendJson,
} from "../http-utils.ts";
import { projectResponse, tagResponse, type RouteContext } from "./shared.ts";
import type { IncomingMessage, ServerResponse } from "node:http";

const sendRecord = (
  response: ServerResponse,
  status: number,
  record: ProjectRecord | TagRecord,
) =>
  sendJson(
    response,
    status,
    "normalizedName" in record
      ? { tag: tagResponse(record) }
      : { project: projectResponse(record) },
    { ETag: `"${String(record.revision)}"` },
  );

export const handleOrganization = async (
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  ctx: RouteContext,
  kind: "project" | "tag",
): Promise<boolean> => {
  const root = kind === "project" ? "/api/projects" : "/api/tags";
  const match = new RegExp(`^${root}/([0-9a-f-]{36})$`).exec(url.pathname);
  const backlogMatch =
    kind === "project"
      ? new RegExp(`^${root}/([0-9a-f-]{36})/backlog$`).exec(url.pathname)
      : null;
  const method = request.method ?? "GET";
  const create = method === "POST" && url.pathname === root;
  const patch = method === "PATCH" && match !== null;
  const read = method === "GET" && url.pathname === root;
  const order = method === "PUT" && url.pathname === `${root}/order`;
  const backlog = method === "PUT" && backlogMatch !== null;
  if (!create && !patch && !read && !order && !backlog) return false;
  const session = ctx.auth.authenticate(request, !read);
  if (session === undefined) {
    sendError(response, 401, "AUTH_REQUIRED", "Authentication required");
    return true;
  }
  if (read) {
    sendJson(
      response,
      200,
      kind === "project"
        ? {
            projects: ctx.stores
              .listProjects(session.owner.id)
              .map(projectResponse),
          }
        : { tags: ctx.stores.listTags(session.owner.id).map(tagResponse) },
    );
    return true;
  }
  if (
    !sameOrigin(request) ||
    !ctx.auth.csrfMatches(
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
  if (order) {
    const parsed = organizationOrderRequestSchema.safeParse(
      await readJson(request),
    );
    if (!parsed.success) {
      sendError(
        response,
        400,
        "INVALID_ORGANIZATION_ORDER",
        "Provide every record once with its current revision",
      );
      return true;
    }
    const records = ctx.stores.reorderOrganization(
      kind,
      session.owner.id,
      parsed.data.items,
      now,
    );
    if (records === undefined) {
      sendError(
        response,
        412,
        "ORGANIZATION_REVISION_CONFLICT",
        "The list changed; reload before reordering",
      );
      return true;
    }
    sendJson(
      response,
      200,
      kind === "project"
        ? {
            projects: records
              .filter((record) => !("normalizedName" in record))
              .map((record) => projectResponse(record as ProjectRecord)),
          }
        : {
            tags: records
              .filter((record) => "normalizedName" in record)
              .map((record) => tagResponse(record)),
          },
    );
    return true;
  }
  const revision = create ? null : expectedRevision(request, response);
  if (revision === undefined) return true;
  if (backlog) {
    const parsed = projectBacklogRequestSchema.safeParse(
      await readJson(request),
    );
    const projectId = backlogMatch[1];
    if (!parsed.success || projectId === undefined || revision === null) {
      sendError(
        response,
        400,
        "INVALID_BACKLOG_MOVE",
        "Provide a task and whether it belongs in the backlog",
      );
      return true;
    }
    const result = ctx.stores.setProjectBacklog(
      session.owner.id,
      projectId,
      revision,
      parsed.data.taskId,
      parsed.data.inBacklog,
      now,
    );
    if (result.kind === "conflict") {
      sendError(
        response,
        412,
        "ORGANIZATION_REVISION_CONFLICT",
        "The project changed; reload before trying again",
      );
      return true;
    }
    if (result.kind !== "applied") {
      sendError(
        response,
        409,
        "BACKLOG_MOVE_INVALID",
        "The task must be an active task of this unarchived project, the backlog must be enabled, and the move must change membership",
      );
      return true;
    }
    sendRecord(response, 200, result.project);
    return true;
  }
  const schema =
    kind === "project"
      ? create
        ? projectCreateRequestSchema
        : projectPatchRequestSchema
      : create
        ? tagCreateRequestSchema
        : tagPatchRequestSchema;
  const parsed = schema.safeParse(await readJson(request));
  if (
    !parsed.success ||
    ("archived" in parsed.data &&
      "completed" in parsed.data &&
      parsed.data.archived !== undefined &&
      parsed.data.completed !== undefined)
  ) {
    sendError(
      response,
      400,
      "INVALID_ORGANIZATION",
      "Provide a valid title, lifecycle change, colour, icon or setting; archive and completion cannot change together",
    );
    return true;
  }
  const id = create ? randomUUID() : match?.[1];
  if (id === undefined) return false;
  let record;
  try {
    record = ctx.stores.mutateOrganization(
      kind,
      session.owner.id,
      id,
      revision,
      parsed.data,
      now,
    );
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !error.message.includes("UNIQUE constraint failed")
    )
      throw error;
    sendError(
      response,
      409,
      "ORGANIZATION_NAME_CONFLICT",
      "Organization change could not be saved; reload and check the name",
    );
    return true;
  }
  if (record === undefined) {
    sendError(
      response,
      412,
      "ORGANIZATION_REVISION_CONFLICT",
      "The record changed; reload before trying again",
    );
    return true;
  }
  sendRecord(response, create ? 201 : 200, record);
  return true;
};
