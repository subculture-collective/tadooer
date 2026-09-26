import { pluginDataListBody } from "./plugin-data.ts";
import { planningPatch, planningPatchProblem } from "../task-planning.ts";
import { readDayPlan } from "../day-plan.ts";
import { readNotificationStatus } from "../notification-status.ts";
import { StructuredCaptureError, validateTaskParent } from "@suite/domain";
import { hierarchyViolationError } from "./task-hierarchy.ts";
import { createCapturedTask, resolveTaskCapture } from "../task-capture.ts";
import {
  captureAffected,
  captureSummary,
  confirmCaptureBatch,
  isCaptureBatchCommand,
  previewCaptureBatch,
} from "../capture-automation.ts";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  AutomationConfirmationResponse,
  AutomationTokenScope,
} from "@suite/contracts";
import {
  dayPlanInputSchema,
  notificationDeliveryInputSchema,
  checklistResourceInputSchema,
  createAutomationTokenRequestSchema,
  automationPreviewCommandSchema,
  automationConfirmRequestSchema,
  automationFocusCommandInputSchema,
  plannerWindowSchema,
  taskLinksResourceInputSchema,
  templateSearchRequestSchema,
  taskHistoryQuerySchema,
  timeReportQuerySchema,
  counterHistoryQuerySchema,
  evaluationListQuerySchema,
  dayOrderResourceInputSchema,
  calendarSubscriptionResourceInputSchema,
} from "@suite/contracts";
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
  confirmOrganizationParity,
  isOrganizationParityCommand,
  organizationFieldsFor,
  organizationSummary,
  previewOrganizationParity,
} from "./automation-organization-parity.ts";
import {
  confirmTaskLinks,
  isTaskLinkCommand,
  previewTaskLinks,
} from "./automation-task-links.ts";
import { taskLinksResponse } from "./task-links.ts";
import {
  confirmTaskArchive,
  isTaskArchiveCommand,
  previewTaskArchive,
} from "./automation-task-archive.ts";
import { taskHistoryBody } from "./task-archive.ts";
import {
  confirmTimeBlockRemove,
  confirmTimeBlockWrite,
  isTimeBlockCommand,
  previewTimeBlock,
} from "./automation-time-blocks.ts";
import {
  confirmRecurrence,
  isRecurrenceCommand,
  previewRecurrence,
} from "./automation-recurrence.ts";
import { ownerToday, recurringSeriesResponse } from "./recurrence.ts";
import {
  confirmTimeEntry,
  isTimeEntryCommand,
  previewTimeEntry,
} from "./automation-time-entries.ts";
import { timeReportBody } from "./time-history.ts";
import {
  confirmCounter,
  isCounterCommand,
  previewCounter,
} from "./automation-counters.ts";
import { counterHistoryBody, evaluationListBody } from "./counters.ts";
import {
  confirmDayOrder,
  dayOrderResourceDate,
  isDayOrderCommand,
  previewDayOrder,
} from "./automation-day-order.ts";
import { readDayOrder } from "./day-order.ts";
import {
  confirmBoardCommand,
  isBoardCommand,
  previewBoardCommand,
} from "./automation-boards.ts";
import { boardClock } from "./boards.ts";
import {
  automationBoardsResourceInputSchema,
  automationSectionsResourceInputSchema,
} from "@suite/contracts";
import {
  confirmFocusParity,
  isFocusParityCommand,
  previewFocusParity,
} from "./automation-focus.ts";
import { focusPreferencesBody } from "./focus.ts";
import {
  applicationPreferencesEntityKind,
  confirmApplicationPreferences,
  isApplicationPreferencesCommand,
  previewApplicationPreferences,
} from "./automation-application-preferences.ts";
import { readApplicationPreferences } from "./application-preferences.ts";
import {
  confirmCalendarSubscription,
  isCalendarSubscriptionCommand,
  previewCalendarSubscription,
} from "./automation-calendar-subscriptions.ts";
import {
  automationTokenResponse,
  automationScopeFor,
  automationPreviewPath,
  automationConfirmPath,
  automationResourceEntries,
  sendEmpty,
  subtaskResponse,
  taskResponse,
  projectResponse,
  tagResponse,
  noteResponse,
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
  const deletionBlocked = (ownerId: string, taskId: string): boolean => {
    // Deleting a parent also deletes its active children (ADR 0018).
    const scope = database.taskHierarchy.deletionScope(ownerId, taskId);
    const active = database.getActiveSession(ownerId);
    if (active?.endedAt === null && scope.includes(active.taskId)) {
      sendError(
        response,
        409,
        "ACTIVE_SESSION_COMPLETE_REQUIRED",
        "Complete the active focus session before deleting this task",
      );
      return true;
    }
    if (
      scope.some(
        (id) => database.getTaskCalendarBlock(ownerId, id) !== undefined,
      )
    ) {
      sendError(
        response,
        409,
        "TIME_BLOCK_REMOVE_REQUIRED",
        "Remove the calendar block before deleting this task",
      );
      return true;
    }
    return false;
  };

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
    if (resource === "planning.day_plan") {
      const input = dayPlanInputSchema.safeParse({
        at: url.searchParams.get("at"),
      });
      if (!input.success) {
        sendError(
          response,
          400,
          "INVALID_DAY_PLAN_TIME",
          "Day-plan time must be an ISO timestamp",
        );
        return true;
      }
      body = await readDayPlan(ctx, token.ownerId, new Date(input.data.at));
    } else if (resource === "planning.preferences")
      body = {
        ...database.getPlanningPreferences(token.ownerId),
        revision: database.getPreferenceRevision(token.ownerId, "planning"),
      };
    else if (resource === "application.preferences")
      body = readApplicationPreferences(database, token.ownerId);
    else if (resource === "notifications.preferences")
      body = {
        ...database.getNotificationPreferences(token.ownerId),
        revision: database.getPreferenceRevision(
          token.ownerId,
          "notifications",
        ),
      };
    else if (resource === "notifications.delivery") {
      const parsed = notificationDeliveryInputSchema.safeParse({
        deliveryId: url.searchParams.get("deliveryId"),
      });
      if (!parsed.success) {
        sendError(
          response,
          400,
          "INVALID_DELIVERY_ID",
          "A notification delivery ID is required",
        );
        return true;
      }
      const delivery = database.getNotificationDelivery(parsed.data.deliveryId);
      if (delivery?.ownerId !== token.ownerId) {
        sendError(
          response,
          404,
          "NOTIFICATION_DELIVERY_NOT_FOUND",
          "Notification delivery not found",
        );
        return true;
      }
      body = {
        delivery: {
          id: delivery.id,
          state: delivery.state,
          kind: delivery.kind,
          attemptCount: delivery.attemptCount,
          updatedAt: delivery.updatedAt,
          deliveredAt: delivery.deliveredAt,
          errorCode: delivery.errorCode,
        },
      };
    } else if (resource === "notifications.status")
      body = readNotificationStatus(ctx, token.ownerId);
    else if (resource === "habits.list")
      body = {
        habits: database.habits.list(token.ownerId),
        occurrences: database.habits.occurrences(token.ownerId),
      };
    else if (resource === "subtasks.list") {
      const input = checklistResourceInputSchema.safeParse({
        taskId: url.searchParams.get("taskId"),
      });
      if (!input.success) {
        sendError(response, 400, "INVALID_CHECKLIST", "A task id is required");
        return true;
      }
      if (database.getTask(token.ownerId, input.data.taskId) === undefined) {
        sendError(response, 404, "TASK_NOT_FOUND", "Task not found");
        return true;
      }
      body = {
        taskId: input.data.taskId,
        subtasks: database
          .listSubtasks(token.ownerId, input.data.taskId)
          .map(subtaskResponse),
      };
    } else if (resource === "tasks.list")
      body = {
        tasks: database.listTasks(token.ownerId).map(taskResponse),
      };
    else if (resource === "tasks.deleted")
      body = {
        tasks: database.listDeletedTasks(token.ownerId).map(taskResponse),
      };
    else if (resource === "tasks.history") {
      const input = taskHistoryQuerySchema.safeParse(
        Object.fromEntries(url.searchParams.entries()),
      );
      body = input.success
        ? taskHistoryBody(database, token.ownerId, input.data)
        : undefined;
      if (body === undefined) {
        sendError(
          response,
          400,
          "INVALID_HISTORY_QUERY",
          "History search, cursor or limit is invalid",
        );
        return true;
      }
    } else if (resource === "recurrence.list") {
      const { today } = ownerToday(database, token.ownerId, new Date());
      body = {
        series: database.recurrence
          .list(token.ownerId)
          .map((series) => recurringSeriesResponse(database, series, today)),
      };
    } else if (resource === "time.report") {
      const input = timeReportQuerySchema.safeParse(
        Object.fromEntries(url.searchParams.entries()),
      );
      if (!input.success) {
        sendError(
          response,
          400,
          "INVALID_TIME_REPORT",
          "Provide from and to calendar dates at most 366 days apart",
        );
        return true;
      }
      body = timeReportBody(
        database,
        token.ownerId,
        input.data,
        ctx.sessionClock.now().toISOString(),
      );
    } else if (
      resource === "counters.history" ||
      resource === "evaluations.list"
    ) {
      // ADR 0025: counter values with derived streaks, or evaluations.
      const input = (
        resource === "counters.history"
          ? counterHistoryQuerySchema
          : evaluationListQuerySchema
      ).safeParse(Object.fromEntries(url.searchParams.entries()));
      if (!input.success) {
        sendError(
          response,
          400,
          "INVALID_RANGE",
          "Provide from and to calendar dates at most 366 days apart",
        );
        return true;
      }
      const at = ctx.sessionClock.now().toISOString();
      body =
        resource === "counters.history"
          ? counterHistoryBody(database, token.ownerId, input.data, at)
          : evaluationListBody(database, token.ownerId, input.data, at);
    } else if (resource === "day_order.get") {
      // ADR 0027: one date's saved order; the owner's planning date by default.
      const input = dayOrderResourceInputSchema.safeParse(
        Object.fromEntries(url.searchParams.entries()),
      );
      if (!input.success) {
        sendError(
          response,
          400,
          "INVALID_DAY_ORDER_DATE",
          "Provide a calendar date or omit it for today",
        );
        return true;
      }
      body = {
        dayOrder: readDayOrder(
          database,
          token.ownerId,
          dayOrderResourceDate(
            database,
            token.ownerId,
            input.data.date,
            ctx.sessionClock.now(),
          ),
        ),
      };
    } else if (resource === "boards.list") {
      // ADR 0028: configurations plus computed membership of one or all boards.
      const input = automationBoardsResourceInputSchema.safeParse(
        Object.fromEntries(url.searchParams.entries()),
      );
      if (!input.success) {
        sendError(
          response,
          400,
          "INVALID_BOARD_ID",
          "Provide a board ID or omit it",
        );
        return true;
      }
      const clock = boardClock(database, token.ownerId, ctx.sessionClock.now());
      const boards = database.boards
        .listBoards(token.ownerId)
        .filter(
          (board) =>
            input.data.boardId === undefined || board.id === input.data.boardId,
        );
      body = {
        boards,
        views: boards.flatMap((board) => {
          const view = database.boards.viewBoard(
            token.ownerId,
            board.id,
            clock,
          );
          return view === undefined ? [] : [view];
        }),
      };
    } else if (resource === "sections.list") {
      const input = automationSectionsResourceInputSchema.safeParse(
        Object.fromEntries(url.searchParams.entries()),
      );
      if (!input.success) {
        sendError(
          response,
          400,
          "INVALID_SECTION_CONTEXT",
          "Provide contextKind (project or tag) and contextId",
        );
        return true;
      }
      body = {
        sections: database.boards.listSections(token.ownerId, input.data),
      };
    } else if (resource === "task_views.list")
      body = { views: database.boards.listTaskViews(token.ownerId) };
    else if (resource === "menu_folders.list")
      body = { folders: database.boards.listMenuFolders(token.ownerId) };
    else if (resource === "focus.preferences") {
      // ADR 0029: the preference fields with their revision.
      const focus = focusPreferencesBody(database, token.ownerId);
      body = { ...focus.preferences, revision: focus.revision };
    } else if (resource === "calendar_subscriptions.list") {
      // ADR 0032: subscriptions by host, plus their events for a window.
      const input = calendarSubscriptionResourceInputSchema.safeParse(
        Object.fromEntries(url.searchParams.entries()),
      );
      if (!input.success) {
        sendError(
          response,
          400,
          "INVALID_WINDOW",
          "Give both from and to, at most 31 days apart, or neither",
        );
        return true;
      }
      const at = ctx.sessionClock.now().toISOString();
      body = {
        subscriptions: ctx.calendarSubscriptions.list(token.ownerId, at),
        events:
          input.data.from === undefined || input.data.to === undefined
            ? []
            : ctx.calendarSubscriptions.events(
                token.ownerId,
                input.data.from,
                input.data.to,
              ),
      };
    } else if (resource === "projects.list")
      body = {
        projects: database.listProjects(token.ownerId).map(projectResponse),
      };
    else if (resource === "tags.list")
      body = { tags: database.listTags(token.ownerId).map(tagResponse) };
    else if (resource === "notes.list")
      body = { notes: database.notes.list(token.ownerId).map(noteResponse) };
    // ADR 0026: identity, sizes and flags only; the data is never returned.
    else if (resource === "plugin_data.list")
      body = pluginDataListBody(database, token.ownerId);
    else if (resource === "task_links.get") {
      const input = taskLinksResourceInputSchema.safeParse({
        taskId: url.searchParams.get("taskId"),
      });
      if (!input.success) {
        sendError(response, 400, "INVALID_TASK_LINKS", "A task id is required");
        return true;
      }
      const links = database.taskLinks.get(token.ownerId, input.data.taskId);
      if (links === undefined) {
        sendError(response, 404, "TASK_NOT_FOUND", "Task not found");
        return true;
      }
      body = taskLinksResponse(links);
    } else if (resource === "templates.list") {
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
        events: events.map((event) => calendarEventResponse(event)),
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
    // ADR 0031: capture resolves at preview; new tags become affected objects.
    let captureBatch: ReturnType<typeof previewCaptureBatch> | undefined;
    if (command.operation === "tasks.create") {
      try {
        command = {
          ...command,
          input: resolveTaskCapture(
            database,
            token.ownerId,
            command.input,
            new Date().toISOString(),
            { allowNewTags: true },
          ),
        };
      } catch (error) {
        if (!(error instanceof StructuredCaptureError)) throw error;
        sendError(response, 400, "INVALID_TASK", error.message);
        return true;
      }
    } else if (isCaptureBatchCommand(command)) {
      try {
        captureBatch = previewCaptureBatch(
          database,
          token.ownerId,
          command,
          new Date().toISOString(),
        );
        command = { ...command, input: captureBatch.input };
      } catch (error) {
        if (!(error instanceof StructuredCaptureError)) throw error;
        sendError(response, 400, "INVALID_TASK", error.message);
        return true;
      }
    }
    let taskSummary: string | undefined;
    const affected: {
      entityKind:
        | "planning_preferences"
        | "notification_preferences"
        | "focus_preferences"
        | "application_preferences"
        | "subtask"
        | "task"
        | "calendar"
        | "active_session"
        | "template"
        | "template_set"
        | "tag"
        | "project"
        | "note"
        | "task_attachment"
        | "task_issue_link"
        | "time_entry"
        | "choice_pool"
        | "planning_placeholder"
        | "pool_item"
        | "recurring_series"
        | "counter"
        | "daily_evaluation"
        | "board"
        | "section"
        | "task_view"
        | "menu_folder"
        | "habit";
      entityId: string;
    }[] = [];
    const baseRevisions: {
      entityKind:
        | "planning_preferences"
        | "notification_preferences"
        | "focus_preferences"
        | "application_preferences"
        | "subtask"
        | "task"
        | "active_session"
        | "template"
        | "template_set"
        | "tag"
        | "project"
        | "note"
        | "task_attachment"
        | "task_issue_link"
        | "time_entry"
        | "choice_pool"
        | "planning_placeholder"
        | "pool_item"
        | "recurring_series"
        | "counter"
        | "daily_evaluation"
        | "board"
        | "section"
        | "menu_folder"
        | "habit";
      entityId: string;
      revision: number;
    }[] = [];
    if (command.operation === "notifications.send_test") {
      if (ctx.ntfy === undefined) {
        sendError(
          response,
          503,
          "NTFY_NOT_CONFIGURED",
          "Notification delivery is unavailable",
        );
        return true;
      }
      const revision = database.getPreferenceRevision(
        token.ownerId,
        "notifications",
      );
      if (revision !== command.input.expectedRevision) {
        sendError(
          response,
          412,
          "REVISION_CONFLICT",
          "Notification preferences changed before preview",
        );
        return true;
      }
      affected.push({
        entityKind: "notification_preferences",
        entityId: token.ownerId,
      });
      baseRevisions.push({
        entityKind: "notification_preferences",
        entityId: token.ownerId,
        revision,
      });
      taskSummary =
        "Queue one test notification to the server-configured owner notification destination, even if scheduled reminders are disabled. Confirmation queues delivery; it does not prove delivery. Ambiguous sends are not retried.";
    } else if (
      command.operation === "planning.update_preferences" ||
      command.operation === "notifications.update_preferences"
    ) {
      const kind =
        command.operation === "planning.update_preferences"
          ? "planning"
          : "notifications";
      const revision = database.getPreferenceRevision(token.ownerId, kind);
      if (revision !== command.input.expectedRevision) {
        sendError(
          response,
          412,
          "REVISION_CONFLICT",
          "Preferences changed before preview",
        );
        return true;
      }
      const entityKind =
        kind === "planning"
          ? "planning_preferences"
          : "notification_preferences";
      affected.push({ entityKind, entityId: token.ownerId });
      baseRevisions.push({ entityKind, entityId: token.ownerId, revision });
      taskSummary =
        command.operation === "planning.update_preferences"
          ? `Change planning preferences to ${JSON.stringify(command.input.preferences)}. This changes civil-day planning and reminder eligibility.`
          : `Change notification preferences to ${JSON.stringify(command.input.preferences)}. ${command.input.preferences.enabled ? "Scheduled reminder delivery may follow; this does not send a test notification." : "Future reminder delivery will be disabled."}`;
    } else if (command.operation === "subtasks.mutate") {
      const input = command.input.command;
      const task = database.getTask(token.ownerId, input.taskId);
      if (task?.revision !== command.input.expectedTaskRevision) {
        sendError(
          response,
          412,
          "REVISION_CONFLICT",
          "Parent task changed or is unavailable",
        );
        return true;
      }
      const items = database.listSubtasks(token.ownerId, input.taskId);
      const targets =
        input.action === "reorder"
          ? items
          : items.filter((item) => item.id === input.id);
      if (
        input.action === "create"
          ? database.getSubtask(token.ownerId, input.id) !== undefined
          : input.action === "reorder"
            ? input.items.length !== items.length ||
              input.items.some(
                (item) =>
                  items.find((current) => current.id === item.id)?.revision !==
                  item.revision,
              )
            : targets[0]?.revision !== input.expectedRevision
      ) {
        sendError(
          response,
          412,
          "SUBTASK_REVISION_CONFLICT",
          "Checklist changed or is unavailable",
        );
        return true;
      }
      affected.push({ entityKind: "task", entityId: task.id });
      baseRevisions.push({
        entityKind: "task",
        entityId: task.id,
        revision: task.revision,
      });
      for (const item of targets) {
        affected.push({ entityKind: "subtask", entityId: item.id });
        baseRevisions.push({
          entityKind: "subtask",
          entityId: item.id,
          revision: item.revision,
        });
      }
      if (input.action === "create")
        affected.push({ entityKind: "subtask", entityId: input.id });
      taskSummary =
        input.action === "create"
          ? `Add checklist item "${input.title}" to task "${task.title}"`
          : input.action === "delete"
            ? `Permanently delete checklist item "${targets[0]?.title ?? ""}" from task "${task.title}"`
            : input.action === "reorder"
              ? `Reorder all ${String(items.length)} checklist items on task "${task.title}"`
              : `Edit checklist item "${targets[0]?.title ?? ""}" on task "${task.title}": ${Object.keys(input.patch).join(", ")}`;
    } else if (
      command.operation === "projects.mutate" ||
      command.operation === "tags.mutate"
    ) {
      const kind = command.operation === "projects.mutate" ? "project" : "tag";
      const input = command.input;
      const records =
        kind === "project"
          ? database.listProjects(token.ownerId)
          : database.listTags(token.ownerId);
      const current = records.find((record) => record.id === input.id);
      if (
        input.action === "create"
          ? current !== undefined
          : current?.revision !== input.expectedRevision
      ) {
        sendError(
          response,
          412,
          "REVISION_CONFLICT",
          "Organization changed or is unavailable",
        );
        return true;
      }
      if (
        kind === "tag" &&
        (input.action === "create" || input.action === "rename") &&
        database
          .listTags(token.ownerId)
          .some(
            (tag) =>
              tag.id !== input.id &&
              tag.normalizedName ===
                input.title.normalize("NFKC").toLocaleLowerCase(),
          )
      ) {
        sendError(
          response,
          409,
          "ORGANIZATION_NAME_CONFLICT",
          "That tag name is already in use",
        );
        return true;
      }
      affected.push({ entityKind: kind, entityId: input.id });
      if (current !== undefined)
        baseRevisions.push({
          entityKind: kind,
          entityId: input.id,
          revision: current.revision,
        });
      taskSummary = organizationSummary(kind, input, current?.title ?? "");
    } else if (isOrganizationParityCommand(command)) {
      const planned = previewOrganizationParity(
        database,
        token.ownerId,
        command,
      );
      if (!planned.ok) {
        sendError(response, planned.status, planned.code, planned.message);
        return true;
      }
      affected.push(...planned.affected);
      baseRevisions.push(...planned.baseRevisions);
      taskSummary = planned.summary;
    } else if (isRecurrenceCommand(command)) {
      // ADR 0023: freezes the series revision (and a deleted instance's).
      const planned = previewRecurrence(database, token.ownerId, command);
      if (!planned.ok) {
        sendError(response, planned.status, planned.code, planned.message);
        return true;
      }
      affected.push(...planned.affected);
      baseRevisions.push(...planned.baseRevisions);
      taskSummary = planned.summary;
    } else if (isApplicationPreferencesCommand(command)) {
      // ADR 0030: freezes the preference record revision.
      const planned = previewApplicationPreferences(
        database,
        token.ownerId,
        command,
      );
      if (!planned.ok) {
        sendError(response, planned.status, planned.code, planned.message);
        return true;
      }
      affected.push({
        entityKind: applicationPreferencesEntityKind,
        entityId: token.ownerId,
      });
      baseRevisions.push({
        entityKind: applicationPreferencesEntityKind,
        entityId: token.ownerId,
        revision: planned.revision,
      });
      taskSummary = planned.summary;
    } else if (command.operation === "tasks.create") {
      affected.push(...captureAffected(command.input));
      taskSummary = captureSummary(command.input);
    } else if (captureBatch !== undefined) {
      affected.push(...captureBatch.affected);
      taskSummary = captureBatch.summary;
    } else if (isDayOrderCommand(command)) {
      // ADR 0027: no entity revision to freeze; confirmation re-checks the
      // day order revision and exact membership.
      const planned = previewDayOrder(database, token.ownerId, command);
      if (!planned.ok) {
        sendError(response, planned.status, planned.code, planned.message);
        return true;
      }
      affected.push(...planned.affected);
      taskSummary = planned.summary;
    } else if (isBoardCommand(command)) {
      // ADR 0028: freezes board, section, folder and moved-task revisions.
      const planned = previewBoardCommand(
        database,
        token.ownerId,
        command,
        boardClock(database, token.ownerId, ctx.sessionClock.now()),
      );
      if (!planned.ok) {
        sendError(response, planned.status, planned.code, planned.message);
        return true;
      }
      affected.push(...planned.affected);
      baseRevisions.push(...planned.baseRevisions);
      taskSummary = planned.summary;
    } else if (isCalendarSubscriptionCommand(command)) {
      // ADR 0032: names the subscription host and event; a refresh repeats
      // its revision check at confirmation.
      const planned = previewCalendarSubscription(
        database,
        token.ownerId,
        command,
      );
      if (!planned.ok) {
        sendError(response, planned.status, planned.code, planned.message);
        return true;
      }
      affected.push(...planned.affected);
      taskSummary = planned.summary;
    } else if (isTimeEntryCommand(command)) {
      // ADR 0024: freezes the entry revision, or the task for an addition.
      const planned = previewTimeEntry(
        database,
        token.ownerId,
        command,
        ctx.sessionClock.now().toISOString(),
      );
      if (!planned.ok) {
        sendError(response, planned.status, planned.code, planned.message);
        return true;
      }
      affected.push(...planned.affected);
      baseRevisions.push(...planned.baseRevisions);
      taskSummary = planned.summary;
    } else if (isFocusParityCommand(command)) {
      // ADR 0029: binds the focus preference revision or the session revision.
      const planned = previewFocusParity(
        database,
        ctx.sessionClock,
        token.ownerId,
        command,
      );
      if (!planned.ok) {
        sendError(response, planned.status, planned.code, planned.message);
        return true;
      }
      affected.push(...planned.affected);
      baseRevisions.push(...planned.baseRevisions);
      taskSummary = planned.summary;
    } else if (isCounterCommand(command)) {
      // ADR 0025: freezes the counter, or checks the day/evaluation revision.
      const planned = previewCounter(database, token.ownerId, command);
      if (!planned.ok) {
        sendError(response, planned.status, planned.code, planned.message);
        return true;
      }
      affected.push(...planned.affected);
      baseRevisions.push(...planned.baseRevisions);
      taskSummary = planned.summary;
    } else if (isTaskArchiveCommand(command)) {
      // ADR 0022: freezes the parent and every child the archive moves.
      const planned = previewTaskArchive(database, token.ownerId, command);
      if (!planned.ok) {
        sendError(response, planned.status, planned.code, planned.message);
        return true;
      }
      affected.push(...planned.affected);
      baseRevisions.push(...planned.baseRevisions);
      taskSummary = planned.summary;
    } else if (command.operation === "tasks.hierarchy") {
      // ADR 0018: the preview freezes the task, the target parent and, for a
      // reorder, every child revision; confirmation fails if any changed.
      const input = command.input;
      const reject = (status: number, code: string, message: string) => {
        sendError(response, status, code, message);
        return true;
      };
      if (input.action === "move") {
        const task = database.getTask(token.ownerId, input.taskId);
        if (task?.revision !== input.expectedRevision)
          return reject(
            412,
            "REVISION_CONFLICT",
            "Task changed or is unavailable",
          );
        const parent =
          input.parentId === null
            ? undefined
            : database.getTask(token.ownerId, input.parentId, true);
        if (input.parentId !== null) {
          const violation = validateTaskParent({
            taskId: task.id,
            parent,
            taskHasActiveChildren:
              database.taskHierarchy.childIds(token.ownerId, task.id).length >
              0,
          });
          if (violation !== null) {
            const error = hierarchyViolationError(violation);
            return reject(error.status, error.code, error.message);
          }
        }
        affected.push({ entityKind: "task", entityId: task.id });
        baseRevisions.push({
          entityKind: "task",
          entityId: task.id,
          revision: task.revision,
        });
        if (parent !== undefined) {
          affected.push({ entityKind: "task", entityId: parent.id });
          baseRevisions.push({
            entityKind: "task",
            entityId: parent.id,
            revision: parent.revision,
          });
        }
        taskSummary =
          parent === undefined
            ? `Make task "${task.title}" a top-level task`
            : `Move task "${task.title}" under "${parent.title}" ${
                input.index == null
                  ? "as its last child"
                  : `at child position ${String(input.index + 1)}`
              }`;
      } else {
        const parent = database.getTask(token.ownerId, input.parentId);
        if (parent?.revision !== input.expectedParentRevision)
          return reject(
            412,
            "REVISION_CONFLICT",
            "Parent task changed or is unavailable",
          );
        affected.push({ entityKind: "task", entityId: parent.id });
        baseRevisions.push({
          entityKind: "task",
          entityId: parent.id,
          revision: parent.revision,
        });
        if (input.action === "create_child") {
          const violation = validateTaskParent({
            taskId: "",
            parent,
            taskHasActiveChildren: false,
          });
          if (violation !== null) {
            const error = hierarchyViolationError(violation);
            return reject(error.status, error.code, error.message);
          }
          taskSummary = `Add child task "${input.task.title}" under "${parent.title}"`;
        } else {
          const children = database.taskHierarchy.listChildren(
            token.ownerId,
            parent.id,
          );
          if (children.length > 200)
            return reject(
              400,
              "INVALID_CHILD_ORDER",
              "Reorder at most 200 child tasks in one assistant action",
            );
          if (
            input.items.length !== children.length ||
            input.items.some(
              (item) =>
                children.find(({ id }) => id === item.id)?.revision !==
                item.revision,
            )
          )
            return reject(
              412,
              "TASK_CHILDREN_CHANGED",
              "Child tasks changed or are unavailable",
            );
          for (const child of children) {
            affected.push({ entityKind: "task", entityId: child.id });
            baseRevisions.push({
              entityKind: "task",
              entityId: child.id,
              revision: child.revision,
            });
          }
          taskSummary = `Reorder all ${String(children.length)} child tasks of "${parent.title}"`;
        }
      }
    } else if (isTaskLinkCommand(command)) {
      const planned = previewTaskLinks(database, token.ownerId, command);
      if (!planned.ok) {
        sendError(response, planned.status, planned.code, planned.message);
        return true;
      }
      affected.push(...planned.affected);
      baseRevisions.push(...planned.baseRevisions);
      taskSummary = planned.summary;
    } else if (
      command.operation === "tasks.assign_project" ||
      command.operation === "tasks.set_tags"
    ) {
      const task = database.getTask(token.ownerId, command.input.taskId);
      if (task?.revision !== command.input.expectedRevision) {
        sendError(
          response,
          412,
          "REVISION_CONFLICT",
          "Task changed or is unavailable",
        );
        return true;
      }
      affected.push({ entityKind: "task", entityId: task.id });
      baseRevisions.push({
        entityKind: "task",
        entityId: task.id,
        revision: task.revision,
      });
      if (command.operation === "tasks.assign_project") {
        const project = database
          .listProjects(token.ownerId)
          .find(
            (record) =>
              record.id === command.input.projectId &&
              record.archivedAt === null,
          );
        if (command.input.projectId !== null && project === undefined) {
          sendError(
            response,
            400,
            "INVALID_ORGANIZATION",
            "Project is unavailable or archived",
          );
          return true;
        }
        if (project !== undefined)
          baseRevisions.push({
            entityKind: "project",
            entityId: project.id,
            revision: project.revision,
          });
        taskSummary = `Assign task "${task.title}" to ${project === undefined ? "no project" : `project "${project.title}"`}`;
      } else {
        const tags = database
          .listTags(token.ownerId)
          .filter(
            (tag) =>
              command.input.tagIds.includes(tag.id) && tag.archivedAt === null,
          );
        if (tags.length !== command.input.tagIds.length) {
          sendError(
            response,
            400,
            "INVALID_ORGANIZATION",
            "A tag is unavailable or archived",
          );
          return true;
        }
        for (const tag of tags)
          baseRevisions.push({
            entityKind: "tag",
            entityId: tag.id,
            revision: tag.revision,
          });
        taskSummary = `Replace all tags on task "${task.title}" with ${
          tags.length === 0
            ? "none"
            : `${String(tags.length)} tags: ${tags
                .map((tag) => `"${tag.title}"`)
                .join(", ")
                .slice(0, 650)}`
        }`;
      }
    } else if (
      command.operation === "tasks.update" ||
      command.operation === "tasks.set_completed" ||
      command.operation === "tasks.delete" ||
      command.operation === "tasks.restore"
    ) {
      const task = database.getTask(
        token.ownerId,
        command.input.taskId,
        command.operation === "tasks.restore",
      );
      if (
        task === undefined ||
        (command.operation === "tasks.restore" && task.deletedAt === null)
      ) {
        sendError(response, 404, "TASK_NOT_FOUND", "Task not found");
        return true;
      }
      if (task.revision !== command.input.expectedRevision) {
        sendError(
          response,
          412,
          "REVISION_CONFLICT",
          "Task changed before preview",
        );
        return true;
      }
      if (
        command.operation === "tasks.delete" &&
        deletionBlocked(token.ownerId, task.id)
      )
        return true;
      const planningProblem =
        command.operation === "tasks.update"
          ? planningPatchProblem(
              database,
              token.ownerId,
              task.id,
              command.input.patch,
            )
          : undefined;
      if (planningProblem !== undefined) {
        sendError(
          response,
          planningProblem.status,
          planningProblem.code,
          planningProblem.message,
        );
        return true;
      }
      taskSummary =
        command.operation === "tasks.delete"
          ? `Delete task "${task.title}"; it remains available in recovery`
          : command.operation === "tasks.restore"
            ? `Restore task "${task.title}" from recovery`
            : command.operation === "tasks.set_completed"
              ? `${command.input.completed ? "Complete" : "Reopen"} task "${task.title}"`
              : `Edit task "${task.title}": ${Object.keys(command.input.patch).join(", ")}`;
      affected.push({ entityKind: "task", entityId: task.id });
      baseRevisions.push({
        entityKind: "task",
        entityId: task.id,
        revision: task.revision,
      });
    } else if (command.operation === "habits.mutate") {
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
    } else if (isTimeBlockCommand(command)) {
      // ADR 0037: freezes the task revision; the block follows it.
      const planned = previewTimeBlock(database, token.ownerId, command);
      if (!planned.ok) {
        sendError(response, planned.status, planned.code, planned.message);
        return true;
      }
      affected.push(...planned.affected);
      baseRevisions.push(...planned.baseRevisions);
      taskSummary = planned.summary;
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
      summary:
        taskSummary ??
        `Confirm ${command.operation} affecting ${String(affected.length)} resource(s)`,
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
      const preferenceKind =
        preview.operation === "planning.update_preferences"
          ? "planning"
          : preview.operation === "notifications.update_preferences" ||
              preview.operation === "notifications.send_test"
            ? "notifications"
            : preview.operation === "focus.update_preferences"
              ? "focus"
              : undefined;
      const preferenceCurrent =
        preview.operation === "application.update_preferences"
          ? {
              id: token.ownerId,
              revision: database.applicationPreferences.get(token.ownerId)
                .revision,
            }
          : preferenceKind === undefined
            ? undefined
            : {
                id: token.ownerId,
                revision:
                  preferenceKind === "focus"
                    ? database.focus.getRevision(token.ownerId)
                    : database.getPreferenceRevision(
                        token.ownerId,
                        preferenceKind,
                      ),
              };
      const current =
        preferenceCurrent ??
        database.habits.list(token.ownerId).find(({ id }) => id === entityId) ??
        database.getTask(token.ownerId, entityId, true) ??
        database.getSubtask(token.ownerId, entityId) ??
        database.getTaskTemplate(token.ownerId, entityId, true) ??
        database
          .listTemplateSets(token.ownerId, true)
          .find(({ id }) => id === entityId) ??
        database
          .listProjects(token.ownerId)
          .find(({ id }) => id === entityId) ??
        database.listTags(token.ownerId).find(({ id }) => id === entityId) ??
        database.notes.get(token.ownerId, entityId) ??
        database.taskLinks.getAttachment(token.ownerId, entityId) ??
        database.taskLinks.getIssueLink(token.ownerId, entityId) ??
        database.timeEntries.get(token.ownerId, entityId) ??
        database.counters.get(token.ownerId, entityId) ??
        database.counters.getEvaluationById(token.ownerId, entityId) ??
        database.getChoicePool(token.ownerId, entityId, true) ??
        database.getPlanningPlaceholder(token.ownerId, entityId) ??
        database
          .listChoicePools(token.ownerId, true)
          .flatMap((pool) => database.listChoicePoolItems(pool.id, true))
          .find(({ id }) => id === entityId) ??
        database.recurrence.get(token.ownerId, entityId) ??
        database.boards.entityRevision(token.ownerId, entityId) ??
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
    let result: AutomationConfirmationResponse["result"] | undefined;
    let applyLocalMutation:
      (() => AutomationConfirmationResponse["result"]) | undefined;
    if (command.operation === "notifications.send_test") {
      if (ctx.ntfy === undefined) {
        sendError(
          response,
          503,
          "NTFY_NOT_CONFIGURED",
          "Notification delivery is unavailable",
        );
        return true;
      }
      applyLocalMutation = () => {
        const delivery = database.queueNotificationTest(
          token.ownerId,
          preview.id,
          new Date().toISOString(),
        );
        return {
          notificationTest: { deliveryId: delivery.id, state: "pending" },
        };
      };
    } else if (command.operation === "planning.update_preferences") {
      applyLocalMutation = () => {
        const preferences = database.mutatePlanningPreferences(
          token.ownerId,
          command.input.expectedRevision,
          command.input.preferences,
          new Date().toISOString(),
        );
        if (preferences === undefined)
          throw new Error("Planning preferences changed during confirmation");
        return {
          planningPreferences: {
            ...preferences,
            workingDays: [...preferences.workingDays],
            revision: database.getPreferenceRevision(token.ownerId, "planning"),
          },
        };
      };
    } else if (command.operation === "notifications.update_preferences") {
      applyLocalMutation = () => {
        const preferences = database.mutateNotificationPreferences(
          token.ownerId,
          command.input.expectedRevision,
          command.input.preferences,
          new Date().toISOString(),
        );
        if (preferences === undefined)
          throw new Error(
            "Notification preferences changed during confirmation",
          );
        return {
          notificationPreferences: {
            ...preferences,
            revision: database.getPreferenceRevision(
              token.ownerId,
              "notifications",
            ),
          },
        };
      };
    } else if (command.operation === "subtasks.mutate") {
      const frozen = command.input.command;
      if (frozen.action === "reorder") {
        const items = database.listSubtasks(token.ownerId, frozen.taskId);
        if (
          items.length !== frozen.items.length ||
          frozen.items.some(
            (item) =>
              items.find((current) => current.id === item.id)?.revision !==
              item.revision,
          )
        ) {
          sendError(
            response,
            412,
            "AUTOMATION_PREVIEW_STALE",
            "Checklist membership changed before confirmation",
          );
          return true;
        }
      }
      if (
        frozen.action === "create" &&
        database.getSubtask(token.ownerId, frozen.id) !== undefined
      ) {
        sendError(
          response,
          412,
          "AUTOMATION_PREVIEW_STALE",
          "Checklist item already exists",
        );
        return true;
      }
      applyLocalMutation = () => {
        const input = command.input.command;
        const items = database.mutateChecklist(
          token.ownerId,
          input,
          new Date().toISOString(),
          command.input.expectedTaskRevision,
        );
        if (items === undefined)
          throw new Error("Checklist changed during atomic confirmation");
        return {
          taskId: input.taskId,
          subtasks: items.map(subtaskResponse),
          deletedIds: input.action === "delete" ? [input.id] : [],
        };
      };
    } else if (
      command.operation === "projects.mutate" ||
      command.operation === "tags.mutate"
    ) {
      const kind = command.operation === "projects.mutate" ? "project" : "tag";
      const input = command.input;
      applyLocalMutation = () => {
        const record = database.mutateOrganization(
          kind,
          token.ownerId,
          input.id,
          input.action === "create" ? null : input.expectedRevision,
          organizationFieldsFor(input),
          new Date().toISOString(),
        );
        if (record === undefined)
          throw new Error("Organization changed during atomic confirmation");
        return "normalizedName" in record
          ? { tag: tagResponse(record) }
          : { project: projectResponse(record) };
      };
    } else if (isOrganizationParityCommand(command)) {
      const confirmation = confirmOrganizationParity(
        database,
        token.ownerId,
        command,
      );
      if (!confirmation.ok) {
        sendError(
          response,
          confirmation.status,
          "AUTOMATION_PREVIEW_STALE",
          confirmation.message,
        );
        return true;
      }
      applyLocalMutation = confirmation.apply;
    } else if (isRecurrenceCommand(command)) {
      const confirmation = confirmRecurrence(
        database,
        token.ownerId,
        command,
        preview.id,
      );
      if (!confirmation.ok) {
        sendError(
          response,
          confirmation.status,
          "AUTOMATION_PREVIEW_STALE",
          confirmation.message,
        );
        return true;
      }
      applyLocalMutation = confirmation.apply;
    } else if (isApplicationPreferencesCommand(command)) {
      const confirmation = confirmApplicationPreferences(
        database,
        token.ownerId,
        command,
        () => ctx.sessionClock.now().toISOString(),
      );
      if (!confirmation.ok) {
        sendError(
          response,
          confirmation.status,
          "AUTOMATION_PREVIEW_STALE",
          confirmation.message,
        );
        return true;
      }
      applyLocalMutation = confirmation.apply;
    } else if (isDayOrderCommand(command)) {
      const confirmation = confirmDayOrder(
        database,
        token.ownerId,
        command,
        () => ctx.sessionClock.now().toISOString(),
      );
      if (!confirmation.ok) {
        sendError(
          response,
          confirmation.status,
          "AUTOMATION_PREVIEW_STALE",
          confirmation.message,
        );
        return true;
      }
      applyLocalMutation = confirmation.apply;
    } else if (isBoardCommand(command)) {
      const confirmation = confirmBoardCommand(
        database,
        token.ownerId,
        command,
        boardClock(database, token.ownerId, ctx.sessionClock.now()),
        () => ctx.sessionClock.now().toISOString(),
      );
      if (!confirmation.ok) {
        sendError(
          response,
          confirmation.status,
          "AUTOMATION_PREVIEW_STALE",
          confirmation.message,
        );
        return true;
      }
      applyLocalMutation = confirmation.apply;
    } else if (isCalendarSubscriptionCommand(command)) {
      const confirmation = await confirmCalendarSubscription(
        database,
        ctx.calendarSubscriptions,
        token.ownerId,
        command,
        () => ctx.sessionClock.now().toISOString(),
      );
      if (!confirmation.ok) {
        sendError(
          response,
          confirmation.status,
          "AUTOMATION_PREVIEW_STALE",
          confirmation.message,
        );
        return true;
      }
      if ("result" in confirmation) result = confirmation.result;
      else applyLocalMutation = confirmation.apply;
    } else if (isTimeEntryCommand(command)) {
      const confirmation = confirmTimeEntry(
        database,
        token.ownerId,
        command,
        () => ctx.sessionClock.now().toISOString(),
      );
      if (!confirmation.ok) {
        sendError(
          response,
          confirmation.status,
          "AUTOMATION_PREVIEW_STALE",
          confirmation.message,
        );
        return true;
      }
      applyLocalMutation = confirmation.apply;
    } else if (isFocusParityCommand(command)) {
      // ADR 0029: preferences nest in the confirmation transaction; an idle
      // disposition commits its own session transition like focus commands.
      if (command.operation === "focus.update_preferences")
        applyLocalMutation = () =>
          confirmFocusParity(
            database,
            ctx.sessionClock,
            token.ownerId,
            token.id,
            internalKey,
            requestHash,
            command,
          );
      else
        try {
          result = confirmFocusParity(
            database,
            ctx.sessionClock,
            token.ownerId,
            token.id,
            internalKey,
            requestHash,
            command,
          );
        } catch {
          sendError(
            response,
            409,
            "ACTIVE_SESSION_CONFLICT",
            "Session changed; preview the idle disposition again",
          );
          return true;
        }
    } else if (isCounterCommand(command)) {
      const confirmation = confirmCounter(
        database,
        token.ownerId,
        command,
        () => ctx.sessionClock.now().toISOString(),
      );
      if (!confirmation.ok) {
        sendError(
          response,
          confirmation.status,
          "AUTOMATION_PREVIEW_STALE",
          confirmation.message,
        );
        return true;
      }
      applyLocalMutation = confirmation.apply;
    } else if (isTaskArchiveCommand(command)) {
      const confirmation = confirmTaskArchive(
        database,
        token.ownerId,
        command,
        Object.keys(preview.baseRevisions),
      );
      if (!confirmation.ok) {
        sendError(
          response,
          confirmation.status,
          "AUTOMATION_PREVIEW_STALE",
          confirmation.message,
        );
        return true;
      }
      applyLocalMutation = confirmation.apply;
    } else if (command.operation === "tasks.hierarchy") {
      const input = command.input;
      applyLocalMutation = () => {
        const now = new Date().toISOString();
        const children = (parentId: string | null) =>
          parentId === null
            ? []
            : database.taskHierarchy
                .listChildren(token.ownerId, parentId)
                .map(taskResponse);
        const parentOf = (parentId: string | null) => {
          const parent =
            parentId === null
              ? undefined
              : database.getTask(token.ownerId, parentId);
          return parent === undefined ? null : taskResponse(parent);
        };
        if (input.action === "reorder") {
          const reordered = database.taskHierarchy.reorder({
            ownerId: token.ownerId,
            parentId: input.parentId,
            items: input.items,
            now,
          });
          if (reordered.kind !== "reordered")
            throw new Error("Child tasks changed during atomic confirmation");
          return {
            hierarchy: {
              task: null,
              parent: parentOf(input.parentId),
              children: children(input.parentId),
            },
            replayed: false,
          };
        }
        if (input.action === "move") {
          const moved = database.taskHierarchy.move({
            ownerId: token.ownerId,
            taskId: input.taskId,
            parentId: input.parentId,
            index: input.index ?? null,
            expectedRevision: input.expectedRevision,
            now,
          });
          if (moved.kind !== "moved")
            throw new Error(
              "Task hierarchy changed during atomic confirmation",
            );
          return {
            hierarchy: {
              task: taskResponse(moved.task),
              parent: parentOf(input.parentId),
              children: children(input.parentId),
            },
            replayed: false,
          };
        }
        const created = database.taskHierarchy.createChild({
          ownerId: token.ownerId,
          parentId: input.parentId,
          index: input.index ?? null,
          now,
          create: () =>
            createCapturedTask(
              database,
              token.ownerId,
              internalKey,
              createHash("sha256").update(JSON.stringify(input)).digest("hex"),
              input.task,
              now,
            ),
        });
        if (created.kind !== "created" && created.kind !== "replayed")
          throw new Error("Child task could not be created atomically");
        return {
          hierarchy: {
            task: taskResponse(created.task),
            parent: parentOf(input.parentId),
            children: children(input.parentId),
          },
          replayed: created.kind === "replayed",
        };
      };
    } else if (isTaskLinkCommand(command)) {
      const confirmation = confirmTaskLinks(database, token.ownerId, command);
      if (!confirmation.ok) {
        sendError(
          response,
          confirmation.status,
          "AUTOMATION_PREVIEW_STALE",
          confirmation.message,
        );
        return true;
      }
      applyLocalMutation = confirmation.apply;
    } else if (
      command.operation === "tasks.assign_project" ||
      command.operation === "tasks.set_tags"
    ) {
      const current = database.getTask(token.ownerId, command.input.taskId);
      if (current === undefined) {
        sendError(response, 404, "TASK_NOT_FOUND", "Task not found");
        return true;
      }
      result = { task: taskResponse(current), replayed: false };
      applyLocalMutation = () => {
        const input = command.input;
        const now = new Date().toISOString();
        const targets =
          command.operation === "tasks.assign_project"
            ? database
                .listProjects(token.ownerId)
                .filter((project) => project.id === command.input.projectId)
            : database
                .listTags(token.ownerId)
                .filter((tag) => command.input.tagIds.includes(tag.id));
        for (const target of targets) {
          if (
            target.revision !== preview.baseRevisions[target.id] ||
            target.archivedAt !== null
          )
            throw new Error("Organization changed during atomic confirmation");
        }
        const task =
          command.operation === "tasks.assign_project"
            ? database.assignTaskProject(
                token.ownerId,
                input.taskId,
                command.input.projectId,
                input.expectedRevision,
                now,
              )
            : database.setTaskTags(
                  token.ownerId,
                  input.taskId,
                  command.input.tagIds,
                  input.expectedRevision,
                  now,
                )
              ? database.getTask(token.ownerId, input.taskId)
              : undefined;
        if (task === undefined)
          throw new Error("Task assignment changed during atomic confirmation");
        return { task: taskResponse(task), replayed: false };
      };
    } else if (
      command.operation === "tasks.update" ||
      command.operation === "tasks.set_completed" ||
      command.operation === "tasks.delete" ||
      command.operation === "tasks.restore"
    ) {
      const current = database.getTask(
        token.ownerId,
        command.input.taskId,
        command.operation === "tasks.restore",
      );
      if (current === undefined) {
        sendError(response, 404, "TASK_NOT_FOUND", "Task not found");
        return true;
      }
      if (
        command.operation === "tasks.delete" &&
        deletionBlocked(token.ownerId, current.id)
      )
        return true;
      result = { task: taskResponse(current), replayed: false };
      // Execute inside the confirmation transaction so task, sync change,
      // consumed preview, audit, and replay response commit or roll back together.
      applyLocalMutation = () => {
        const now = new Date().toISOString();
        const input = command.input;
        let applied;
        if (command.operation === "tasks.delete") {
          applied = database.deleteTask(
            token.ownerId,
            input.taskId,
            input.expectedRevision,
            now,
          );
        } else if (command.operation === "tasks.restore") {
          applied = database.restoreTask(
            token.ownerId,
            input.taskId,
            input.expectedRevision,
            now,
          );
        } else if (command.operation === "tasks.set_completed") {
          applied = database.setTaskCompleted(
            token.ownerId,
            input.taskId,
            input.expectedRevision,
            command.input.completed,
            now,
          );
        } else {
          const { deadline, ...fields } = command.input.patch;
          applied = database.patchTask(
            token.ownerId,
            input.taskId,
            input.expectedRevision,
            {
              ...(fields.title === undefined ? {} : { title: fields.title }),
              ...(fields.notes === undefined ? {} : { notes: fields.notes }),
              ...(fields.plannedStart === undefined
                ? {}
                : { plannedStart: fields.plannedStart }),
              ...(fields.estimateMinutes === undefined
                ? {}
                : { estimateMinutes: fields.estimateMinutes }),
              ...(deadline === undefined
                ? {}
                : deadline === null
                  ? { deadlineDate: null, deadlineAt: null }
                  : deadline.kind === "date"
                    ? { deadlineDate: deadline.value, deadlineAt: null }
                    : { deadlineDate: null, deadlineAt: deadline.value }),
              ...planningPatch(command.input.patch),
            },
            now,
          );
        }
        if (applied.kind !== "updated")
          throw new Error("Task changed during atomic confirmation");
        return { task: taskResponse(applied.task), replayed: false };
      };
    } else if (command.operation === "habits.mutate") {
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
    } else if (isCaptureBatchCommand(command)) {
      let batch;
      try {
        batch = confirmCaptureBatch(
          database,
          token.ownerId,
          internalKey,
          createHash("sha256")
            .update(JSON.stringify(command.input))
            .digest("hex"),
          command,
          new Date().toISOString(),
        );
      } catch (error) {
        if (!(error instanceof StructuredCaptureError)) throw error;
        sendError(response, 400, "INVALID_TASK", error.message);
        return true;
      }
      if (batch.kind === "conflict") {
        sendError(
          response,
          409,
          "IDEMPOTENCY_CONFLICT",
          "Operation key conflict",
        );
        return true;
      }
      result = batch.result;
    } else if (isTimeBlockCommand(command)) {
      const taskRevision = preview.baseRevisions[command.input.taskId];
      if (taskRevision === undefined) {
        sendError(response, 404, "TASK_NOT_FOUND", "Task not found");
        return true;
      }
      const outcome =
        command.operation === "schedule.remove_time_block"
          ? await confirmTimeBlockRemove(
              database,
              connector,
              token.ownerId,
              command,
              taskRevision,
            )
          : await confirmTimeBlockWrite(
              database,
              connector,
              token.ownerId,
              internalKey,
              command,
              taskRevision,
            );
      if (!outcome.ok) {
        // Provider failures leave the preview open for another attempt and
        // are recorded so the owner can see why the receipt is missing.
        database.appendAutomationAudit({
          id: randomUUID(),
          ownerId: token.ownerId,
          tokenId: token.id,
          operation: preview.operation,
          phase: "execute",
          outcome: "failed",
          errorCode: outcome.code,
          previewId: preview.id,
          affectedIds: preview.affectedIds,
          requestHash,
          createdAt: new Date().toISOString(),
        });
        if (outcome.body === undefined)
          sendError(response, outcome.status, outcome.code, outcome.message);
        else
          sendJson(response, outcome.status, {
            code: outcome.code,
            message: outcome.message,
            requestId: randomUUID(),
            ...outcome.body,
          });
        return true;
      }
      result = outcome.result;
      applyLocalMutation = outcome.apply;
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
    const responseBody = (
      value: AutomationConfirmationResponse["result"],
    ): AutomationConfirmationResponse => ({
      previewId: preview.id,
      operation: command.operation,
      replayed: false,
      result: value,
    });
    let body = result === undefined ? undefined : responseBody(result);
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
      applyLocalMutation === undefined
        ? undefined
        : () => {
            body = responseBody(applyLocalMutation());
            return body;
          },
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
    if (body === undefined) throw new Error("Confirmation result missing");
    sendJson(response, 200, body);
    return true;
  }

  return false;
};
