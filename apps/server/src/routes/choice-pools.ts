import { randomUUID, createHash } from "node:crypto";
import {
  createChoicePoolRequestSchema,
  updateChoicePoolRequestSchema,
  completeChoicePoolItemRequestSchema,
  createTemplatePoolSlotRequestSchema,
  createPlanningPlaceholderRequestSchema,
  resolvePlanningPlaceholderRequestSchema,
} from "@suite/contracts";
import { suggestChoicePool, validateChoicePoolSelection } from "@suite/domain";
import {
  sendJson,
  sendError,
  readJson,
  sameOrigin,
  expectedRevision,
} from "../http-utils.ts";
import type { RouteHandler } from "./shared.ts";
import {
  choicePoolResponse,
  choicePoolItemResponse,
  choicePoolHistoryResponse,
  planningPlaceholderResponse,
  placeholderResolutionResponse,
  choiceSuggestion,
} from "./shared.ts";

export const handleChoicePools: RouteHandler = async (
  request,
  response,
  url,
  ctx,
) => {
  const { stores: database, auth } = ctx;
  const method = request.method ?? "GET";

  // Only handle pool/placeholder paths, skip other template paths
  if (
    !url.pathname.startsWith("/api/pools") &&
    !url.pathname.startsWith("/api/placeholders") &&
    !url.pathname.startsWith("/api/templates/")
  )
    return false;

  // Handle template pool slots specially (under /api/templates/ but pool-related)
  const slotMatch = /^\/api\/templates\/([0-9a-f-]{36})\/pool-slots$/.exec(
    url.pathname,
  );
  if (method === "POST" && slotMatch !== null) {
    const mutating = true;
    const session = auth.authenticate(request, mutating);
    if (session === undefined) {
      sendError(response, 401, "AUTH_REQUIRED", "Authentication required");
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

    const parsed = createTemplatePoolSlotRequestSchema.safeParse(
      await readJson(request),
    );
    if (!parsed.success) {
      sendError(
        response,
        400,
        "INVALID_TEMPLATE_POOL_SLOT",
        "Template pool slot input is invalid",
      );
      return true;
    }
    const slot = database.createTemplatePoolSlot(session.owner.id, {
      id: randomUUID(),
      templateId: slotMatch[1] ?? "",
      ...parsed.data,
      createdAt: new Date().toISOString(),
    });
    if (slot === undefined) {
      sendError(
        response,
        409,
        "TEMPLATE_POOL_SLOT_INVALID",
        "Template, pool, order, or pick count is invalid",
      );
      return true;
    }
    sendJson(response, 201, slot);
    return true;
  }

  // For other /api/templates/ paths, return false (handled by templates.ts)
  if (url.pathname.startsWith("/api/templates/")) return false;

  // Shared auth/CSRF block for pools and placeholders
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

  // ── GET /api/pools ──────────────────────────────────────────────────────

  if (method === "GET" && url.pathname === "/api/pools") {
    const pools = database.listChoicePools(session.owner.id, true);
    sendJson(response, 200, {
      pools: pools.map(choicePoolResponse),
      items: pools.flatMap((pool) =>
        database.listChoicePoolItems(pool.id, true).map(choicePoolItemResponse),
      ),
      history: pools.flatMap((pool) =>
        database.listChoicePoolHistory(pool.id).map(choicePoolHistoryResponse),
      ),
      placeholders: database
        .listPlanningPlaceholders(session.owner.id)
        .map(planningPlaceholderResponse),
    });
    return true;
  }

  // ── POST /api/pools ─────────────────────────────────────────────────────

  if (method === "POST" && url.pathname === "/api/pools") {
    const parsed = createChoicePoolRequestSchema.safeParse(
      await readJson(request),
    );
    if (!parsed.success || parsed.data.items.length < parsed.data.pickCount) {
      sendError(
        response,
        400,
        "INVALID_CHOICE_POOL",
        "Choice pool input is invalid or has too few items",
      );
      return true;
    }
    const now = new Date().toISOString();
    const poolId = randomUUID();
    const pool = database.createChoicePool(
      {
        id: poolId,
        ownerId: session.owner.id,
        title: parsed.data.title,
        policy: parsed.data.policy,
        pickCount: parsed.data.pickCount,
        cooldownSeconds: parsed.data.cooldownSeconds,
        revision: 1,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
      },
      parsed.data.items.map(({ title }, position) => ({
        id: randomUUID(),
        poolId,
        title,
        position,
        revision: 1,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
      })),
    );
    sendJson(response, 201, {
      pool: choicePoolResponse(pool),
      items: database.listChoicePoolItems(pool.id).map(choicePoolItemResponse),
    });
    return true;
  }

  // ── PATCH /api/pools/:id ────────────────────────────────────────────────

  const poolPatch = /^\/api\/pools\/([0-9a-f-]{36})$/.exec(url.pathname);
  if (method === "PATCH" && poolPatch !== null) {
    const revision = expectedRevision(request, response);
    if (revision === undefined) return true;
    const parsed = updateChoicePoolRequestSchema.safeParse(
      await readJson(request),
    );
    if (!parsed.success) {
      sendError(
        response,
        400,
        "INVALID_CHOICE_POOL",
        "Choice pool update is invalid",
      );
      return true;
    }
    const updated = database.updateChoicePool({
      ownerId: session.owner.id,
      id: poolPatch[1] ?? "",
      expectedRevision: revision,
      title: parsed.data.title,
      policy: parsed.data.policy,
      pickCount: parsed.data.pickCount,
      cooldownSeconds: parsed.data.cooldownSeconds,
      items: parsed.data.items.map((item) => ({
        title: item.title,
        ...(item.id === undefined ? {} : { id: item.id }),
      })),
      now: new Date().toISOString(),
    });
    if (updated === undefined) {
      sendError(
        response,
        412,
        "CHOICE_POOL_STALE",
        "Choice pool changed or is invalid",
      );
      return true;
    }
    sendJson(response, 200, choicePoolResponse(updated), {
      ETag: `"${String(updated.revision)}"`,
    });
    return true;
  }

  // ── POST /api/pools/:id/items/:itemId/completions ───────────────────────

  const completionMatch =
    /^\/api\/pools\/([0-9a-f-]{36})\/items\/([0-9a-f-]{36})\/completions$/.exec(
      url.pathname,
    );
  if (method === "POST" && completionMatch !== null) {
    const parsed = completeChoicePoolItemRequestSchema.safeParse(
      await readJson(request),
    );
    if (!parsed.success) {
      sendError(
        response,
        400,
        "INVALID_POOL_COMPLETION",
        "Completion input is invalid",
      );
      return true;
    }
    const event = database.recordChoicePoolCompletion({
      ownerId: session.owner.id,
      poolId: completionMatch[1] ?? "",
      itemId: completionMatch[2] ?? "",
      placeholderId: parsed.data.placeholderId,
      occurredAt: parsed.data.occurredAt,
    });
    if (event === undefined) {
      sendError(
        response,
        404,
        "POOL_ITEM_NOT_FOUND",
        "Choice Pool item not found",
      );
      return true;
    }
    sendJson(response, 201, choicePoolHistoryResponse(event));
    return true;
  }

  // ── POST /api/placeholders ──────────────────────────────────────────────

  if (method === "POST" && url.pathname === "/api/placeholders") {
    const parsed = createPlanningPlaceholderRequestSchema.safeParse(
      await readJson(request),
    );
    if (!parsed.success) {
      sendError(
        response,
        400,
        "INVALID_PLANNING_PLACEHOLDER",
        "Planning placeholder input is invalid",
      );
      return true;
    }
    const pool = database.getChoicePool(session.owner.id, parsed.data.poolId);
    if (pool === undefined) {
      sendError(
        response,
        404,
        "CHOICE_POOL_NOT_FOUND",
        "Choice pool not found",
      );
      return true;
    }
    const now = new Date().toISOString();
    const placeholder = database.createPlanningPlaceholder({
      id: randomUUID(),
      ownerId: session.owner.id,
      taskId: parsed.data.taskId,
      poolId: pool.id,
      pickCount: parsed.data.pickCount ?? pool.pickCount,
      position: database
        .listPlanningPlaceholders(session.owner.id)
        .filter(({ taskId }) => taskId === parsed.data.taskId).length,
      state: "unresolved",
      revision: 1,
      createdAt: now,
      updatedAt: now,
      resolvedAt: null,
    });
    if (placeholder === undefined) {
      sendError(
        response,
        409,
        "PLACEHOLDER_RESOURCE_INVALID",
        "Task, pool, or pick count is invalid",
      );
      return true;
    }
    sendJson(response, 201, planningPlaceholderResponse(placeholder));
    return true;
  }

  // ── GET /api/placeholders/:id/suggestion ────────────────────────────────

  const suggestionMatch =
    /^\/api\/placeholders\/([0-9a-f-]{36})\/suggestion$/.exec(url.pathname);
  if (method === "GET" && suggestionMatch !== null) {
    const placeholder = database.getPlanningPlaceholder(
      session.owner.id,
      suggestionMatch[1] ?? "",
    );
    const logicalTime = url.searchParams.get("at") ?? new Date().toISOString();
    if (
      placeholder === undefined ||
      !Number.isFinite(Date.parse(logicalTime))
    ) {
      sendError(
        response,
        placeholder === undefined ? 404 : 400,
        placeholder === undefined
          ? "PLANNING_PLACEHOLDER_NOT_FOUND"
          : "INVALID_LOGICAL_TIME",
        "Placeholder or logical time is invalid",
      );
      return true;
    }
    const evaluated = choiceSuggestion(
      database,
      session.owner.id,
      placeholder.poolId,
      logicalTime,
    );
    if (evaluated === undefined)
      throw new Error("Placeholder pool could not be evaluated");
    const suggestion = suggestChoicePool(
      {
        policy: evaluated.pool.policy,
        pickCount: placeholder.pickCount,
        cooldownSeconds: evaluated.pool.cooldownSeconds,
      },
      evaluated.items.map(({ id, position, archivedAt }) => ({
        id,
        position,
        archived: archivedAt !== null,
      })),
      evaluated.history,
      logicalTime,
    );
    sendJson(response, 200, {
      pool: choicePoolResponse(evaluated.pool),
      selectedItemIds: [...suggestion.selectedItemIds],
      cycle: suggestion.cycle,
      eligibility: suggestion.eligibility,
      logicalTime,
    });
    return true;
  }

  // ── POST /api/placeholders/:id/resolve ──────────────────────────────────

  const resolutionMatch =
    /^\/api\/placeholders\/([0-9a-f-]{36})\/resolve$/.exec(url.pathname);
  if (method === "POST" && resolutionMatch !== null) {
    const parsed = resolvePlanningPlaceholderRequestSchema.safeParse(
      await readJson(request),
    );
    const placeholderId = resolutionMatch[1] ?? "";
    const placeholder = database.getPlanningPlaceholder(
      session.owner.id,
      placeholderId,
    );
    if (!parsed.success || placeholder === undefined) {
      sendError(
        response,
        placeholder === undefined ? 404 : 400,
        placeholder === undefined
          ? "PLANNING_PLACEHOLDER_NOT_FOUND"
          : "INVALID_PLACEHOLDER_RESOLUTION",
        "Placeholder resolution input is invalid",
      );
      return true;
    }
    const requestHash = createHash("sha256")
      .update(
        JSON.stringify({
          selectedItemIds: parsed.data.selectedItemIds,
          logicalTime: parsed.data.logicalTime,
          override: parsed.data.override,
        }),
      )
      .digest("hex");
    if (placeholder.state === "resolved") {
      const replay = database.resolvePlanningPlaceholderIdempotently({
        ownerId: session.owner.id,
        placeholderId,
        expectedRevision: parsed.data.expectedRevision,
        selectedItemIds: parsed.data.selectedItemIds,
        logicalTime: parsed.data.logicalTime,
        cycle: 1,
        overridden: parsed.data.override,
        idempotencyKey: parsed.data.idempotencyKey,
        requestHash,
        now: new Date().toISOString(),
      });
      if (replay.kind === "replayed") {
        sendJson(response, 200, placeholderResolutionResponse(replay));
        return true;
      }
      sendError(
        response,
        replay.kind === "conflict" ? 409 : 412,
        replay.kind === "conflict"
          ? "IDEMPOTENCY_CONFLICT"
          : "PLANNING_PLACEHOLDER_STALE",
        "Placeholder was already resolved",
      );
      return true;
    }
    const evaluated = choiceSuggestion(
      database,
      session.owner.id,
      placeholder.poolId,
      parsed.data.logicalTime,
    );
    if (evaluated === undefined)
      throw new Error("Placeholder pool could not be evaluated");
    const selection = validateChoicePoolSelection(
      {
        policy: evaluated.pool.policy,
        pickCount: placeholder.pickCount,
        cooldownSeconds: evaluated.pool.cooldownSeconds,
      },
      evaluated.items.map(({ id, position, archivedAt }) => ({
        id,
        position,
        archived: archivedAt !== null,
      })),
      evaluated.history,
      parsed.data.logicalTime,
      parsed.data.selectedItemIds,
      parsed.data.override,
    );
    if (!selection.valid) {
      sendError(
        response,
        409,
        "POOL_ITEM_INELIGIBLE",
        `Selection is unavailable: ${selection.reason ?? "unknown"}`,
      );
      return true;
    }
    const result = database.resolvePlanningPlaceholderIdempotently({
      ownerId: session.owner.id,
      placeholderId,
      expectedRevision: parsed.data.expectedRevision,
      selectedItemIds: parsed.data.selectedItemIds,
      logicalTime: parsed.data.logicalTime,
      cycle: selection.cycle,
      overridden: parsed.data.override,
      idempotencyKey: parsed.data.idempotencyKey,
      requestHash,
      now: new Date().toISOString(),
    });
    if (result.kind === "conflict" || result.kind === "stale") {
      sendError(
        response,
        result.kind === "stale" ? 412 : 409,
        result.kind === "stale"
          ? "PLANNING_PLACEHOLDER_STALE"
          : "IDEMPOTENCY_CONFLICT",
        "Placeholder resolution conflicted",
      );
      return true;
    }
    if (result.kind === "not-found") {
      sendError(
        response,
        404,
        "PLANNING_PLACEHOLDER_NOT_FOUND",
        "Placeholder not found",
      );
      return true;
    }
    sendJson(
      response,
      result.kind === "created" ? 201 : 200,
      placeholderResolutionResponse(result),
    );
    return true;
  }

  return false;
};
