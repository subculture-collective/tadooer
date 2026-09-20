import { StructuredCaptureError } from "@suite/domain";
import { createCapturedTask, resolveTaskCapture } from "../task-capture.ts";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  AutomationConfirmationResponse,
  AutomationTokenScope,
} from "@suite/contracts";
import {
  createAutomationTokenRequestSchema,
  automationPreviewCommandSchema,
  automationConfirmRequestSchema,
  automationFocusCommandInputSchema,
  plannerWindowSchema,
  templateSearchRequestSchema,
} from "@suite/contracts";
import type { CalendarEventResource } from "@suite/caldav";
import type { CalendarOperationResult } from "../connector.ts";
import {
  createActiveSession,
  transitionActiveSession,
  observeActiveSession,
  type ActiveSession,
  validateChoicePoolSelection,
} from "@suite/domain";
import { sendJson, sendError, readJson, sameOrigin } from "../http-utils.ts";
import type { RouteHandler } from "./shared.ts";
import type { SuiteDatabase } from "@suite/persistence";
import {
  automationTokenResponse,
  automationScopeFor,
  automationPreviewPath,
  automationConfirmPath,
  automationResourceEntries,
  sendEmpty,
  taskResponse,
  projectResponse,
  tagResponse,
  calendarEventResponse,
  templateResponse,
  templateBlueprintResponse,
  templateSetResponse,
  choicePoolResponse,
  choicePoolItemResponse,
  choicePoolHistoryResponse,
  planningPlaceholderResponse,
  placeholderResolutionResponse,
  templateInstantiationResponse,
  choiceSuggestion,
  activeFromRecord,
  recordFromActive,
  intervalsFromActive,
  eventsFromActive,
  activeResponse,
} from "./shared.ts";

function authenticateAutomation(
  request: IncomingMessage,
  response: ServerResponse,
  database: SuiteDatabase,
  scope?: AutomationTokenScope,
) {
  if (request.headers.origin !== undefined) {
    sendError(
      response,
      403,
      "AUTOMATION_ORIGIN_FORBIDDEN",
      "Automation requests cannot carry a browser Origin",
    );
    return undefined;
  }
  const authorization = request.headers.authorization;
  const match = /^Bearer (suite_at_([0-9a-f-]{36})\.([A-Za-z0-9_-]{43}))$/.exec(
    authorization ?? "",
  );
  if (match === null) {
    sendError(
      response,
      401,
      "AUTOMATION_AUTH_REQUIRED",
      "Valid automation bearer credential required",
    );
    return undefined;
  }
  const tokenId = match[2] ?? "";
  const secret = match[3] ?? "";
  const token = database.authenticateAutomationToken(
    tokenId,
    createHash("sha256").update(secret).digest("base64url"),
    new Date().toISOString(),
  );
  if (token === undefined) {
    sendError(
      response,
      401,
      "AUTOMATION_TOKEN_INVALID",
      "Automation credential is expired, revoked, or invalid",
    );
    return undefined;
  }
  if (scope !== undefined && !token.scopes.includes(scope)) {
    database.appendAutomationAudit({
      id: randomUUID(),
      ownerId: token.ownerId,
      tokenId: token.id,
      operation: scope,
      phase: "resource_read",
      outcome: "denied",
      errorCode: "AUTOMATION_SCOPE_DENIED",
      previewId: null,
      affectedIds: [],
      requestHash: null,
      createdAt: new Date().toISOString(),
    });
    sendError(
      response,
      403,
      "AUTOMATION_SCOPE_DENIED",
      `Automation scope ${scope} is required`,
    );
    return undefined;
  }
  return token;
}

