import { randomUUID, createHash } from "node:crypto";
import {
  createTaskTemplateRequestSchema,
  createTaskTemplateFromTaskRequestSchema,
  taskTemplatePatchRequestSchema,
  createTemplateSetRequestSchema,
  instantiateTemplateRequestSchema,
  idempotencyKeySchema,
  templateSearchRequestSchema,
} from "@suite/contracts";
import { sendJson, sendError, readJson, sameOrigin, expectedRevision } from "../http-utils.ts";
import type { RouteHandler } from "./shared.ts";
import {
  templateResponse,
  templateBlueprintResponse,
  templateSetResponse,
  templateInstantiationResponse,
} from "./shared.ts";

export const handleTemplates: RouteHandler = async (request, response, url, ctx) => {
  const { stores: database, auth } = ctx;
  const method = request.method ?? "GET";

  // Only handle template and template-set paths; skip pools and placeholders
  if (
    url.pathname !== "/api/templates" &&
    !url.pathname.startsWith("/api/templates/") &&
    url.pathname !== "/api/template-sets" &&
    !url.pathname.startsWith("/api/template-sets/")
  )
    return false;

  // Shared auth/CSRF block (originally lines 3116-3142, shared across templates, pools, placeholders)
  const mutating = method !== "GET";
  const session = auth.authenticate(request, mutating);
  if (session === undefined) {
    sendError(response, 401, "AUTH_REQUIRED", "Authentication required");
    return true;
  }
  if (
    mutating &&
    (!sameOrigin(request) ||
      !auth.csrfMatches(
        session,
        request.headers["x-csrf-token"] as string | undefined,
      ))
  ) {
    sendError(
      response,
      403,
      "CSRF_REQUIRED",
      "Same-origin session and CSRF token required",
    );
    return true;
  }

  // ── GET /api/templates ────────────────────────────────────────────────

  if (method === "GET" && url.pathname === "/api/templates") {
    const search = templateSearchRequestSchema.safeParse({
      query: url.searchParams.get("query") ?? "",
      includeArchived:
        url.searchParams.get("includeArchived") === "true",
    });
    if (!search.success) {
      sendError(
        response,
        400,
        "INVALID_TEMPLATE_SEARCH",
        "Template search is invalid",
      );
      return true;
    }
    const templates = database.listTaskTemplates(
      session.owner.id,
      search.data.query,
      search.data.includeArchived,
    );
    sendJson(response, 200, {
      templates: templates.map(templateResponse),
      blueprints: templates.flatMap((template) =>
        database
          .listTemplateSubtaskBlueprints(template.id)
          .map(templateBlueprintResponse),
      ),
      provenance: database.listTaskTemplateProvenance(session.owner.id),
      poolSlots: templates.flatMap((template) =>
        database.listTemplatePoolSlots(template.id),
      ),
    });
    return true;
  }

  // ── POST /api/templates ───────────────────────────────────────────────

  if (method === "POST" && url.pathname === "/api/templates") {
    const parsed = createTaskTemplateRequestSchema.safeParse(
      await readJson(request),
    );
    if (!parsed.success) {
      sendError(
        response,
        400,
        "INVALID_TEMPLATE",
        "Task template input is invalid",
      );
      return true;
    }
    const now = new Date().toISOString();
    try {
      const template = database.createTaskTemplate({
        id: randomUUID(),
        ownerId: session.owner.id,
        title: parsed.data.title,
        notes: parsed.data.notes,
        estimateMinutes: parsed.data.estimateMinutes,
        suggestedProjectId: parsed.data.suggestedProjectId,
        tagIds: parsed.data.tagIds,
        revision: 1,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        blueprints: parsed.data.subtasks.map((subtask, position) => ({
          id: randomUUID(),
          title: subtask.title,
          position,
          revision: 1,
          createdAt: now,
          updatedAt: now,
        })),
      });
      sendJson(response, 201, templateResponse(template), {
        ETag: `"${String(template.revision)}"`,
      });
    } catch {
      sendError(
        response,
        400,
        "INVALID_TEMPLATE_REFERENCES",
        "Template project or tags are unavailable",
      );
    }
    return true;
  }

  // ── POST /api/templates/from-task/:id ─────────────────────────────────

  const fromTask =
    /^\/api\/templates\/from-task\/([0-9a-f-]{36})$/.exec(url.pathname);
  if (method === "POST" && fromTask !== null) {
    const taskId = fromTask[1] ?? "";
    const parsed = createTaskTemplateFromTaskRequestSchema.safeParse(
      await readJson(request),
    );
    if (!parsed.success || parsed.data.taskId !== taskId) {
      sendError(
        response,
        400,
        "INVALID_TEMPLATE_SOURCE",
        "Template source task is invalid",
      );
      return true;
    }
    const now = new Date().toISOString();
    const task = database.getTask(session.owner.id, taskId);
    if (task === undefined) {
      sendError(response, 404, "TASK_NOT_FOUND", "Task not found");
      return true;
    }
    const created = database.createTaskTemplateFromTask(
      session.owner.id,
      taskId,
      {
        id: randomUUID(),
        ownerId: session.owner.id,
        title: task.title,
        notes: task.notes,
        estimateMinutes: task.estimateMinutes,
        suggestedProjectId: task.projectId ?? null,
        revision: 1,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        blueprints: database
          .listSubtasks(session.owner.id, taskId)
          .map((subtask, position) => ({
            id: randomUUID(),
            title: subtask.title,
            position,
            revision: 1,
            createdAt: now,
            updatedAt: now,
          })),
      },
    );
    if (created === undefined) {
      sendError(response, 404, "TASK_NOT_FOUND", "Task not found");
      return true;
    }
    sendJson(response, 201, templateResponse(created), {
      ETag: `"${String(created.revision)}"`,
    });
    return true;
  }

  // ── POST /api/templates/:id/archive ───────────────────────────────────

  const templateArchive =
    /^\/api\/templates\/([0-9a-f-]{36})\/archive$/.exec(url.pathname);
  if (method === "POST" && templateArchive !== null) {
    const revision = expectedRevision(request, response);
    if (revision === undefined) return true;
    const archived = database.archiveTaskTemplate(
      session.owner.id,
      templateArchive[1] ?? "",
      revision,
      new Date().toISOString(),
    );
    if (archived === undefined) {
      sendError(
        response,
        412,
        "TEMPLATE_REVISION_CONFLICT",
        "Template changed or was archived",
      );
      return true;
    }
    sendJson(response, 200, templateResponse(archived), {
      ETag: `"${String(archived.revision)}"`,
    });
    return true;
  }

  // ── PATCH /api/templates/:id ──────────────────────────────────────────

  const templateItem = /^\/api\/templates\/([0-9a-f-]{36})$/.exec(
    url.pathname,
  );
  if (method === "PATCH" && templateItem !== null) {
    const revision = expectedRevision(request, response);
    if (revision === undefined) return true;
    const patch = taskTemplatePatchRequestSchema.safeParse(
      await readJson(request),
    );
    const current = database.getTaskTemplate(
      session.owner.id,
      templateItem[1] ?? "",
    );
    if (!patch.success || current === undefined) {
      sendError(
        response,
        current === undefined ? 404 : 400,
        current === undefined
          ? "TEMPLATE_NOT_FOUND"
          : "INVALID_TEMPLATE",
        current === undefined
          ? "Task template not found"
          : "Task template input is invalid",
      );
      return true;
    }
    const now = new Date().toISOString();
    const existingBlueprints = database.listTemplateSubtaskBlueprints(
      current.id,
    );
    const updated = database.updateTaskTemplate({
      ownerId: session.owner.id,
      id: current.id,
      expectedRevision: revision,
      title: patch.data.title ?? current.title,
      notes: patch.data.notes ?? current.notes,
      estimateMinutes:
        "estimateMinutes" in patch.data
          ? (patch.data.estimateMinutes ?? null)
          : current.estimateMinutes,
      suggestedProjectId:
        "suggestedProjectId" in patch.data
          ? (patch.data.suggestedProjectId ?? null)
          : current.suggestedProjectId,
      tagIds: patch.data.tagIds ?? current.tagIds,
      blueprints:
        patch.data.subtasks === undefined
          ? existingBlueprints.map((blueprint) => ({
              id: blueprint.id,
              title: blueprint.title,
              position: blueprint.position,
              revision: blueprint.revision,
              createdAt: blueprint.createdAt,
              updatedAt: blueprint.updatedAt,
            }))
          : patch.data.subtasks.map((subtask, position) => ({
              id: randomUUID(),
              title: subtask.title,
              position,
              revision: 1,
              createdAt: now,
              updatedAt: now,
            })),
      now,
    });
    if (updated === undefined) {
      sendError(
        response,
        412,
        "TEMPLATE_REVISION_CONFLICT",
        "Template changed or references are unavailable",
      );
      return true;
    }
    sendJson(response, 200, templateResponse(updated), {
      ETag: `"${String(updated.revision)}"`,
    });
    return true;
  }

  // ── POST /api/templates/:id/instantiate ───────────────────────────────
  // ── POST /api/template-sets/:id/instantiate ────────────────────────────

  const templateInstantiation =
    /^\/api\/templates\/([0-9a-f-]{36})\/instantiate$/.exec(
      url.pathname,
    );
  const setInstantiation =
    /^\/api\/template-sets\/([0-9a-f-]{36})\/instantiate$/.exec(
      url.pathname,
    );
  if (
    method === "POST" &&
    (templateInstantiation !== null || setInstantiation !== null)
  ) {
    const parsed = instantiateTemplateRequestSchema.safeParse(
      await readJson(request),
    );
    const rawHeaderKey = request.headers["idempotency-key"];
    const headerKey =
      rawHeaderKey === undefined
        ? undefined
        : idempotencyKeySchema.safeParse(rawHeaderKey);
    if (
      !parsed.success ||
      (headerKey !== undefined &&
        (!headerKey.success ||
          headerKey.data !== parsed.data.idempotencyKey))
    ) {
      sendError(
        response,
        400,
        "INVALID_TEMPLATE_INSTANTIATION",
        "Destination and matching idempotency key are required",
      );
      return true;
    }
    const sourceId =
      templateInstantiation?.[1] ?? setInstantiation?.[1] ?? "";
    const requestHash = createHash("sha256")
      .update(
        JSON.stringify({
          sourceId,
          destinationProjectId: parsed.data.destinationProjectId,
          sourceKind:
            templateInstantiation === null ? "set" : "template",
        }),
      )
      .digest("hex");
    const result =
      templateInstantiation !== null
        ? database.instantiateTemplateIdempotently({
            ownerId: session.owner.id,
            templateId: sourceId,
            destinationProjectId: parsed.data.destinationProjectId,
            idempotencyKey: parsed.data.idempotencyKey,
            requestHash,
            now: new Date().toISOString(),
          })
        : database.instantiateTemplateSetIdempotently({
            ownerId: session.owner.id,
            setId: sourceId,
            destinationProjectId: parsed.data.destinationProjectId,
            idempotencyKey: parsed.data.idempotencyKey,
            requestHash,
            now: new Date().toISOString(),
          });
    if (result.kind === "conflict") {
      sendError(
        response,
        409,
        "IDEMPOTENCY_CONFLICT",
        "Idempotency key was used for another instantiation",
      );
      return true;
    }
    if (result.kind === "project-not-found") {
      sendError(
        response,
        404,
        "PROJECT_NOT_FOUND",
        "Destination project not found",
      );
      return true;
    }
    if (result.kind === "not-found") {
      sendError(
        response,
        404,
        templateInstantiation === null
          ? "TEMPLATE_SET_NOT_FOUND"
          : "TEMPLATE_NOT_FOUND",
        "Reusable work source not found",
      );
      return true;
    }
    const body = templateInstantiationResponse(result);
    sendJson(response, result.kind === "created" ? 201 : 200, body);
    return true;
  }

  // ── GET /api/template-sets ────────────────────────────────────────────

  if (method === "GET" && url.pathname === "/api/template-sets") {
    const sets = database.listTemplateSets(session.owner.id);
    sendJson(response, 200, {
      sets: sets.map(templateSetResponse),
      members: sets.flatMap((set) =>
        database.listTemplateSetMembers(set.id),
      ),
    });
    return true;
  }

  // ── POST /api/template-sets ───────────────────────────────────────────

  if (method === "POST" && url.pathname === "/api/template-sets") {
    const parsed = createTemplateSetRequestSchema.safeParse(
      await readJson(request),
    );
    if (!parsed.success) {
      sendError(
        response,
        400,
        "INVALID_TEMPLATE_SET",
        "Template set input is invalid",
      );
      return true;
    }
    const now = new Date().toISOString();
    const set = {
      id: randomUUID(),
      ownerId: session.owner.id,
      title: parsed.data.title,
      revision: 1,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    };
    try {
      database.createTemplateSet(
        set,
        parsed.data.templateIds.map((templateId, position) => ({
          setId: set.id,
          templateId,
          position,
        })),
      );
    } catch {
      sendError(
        response,
        400,
        "INVALID_TEMPLATE_SET_MEMBERS",
        "Template set members must be active owner templates",
      );
      return true;
    }
    sendJson(response, 201, templateSetResponse(set), {
      ETag: `"${String(set.revision)}"`,
    });
    return true;
  }

  // ── Fallback ──────────────────────────────────────────────────────────

  sendError(response, 405, "METHOD_NOT_ALLOWED", "Method not allowed");
  return true;
};
