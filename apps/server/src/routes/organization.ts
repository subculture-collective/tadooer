import { randomUUID } from "node:crypto";
import {
  projectCreateRequestSchema,
  projectPatchRequestSchema,
  tagCreateRequestSchema,
  tagPatchRequestSchema,
} from "@suite/contracts";
import {
  expectedRevision,
  readJson,
  sameOrigin,
  sendError,
  sendJson,
} from "../http-utils.ts";
import { projectResponse, tagResponse, type RouteContext } from "./shared.ts";
import type { IncomingMessage, ServerResponse } from "node:http";

export const handleOrganization = async (
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  ctx: RouteContext,
  kind: "project" | "tag",
): Promise<boolean> => {
  const root = kind === "project" ? "/api/projects" : "/api/tags";
  const match = new RegExp(`^${root}/([0-9a-f-]{36})$`).exec(url.pathname);
  const method = request.method ?? "GET";
  const create = method === "POST" && url.pathname === root;
  const patch = method === "PATCH" && match !== null;
  const read = method === "GET" && url.pathname === root;
  if (!create && !patch && !read) return false;
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
  const revision = create ? null : expectedRevision(request, response);
  if (revision === undefined) return true;
  const schema =
    kind === "project"
      ? create
        ? projectCreateRequestSchema
        : projectPatchRequestSchema
      : create
        ? tagCreateRequestSchema
        : tagPatchRequestSchema;
  const parsed = schema.safeParse(await readJson(request));
  if (!parsed.success) {
    sendError(
      response,
      400,
      "INVALID_ORGANIZATION",
      "Provide a valid title or archive/restore edit",
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
      new Date().toISOString(),
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
  sendJson(
    response,
    create ? 201 : 200,
    "normalizedName" in record
      ? { tag: tagResponse(record) }
      : { project: projectResponse(record) },
    { ETag: `"${String(record.revision)}"` },
  );
  return true;
};