export const handleAutomation: RouteHandler = async (
  request,
  response,
  url,
  ctx,
) => {
  const { stores: database, auth, baikal: connector, sessionClock } = ctx;
  const method = request.method ?? "GET";

  // GET/POST /api/automation/tokens
  if (url.pathname === "/api/automation/tokens") {
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
        method === "GET" ? 401 : 403,
        "AUTH_REQUIRED",
        "Owner session required",
      );
      return true;
    }
    if (method === "GET") {
      sendJson(response, 200, {
        tokens: database
          .listAutomationTokens(session.owner.id)
          .map(automationTokenResponse),
      });
      return true;
    }
    if (method === "POST") {
      const parsed = createAutomationTokenRequestSchema.safeParse(
        await readJson(request),
      );
      const now = new Date();
      if (
        !parsed.success ||
        Date.parse(parsed.data.expiresAt) <= now.getTime() ||
        Date.parse(parsed.data.expiresAt) >
          now.getTime() + 366 * 24 * 60 * 60 * 1000
      ) {
        sendError(
          response,
          400,
          "INVALID_AUTOMATION_TOKEN",
          "Token input or expiry is invalid",
        );
        return true;
      }
      const id = randomUUID();
      const secret = randomBytes(32).toString("base64url");
      const createdAt = now.toISOString();
      const record = {
        id,
        ownerId: session.owner.id,
        label: parsed.data.label,
        secretHash: createHash("sha256").update(secret).digest("base64url"),
        scopes: parsed.data.scopes,
        createdAt,
        lastUsedAt: null,
        expiresAt: parsed.data.expiresAt,
        revokedAt: null,
      };
      // The compatibility controller row has an unrecoverable random
      // proof and is created atomically with the separately authorized
      // automation token. It exists only for Phase 2 interval FKs.
      database.createAutomationTokenWithController(
        record,
        createHash("sha256").update(randomBytes(32)).digest("base64url"),
      );
      sendJson(response, 201, {
        token: `suite_at_${id}.${secret}`,
        record: automationTokenResponse(record),
      });
      return true;
    }
    sendError(response, 405, "METHOD_NOT_ALLOWED", "Method not allowed");
    return true;
  }

  // GET /api/automation/audit
  if (method === "GET" && url.pathname === "/api/automation/audit") {
    const session = auth.authenticate(request, false);
    if (session === undefined) {
      sendError(response, 401, "AUTH_REQUIRED", "Owner session required");
      return true;
    }
    sendJson(response, 200, {
      entries: database.listAutomationAudit(session.owner.id),
    });
    return true;
  }

  // DELETE /api/automation/tokens/:id
  const automationTokenRevoke =
    /^\/api\/automation\/tokens\/([0-9a-f-]{36})$/.exec(url.pathname);
  if (automationTokenRevoke !== null && method === "DELETE") {
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
        "AUTH_REQUIRED",
        "Owner session and CSRF required",
      );
      return true;
    }
    const tokenId = automationTokenRevoke[1] ?? "";
    if (
      !database.revokeAutomationToken(
        session.owner.id,
        tokenId,
        new Date().toISOString(),
      )
    ) {
      sendError(
        response,
        404,
        "AUTOMATION_TOKEN_NOT_FOUND",
        "Automation token not found",
      );
      return true;
    }
    sendEmpty(response, 204);
    return true;
  }

  // GET /api/automation/v1/resources/*
  const automationResource = automationResourceEntries.find(
    ({ apiPath }) => apiPath === url.pathname,
  );
  if (automationResource !== undefined && method === "GET") {
    const resource = automationResource.id;
    const scope = automationResource.scopes[0];
    const token = authenticateAutomation(request, response, database, scope);
    if (token === undefined) return true;
    let body: unknown;
    if (resource === "habits.list")
      body = {
        habits: database.habits.list(token.ownerId),
        occurrences: database.habits.occurrences(token.ownerId),
      };
    else if (resource === "tasks.list")
      body = {
        tasks: database.listTasks(token.ownerId).map(taskResponse),
      };
    else if (resource === "projects.list")
      body = {
        projects: database.listProjects(token.ownerId).map(projectResponse),
      };
    else if (resource === "tags.list")
      body = { tags: database.listTags(token.ownerId).map(tagResponse) };
    else if (resource === "templates.list") {
      const query = templateSearchRequestSchema.safeParse({
        query: url.searchParams.get("query") ?? "",
        includeArchived: url.searchParams.get("includeArchived") === "true",
      });
      if (!query.success) {
        sendError(
          response,
          400,
          "INVALID_TEMPLATE_SEARCH",
          "Template search is invalid",
        );
        return true;
      }
      const templates = database.listTaskTemplates(
        token.ownerId,
        query.data.query,
        query.data.includeArchived,
      );
      body = {
        templates: templates.map(templateResponse),
        blueprints: templates.flatMap((template) =>
          database
            .listTemplateSubtaskBlueprints(template.id)
            .map(templateBlueprintResponse),
        ),
        // A templates-only automation credential does not implicitly
        // gain task-identity metadata through provenance.
        provenance: [],
        poolSlots: templates.flatMap((template) =>
          database.listTemplatePoolSlots(template.id),
        ),
      };
    } else if (resource === "template-sets.list") {
      const sets = database.listTemplateSets(token.ownerId);
      body = {
        sets: sets.map(templateSetResponse),
        members: sets.flatMap((set) => database.listTemplateSetMembers(set.id)),
      };
    } else if (resource === "pools.list") {
      const pools = database.listChoicePools(token.ownerId, true);
      body = {
        pools: pools.map(choicePoolResponse),
        items: pools.flatMap((pool) =>
          database
            .listChoicePoolItems(pool.id, true)
            .map(choicePoolItemResponse),
        ),
        history: pools.flatMap((pool) =>
          database
            .listChoicePoolHistory(pool.id)
            .map(choicePoolHistoryResponse),
        ),
        placeholders: database
          .listPlanningPlaceholders(token.ownerId)
          .map(planningPlaceholderResponse),
      };
    } else if (resource === "active-session.get") {
      const stored = database.getActiveSession(token.ownerId);
      body = {
        session:
          stored === undefined
            ? null
            : activeResponse(
                observeActiveSession(
                  activeFromRecord(stored, database),
                  sessionClock,
                ),
              ),
      };
    } else {
      const window = plannerWindowSchema.safeParse({
        from: url.searchParams.get("from"),
        to: url.searchParams.get("to"),
      });
      if (!window.success) {
        sendError(
          response,
          400,
          "INVALID_PLANNER_WINDOW",
          "A valid schedule window is required",
        );
        return true;
      }
      const events = database.listCalendarEvents(
        token.ownerId,
        window.data.from,
        window.data.to,
      );
      body = {
        window: window.data,
        tasks: database.listTasks(token.ownerId).map(taskResponse),
        events: events.map(calendarEventResponse),
        freshness: {
          state:
            events.length === 0 ? ("unavailable" as const) : ("stale" as const),
          projectedAt: events[0]?.projectedAt ?? null,
          message:
            events.length === 0
              ? "Calendar projection is unavailable"
              : "Showing the last safe calendar projection",
        },
      };
    }
    database.appendAutomationAudit({
      id: randomUUID(),
      ownerId: token.ownerId,
      tokenId: token.id,
      operation: resource,
      phase: "resource_read",
      outcome: "succeeded",
      errorCode: null,
      previewId: null,
      affectedIds: [],
      requestHash: null,
      createdAt: new Date().toISOString(),
    });
    sendJson(response, 200, body);
    return true;
  }

  // POST /api/automation/v1/previews
  if (method === "POST" && url.pathname === automationPreviewPath) {
    const token = authenticateAutomation(request, response, database);
    if (token === undefined) return true;
    const parsed = automationPreviewCommandSchema.safeParse(
      await readJson(request),
    );
    if (!parsed.success) {
      sendError(
        response,
        400,
        "INVALID_AUTOMATION_PREVIEW",
        "Automation preview input is invalid",
      );
      return true;
    }
    let command = parsed.data;
    const scope = automationScopeFor(command.operation);
    if (!token.scopes.includes(scope)) {
      database.appendAutomationAudit({
        id: randomUUID(),
        ownerId: token.ownerId,
        tokenId: token.id,
        operation: command.operation,
        phase: "preview",
        outcome: "denied",
        errorCode: "AUTOMATION_SCOPE_DENIED",
        previewId: null,
        affectedIds: [],
        requestHash: null,
        createdAt: new Date().toISOString(),
      });
      sendError(
        response,
        403,
        "AUTOMATION_SCOPE_DENIED",
        `Automation scope ${scope} is required`,
      );
      return true;
    }
    if (command.operation === "tasks.create") {
      try {
        command = {
          ...command,
          input: resolveTaskCapture(
            database,
            token.ownerId,
            command.input,
            new Date().toISOString(),
          ),
        };
      } catch (error) {
        if (!(error instanceof StructuredCaptureError)) throw error;
        sendError(response, 400, "INVALID_TASK", error.message);
        return true;
      }
    }
    const affected: {
      entityKind:
        | "task"
        | "calendar"
        | "active_session"
        | "template"
        | "template_set"
        | "project"
        | "choice_pool"
        | "planning_placeholder"
        | "pool_item"
        | "habit";
      entityId: string;
    }[] = [];
    const baseRevisions: {
      entityKind:
        | "task"
        | "active_session"
        | "template"
        | "template_set"
        | "project"
        | "choice_pool"
        | "planning_placeholder"
        | "pool_item"
        | "habit";
      entityId: string;
      revision: number;
    }[] = [];
    if (command.operation === "habits.mutate") {
      const input = command.input;
      const habitId =
        input.kind === "habit.create" ? input.habit.id : input.habitId;
      const habit = database.habits
        .list(token.ownerId)
        .find(({ id }) => id === habitId);
      if (
        input.kind !== "habit.create" &&
        habit?.revision !== input.baseRevision
      ) {
        sendError(
          response,
          412,
          "REVISION_CONFLICT",
          "Habit changed or is unavailable",
        );
        return true;
      }
      if (input.kind === "habit.create" && habit !== undefined) {
        sendError(response, 400, "INVALID_HABIT", "Habit already exists");
        return true;
      }
      affected.push({ entityKind: "habit", entityId: habitId });
      if (habit !== undefined)
        baseRevisions.push({
          entityKind: "habit",
          entityId: habitId,
          revision: habit.revision,
        });
    } else if (command.operation === "schedule.create_time_block") {
      const task = database.getTask(token.ownerId, command.input.taskId);
      if (task === undefined) {
        sendError(response, 404, "TASK_NOT_FOUND", "Task not found");
        return true;
      }
      if (
        database.getOwnedCalendar(token.ownerId, command.input.calendarId)
          ?.supportsEvents !== true
      ) {
        sendError(response, 404, "CALENDAR_NOT_FOUND", "Calendar not found");
        return true;
      }
      affected.push(
        { entityKind: "task", entityId: task.id },
        { entityKind: "calendar", entityId: command.input.calendarId },
      );
      baseRevisions.push({
        entityKind: "task",
        entityId: task.id,
        revision: task.revision,
      });
    } else if (command.operation === "templates.instantiate") {
      const template = database.getTaskTemplate(
        token.ownerId,
        command.input.templateId,
      );
      const project = database
        .listProjects(token.ownerId)
        .find(
          ({ id, archivedAt }) =>
            id === command.input.destinationProjectId && archivedAt === null,
        );
      if (template === undefined) {
        sendError(
          response,
          404,
          "TEMPLATE_NOT_FOUND",
          "Task template not found",
        );
        return true;
      }
      if (project === undefined) {
        sendError(
          response,
          404,
          "PROJECT_NOT_FOUND",
          "Destination project not found",
        );
        return true;
      }
      affected.push(
        { entityKind: "template", entityId: template.id },
        { entityKind: "project", entityId: project.id },
      );
      baseRevisions.push(
        {
          entityKind: "template",
          entityId: template.id,
          revision: template.revision,
        },
        {
          entityKind: "project",
          entityId: project.id,
          revision: project.revision,
        },
      );
    } else if (command.operation === "template_sets.instantiate") {
      const set = database
        .listTemplateSets(token.ownerId)
        .find(({ id }) => id === command.input.setId);
      const project = database
        .listProjects(token.ownerId)
        .find(
          ({ id, archivedAt }) =>
            id === command.input.destinationProjectId && archivedAt === null,
        );
      if (set === undefined) {
        sendError(
          response,
          404,
          "TEMPLATE_SET_NOT_FOUND",
          "Template set not found",
        );
        return true;
      }
      if (project === undefined) {
        sendError(
          response,
          404,
          "PROJECT_NOT_FOUND",
          "Destination project not found",
        );
        return true;
      }
      const members = database.listTemplateSetMembers(set.id);
      const templates = members.map((member) =>
        database.getTaskTemplate(token.ownerId, member.templateId),
      );
      if (templates.some((template) => template === undefined)) {
        sendError(
          response,
          409,
          "TEMPLATE_SET_STALE",
          "A template set member is no longer active",
        );
        return true;
      }
      const activeTemplates = templates.filter(
        (template): template is NonNullable<typeof template> =>
          template !== undefined,
      );
      affected.push(
        { entityKind: "template_set", entityId: set.id },
        { entityKind: "project", entityId: project.id },
        ...activeTemplates.map((template) => ({
          entityKind: "template" as const,
          entityId: template.id,
        })),
      );
      baseRevisions.push(
        {
          entityKind: "template_set",
          entityId: set.id,
          revision: set.revision,
        },
        {
          entityKind: "project",
          entityId: project.id,
          revision: project.revision,
        },
        ...activeTemplates.map((template) => ({
          entityKind: "template" as const,
          entityId: template.id,
          revision: template.revision,
        })),
      );
    } else if (command.operation === "placeholders.resolve") {
      const placeholder = database.getPlanningPlaceholder(
        token.ownerId,
        command.input.placeholderId,
      );
      if (placeholder?.state !== "unresolved") {
        sendError(
          response,
          404,
          "PLANNING_PLACEHOLDER_NOT_FOUND",
          "Unresolved planning placeholder not found",
        );
        return true;
      }
      const evaluated = choiceSuggestion(
        database,
        token.ownerId,
        placeholder.poolId,
        command.input.logicalTime,
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
        command.input.logicalTime,
        command.input.selectedItemIds,
        command.input.override,
      );
      if (
        !selection.valid ||
        command.input.expectedRevision !== placeholder.revision
      ) {
        sendError(
          response,
          409,
          "POOL_ITEM_INELIGIBLE",
          `Selection is unavailable: ${selection.reason ?? "stale placeholder"}`,
        );
        return true;
      }
      const task = database.getTask(token.ownerId, placeholder.taskId);
      if (task === undefined)
        throw new Error("Placeholder parent task could not be read");
      const selected = evaluated.items.filter(({ id }) =>
        command.input.selectedItemIds.includes(id),
      );
      affected.push(
        { entityKind: "planning_placeholder", entityId: placeholder.id },
        { entityKind: "choice_pool", entityId: evaluated.pool.id },
        { entityKind: "task", entityId: task.id },
        ...selected.map(({ id }) => ({
          entityKind: "pool_item" as const,
          entityId: id,
        })),
      );
      baseRevisions.push(
        {
          entityKind: "planning_placeholder",
          entityId: placeholder.id,
          revision: placeholder.revision,
        },
        {
          entityKind: "choice_pool",
          entityId: evaluated.pool.id,
          revision: evaluated.pool.revision,
        },
        {
          entityKind: "task",
          entityId: task.id,
          revision: task.revision,
        },
        ...selected.map(({ id, revision }) => ({
          entityKind: "pool_item" as const,
          entityId: id,
          revision,
        })),
      );
    } else if (command.operation.startsWith("focus.")) {
      const focusInput = automationFocusCommandInputSchema.parse(command.input);
      if (focusInput.operation === "focus.start") {
        const task = database.getTask(token.ownerId, focusInput.taskId);
        if (task === undefined) {
          sendError(response, 404, "TASK_NOT_FOUND", "Task not found");
          return true;
        }
        affected.push({ entityKind: "task", entityId: task.id });
        baseRevisions.push({
          entityKind: "task",
          entityId: task.id,
          revision: task.revision,
        });
      } else {
        const active = database.getActiveSession(token.ownerId);
        if (active?.id !== focusInput.sessionId) {
          sendError(
            response,
            404,
            "ACTIVE_SESSION_NOT_FOUND",
            "Active session not found",
          );
          return true;
        }
        affected.push({
          entityKind: "active_session",
          entityId: active.id,
        });
        baseRevisions.push({
          entityKind: "active_session",
          entityId: active.id,
          revision: active.revision,
        });
      }
    }
    const inputHash = createHash("sha256")
      .update(JSON.stringify(command))
      .digest("hex");
    const now = new Date();
    const preview = {
      id: randomUUID(),
      operation: command.operation,
      inputHash,
      summary: `Confirm ${command.operation} affecting ${String(affected.length)} resource(s)`,
      affected,
      baseRevisions,
      expiresAt: new Date(now.getTime() + 5 * 60 * 1000).toISOString(),
      requiresConfirmation: true as const,
    };
    database.createAutomationPreview({
      ...preview,
      ownerId: token.ownerId,
      tokenId: token.id,
      input: command,
      affectedIds: affected.map(({ entityId }) => entityId),
      baseRevisions: Object.fromEntries(
        baseRevisions.map(({ entityId, revision }) => [entityId, revision]),
      ),
      consumedAt: null,
      createdAt: now.toISOString(),
    });
    database.appendAutomationAudit({
      id: randomUUID(),
      ownerId: token.ownerId,
      tokenId: token.id,
      operation: command.operation,
      phase: "preview",
      outcome: "succeeded",
      errorCode: null,
      previewId: preview.id,
      affectedIds: affected.map(({ entityId }) => entityId),
      requestHash: inputHash,
      createdAt: now.toISOString(),
    });
    sendJson(response, 201, { preview });
    return true;
  }

  // POST /api/automation/v1/previews/:id/confirm
  if (automationConfirmPath === undefined) return false;
  const automationConfirmPattern = new RegExp(
    `^${automationConfirmPath.replace("{previewId}", "([0-9a-f-]{36})")}$`,
  );
  const automationConfirm = automationConfirmPattern.exec(url.pathname);
  if (automationConfirm !== null && method === "POST") {
    const token = authenticateAutomation(request, response, database);
    if (token === undefined) return true;
    const parsed = automationConfirmRequestSchema.safeParse(
      await readJson(request),
    );
    const previewId = automationConfirm[1] ?? "";
    const preview = database.getAutomationPreview(previewId);
    if (
      !parsed.success ||
      preview?.ownerId !== token.ownerId ||
      preview.tokenId !== token.id
    ) {
      sendError(
        response,
        404,
        "AUTOMATION_PREVIEW_NOT_FOUND",
        "Automation preview not found",
      );
      return true;
    }
    const requestHash = createHash("sha256")
      .update(
        `${preview.operation}:${preview.inputHash}:${parsed.data.idempotencyKey}`,
      )
      .digest("hex");
    const prior = database.getAutomationOutcome(
      token.ownerId,
      token.id,
      preview.operation,
      parsed.data.idempotencyKey,
    );
    if (prior !== undefined) {
      if (prior.requestHash !== requestHash) {
        sendError(
          response,
          409,
          "IDEMPOTENCY_CONFLICT",
          "Idempotency key was used for another confirmation",
        );
        return true;
      }
      database.appendAutomationAudit({
        id: randomUUID(),
        ownerId: token.ownerId,
        tokenId: token.id,
        operation: preview.operation,
        phase: "confirm",
        outcome: "replayed",
        errorCode: null,
        previewId: preview.id,
        affectedIds: preview.affectedIds,
        requestHash,
        createdAt: new Date().toISOString(),
      });
      sendJson(response, 200, {
        ...(prior.response as object),
        replayed: true,
      });
      return true;
    }
    if (
      preview.consumedAt !== null ||
      Date.parse(preview.expiresAt) <= Date.now()
    ) {
      database.appendAutomationAudit({
        id: randomUUID(),
        ownerId: token.ownerId,
        tokenId: token.id,
        operation: preview.operation,
        phase: "confirm",
        outcome: "denied",
        errorCode: "AUTOMATION_CONFIRMATION_EXPIRED",
        previewId: preview.id,
        affectedIds: preview.affectedIds,
        requestHash,
        createdAt: new Date().toISOString(),
      });
      sendError(
        response,
        409,
        "AUTOMATION_CONFIRMATION_EXPIRED",
        "Preview is expired or already consumed",
      );
      return true;
    }
    const habitAlreadyApplied =
      preview.operation === "habits.mutate" &&
      database.habits.hasOutcome(
        token.ownerId,
        `automation:${token.id}`,
        preview.id,
      );
    for (const [entityId, revision] of Object.entries(
      habitAlreadyApplied ? {} : preview.baseRevisions,
    )) {
      const current =
        database.habits.list(token.ownerId).find(({ id }) => id === entityId) ??
        database.getTask(token.ownerId, entityId, true) ??
        database.getTaskTemplate(token.ownerId, entityId, true) ??
        database
          .listTemplateSets(token.ownerId, true)
          .find(({ id }) => id === entityId) ??
        database
          .listProjects(token.ownerId)
          .find(({ id }) => id === entityId) ??
        database.getChoicePool(token.ownerId, entityId, true) ??
        database.getPlanningPlaceholder(token.ownerId, entityId) ??
        database
          .listChoicePools(token.ownerId, true)
          .flatMap((pool) => database.listChoicePoolItems(pool.id, true))
          .find(({ id }) => id === entityId) ??
        database.getActiveSession(token.ownerId);
      if (current?.id !== entityId || current.revision !== revision) {
        database.appendAutomationAudit({
          id: randomUUID(),
          ownerId: token.ownerId,
          tokenId: token.id,
          operation: preview.operation,
          phase: "confirm",
          outcome: "denied",
          errorCode: "AUTOMATION_PREVIEW_STALE",
          previewId: preview.id,
          affectedIds: preview.affectedIds,
          requestHash,
          createdAt: new Date().toISOString(),
        });
        sendError(
          response,
          412,
          "AUTOMATION_PREVIEW_STALE",
          "A previewed resource changed before confirmation",
        );
        return true;
      }
    }
    const command = automationPreviewCommandSchema.parse(preview.input);
    const internalKey = `automation.${token.id}.${parsed.data.idempotencyKey}`;
    let result: AutomationConfirmationResponse["result"];
    if (command.operation === "habits.mutate") {
      const applied = database.habits.apply({
        ownerId: token.ownerId,
        actorId: `automation:${token.id}`,
        operationId: preview.id,
        command: command.input,
        now: new Date().toISOString(),
      });
      if (applied.kind !== "applied" && applied.kind !== "replayed") {
        sendError(
          response,
          applied.kind === "conflict" ? 412 : 400,
          "INVALID_HABIT",
          "Habit mutation cannot be applied",
        );
        return true;
      }
      result = {
        habit: applied.habit,
        occurrence: applied.occurrence,
        replayed: applied.kind === "replayed",
      };
    } else if (command.operation === "tasks.create") {
      const now = new Date().toISOString();
      let created;
      try {
        created = createCapturedTask(
          database,
          token.ownerId,
          internalKey,
          createHash("sha256")
            .update(JSON.stringify(command.input))
            .digest("hex"),
          command.input,
          now,
        );
      } catch (error) {
        if (!(error instanceof StructuredCaptureError)) throw error;
        sendError(response, 400, "INVALID_TASK", error.message);
        return true;
      }
      if (created.kind === "conflict") {
        sendError(
          response,
          409,
          "IDEMPOTENCY_CONFLICT",
          "Operation key conflict",
        );
        return true;
      }
      result = {
        task: taskResponse(created.task),
        replayed: created.kind === "replayed",
      };
    } else if (command.operation === "schedule.create_time_block") {
      const input = command.input;
      const taskRevision = preview.baseRevisions[input.taskId];
      const task = database.getTask(token.ownerId, input.taskId);
      const calendar = database.getOwnedCalendar(
        token.ownerId,
        input.calendarId,
      );
      if (task === undefined || taskRevision === undefined) {
        sendError(response, 404, "TASK_NOT_FOUND", "Task not found");
        return true;
      }
      if (calendar?.supportsEvents !== true) {
        sendError(response, 404, "CALENDAR_NOT_FOUND", "Calendar not found");
        return true;
      }
      const existingBlock = database.getTaskCalendarBlock(
        token.ownerId,
        input.taskId,
      );
      if (
        existingBlock !== undefined &&
        existingBlock.calendarId !== input.calendarId
      ) {
        sendError(
          response,
          409,
          "TIME_BLOCK_CALENDAR_FIXED",
          "Remove the existing block before changing calendars",
        );
        return true;
      }
      const uid = existingBlock?.eventUid ?? `${randomUUID()}@suite.local`;
      const href =
        existingBlock?.eventHref ??
        `${calendar.href.replace(/\/$/, "")}/${randomUUID()}.ics`;
      const operationHash = createHash("sha256")
        .update(JSON.stringify(input))
        .digest("hex");
      const reservation = database.reserveCalendarWrite({
        ownerId: token.ownerId,
        taskId: input.taskId,
        expectedTaskRevision: taskRevision,
        idempotencyKey: internalKey,
        requestHash: operationHash,
        calendarId: input.calendarId,
        reservedHref: href,
        reservedUid: uid,
        now: new Date().toISOString(),
      });
      if (
        reservation.kind === "conflict" ||
        reservation.kind === "task-precondition-failed"
      ) {
        sendError(
          response,
          409,
          reservation.kind === "conflict"
            ? "IDEMPOTENCY_CONFLICT"
            : "AUTOMATION_PREVIEW_STALE",
          "Scheduling operation conflicted",
        );
        return true;
      }
      if (
        reservation.kind === "task-not-found" ||
        reservation.kind === "calendar-not-found"
      ) {
        sendError(
          response,
          404,
          reservation.kind === "task-not-found"
            ? "TASK_NOT_FOUND"
            : "CALENDAR_NOT_FOUND",
          "Scheduling resource not found",
        );
        return true;
      }
      if (
        reservation.kind === "replayed" &&
        reservation.operation.state === "completed"
      ) {
        const replayedTask = database.getTask(token.ownerId, input.taskId);
        const block = database.getTaskCalendarBlock(
          token.ownerId,
          input.taskId,
        );
        if (replayedTask === undefined || block === undefined) {
          sendError(
            response,
            409,
            "CALENDAR_WRITE_RECONCILIATION_REQUIRED",
            "Completed scheduling state could not be reconstructed",
          );
          return true;
        }
        result = {
          task: taskResponse(replayedTask),
          replayed: true,
          mapping: {
            id: block.id,
            taskId: block.taskId,
            event: {
              providerId: block.providerId,
              calendarId: block.calendarId,
              eventId: block.eventHref,
            },
            href: block.eventHref,
            uid: block.eventUid,
            etag: block.remoteEtag,
            state: "active",
            createdBySuite: true,
            createdAt: block.createdAt,
            updatedAt: block.updatedAt,
          },
        };
      } else {
        const operation = reservation.operation;
        const endsAt = new Date(
          Date.parse(input.startsAt) + input.durationMinutes * 60 * 1000,
        ).toISOString();
        let remote: CalendarOperationResult<CalendarEventResource>;
        if (reservation.kind === "replayed") {
          const projection = await connector.projectEvents(
            token.ownerId,
            operation.calendarId,
            new Date(Date.parse(input.startsAt) - 3_600_000).toISOString(),
            new Date(Date.parse(endsAt) + 3_600_000).toISOString(),
          );
          if (!projection.ok) remote = projection;
          else {
            const reconciled = projection.value.find(
              (candidate) =>
                candidate.href === operation.reservedHref &&
                candidate.event.uid === operation.reservedUid &&
                candidate.event.summary === task.title &&
                Date.parse(candidate.event.startsAt) ===
                  Date.parse(input.startsAt) &&
                Date.parse(candidate.event.endsAt) === Date.parse(endsAt) &&
                !candidate.event.allDay,
            );
            remote =
              reconciled === undefined
                ? { ok: false, reason: "outcome-unknown" }
                : { ok: true, value: reconciled };
          }
        } else {
          remote = await connector.putTaskBlock({
            ownerId: token.ownerId,
            calendarId: operation.calendarId,
            href: operation.reservedHref,
            uid: operation.reservedUid,
            summary: task.title,
            startsAt: input.startsAt,
            endsAt,
            ...(existingBlock === undefined
              ? {}
              : { expectedEtag: existingBlock.remoteEtag }),
          });
        }
        if (!remote.ok) {
          database.markCalendarWriteConflict(
            token.ownerId,
            internalKey,
            new Date().toISOString(),
          );
          sendError(
            response,
            409,
            "CALENDAR_WRITE_RECONCILIATION_REQUIRED",
            "Calendar write could not be safely reconciled",
          );
          return true;
        }
        const remoteEvent = remote.value;
        const completed = database.completeCalendarWrite({
          ownerId: token.ownerId,
          idempotencyKey: internalKey,
          event: {
            id: randomUUID(),
            providerId: operation.providerId,
            calendarId: operation.calendarId,
            href: remoteEvent.href,
            uid: remoteEvent.event.uid,
            etag: remoteEvent.etag,
            rawIcs: remoteEvent.rawIcs,
            summary: remoteEvent.event.summary,
            startsAt: new Date(remoteEvent.event.startsAt).toISOString(),
            endsAt: new Date(remoteEvent.event.endsAt).toISOString(),
            allDay: false,
            freshness: "current",
            mutable: true,
            revision: 1,
            projectedAt: new Date().toISOString(),
          },
          plannedStart: input.startsAt,
          estimateMinutes: input.durationMinutes,
          now: new Date().toISOString(),
        });
        if (completed === undefined)
          throw new Error("Automation scheduling could not be completed");
        result = {
          task: taskResponse(completed.task),
          replayed: reservation.kind === "replayed",
          mapping: {
            id: completed.block.id,
            taskId: completed.block.taskId,
            event: {
              providerId: completed.block.providerId,
              calendarId: completed.block.calendarId,
              eventId: completed.block.eventHref,
            },
            href: completed.block.eventHref,
            uid: completed.block.eventUid,
            etag: completed.block.remoteEtag,
            state: "active",
            createdBySuite: true,
            createdAt: completed.block.createdAt,
            updatedAt: completed.block.updatedAt,
          },
        };
      }
    } else if (
      command.operation === "templates.instantiate" ||
      command.operation === "template_sets.instantiate"
    ) {
      const input = command.input;
      const instantiated =
        command.operation === "templates.instantiate"
          ? database.instantiateTemplateIdempotently({
              ownerId: token.ownerId,
              templateId: "templateId" in input ? input.templateId : "",
              destinationProjectId: input.destinationProjectId,
              idempotencyKey: internalKey,
              requestHash,
              now: new Date().toISOString(),
            })
          : database.instantiateTemplateSetIdempotently({
              ownerId: token.ownerId,
              setId: "setId" in input ? input.setId : "",
              destinationProjectId: input.destinationProjectId,
              idempotencyKey: internalKey,
              requestHash,
              now: new Date().toISOString(),
            });
      if (instantiated.kind === "conflict") {
        sendError(
          response,
          409,
          "IDEMPOTENCY_CONFLICT",
          "Operation key conflict",
        );
        return true;
      }
      if (instantiated.kind === "project-not-found") {
        sendError(
          response,
          404,
          "PROJECT_NOT_FOUND",
          "Destination project not found",
        );
        return true;
      }
      if (instantiated.kind === "not-found") {
        sendError(
          response,
          404,
          command.operation === "templates.instantiate"
            ? "TEMPLATE_NOT_FOUND"
            : "TEMPLATE_SET_NOT_FOUND",
          "Reusable work source not found",
        );
        return true;
      }
      result = templateInstantiationResponse(instantiated);
    } else if (command.operation === "placeholders.resolve") {
      const input = command.input;
      const placeholder = database.getPlanningPlaceholder(
        token.ownerId,
        input.placeholderId,
      );
      if (placeholder === undefined) {
        sendError(
          response,
          404,
          "PLANNING_PLACEHOLDER_NOT_FOUND",
          "Planning placeholder not found",
        );
        return true;
      }
      const evaluated = choiceSuggestion(
        database,
        token.ownerId,
        placeholder.poolId,
        input.logicalTime,
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
        input.logicalTime,
        input.selectedItemIds,
        input.override,
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
      const resolved = database.resolvePlanningPlaceholderIdempotently({
        ownerId: token.ownerId,
        placeholderId: placeholder.id,
        expectedRevision: input.expectedRevision,
        selectedItemIds: input.selectedItemIds,
        logicalTime: input.logicalTime,
        cycle: selection.cycle,
        overridden: input.override,
        idempotencyKey: internalKey,
        requestHash,
        now: new Date().toISOString(),
      });
      if (resolved.kind === "conflict" || resolved.kind === "stale") {
        sendError(
          response,
          resolved.kind === "stale" ? 412 : 409,
          resolved.kind === "stale"
            ? "AUTOMATION_PREVIEW_STALE"
            : "IDEMPOTENCY_CONFLICT",
          "Placeholder resolution conflicted",
        );
        return true;
      }
      if (resolved.kind === "not-found") {
        sendError(
          response,
          404,
          "PLANNING_PLACEHOLDER_NOT_FOUND",
          "Planning placeholder not found",
        );
        return true;
      }
      result = placeholderResolutionResponse(resolved);
    } else {
      const before = database.getActiveSession(token.ownerId);
      const focusInput = automationFocusCommandInputSchema.parse(command.input);
      let next: ActiveSession;
      let expected: number | null;
      if (focusInput.operation === "focus.start") {
        next = createActiveSession(
          {
            ownerId: token.ownerId,
            controllerClientId: token.id,
            taskId: focusInput.taskId,
          },
          sessionClock,
          { sessionId: randomUUID(), intervalId: () => randomUUID() },
        );
        expected = null;
      } else {
        if (before === undefined) {
          sendError(
            response,
            404,
            "ACTIVE_SESSION_NOT_FOUND",
            "Active session not found",
          );
          return true;
        }
        const transition = transitionActiveSession(
          activeFromRecord(before, database),
          {
            type:
              command.operation === "focus.start_break"
                ? "start-break"
                : command.operation === "focus.end_break"
                  ? "end-break"
                  : (command.operation.slice(6) as
                      "pause" | "resume" | "complete" | "takeover"),
            actorClientId: token.id,
            expectedRevision: focusInput.expectedRevision,
          },
          sessionClock,
          { intervalId: () => randomUUID() },
        );
        if (!transition.ok) {
          sendError(
            response,
            409,
            "ACTIVE_SESSION_CONFLICT",
            transition.reason,
          );
          return true;
        }
        next = transition.session;
        expected = before.revision;
      }
      const applied = database.applyActiveSessionTransition({
        session: recordFromActive(next),
        expectedRevision: expected,
        clientId: token.id,
        idempotencyKey: internalKey,
        requestHash,
        intervals: intervalsFromActive(next),
        events: eventsFromActive(next),
        now: next.updatedAt,
      });
      if (applied.kind === "conflict" || applied.kind === "stale") {
        sendError(response, 409, "ACTIVE_SESSION_CONFLICT", "Session changed");
        return true;
      }
      result = {
        session: activeResponse(next),
        openedInterval: null,
        closedInterval: null,
        replayed: false,
        changeSequence: database.getSyncState(token.ownerId).cursor,
      };
    }
    const body: AutomationConfirmationResponse = {
      previewId: preview.id,
      operation: command.operation,
      replayed: false,
      result,
    };
    const completedAt = new Date().toISOString();
    const completed = database.completeAutomationConfirmation(
      preview.id,
      {
        ownerId: token.ownerId,
        tokenId: token.id,
        operation: command.operation,
        idempotencyKey: parsed.data.idempotencyKey,
        requestHash,
        previewId: preview.id,
        response: body,
        createdAt: completedAt,
      },
      {
        id: randomUUID(),
        ownerId: token.ownerId,
        tokenId: token.id,
        operation: command.operation,
        phase: "execute",
        outcome: "succeeded",
        errorCode: null,
        previewId: preview.id,
        affectedIds: preview.affectedIds,
        requestHash,
        createdAt: completedAt,
      },
      completedAt,
    );
    if (!completed) {
      const replay = database.getAutomationOutcome(
        token.ownerId,
        token.id,
        preview.operation,
        parsed.data.idempotencyKey,
      );
      if (replay?.requestHash === requestHash) {
        sendJson(response, 200, {
          ...(replay.response as object),
          replayed: true,
        });
        return true;
      }
      sendError(
        response,
        409,
        "AUTOMATION_CONFIRMATION_EXPIRED",
        "Preview could not be consumed",
      );
      return true;
    }
    sendJson(response, 200, body);
    return true;
  }

  return false;
};
