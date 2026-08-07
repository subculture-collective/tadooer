import { createReadStream, existsSync, statSync } from "node:fs";
import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { isIP, type AddressInfo } from "node:net";
import type {
  ApiError,
  BaikalStatusResponse,
  BuildResponse,
  HealthResponse,
  SessionResponse,
  SetupStatusResponse,
  TaskListResponse,
  TaskMutationResponse,
  Task,
  ConditionalTaskMutationResponse,
  PlannerResponse,
  TaskTimeBlockMutationResponse,
  ReadinessResponse,
  ClientRegistrationResponse,
  SyncRoundResponse,
  SyncSnapshotResponse,
  Project,
  Tag,
  Subtask,
  ActiveSessionCommandResponse,
  ActiveSession as ContractActiveSession,
  AutomationConfirmationResponse,
  AutomationPreviewCommand,
  AutomationTokenScope,
  TaskTemplate,
  TemplateSubtaskBlueprint,
  TemplateSet,
  TemplateInstantiationResponse,
  ChoicePool,
  ChoicePoolItem,
  ChoicePoolHistoryEvent,
  PlanningPlaceholder,
  PlanningPlaceholderResolutionResponse,
  DayPlanResponse,
} from "@suite/contracts";
import {
  baikalConnectRequestSchema,
  createTaskRequestSchema,
  createTaskTimeBlockRequestSchema,
  conditionalRequestHeadersSchema,
  idempotencyKeySchema,
  loginRequestSchema,
  ownerSetupRequestSchema,
  plannerWindowSchema,
  taskPatchRequestSchema,
  clientRegistrationRequestSchema,
  clientAuthenticationHeadersSchema,
  syncRoundRequestSchema,
  activeSessionCommandSchema,
  automationConfirmRequestSchema,
  automationFocusCommandInputSchema,
  automationPreviewCommandSchema,
  createAutomationTokenRequestSchema,
  automationCatalog,
  createTaskTemplateRequestSchema,
  createTaskTemplateFromTaskRequestSchema,
  taskTemplatePatchRequestSchema,
  createTemplateSetRequestSchema,
  instantiateTemplateRequestSchema,
  templateSearchRequestSchema,
  createChoicePoolRequestSchema,
  createPlanningPlaceholderRequestSchema,
  resolvePlanningPlaceholderRequestSchema,
  updateChoicePoolRequestSchema,
  createTemplatePoolSlotRequestSchema,
  completeChoicePoolItemRequestSchema,
  calendarImportPreviewRequestSchema,
  calendarImportReportSchema,
  calendarFeedCreateRequestSchema,
  planningPreferencesSchema,
} from "@suite/contracts";
import { parseIcsImport, serializeCalendarFeed } from "@suite/import-export";
import {
  SuiteDatabase,
  type TaskRecord,
  type ConditionalTaskResult,
  type ActiveSessionRecord,
  type ActiveSessionIntervalRecord,
  type ActiveSessionEventRecord,
  type TemplateInstantiationResult,
  type PlanningPlaceholderResolutionResult,
  type PlanningPlaceholderResolutionRecord,
} from "@suite/persistence";
import {
  createActiveSession,
  observeActiveSession,
  transitionActiveSession,
  type ActiveSession,
  type SessionClock,
  suggestChoicePool,
  validateChoicePoolSelection,
  buildCalmDay,
} from "@suite/domain";
import type { CalendarEventResource } from "@suite/caldav";
import type { ServerConfig } from "./config.ts";
import {
  AuthService,
  clearSessionCookie,
  LoginRateLimiter,
  passwordMeetsPolicy,
  sessionCookie,
} from "./auth.ts";
import {
  BaikalConnectorService,
  type CalendarOperationResult,
  type ConnectorFailure,
} from "./connector.ts";
import { GoogleConnectorService } from "./google-connector.ts";

const mimeTypes: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json",
};

const securityHeaders = {
  "Content-Security-Policy":
    "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
} as const;

const maxJsonBytes = 5 * 1024 * 1024;

const automationTokenResponse = (token: {
  readonly id: string;
  readonly ownerId: string;
  readonly label: string;
  readonly scopes: readonly string[];
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
  readonly expiresAt: string | null;
  readonly revokedAt: string | null;
}) => ({
  id: token.id,
  ownerId: token.ownerId,
  label: token.label,
  scopes: token.scopes,
  createdAt: token.createdAt,
  lastUsedAt: token.lastUsedAt,
  expiresAt: token.expiresAt ?? token.createdAt,
  revokedAt: token.revokedAt,
});

const automationScopeFor = (
  operation: AutomationPreviewCommand["operation"],
): AutomationTokenScope => {
  const entry = automationCatalog.find(({ id }) => id === operation);
  const scope = entry?.scopes[0];
  if (scope === undefined)
    throw new Error(`Automation catalog scope is missing for ${operation}`);
  return scope;
};

const automationPreviewPath = automationCatalog.find(
  ({ id }) => id === "tasks.create",
)?.apiPath;
const automationConfirmPath = automationCatalog.find(
  ({ id }) => id === "automation.confirm",
)?.apiPath;
const automationResourceEntries = automationCatalog.filter(
  (entry) => entry.kind === "resource",
);
const requiredAutomationResources = [
  "tasks.list",
  "schedule.get",
  "projects.list",
  "tags.list",
  "active-session.get",
  "templates.list",
  "template-sets.list",
  "pools.list",
] as const;
if (
  automationPreviewPath === undefined ||
  automationConfirmPath === undefined ||
  requiredAutomationResources.some(
    (id) => !automationResourceEntries.some((entry) => entry.id === id),
  )
)
  throw new Error(
    "Suite automation catalog and HTTP handlers are out of parity",
  );

const taskResponse = (task: TaskRecord): Task => ({
  id: task.id,
  title: task.title,
  notes: task.notes,
  status: task.status,
  revision: task.revision,
  createdAt: task.createdAt,
  updatedAt: task.updatedAt,
  completedAt: task.completedAt,
  deletedAt: task.deletedAt,
  plannedStart: task.plannedStart,
  estimateMinutes: task.estimateMinutes,
  projectId: task.projectId ?? null,
  tagIds: [...(task.tagIds ?? [])],
});

const templateResponse = (template: {
  readonly id: string;
  readonly ownerId: string;
  readonly title: string;
  readonly notes: string;
  readonly estimateMinutes: number | null;
  readonly suggestedProjectId: string | null;
  readonly tagIds: readonly string[];
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
}): TaskTemplate => ({ ...template, tagIds: [...template.tagIds] });

const templateBlueprintResponse = (blueprint: {
  readonly id: string;
  readonly templateId: string;
  readonly title: string;
  readonly position: number;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}): TemplateSubtaskBlueprint => ({ ...blueprint });

const templateSetResponse = (set: {
  readonly id: string;
  readonly ownerId: string;
  readonly title: string;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
}): TemplateSet => ({ ...set });

const choicePoolResponse = (pool: ChoicePool): ChoicePool => ({ ...pool });
const choicePoolItemResponse = (item: ChoicePoolItem): ChoicePoolItem => ({
  ...item,
});
const choicePoolHistoryResponse = (
  event: ChoicePoolHistoryEvent,
): ChoicePoolHistoryEvent => ({ ...event });
const planningPlaceholderResponse = (
  placeholder: PlanningPlaceholder,
): PlanningPlaceholder => ({ ...placeholder });
const planningResolutionResponse = (
  resolution: PlanningPlaceholderResolutionRecord,
) => ({
  ...resolution,
  selectedItemIds: [...resolution.selectedItemIds],
  subtaskIds: [...resolution.subtaskIds],
  historyIds: [...resolution.historyIds],
});
const placeholderResolutionResponse = (
  result: PlanningPlaceholderResolutionResult,
): PlanningPlaceholderResolutionResponse => {
  if (
    result.placeholder === undefined ||
    result.resolution === undefined ||
    result.subtasks === undefined ||
    result.history === undefined
  )
    throw new Error("Resolved placeholder result is incomplete");
  return {
    placeholder: planningPlaceholderResponse(result.placeholder),
    resolution: planningResolutionResponse(result.resolution),
    subtasks: result.subtasks.map(subtaskResponse),
    history: result.history.map(choicePoolHistoryResponse),
    replayed: result.kind === "replayed",
  };
};

const choiceSuggestion = (
  database: SuiteDatabase,
  ownerId: string,
  poolId: string,
  logicalTime: string,
) => {
  const pool = database.getChoicePool(ownerId, poolId);
  if (pool === undefined) return undefined;
  const items = database.listChoicePoolItems(poolId, true);
  const history = database
    .listChoicePoolHistory(poolId)
    .filter(({ kind }) => kind === "selected")
    .map(({ itemId, occurredAt, cycle }) => ({
      itemId,
      selectedAt: occurredAt,
      cycle,
    }));
  const suggestion = suggestChoicePool(
    {
      policy: pool.policy,
      pickCount: pool.pickCount,
      cooldownSeconds: pool.cooldownSeconds,
    },
    items.map(({ id, position, archivedAt }) => ({
      id,
      position,
      archived: archivedAt !== null,
    })),
    history,
    logicalTime,
  );
  return { pool, items, history, suggestion };
};

const sendJson = (
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): void => {
  response.writeHead(status, {
    ...securityHeaders,
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    ...headers,
  });
  response.end(JSON.stringify(body));
};

const sendError = (
  response: ServerResponse,
  status: number,
  code: string,
  message: string,
): void => {
  const body: ApiError = { code, message, requestId: randomUUID() };
  sendJson(response, status, body);
};

const expectedRevision = (
  request: IncomingMessage,
  response: ServerResponse,
): number | undefined => {
  const header = request.headers["if-match"];
  if (header === undefined) {
    sendError(
      response,
      428,
      "PRECONDITION_REQUIRED",
      "A current task If-Match header is required",
    );
    return undefined;
  }
  const parsed = conditionalRequestHeadersSchema.safeParse({ ifMatch: header });
  if (!parsed.success) {
    sendError(
      response,
      400,
      "INVALID_PRECONDITION",
      "The task If-Match header is invalid",
    );
    return undefined;
  }
  return Number(parsed.data.ifMatch.slice(1, -1));
};

const sendConditionalTask = (
  response: ServerResponse,
  result: ConditionalTaskResult,
): void => {
  if (result.kind === "not-found") {
    sendError(response, 404, "TASK_NOT_FOUND", "Task not found");
    return;
  }
  if (result.kind === "precondition-failed") {
    sendError(
      response,
      412,
      "TASK_REVISION_CONFLICT",
      "The task changed; reload it before trying again",
    );
    return;
  }
  const body: ConditionalTaskMutationResponse = {
    task: taskResponse(result.task),
  };
  sendJson(response, 200, body, {
    ETag: `"${String(result.task.revision)}"`,
  });
};

const sameOrigin = (request: IncomingMessage): boolean => {
  const origin = request.headers.origin;
  const host = request.headers.host;
  if (origin === undefined || host === undefined) return false;
  try {
    const parsed = new URL(origin);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      parsed.host === host &&
      parsed.username === "" &&
      parsed.password === ""
    );
  } catch {
    return false;
  }
};

const normalizedAddress = (value: string): string =>
  value.startsWith("::ffff:") ? value.slice(7) : value;

const clientAddress = (
  request: IncomingMessage,
  trustedProxyCidrs: readonly string[],
): string => {
  const remote = normalizedAddress(request.socket.remoteAddress ?? "unknown");
  const trusted = trustedProxyCidrs.some((cidr) => {
    const [address, prefix] = cidr.split("/");
    return (
      address !== undefined &&
      ((prefix === "32" && normalizedAddress(address) === remote) ||
        (prefix === "128" && address === remote))
    );
  });
  if (!trusted) return remote;
  const forwarded = request.headers["x-forwarded-for"];
  if (
    typeof forwarded !== "string" ||
    forwarded.includes(",") ||
    isIP(forwarded.trim()) === 0
  )
    return remote;
  return normalizedAddress(forwarded.trim());
};

const readJson = async (request: IncomingMessage): Promise<unknown> => {
  const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim();
  if (contentType !== "application/json") throw new Error("CONTENT_TYPE");
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk as Uint8Array);
    bytes += buffer.byteLength;
    if (bytes > maxJsonBytes) throw new Error("BODY_TOO_LARGE");
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new Error("INVALID_JSON");
  }
};

const connectorStatus = (reason: ConnectorFailure): number =>
  reason === "authentication-required"
    ? 401
    : reason === "authorization-denied"
      ? 403
      : reason === "credential-unavailable"
        ? 409
        : 502;

const sendEmpty = (response: ServerResponse, status: number): void => {
  response.writeHead(status, securityHeaders);
  response.end();
};

const isInside = (root: string, candidate: string): boolean =>
  candidate === root || candidate.startsWith(`${root}${sep}`);

const serveFile = (response: ServerResponse, path: string): void => {
  response.writeHead(200, {
    ...securityHeaders,
    "Cache-Control": path.endsWith(".html")
      ? "no-cache"
      : "public, max-age=31536000, immutable",
    "Content-Type": mimeTypes[extname(path)] ?? "application/octet-stream",
  });
  createReadStream(path).pipe(response);
};

const cursorFor = (state: {
  readonly epoch: string;
  readonly cursor: number;
}): string => `${state.epoch}.${String(state.cursor)}`;

const parseCursor = (
  cursor: string,
): { readonly epoch: string; readonly sequence: number } | undefined => {
  const index = cursor.lastIndexOf(".");
  if (index < 1) return undefined;
  const sequence = Number(cursor.slice(index + 1));
  return Number.isInteger(sequence) && sequence >= 0
    ? { epoch: cursor.slice(0, index), sequence }
    : undefined;
};

const projectResponse = (project: {
  readonly id: string;
  readonly ownerId: string;
  readonly title: string;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
}): Project => ({ ...project });

const tagResponse = (tag: {
  readonly id: string;
  readonly ownerId: string;
  readonly title: string;
  readonly normalizedName: string;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
}): Tag => ({
  id: tag.id,
  ownerId: tag.ownerId,
  displayName: tag.title,
  normalizedName: tag.normalizedName,
  revision: tag.revision,
  createdAt: tag.createdAt,
  updatedAt: tag.updatedAt,
  archivedAt: tag.archivedAt,
});

const subtaskResponse = (subtask: {
  readonly id: string;
  readonly taskId: string;
  readonly title: string;
  readonly completed: boolean;
  readonly position: number;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}): Subtask => ({ ...subtask });

const templateInstantiationResponse = (
  result: TemplateInstantiationResult,
): TemplateInstantiationResponse => {
  if (
    (result.kind !== "created" && result.kind !== "replayed") ||
    result.instantiationId === undefined ||
    result.tasks === undefined
  )
    throw new Error("Template instantiation result is incomplete");
  return {
    instantiationId: result.instantiationId,
    tasks: result.tasks.map((tree) => ({
      task: taskResponse(tree.task),
      subtasks: tree.subtasks.map(subtaskResponse),
      provenance: tree.provenance,
    })),
    replayed: result.kind === "replayed",
  };
};

const activeFromRecord = (
  record: ActiveSessionRecord,
  database: SuiteDatabase,
): ActiveSession =>
  activeFromPersistence(
    record,
    database.listActiveSessionIntervals(record.id),
    database.listActiveSessionEvents(record.id),
  );

const activeFromPersistence = (
  record: ActiveSessionRecord,
  intervals: readonly ActiveSessionIntervalRecord[],
  events: readonly ActiveSessionEventRecord[],
): ActiveSession => ({
  id: record.id,
  ownerId: record.ownerId,
  controllerClientId: record.controllerClientId,
  taskId: record.taskId,
  state: record.state,
  phase: record.phase,
  revision: record.revision,
  startedAt: record.startedAt,
  updatedAt: record.updatedAt,
  leaseExpiresAt: record.leaseExpiresAt,
  hardExpiresAt: record.hardExpiresAt,
  terminalReason:
    record.state === "completed" || record.state === "expired"
      ? record.state
      : null,
  intervals: intervals.map((interval) => ({
    id: interval.id,
    ordinal: interval.ordinal,
    kind: interval.phase,
    taskId: interval.taskId,
    controllerClientId: interval.controllerClientId,
    startedAt: interval.startedAt,
    endedAt: interval.endedAt,
    closedBy: interval.closedBy as
      "pause" | "break" | "complete" | "takeover" | "expiry" | null,
  })),
  events: events.map((event) => ({
    revision: event.revision,
    type: event.kind,
    actorClientId: event.actorClientId,
    occurredAt: event.createdAt,
  })),
});

const recordFromActive = (session: ActiveSession): ActiveSessionRecord => ({
  id: session.id,
  ownerId: session.ownerId,
  taskId: session.taskId ?? "",
  controllerClientId: session.controllerClientId,
  state: session.state,
  phase: session.phase,
  revision: session.revision,
  startedAt: session.startedAt,
  leaseExpiresAt: session.leaseExpiresAt,
  hardExpiresAt: session.hardExpiresAt,
  createdAt: session.startedAt,
  updatedAt: session.updatedAt,
  endedAt:
    session.state === "completed" || session.state === "expired"
      ? session.updatedAt
      : null,
});

const intervalsFromActive = (
  session: ActiveSession,
): readonly ActiveSessionIntervalRecord[] =>
  session.intervals.map((interval) => ({
    id: interval.id,
    ordinal: interval.ordinal,
    phase: interval.kind,
    taskId: interval.taskId,
    controllerClientId: interval.controllerClientId,
    startedAt: interval.startedAt,
    endedAt: interval.endedAt,
    closedBy: interval.closedBy,
  }));
const eventsFromActive = (
  session: ActiveSession,
): readonly ActiveSessionEventRecord[] =>
  session.events.map((event) => ({
    kind: event.type,
    revision: event.revision,
    actorClientId: event.actorClientId,
    createdAt: event.occurredAt,
  }));
const activeResponse = (session: ActiveSession): ContractActiveSession => ({
  id: session.id,
  ownerId: session.ownerId,
  taskId: session.taskId ?? "",
  controllerClientId: session.controllerClientId,
  state: session.state,
  phase: session.phase,
  revision: session.revision,
  startedAt: session.startedAt,
  updatedAt: session.updatedAt,
  leaseExpiresAt: session.leaseExpiresAt,
  hardExpiresAt: session.hardExpiresAt,
  currentIntervalId:
    session.intervals.find((interval) => interval.endedAt === null)?.id ?? null,
});

export interface RunningSuiteServer {
  readonly baseUrl: string;
  close(): Promise<void>;
}

export interface SuiteServerOptions {
  readonly connectorFetch?: typeof fetch;
  readonly googleFetch?: typeof fetch;
  readonly sessionClock?: SessionClock;
}

export const startSuiteServer = async (
  config: ServerConfig,
  options: SuiteServerOptions = {},
): Promise<RunningSuiteServer> => {
  const database = SuiteDatabase.open(config.databasePath);
  const webRoot = resolve(config.webRoot);
  const auth = new AuthService(database);
  const sessionClock = options.sessionClock ?? { now: () => new Date() };
  const loginLimiter = new LoginRateLimiter();
  const connector = new BaikalConnectorService(
    database,
    new URL(config.baikalEndpoint),
    config.credentialKeyPath,
    options.connectorFetch,
  );
  const google = new GoogleConnectorService(
    database,
    config.credentialKeyPath,
    config.googleOAuthConfigPath,
    options.googleFetch,
  );
  const startedAt = Date.now();
  const requestCounts = new Map<number, number>();

  const authenticateAutomation = (
    request: IncomingMessage,
    response: ServerResponse,
    scope?: AutomationTokenScope,
  ) => {
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
    const match =
      /^Bearer (suite_at_([0-9a-f-]{36})\.([A-Za-z0-9_-]{43}))$/.exec(
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
  };

  const server = createServer(
    (request: IncomingMessage, response: ServerResponse) => {
      response.once("finish", () =>
        requestCounts.set(
          response.statusCode,
          (requestCounts.get(response.statusCode) ?? 0) + 1,
        ),
      );
      const handleRequest = async (): Promise<void> => {
        const method = request.method ?? "GET";
        const url = new URL(request.url ?? "/", "http://suite.local");
        const timestamp = new Date().toISOString();

        if (config.publicOrigin !== undefined) {
          const expected = new URL(config.publicOrigin);
          if (request.headers.host !== expected.host) {
            sendError(
              response,
              421,
              "PUBLIC_ORIGIN_MISMATCH",
              "Request host does not match the configured public origin",
            );
            return;
          }
          if (
            request.headers.origin !== undefined &&
            request.headers.origin !== expected.origin
          ) {
            sendError(
              response,
              403,
              "ORIGIN_REQUIRED",
              "Request origin does not match the configured public origin",
            );
            return;
          }
        }

        const publicFeedMatch =
          /^\/feeds\/([0-9a-f-]{36})\/([A-Za-z0-9_-]{43})\.ics$/.exec(
            url.pathname,
          );
        if (publicFeedMatch !== null) {
          if (method !== "GET" && method !== "HEAD") {
            response.writeHead(405, {
              ...securityHeaders,
              Allow: "GET, HEAD",
              "Cache-Control": "private, no-store",
            });
            response.end();
            return;
          }
          const capability = database.getCalendarFeedCapability(
            publicFeedMatch[1] ?? "",
          );
          const supplied = createHash("sha256")
            .update(publicFeedMatch[2] ?? "")
            .digest();
          const expected =
            capability === undefined
              ? Buffer.alloc(32)
              : Buffer.from(capability.secretHash, "base64url");
          if (
            capability?.revokedAt !== null ||
            expected.length !== supplied.length ||
            !timingSafeEqual(expected, supplied)
          ) {
            sendError(
              response,
              404,
              "FEED_NOT_FOUND",
              "Calendar feed is unavailable",
            );
            return;
          }
          const feed = serializeCalendarFeed(
            database.listPublishedCalendarRaw(
              capability.ownerId,
              capability.calendarId,
            ),
          );
          response.writeHead(200, {
            ...securityHeaders,
            "Cache-Control": "private, no-store",
            "Content-Type": "text/calendar; charset=utf-8",
            "Content-Disposition": 'inline; filename="suite-read-only.ics"',
            Allow: "GET, HEAD",
          });
          response.end(method === "HEAD" ? undefined : feed);
          return;
        }

        if (method === "GET" && url.pathname === "/api/health") {
          const body: HealthResponse = {
            service: "productivity-suite",
            status: "ok",
            timestamp,
          };
          sendJson(response, 200, body);
          return;
        }

        if (method === "GET" && url.pathname === "/api/metrics") {
          const state = database.state();
          const lines = [
            "# HELP suite_uptime_seconds Process uptime in seconds.",
            "# TYPE suite_uptime_seconds gauge",
            `suite_uptime_seconds ${String(Math.floor((Date.now() - startedAt) / 1000))}`,
            "# HELP suite_database_migrations Applied SQLite migrations.",
            "# TYPE suite_database_migrations gauge",
            `suite_database_migrations ${String(state.appliedMigrationCount)}`,
            "# HELP suite_http_requests_total Completed HTTP responses by status.",
            "# TYPE suite_http_requests_total counter",
            ...[...requestCounts.entries()]
              .sort(([left], [right]) => left - right)
              .map(
                ([status, count]) =>
                  `suite_http_requests_total{status="${String(status)}"} ${String(count)}`,
              ),
            "",
          ];
          response.writeHead(200, {
            ...securityHeaders,
            "Cache-Control": "no-store",
            "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
          });
          response.end(lines.join("\n"));
          return;
        }

        if (method === "GET" && url.pathname === "/api/build") {
          const body: BuildResponse = {
            service: "productivity-suite",
            ...config.build,
          };
          sendJson(response, 200, body);
          return;
        }

        if (method === "POST" && url.pathname === "/api/imports/preview") {
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
            return;
          }
          const parsed = calendarImportPreviewRequestSchema.safeParse(
            await readJson(request),
          );
          if (!parsed.success) {
            sendError(
              response,
              400,
              "INVALID_IMPORT",
              "Calendar import input is invalid",
            );
            return;
          }
          const report = parseIcsImport(parsed.data.source, parsed.data.rawIcs);
          const jobId = randomUUID();
          const result = database.createCalendarImportPreview({
            id: jobId,
            ownerId: session.owner.id,
            calendarId: parsed.data.calendarId,
            source: parsed.data.source,
            inputHash: report.inputHash,
            report,
            candidates: report.candidates.map((candidate) => ({
              externalId: candidate.externalId,
              uid: candidate.uid,
              rawIcs: candidate.rawIcs,
              href: `${createHash("sha256").update(`${parsed.data.calendarId}\0${candidate.externalId}`).digest("hex").slice(0, 40)}.ics`,
            })),
            createdAt: timestamp,
          });
          if (result === undefined) {
            sendError(
              response,
              404,
              "CALENDAR_NOT_FOUND",
              "Destination calendar not found",
            );
            return;
          }
          sendJson(response, result.replayed ? 200 : 201, {
            job: {
              ...result.job,
              report: calendarImportReportSchema.parse(result.job.report),
              items: result.job.items.map((item) => ({
                externalId: item.externalId,
                uid: item.uid,
                href: item.href,
                state: item.state,
                appliedAt: item.appliedAt,
              })),
            },
            replayed: result.replayed,
          });
          return;
        }

        const importMatch =
          /^\/api\/imports\/([0-9a-f-]{36})(?:\/(apply))?$/.exec(url.pathname);
        if (importMatch !== null) {
          const session = auth.authenticate(request, method === "POST");
          if (session === undefined) {
            sendError(response, 401, "AUTH_REQUIRED", "Owner session required");
            return;
          }
          if (method === "GET" && importMatch[2] === undefined) {
            const job = database.getCalendarImportJob(
              session.owner.id,
              importMatch[1] ?? "",
            );
            if (job === undefined)
              sendError(
                response,
                404,
                "IMPORT_NOT_FOUND",
                "Calendar import not found",
              );
            else
              sendJson(response, 200, {
                job: {
                  ...job,
                  report: calendarImportReportSchema.parse(job.report),
                  items: job.items.map((item) => ({
                    externalId: item.externalId,
                    uid: item.uid,
                    href: item.href,
                    state: item.state,
                    appliedAt: item.appliedAt,
                  })),
                },
                replayed: job.state !== "previewed",
              });
            return;
          }
          if (method === "POST" && importMatch[2] === "apply") {
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
              return;
            }
            const job = database.getCalendarImportJob(
              session.owner.id,
              importMatch[1] ?? "",
            );
            if (job === undefined) {
              sendError(
                response,
                404,
                "IMPORT_NOT_FOUND",
                "Calendar import not found",
              );
              return;
            }
            const replayed = job.state === "applied";
            if (!replayed) {
              for (const item of job.items) {
                if (item.state === "applied") continue;
                const write = await connector.putImportedEvent({
                  ownerId: session.owner.id,
                  calendarId: job.calendarId,
                  href: item.href,
                  rawIcs: item.rawIcs,
                });
                database.markCalendarImportItem(
                  session.owner.id,
                  job.id,
                  item.externalId,
                  write.ok || write.reason === "precondition-failed"
                    ? "applied"
                    : "reconciliation_required",
                  timestamp,
                );
              }
            }
            const completed = database.finishCalendarImport(
              session.owner.id,
              job.id,
              timestamp,
            );
            if (completed === undefined)
              throw new Error("Calendar import disappeared");
            sendJson(response, 200, {
              job: {
                ...completed,
                report: calendarImportReportSchema.parse(completed.report),
                items: completed.items.map((item) => ({
                  externalId: item.externalId,
                  uid: item.uid,
                  href: item.href,
                  state: item.state,
                  appliedAt: item.appliedAt,
                })),
              },
              replayed,
            });
            return;
          }
          sendError(response, 405, "METHOD_NOT_ALLOWED", "Method not allowed");
          return;
        }

        const exportMatch =
          /^\/api\/calendars\/([0-9a-f-]{36})\/export\.ics$/.exec(url.pathname);
        if (method === "GET" && exportMatch !== null) {
          const session = auth.authenticate(request, false);
          const calendarId = exportMatch[1] ?? "";
          if (session === undefined) {
            sendError(response, 401, "AUTH_REQUIRED", "Owner session required");
            return;
          }
          if (
            database.getOwnedCalendar(session.owner.id, calendarId) ===
            undefined
          ) {
            sendError(
              response,
              404,
              "CALENDAR_NOT_FOUND",
              "Calendar not found",
            );
            return;
          }
          const feed = serializeCalendarFeed(
            database.listPublishedCalendarRaw(session.owner.id, calendarId),
          );
          response.writeHead(200, {
            ...securityHeaders,
            "Cache-Control": "no-store",
            "Content-Type": "text/calendar; charset=utf-8",
            "Content-Disposition": 'attachment; filename="suite-calendar.ics"',
          });
          response.end(feed);
          return;
        }

        if (url.pathname === "/api/calendar-feeds") {
          const session = auth.authenticate(request, method === "POST");
          if (session === undefined) {
            sendError(response, 401, "AUTH_REQUIRED", "Owner session required");
            return;
          }
          if (method === "GET") {
            sendJson(response, 200, {
              capabilities: database
                .listCalendarFeedCapabilities(session.owner.id)
                .map((record) => ({
                  id: record.id,
                  calendarId: record.calendarId,
                  label: record.label,
                  createdAt: record.createdAt,
                  revokedAt: record.revokedAt,
                })),
            });
            return;
          }
          if (method === "POST") {
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
              return;
            }
            const parsed = calendarFeedCreateRequestSchema.safeParse(
              await readJson(request),
            );
            if (
              !parsed.success ||
              database.getOwnedCalendar(
                session.owner.id,
                parsed.data.calendarId,
              ) === undefined
            ) {
              sendError(
                response,
                400,
                "INVALID_FEED",
                "Read-only feed input is invalid",
              );
              return;
            }
            const id = randomUUID();
            const secret = randomBytes(32).toString("base64url");
            const record = {
              id,
              ownerId: session.owner.id,
              calendarId: parsed.data.calendarId,
              label: parsed.data.label,
              secretHash: createHash("sha256")
                .update(secret)
                .digest("base64url"),
              createdAt: timestamp,
              revokedAt: null,
            };
            database.createCalendarFeedCapability(record);
            const capability = {
              id: record.id,
              calendarId: record.calendarId,
              label: record.label,
              createdAt: record.createdAt,
              revokedAt: record.revokedAt,
            };
            sendJson(response, 201, {
              capability,
              url: `/feeds/${id}/${secret}.ics`,
            });
            return;
          }
        }
        const feedRevokeMatch = /^\/api\/calendar-feeds\/([0-9a-f-]{36})$/.exec(
          url.pathname,
        );
        if (method === "DELETE" && feedRevokeMatch !== null) {
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
            return;
          }
          if (
            !database.revokeCalendarFeedCapability(
              session.owner.id,
              feedRevokeMatch[1] ?? "",
              timestamp,
            )
          )
            sendError(
              response,
              404,
              "FEED_NOT_FOUND",
              "Calendar feed not found",
            );
          else {
            response.writeHead(204, {
              ...securityHeaders,
              "Cache-Control": "no-store",
            });
            response.end();
          }
          return;
        }

        if (method === "GET" && url.pathname === "/api/ready") {
          try {
            database.check();
            const state = database.state();
            const current =
              state.appliedMigrationCount === state.expectedMigrationCount;
            const body: ReadinessResponse = {
              service: "productivity-suite",
              status: current ? "ok" : "not_ready",
              checks: {
                database: "ok",
                migrations: current ? "current" : "pending",
              },
              instanceId: state.install.instanceId,
              migrationCount: state.appliedMigrationCount,
              timestamp,
            };
            sendJson(response, current ? 200 : 503, body);
          } catch {
            const body: ReadinessResponse = {
              service: "productivity-suite",
              status: "not_ready",
              checks: { database: "error", migrations: "error" },
              instanceId: null,
              migrationCount: 0,
              timestamp,
            };
            sendJson(response, 503, body);
          }
          return;
        }

        if (method === "GET" && url.pathname === "/api/setup/status") {
          const body: SetupStatusResponse = {
            setupRequired: auth.setupRequired(),
          };
          sendJson(response, 200, body);
          return;
        }

        if (method === "POST" && url.pathname === "/api/setup") {
          if (!sameOrigin(request)) {
            sendError(
              response,
              403,
              "ORIGIN_REQUIRED",
              "Same-origin request required",
            );
            return;
          }
          const parsed = ownerSetupRequestSchema.safeParse(
            await readJson(request),
          );
          if (!parsed.success || !passwordMeetsPolicy(parsed.data.password)) {
            sendError(
              response,
              400,
              "INVALID_SETUP",
              "Owner setup input is invalid",
            );
            return;
          }
          const created = await auth.setup(parsed.data);
          if (!created) {
            sendError(
              response,
              409,
              "SETUP_COMPLETE",
              "Owner setup is already complete",
            );
            return;
          }
          console.info("auth.setup.completed");
          const body: SetupStatusResponse = { setupRequired: false };
          sendJson(response, 201, body);
          return;
        }

        if (method === "POST" && url.pathname === "/api/auth/login") {
          if (!sameOrigin(request)) {
            sendError(
              response,
              403,
              "ORIGIN_REQUIRED",
              "Same-origin request required",
            );
            return;
          }
          const parsed = loginRequestSchema.safeParse(await readJson(request));
          if (!parsed.success) {
            sendError(
              response,
              401,
              "INVALID_CREDENTIALS",
              "Invalid username or password",
            );
            return;
          }
          const limiterKey = `${clientAddress(request, config.trustedProxyCidrs ?? [])}:${parsed.data.username.toLowerCase()}`;
          if (!loginLimiter.allows(limiterKey)) {
            console.warn("auth.login.rate_limited");
            sendError(
              response,
              429,
              "LOGIN_RATE_LIMITED",
              "Too many login attempts",
            );
            return;
          }
          const session = await auth.login(
            parsed.data.username,
            parsed.data.password,
          );
          if (session === undefined) {
            loginLimiter.failed(limiterKey);
            console.warn("auth.login.failed");
            sendError(
              response,
              401,
              "INVALID_CREDENTIALS",
              "Invalid username or password",
            );
            return;
          }
          loginLimiter.succeeded(limiterKey);
          console.info("auth.login.succeeded");
          sendJson(response, 200, auth.response(session), {
            "Set-Cookie": sessionCookie(session.token, config.secureCookies),
          });
          return;
        }

        if (method === "GET" && url.pathname === "/api/auth/session") {
          const session = auth.resume(request);
          if (session === undefined) {
            sendError(
              response,
              401,
              "AUTH_REQUIRED",
              "Authentication required",
            );
            return;
          }
          const body: SessionResponse = auth.response(session);
          sendJson(response, 200, body);
          return;
        }

        if (method === "POST" && url.pathname === "/api/auth/logout") {
          if (!sameOrigin(request)) {
            sendError(
              response,
              403,
              "ORIGIN_REQUIRED",
              "Same-origin request required",
            );
            return;
          }
          const session = auth.authenticate(request, true);
          if (
            session === undefined ||
            !auth.csrfMatches(
              session,
              request.headers["x-csrf-token"] as string | undefined,
            )
          ) {
            sendError(
              response,
              403,
              "CSRF_INVALID",
              "Valid session and CSRF token required",
            );
            return;
          }
          auth.revoke(session);
          console.info("auth.logout.completed");
          sendJson(
            response,
            200,
            { loggedOut: true },
            {
              "Set-Cookie": clearSessionCookie(config.secureCookies),
            },
          );
          return;
        }

        if (method === "GET" && url.pathname === "/api/connectors/baikal") {
          const session = auth.authenticate(request, false);
          if (session === undefined) {
            sendError(
              response,
              401,
              "AUTH_REQUIRED",
              "Authentication required",
            );
            return;
          }
          const result = await connector.status(session.owner.id);
          if (!result.ok) {
            sendError(
              response,
              connectorStatus(result.reason),
              "BAIKAL_UNAVAILABLE",
              "Baïkal connection could not be verified",
            );
            return;
          }
          const body: BaikalStatusResponse = result.status;
          sendJson(response, 200, body);
          return;
        }

        if (method === "PUT" && url.pathname === "/api/connectors/baikal") {
          if (!sameOrigin(request)) {
            sendError(
              response,
              403,
              "ORIGIN_REQUIRED",
              "Same-origin request required",
            );
            return;
          }
          const session = auth.authenticate(request, true);
          if (session === undefined) {
            sendError(
              response,
              401,
              "AUTH_REQUIRED",
              "Authentication required",
            );
            return;
          }
          if (
            !auth.csrfMatches(
              session,
              request.headers["x-csrf-token"] as string | undefined,
            )
          ) {
            sendError(
              response,
              403,
              "CSRF_INVALID",
              "Valid CSRF token required",
            );
            return;
          }
          const parsed = baikalConnectRequestSchema.safeParse(
            await readJson(request),
          );
          if (!parsed.success) {
            sendError(
              response,
              400,
              "INVALID_CONNECTOR",
              "Baïkal credentials are invalid",
            );
            return;
          }
          const result = await connector.connect(
            session.owner.id,
            parsed.data.username,
            parsed.data.password,
          );
          if (!result.ok) {
            console.warn("connector.baikal.verification_failed");
            sendError(
              response,
              connectorStatus(result.reason),
              "BAIKAL_VERIFICATION_FAILED",
              "Baïkal credentials or endpoint could not be verified",
            );
            return;
          }
          console.info("connector.baikal.verified");
          sendJson(response, 200, result.status);
          return;
        }

        if (method === "GET" && url.pathname === "/api/connectors/google") {
          const session = auth.authenticate(request, false);
          if (session === undefined) {
            sendError(
              response,
              401,
              "AUTH_REQUIRED",
              "Authentication required",
            );
            return;
          }
          sendJson(response, 200, google.status(session.owner.id));
          return;
        }

        if (
          method === "POST" &&
          url.pathname === "/api/connectors/google/authorize"
        ) {
          if (!sameOrigin(request)) {
            sendError(
              response,
              403,
              "ORIGIN_REQUIRED",
              "Same-origin request required",
            );
            return;
          }
          const session = auth.authenticate(request, true);
          if (session === undefined) {
            sendError(
              response,
              401,
              "AUTH_REQUIRED",
              "Authentication required",
            );
            return;
          }
          if (
            !auth.csrfMatches(
              session,
              request.headers["x-csrf-token"] as string | undefined,
            )
          ) {
            sendError(
              response,
              403,
              "CSRF_INVALID",
              "Valid CSRF token required",
            );
            return;
          }
          const authorization = google.begin(session.owner.id);
          if (authorization === undefined) {
            sendError(
              response,
              503,
              "GOOGLE_OAUTH_NOT_CONFIGURED",
              "Google OAuth configuration is not installed",
            );
            return;
          }
          sendJson(response, 200, authorization, {
            "Cache-Control": "no-store",
          });
          return;
        }

        if (
          method === "GET" &&
          url.pathname === "/api/connectors/google/callback"
        ) {
          const state = url.searchParams.get("state");
          const code = url.searchParams.get("code");
          if (
            url.searchParams.get("error") !== null ||
            state === null ||
            code === null ||
            state.length < 32 ||
            state.length > 256 ||
            code.length < 4 ||
            code.length > 4096
          ) {
            sendError(
              response,
              400,
              "GOOGLE_AUTHORIZATION_REJECTED",
              "Google authorization was not completed",
            );
            return;
          }
          const ownerId = await google.complete(state, code);
          if (ownerId === undefined) {
            sendError(
              response,
              400,
              "GOOGLE_AUTHORIZATION_INVALID",
              "Google authorization state or grant was invalid",
            );
            return;
          }
          response.writeHead(303, {
            ...securityHeaders,
            "Cache-Control": "no-store",
            Location: "/?google=connected",
          });
          response.end();
          return;
        }

        if (
          method === "POST" &&
          url.pathname === "/api/connectors/google/sync"
        ) {
          if (!sameOrigin(request)) {
            sendError(
              response,
              403,
              "ORIGIN_REQUIRED",
              "Same-origin request required",
            );
            return;
          }
          const session = auth.authenticate(request, true);
          if (session === undefined) {
            sendError(
              response,
              401,
              "AUTH_REQUIRED",
              "Authentication required",
            );
            return;
          }
          if (
            !auth.csrfMatches(
              session,
              request.headers["x-csrf-token"] as string | undefined,
            )
          ) {
            sendError(
              response,
              403,
              "CSRF_INVALID",
              "Valid CSRF token required",
            );
            return;
          }
          sendJson(response, 200, await google.synchronize(session.owner.id));
          return;
        }

        if (method === "DELETE" && url.pathname === "/api/connectors/google") {
          if (!sameOrigin(request)) {
            sendError(
              response,
              403,
              "ORIGIN_REQUIRED",
              "Same-origin request required",
            );
            return;
          }
          const session = auth.authenticate(request, true);
          if (session === undefined) {
            sendError(
              response,
              401,
              "AUTH_REQUIRED",
              "Authentication required",
            );
            return;
          }
          if (
            !auth.csrfMatches(
              session,
              request.headers["x-csrf-token"] as string | undefined,
            )
          ) {
            sendError(
              response,
              403,
              "CSRF_INVALID",
              "Valid CSRF token required",
            );
            return;
          }
          sendJson(response, 200, await google.disconnect(session.owner.id));
          return;
        }

        if (method === "GET" && url.pathname === "/api/tasks") {
          const session = auth.authenticate(request, false);
          if (session === undefined) {
            sendError(
              response,
              401,
              "AUTH_REQUIRED",
              "Authentication required",
            );
            return;
          }
          const body: TaskListResponse = {
            tasks: database.listTasks(session.owner.id).map(taskResponse),
          };
          sendJson(response, 200, body);
          return;
        }

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
            return;
          }
          if (method === "GET") {
            sendJson(response, 200, {
              tokens: database
                .listAutomationTokens(session.owner.id)
                .map(automationTokenResponse),
            });
            return;
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
              return;
            }
            const id = randomUUID();
            const secret = randomBytes(32).toString("base64url");
            const createdAt = now.toISOString();
            const record = {
              id,
              ownerId: session.owner.id,
              label: parsed.data.label,
              secretHash: createHash("sha256")
                .update(secret)
                .digest("base64url"),
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
            return;
          }
          sendError(response, 405, "METHOD_NOT_ALLOWED", "Method not allowed");
          return;
        }

        if (method === "GET" && url.pathname === "/api/automation/audit") {
          const session = auth.authenticate(request, false);
          if (session === undefined) {
            sendError(response, 401, "AUTH_REQUIRED", "Owner session required");
            return;
          }
          sendJson(response, 200, {
            entries: database.listAutomationAudit(session.owner.id),
          });
          return;
        }

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
            return;
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
            return;
          }
          sendEmpty(response, 204);
          return;
        }

        const automationResource = automationResourceEntries.find(
          ({ apiPath }) => apiPath === url.pathname,
        );
        if (automationResource !== undefined && method === "GET") {
          const resource = automationResource.id;
          const scope = automationResource.scopes[0];
          const token = authenticateAutomation(request, response, scope);
          if (token === undefined) return;
          let body: unknown;
          if (resource === "tasks.list")
            body = {
              tasks: database.listTasks(token.ownerId).map(taskResponse),
            };
          else if (resource === "projects.list")
            body = {
              projects: database
                .listProjects(token.ownerId)
                .map(projectResponse),
            };
          else if (resource === "tags.list")
            body = { tags: database.listTags(token.ownerId).map(tagResponse) };
          else if (resource === "templates.list") {
            const query = templateSearchRequestSchema.safeParse({
              query: url.searchParams.get("query") ?? "",
              includeArchived:
                url.searchParams.get("includeArchived") === "true",
            });
            if (!query.success) {
              sendError(
                response,
                400,
                "INVALID_TEMPLATE_SEARCH",
                "Template search is invalid",
              );
              return;
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
              members: sets.flatMap((set) =>
                database.listTemplateSetMembers(set.id),
              ),
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
              return;
            }
            const events = database.listCalendarEvents(
              token.ownerId,
              window.data.from,
              window.data.to,
            );
            body = {
              window: window.data,
              tasks: database.listTasks(token.ownerId).map(taskResponse),
              events: events.map((event) => ({
                identity: {
                  providerId: event.providerId,
                  calendarId: event.calendarId,
                  eventId: event.href,
                },
                href: event.href,
                uid: event.uid,
                etag: event.etag,
                summary: event.summary,
                startsAt: event.startsAt,
                endsAt: event.endsAt,
                allDay: false,
                recurrence: "none" as const,
                projectedAt: event.projectedAt,
              })),
              freshness: {
                state:
                  events.length === 0
                    ? ("unavailable" as const)
                    : ("stale" as const),
                projectedAt: events[0]?.projectedAt ?? null,
                message:
                  events.length === 0
                    ? "Calendar projection is unavailable"
                    : "Showing the last safe calendar projection",
              },
            } satisfies PlannerResponse;
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
          return;
        }

        if (method === "POST" && url.pathname === automationPreviewPath) {
          const token = authenticateAutomation(request, response);
          if (token === undefined) return;
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
            return;
          }
          const command = parsed.data;
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
            return;
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
              | "pool_item";
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
              | "pool_item";
            entityId: string;
            revision: number;
          }[] = [];
          if (command.operation === "schedule.create_time_block") {
            const task = database.getTask(token.ownerId, command.input.taskId);
            if (task === undefined) {
              sendError(response, 404, "TASK_NOT_FOUND", "Task not found");
              return;
            }
            if (
              database.getOwnedCalendar(token.ownerId, command.input.calendarId)
                ?.supportsEvents !== true
            ) {
              sendError(
                response,
                404,
                "CALENDAR_NOT_FOUND",
                "Calendar not found",
              );
              return;
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
                  id === command.input.destinationProjectId &&
                  archivedAt === null,
              );
            if (template === undefined) {
              sendError(
                response,
                404,
                "TEMPLATE_NOT_FOUND",
                "Task template not found",
              );
              return;
            }
            if (project === undefined) {
              sendError(
                response,
                404,
                "PROJECT_NOT_FOUND",
                "Destination project not found",
              );
              return;
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
                  id === command.input.destinationProjectId &&
                  archivedAt === null,
              );
            if (set === undefined) {
              sendError(
                response,
                404,
                "TEMPLATE_SET_NOT_FOUND",
                "Template set not found",
              );
              return;
            }
            if (project === undefined) {
              sendError(
                response,
                404,
                "PROJECT_NOT_FOUND",
                "Destination project not found",
              );
              return;
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
              return;
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
              return;
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
              return;
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
            const focusInput = automationFocusCommandInputSchema.parse(
              command.input,
            );
            if (focusInput.operation === "focus.start") {
              const task = database.getTask(token.ownerId, focusInput.taskId);
              if (task === undefined) {
                sendError(response, 404, "TASK_NOT_FOUND", "Task not found");
                return;
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
                return;
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
              baseRevisions.map(({ entityId, revision }) => [
                entityId,
                revision,
              ]),
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
          return;
        }

        const automationConfirmPattern = new RegExp(
          `^${automationConfirmPath.replace("{previewId}", "([0-9a-f-]{36})")}$`,
        );
        const automationConfirm = automationConfirmPattern.exec(url.pathname);
        if (automationConfirm !== null && method === "POST") {
          const token = authenticateAutomation(request, response);
          if (token === undefined) return;
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
            return;
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
              return;
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
            return;
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
            return;
          }
          for (const [entityId, revision] of Object.entries(
            preview.baseRevisions,
          )) {
            const current =
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
              return;
            }
          }
          const command = automationPreviewCommandSchema.parse(preview.input);
          const internalKey = `automation.${token.id}.${parsed.data.idempotencyKey}`;
          let result: AutomationConfirmationResponse["result"];
          if (command.operation === "tasks.create") {
            const now = new Date().toISOString();
            const created = database.createTaskIdempotently(
              token.ownerId,
              internalKey,
              createHash("sha256")
                .update(JSON.stringify(command.input))
                .digest("hex"),
              {
                id: randomUUID(),
                title: command.input.title,
                notes: command.input.notes,
                status: "open",
                revision: 1,
                createdAt: now,
                updatedAt: now,
              },
            );
            if (created.kind === "conflict") {
              sendError(
                response,
                409,
                "IDEMPOTENCY_CONFLICT",
                "Operation key conflict",
              );
              return;
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
              return;
            }
            if (calendar?.supportsEvents !== true) {
              sendError(
                response,
                404,
                "CALENDAR_NOT_FOUND",
                "Calendar not found",
              );
              return;
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
              return;
            }
            const uid =
              existingBlock?.eventUid ?? `${randomUUID()}@suite.local`;
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
              return;
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
              return;
            }
            if (
              reservation.kind === "replayed" &&
              reservation.operation.state === "completed"
            ) {
              const replayedTask = database.getTask(
                token.ownerId,
                input.taskId,
              );
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
                return;
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
                  new Date(
                    Date.parse(input.startsAt) - 3_600_000,
                  ).toISOString(),
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
                      Date.parse(candidate.event.endsAt) ===
                        Date.parse(endsAt) &&
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
                return;
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
              return;
            }
            if (instantiated.kind === "project-not-found") {
              sendError(
                response,
                404,
                "PROJECT_NOT_FOUND",
                "Destination project not found",
              );
              return;
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
              return;
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
              return;
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
              return;
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
              return;
            }
            if (resolved.kind === "not-found") {
              sendError(
                response,
                404,
                "PLANNING_PLACEHOLDER_NOT_FOUND",
                "Planning placeholder not found",
              );
              return;
            }
            result = placeholderResolutionResponse(resolved);
          } else {
            const before = database.getActiveSession(token.ownerId);
            const focusInput = automationFocusCommandInputSchema.parse(
              command.input,
            );
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
                return;
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
                return;
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
              sendError(
                response,
                409,
                "ACTIVE_SESSION_CONFLICT",
                "Session changed",
              );
              return;
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
              return;
            }
            sendError(
              response,
              409,
              "AUTOMATION_CONFIRMATION_EXPIRED",
              "Preview could not be consumed",
            );
            return;
          }
          sendJson(response, 200, body);
          return;
        }

        if (
          url.pathname === "/api/templates" ||
          url.pathname.startsWith("/api/templates/") ||
          url.pathname === "/api/template-sets" ||
          url.pathname.startsWith("/api/template-sets/") ||
          url.pathname === "/api/pools" ||
          url.pathname.startsWith("/api/pools/") ||
          url.pathname === "/api/placeholders" ||
          url.pathname.startsWith("/api/placeholders/")
        ) {
          const mutating = method !== "GET";
          const session = auth.authenticate(request, mutating);
          if (session === undefined) {
            sendError(
              response,
              401,
              "AUTH_REQUIRED",
              "Authentication required",
            );
            return;
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
            return;
          }

          if (method === "GET" && url.pathname === "/api/pools") {
            const pools = database.listChoicePools(session.owner.id, true);
            sendJson(response, 200, {
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
                .listPlanningPlaceholders(session.owner.id)
                .map(planningPlaceholderResponse),
            });
            return;
          }

          if (method === "POST" && url.pathname === "/api/pools") {
            const parsed = createChoicePoolRequestSchema.safeParse(
              await readJson(request),
            );
            if (
              !parsed.success ||
              parsed.data.items.length < parsed.data.pickCount
            ) {
              sendError(
                response,
                400,
                "INVALID_CHOICE_POOL",
                "Choice pool input is invalid or has too few items",
              );
              return;
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
              items: database
                .listChoicePoolItems(pool.id)
                .map(choicePoolItemResponse),
            });
            return;
          }

          const poolPatch = /^\/api\/pools\/([0-9a-f-]{36})$/.exec(
            url.pathname,
          );
          if (method === "PATCH" && poolPatch !== null) {
            const revision = expectedRevision(request, response);
            if (revision === undefined) return;
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
              return;
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
              return;
            }
            sendJson(response, 200, choicePoolResponse(updated), {
              ETag: `"${String(updated.revision)}"`,
            });
            return;
          }

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
              return;
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
              return;
            }
            sendJson(response, 201, choicePoolHistoryResponse(event));
            return;
          }

          const slotMatch =
            /^\/api\/templates\/([0-9a-f-]{36})\/pool-slots$/.exec(
              url.pathname,
            );
          if (method === "POST" && slotMatch !== null) {
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
              return;
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
              return;
            }
            sendJson(response, 201, slot);
            return;
          }

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
              return;
            }
            const pool = database.getChoicePool(
              session.owner.id,
              parsed.data.poolId,
            );
            if (pool === undefined) {
              sendError(
                response,
                404,
                "CHOICE_POOL_NOT_FOUND",
                "Choice pool not found",
              );
              return;
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
              return;
            }
            sendJson(response, 201, planningPlaceholderResponse(placeholder));
            return;
          }

          const suggestionMatch =
            /^\/api\/placeholders\/([0-9a-f-]{36})\/suggestion$/.exec(
              url.pathname,
            );
          if (method === "GET" && suggestionMatch !== null) {
            const placeholder = database.getPlanningPlaceholder(
              session.owner.id,
              suggestionMatch[1] ?? "",
            );
            const logicalTime =
              url.searchParams.get("at") ?? new Date().toISOString();
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
              return;
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
            return;
          }

          const resolutionMatch =
            /^\/api\/placeholders\/([0-9a-f-]{36})\/resolve$/.exec(
              url.pathname,
            );
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
              return;
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
                return;
              }
              sendError(
                response,
                replay.kind === "conflict" ? 409 : 412,
                replay.kind === "conflict"
                  ? "IDEMPOTENCY_CONFLICT"
                  : "PLANNING_PLACEHOLDER_STALE",
                "Placeholder was already resolved",
              );
              return;
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
              return;
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
              return;
            }
            if (result.kind === "not-found") {
              sendError(
                response,
                404,
                "PLANNING_PLACEHOLDER_NOT_FOUND",
                "Placeholder not found",
              );
              return;
            }
            sendJson(
              response,
              result.kind === "created" ? 201 : 200,
              placeholderResolutionResponse(result),
            );
            return;
          }

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
              return;
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
            return;
          }

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
              return;
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
            return;
          }

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
              return;
            }
            const now = new Date().toISOString();
            const task = database.getTask(session.owner.id, taskId);
            if (task === undefined) {
              sendError(response, 404, "TASK_NOT_FOUND", "Task not found");
              return;
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
              return;
            }
            sendJson(response, 201, templateResponse(created), {
              ETag: `"${String(created.revision)}"`,
            });
            return;
          }

          const templateArchive =
            /^\/api\/templates\/([0-9a-f-]{36})\/archive$/.exec(url.pathname);
          if (method === "POST" && templateArchive !== null) {
            const revision = expectedRevision(request, response);
            if (revision === undefined) return;
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
              return;
            }
            sendJson(response, 200, templateResponse(archived), {
              ETag: `"${String(archived.revision)}"`,
            });
            return;
          }

          const templateItem = /^\/api\/templates\/([0-9a-f-]{36})$/.exec(
            url.pathname,
          );
          if (method === "PATCH" && templateItem !== null) {
            const revision = expectedRevision(request, response);
            if (revision === undefined) return;
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
              return;
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
              return;
            }
            sendJson(response, 200, templateResponse(updated), {
              ETag: `"${String(updated.revision)}"`,
            });
            return;
          }

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
              return;
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
              return;
            }
            if (result.kind === "project-not-found") {
              sendError(
                response,
                404,
                "PROJECT_NOT_FOUND",
                "Destination project not found",
              );
              return;
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
              return;
            }
            const body = templateInstantiationResponse(result);
            sendJson(response, result.kind === "created" ? 201 : 200, body);
            return;
          }

          if (method === "GET" && url.pathname === "/api/template-sets") {
            const sets = database.listTemplateSets(session.owner.id);
            sendJson(response, 200, {
              sets: sets.map(templateSetResponse),
              members: sets.flatMap((set) =>
                database.listTemplateSetMembers(set.id),
              ),
            });
            return;
          }

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
              return;
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
              return;
            }
            sendJson(response, 201, templateSetResponse(set), {
              ETag: `"${String(set.revision)}"`,
            });
            return;
          }

          sendError(response, 405, "METHOD_NOT_ALLOWED", "Method not allowed");
          return;
        }

        if (method === "POST" && url.pathname === "/api/tasks") {
          if (!sameOrigin(request)) {
            sendError(
              response,
              403,
              "ORIGIN_REQUIRED",
              "Same-origin request required",
            );
            return;
          }
          const session = auth.authenticate(request, true);
          if (session === undefined) {
            sendError(
              response,
              401,
              "AUTH_REQUIRED",
              "Authentication required",
            );
            return;
          }
          if (
            !auth.csrfMatches(
              session,
              request.headers["x-csrf-token"] as string | undefined,
            )
          ) {
            sendError(
              response,
              403,
              "CSRF_INVALID",
              "Valid CSRF token required",
            );
            return;
          }
          const idempotencyKey = request.headers["idempotency-key"];
          const parsedKey = idempotencyKeySchema.safeParse(idempotencyKey);
          if (!parsedKey.success) {
            sendError(
              response,
              400,
              "IDEMPOTENCY_KEY_REQUIRED",
              "A valid Idempotency-Key header is required",
            );
            return;
          }
          const parsed = createTaskRequestSchema.safeParse(
            await readJson(request),
          );
          if (!parsed.success) {
            sendError(response, 400, "INVALID_TASK", "Task input is invalid");
            return;
          }
          const requestHash = createHash("sha256")
            .update(JSON.stringify(parsed.data))
            .digest("hex");
          const now = new Date().toISOString();
          const result = database.createTaskIdempotently(
            session.owner.id,
            parsedKey.data,
            requestHash,
            {
              id: randomUUID(),
              title: parsed.data.title,
              notes: parsed.data.notes,
              status: "open",
              revision: 1,
              createdAt: now,
              updatedAt: now,
            },
          );
          if (result.kind === "conflict") {
            sendError(
              response,
              409,
              "IDEMPOTENCY_CONFLICT",
              "The idempotency key was already used for a different request",
            );
            return;
          }
          const body: TaskMutationResponse = {
            replayed: result.kind === "replayed",
            task: taskResponse(result.task),
          };
          console.info(
            result.kind === "replayed"
              ? "task.create.replayed"
              : "task.create.completed",
          );
          sendJson(response, result.kind === "created" ? 201 : 200, body, {
            ETag: `"${String(body.task.revision)}"`,
          });
          return;
        }

        if (method === "GET" && url.pathname === "/api/tasks/recovery") {
          const session = auth.authenticate(request, false);
          if (session === undefined) {
            sendError(
              response,
              401,
              "AUTH_REQUIRED",
              "Authentication required",
            );
            return;
          }
          const body: TaskListResponse = {
            tasks: database
              .listDeletedTasks(session.owner.id)
              .map(taskResponse),
          };
          sendJson(response, 200, body);
          return;
        }

        if (method === "GET" && url.pathname === "/api/planning/preferences") {
          const session = auth.authenticate(request, false);
          if (session === undefined) {
            sendError(
              response,
              401,
              "AUTH_REQUIRED",
              "Authentication required",
            );
            return;
          }
          sendJson(
            response,
            200,
            database.getPlanningPreferences(session.owner.id),
          );
          return;
        }

        if (method === "PUT" && url.pathname === "/api/planning/preferences") {
          if (!sameOrigin(request)) {
            sendError(
              response,
              403,
              "ORIGIN_REQUIRED",
              "Same-origin request required",
            );
            return;
          }
          const session = auth.authenticate(request, true);
          if (session === undefined) {
            sendError(
              response,
              401,
              "AUTH_REQUIRED",
              "Authentication required",
            );
            return;
          }
          if (
            !auth.csrfMatches(
              session,
              request.headers["x-csrf-token"] as string | undefined,
            )
          ) {
            sendError(
              response,
              403,
              "CSRF_INVALID",
              "Valid CSRF token required",
            );
            return;
          }
          const parsed = planningPreferencesSchema.safeParse(
            await readJson(request),
          );
          if (!parsed.success) {
            sendError(
              response,
              400,
              "INVALID_PLANNING_PREFERENCES",
              "Planning preferences are invalid",
            );
            return;
          }
          sendJson(
            response,
            200,
            database.putPlanningPreferences(
              session.owner.id,
              parsed.data,
              new Date().toISOString(),
            ),
          );
          return;
        }

        if (method === "GET" && url.pathname === "/api/planner") {
          const session = auth.authenticate(request, false);
          if (session === undefined) {
            sendError(
              response,
              401,
              "AUTH_REQUIRED",
              "Authentication required",
            );
            return;
          }
          const window = plannerWindowSchema.safeParse({
            from: url.searchParams.get("from"),
            to: url.searchParams.get("to"),
          });
          if (!window.success) {
            sendError(
              response,
              400,
              "INVALID_PLANNER_WINDOW",
              "Planner window must be positive and no longer than 31 days",
            );
            return;
          }
          const status = await connector.status(session.owner.id);
          const googleStatus = google.status(session.owner.id);
          let fresh = true;
          let connectedProviders = 0;
          let projectedAt: string | null = null;
          if (status.ok && status.status.connected) {
            connectedProviders += 1;
            for (const calendar of status.status.calendars.filter(
              (candidate) => candidate.supportsEvents,
            )) {
              const result = await connector.projectEvents(
                session.owner.id,
                calendar.id,
                window.data.from,
                window.data.to,
              );
              if (!result.ok) {
                fresh = false;
                continue;
              }
              const now = new Date().toISOString();
              projectedAt = now;
              database.replaceCalendarEventWindow(
                session.owner.id,
                calendar.id,
                window.data.from,
                window.data.to,
                result.value.map((resource) => ({
                  id: randomUUID(),
                  providerId: calendar.providerId,
                  calendarId: calendar.id,
                  href: resource.href,
                  uid: resource.event.uid,
                  etag: resource.etag,
                  rawIcs: resource.rawIcs,
                  summary: resource.event.summary,
                  startsAt: new Date(resource.event.startsAt).toISOString(),
                  endsAt: new Date(resource.event.endsAt).toISOString(),
                  allDay: resource.event.allDay,
                  recurrence: "none" as const,
                  freshness: "current" as const,
                  mutable: false,
                  revision: 1,
                  projectedAt: now,
                })),
              );
            }
          }
          if (googleStatus.connected) {
            connectedProviders += 1;
            if (
              googleStatus.state !== "connected" ||
              googleStatus.freshness.some(({ state }) => state !== "fresh")
            )
              fresh = false;
            for (const item of googleStatus.freshness) {
              if (
                item.lastSuccessfulSyncAt !== null &&
                (projectedAt === null ||
                  item.lastSuccessfulSyncAt > projectedAt)
              )
                projectedAt = item.lastSuccessfulSyncAt;
            }
          }
          if (connectedProviders === 0) fresh = false;
          const events = database.listCalendarEvents(
            session.owner.id,
            window.data.from,
            window.data.to,
          );
          const body: PlannerResponse = {
            window: window.data,
            tasks: database
              .listTasks(session.owner.id)
              .toSorted((left, right) => {
                const leftTime =
                  left.plannedStart === null
                    ? Number.POSITIVE_INFINITY
                    : Date.parse(left.plannedStart);
                const rightTime =
                  right.plannedStart === null
                    ? Number.POSITIVE_INFINITY
                    : Date.parse(right.plannedStart);
                return leftTime - rightTime || left.id.localeCompare(right.id);
              })
              .map(taskResponse),
            events: events.map((event) => ({
              identity: {
                providerId: event.providerId,
                calendarId: event.calendarId,
                eventId: event.href,
              },
              href: event.href,
              uid: event.uid,
              etag: event.etag,
              summary: event.summary,
              startsAt: event.startsAt,
              endsAt: event.endsAt,
              allDay: event.allDay,
              recurrence: event.recurrence ?? "none",
              projectedAt: event.projectedAt,
            })),
            freshness: fresh
              ? {
                  state: "fresh",
                  projectedAt,
                  message: "Calendar projection is current",
                }
              : {
                  state: events.length === 0 ? "unavailable" : "stale",
                  projectedAt: events.at(0)?.projectedAt ?? null,
                  message:
                    events.length === 0
                      ? "Calendar projection is unavailable"
                      : "Showing the last safe calendar projection",
                },
          };
          sendJson(response, 200, body);
          return;
        }

        if (method === "GET" && url.pathname === "/api/day-plan") {
          const session = auth.authenticate(request, false);
          if (session === undefined) {
            sendError(
              response,
              401,
              "AUTH_REQUIRED",
              "Authentication required",
            );
            return;
          }
          const requestedAt = url.searchParams.get("at");
          const at = requestedAt === null ? new Date() : new Date(requestedAt);
          if (!Number.isFinite(at.getTime())) {
            sendError(
              response,
              400,
              "INVALID_DAY_PLAN_TIME",
              "Day-plan time must be an ISO timestamp",
            );
            return;
          }
          const dayStart = new Date(at);
          dayStart.setUTCHours(0, 0, 0, 0);
          const dayEnd = new Date(dayStart);
          dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);
          const tasks = database.listTasks(session.owner.id).map(taskResponse);
          const events = database.listCalendarEvents(
            session.owner.id,
            dayStart.toISOString(),
            dayEnd.toISOString(),
          );
          const googleStatus = google.status(session.owner.id);
          const baikalStatus = await connector.status(session.owner.id);
          const providerFreshness: boolean[] = [];
          if (baikalStatus.ok && baikalStatus.status.connected)
            providerFreshness.push(true);
          if (googleStatus.connected)
            providerFreshness.push(
              googleStatus.state === "connected" &&
                googleStatus.freshness.every(({ state }) => state === "fresh"),
            );
          const calendarFresh =
            providerFreshness.length > 0 && providerFreshness.every(Boolean);
          const preferences = database.getPlanningPreferences(session.owner.id);
          const calm = buildCalmDay({
            at: at.toISOString(),
            tasks: tasks.map((task) => ({
              id: task.id,
              status: task.status,
              plannedStart: task.plannedStart ?? null,
            })),
            busy: events.map(({ startsAt, endsAt }) => ({
              startsAt,
              endsAt,
            })),
            preferences,
            calendarFresh,
          });
          const byId = new Map(tasks.map((task) => [task.id, task]));
          const projectedAt = events.at(-1)?.projectedAt ?? null;
          const body: DayPlanResponse = {
            at: at.toISOString(),
            state: calm.state,
            preferences: {
              ...preferences,
              workingDays: [...preferences.workingDays],
            },
            orderedTasks: calm.orderedTaskIds.flatMap((id) => {
              const task = byId.get(id);
              return task === undefined ? [] : [task];
            }),
            nextTask:
              calm.nextTaskId === null
                ? null
                : (byId.get(calm.nextTaskId) ?? null),
            reminder: calm.reminder,
            freshness: calendarFresh
              ? {
                  state: "fresh",
                  projectedAt,
                  message: "Calendar projection is current",
                }
              : {
                  state: events.length === 0 ? "unavailable" : "stale",
                  projectedAt,
                  message:
                    events.length === 0
                      ? "Calendar projection is unavailable"
                      : "Showing the last safe calendar projection",
                },
          };
          sendJson(response, 200, body);
          return;
        }

        const taskRoute =
          /^\/api\/tasks\/([0-9a-f-]{36})(?:\/(complete|reopen|restore|time-block))?$/.exec(
            url.pathname,
          );
        if (
          taskRoute !== null &&
          ["PATCH", "POST", "DELETE"].includes(method)
        ) {
          if (!sameOrigin(request)) {
            sendError(
              response,
              403,
              "ORIGIN_REQUIRED",
              "Same-origin request required",
            );
            return;
          }
          const session = auth.authenticate(request, true);
          if (session === undefined) {
            sendError(
              response,
              401,
              "AUTH_REQUIRED",
              "Authentication required",
            );
            return;
          }
          if (
            !auth.csrfMatches(
              session,
              request.headers["x-csrf-token"] as string | undefined,
            )
          ) {
            sendError(
              response,
              403,
              "CSRF_INVALID",
              "Valid CSRF token required",
            );
            return;
          }
          const revision = expectedRevision(request, response);
          if (revision === undefined) return;
          const taskId = taskRoute[1] ?? "";
          const action = taskRoute[2];

          if (method === "PATCH" && action === undefined) {
            const parsed = taskPatchRequestSchema.safeParse(
              await readJson(request),
            );
            if (!parsed.success) {
              sendError(response, 400, "INVALID_TASK", "Task input is invalid");
              return;
            }
            sendConditionalTask(
              response,
              database.patchTask(
                session.owner.id,
                taskId,
                revision,
                {
                  ...(parsed.data.title === undefined
                    ? {}
                    : { title: parsed.data.title }),
                  ...(parsed.data.notes === undefined
                    ? {}
                    : { notes: parsed.data.notes }),
                  ...(parsed.data.plannedStart === undefined
                    ? {}
                    : { plannedStart: parsed.data.plannedStart }),
                  ...(parsed.data.estimateMinutes === undefined
                    ? {}
                    : { estimateMinutes: parsed.data.estimateMinutes }),
                },
                new Date().toISOString(),
              ),
            );
            return;
          }

          if (
            method === "POST" &&
            (action === "complete" || action === "reopen")
          ) {
            sendConditionalTask(
              response,
              database.setTaskCompleted(
                session.owner.id,
                taskId,
                revision,
                action === "complete",
                new Date().toISOString(),
              ),
            );
            return;
          }

          if (method === "DELETE" && action === undefined) {
            const active = database.getActiveSession(session.owner.id);
            if (active?.endedAt === null && active.taskId === taskId) {
              sendError(
                response,
                409,
                "ACTIVE_SESSION_COMPLETE_REQUIRED",
                "Complete the active focus session before deleting this task",
              );
              return;
            }
            if (
              database.getTaskCalendarBlock(session.owner.id, taskId) !==
              undefined
            ) {
              sendError(
                response,
                409,
                "TIME_BLOCK_REMOVE_REQUIRED",
                "Remove the calendar block before deleting this task",
              );
              return;
            }
            sendConditionalTask(
              response,
              database.deleteTask(
                session.owner.id,
                taskId,
                revision,
                new Date().toISOString(),
              ),
            );
            return;
          }

          if (method === "DELETE" && action === "time-block") {
            const task = database.getTask(session.owner.id, taskId);
            if (task === undefined) {
              sendError(response, 404, "TASK_NOT_FOUND", "Task not found");
              return;
            }
            if (task.revision !== revision) {
              sendError(
                response,
                412,
                "TASK_REVISION_CONFLICT",
                "The task changed; reload it before removing its block",
              );
              return;
            }
            const block = database.getTaskCalendarBlock(
              session.owner.id,
              taskId,
            );
            if (block === undefined) {
              sendError(
                response,
                404,
                "TIME_BLOCK_NOT_FOUND",
                "Task time block not found",
              );
              return;
            }
            const remote = await connector.deleteTaskBlock({
              ownerId: session.owner.id,
              calendarId: block.calendarId,
              href: block.eventHref,
              expectedEtag: block.remoteEtag,
            });
            if (!remote.ok && remote.reason !== "not-found") {
              const conflict = remote.reason === "precondition-failed";
              database.markTaskCalendarBlockState(
                session.owner.id,
                taskId,
                conflict ? "conflict" : "needs_reconciliation",
                new Date().toISOString(),
              );
              if (conflict) {
                sendJson(response, 409, {
                  code: "CALENDAR_EVENT_CONFLICT",
                  message:
                    "The calendar event changed; refresh before removing it",
                  requestId: randomUUID(),
                  action: "refresh_and_replan",
                  mappingId: block.id,
                });
              } else {
                sendError(
                  response,
                  502,
                  "CALENDAR_DELETE_UNCERTAIN",
                  "Calendar deletion is uncertain and needs reconciliation",
                );
              }
              return;
            }
            const released = database.releaseTaskCalendarBlock({
              ownerId: session.owner.id,
              taskId,
              expectedTaskRevision: revision,
              expectedBlockRevision: block.revision,
              now: new Date().toISOString(),
            });
            if (released === undefined) {
              sendError(
                response,
                409,
                "CALENDAR_DELETE_RECONCILIATION_REQUIRED",
                "Calendar block was removed remotely but local state changed",
              );
              return;
            }
            sendJson(
              response,
              200,
              { task: taskResponse(released) },
              {
                ETag: `"${String(released.revision)}"`,
              },
            );
            return;
          }

          if (method === "POST" && action === "restore") {
            const input = await readJson(request);
            if (
              typeof input !== "object" ||
              input === null ||
              Object.keys(input).length !== 0
            ) {
              sendError(
                response,
                400,
                "INVALID_RESTORE",
                "Restore input must be empty",
              );
              return;
            }
            sendConditionalTask(
              response,
              database.restoreTask(
                session.owner.id,
                taskId,
                revision,
                new Date().toISOString(),
              ),
            );
            return;
          }

          if (method === "POST" && action === "time-block") {
            const idempotencyKey = idempotencyKeySchema.safeParse(
              request.headers["idempotency-key"],
            );
            const input = createTaskTimeBlockRequestSchema.safeParse(
              await readJson(request),
            );
            if (!idempotencyKey.success || !input.success) {
              sendError(
                response,
                400,
                "INVALID_TIME_BLOCK",
                "Time-block input and idempotency key are required",
              );
              return;
            }
            const existingBlock = database.getTaskCalendarBlock(
              session.owner.id,
              taskId,
            );
            if (
              existingBlock !== undefined &&
              existingBlock.calendarId !== input.data.calendarId
            ) {
              sendError(
                response,
                409,
                "TIME_BLOCK_CALENDAR_FIXED",
                "Remove the current block before choosing another calendar",
              );
              return;
            }
            const calendar = database.getOwnedCalendar(
              session.owner.id,
              input.data.calendarId,
            );
            if (calendar?.supportsEvents !== true) {
              sendError(
                response,
                404,
                "CALENDAR_NOT_FOUND",
                "Calendar not found",
              );
              return;
            }
            const uid =
              existingBlock?.eventUid ?? `${randomUUID()}@suite.local`;
            const href =
              existingBlock?.eventHref ??
              `${calendar.href.replace(/\/$/, "")}/${randomUUID()}.ics`;
            const normalized = {
              taskId,
              calendarId: input.data.calendarId,
              startsAt: input.data.startsAt,
              durationMinutes: input.data.durationMinutes,
            };
            const requestHash = createHash("sha256")
              .update(JSON.stringify(normalized))
              .digest("hex");
            const now = new Date().toISOString();
            const reservation = database.reserveCalendarWrite({
              ownerId: session.owner.id,
              taskId,
              expectedTaskRevision: revision,
              idempotencyKey: idempotencyKey.data,
              requestHash,
              calendarId: input.data.calendarId,
              reservedHref: href,
              reservedUid: uid,
              now,
            });
            if (reservation.kind === "conflict") {
              sendError(
                response,
                409,
                "IDEMPOTENCY_CONFLICT",
                "The idempotency key was used for another request",
              );
              return;
            }
            if (reservation.kind === "task-not-found") {
              sendError(response, 404, "TASK_NOT_FOUND", "Task not found");
              return;
            }
            if (reservation.kind === "task-precondition-failed") {
              sendError(
                response,
                412,
                "TASK_REVISION_CONFLICT",
                "The task changed; reload it before planning",
              );
              return;
            }
            if (reservation.kind === "calendar-not-found") {
              sendError(
                response,
                404,
                "CALENDAR_NOT_FOUND",
                "Calendar not found",
              );
              return;
            }
            if (
              reservation.kind === "replayed" &&
              reservation.operation.state === "completed"
            ) {
              const task = database.getTask(session.owner.id, taskId);
              const block = database.getTaskCalendarBlock(
                session.owner.id,
                taskId,
              );
              if (block === undefined) {
                sendError(
                  response,
                  409,
                  "TIME_BLOCK_RELEASED",
                  "This completed planning operation was subsequently released",
                );
                return;
              }
              if (task === undefined) {
                sendError(response, 404, "TASK_NOT_FOUND", "Task not found");
                return;
              }
              const body: TaskTimeBlockMutationResponse = {
                task: taskResponse(task),
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
              sendJson(response, 200, body, {
                ETag: `"${String(task.revision)}"`,
              });
              return;
            }
            const operation = reservation.operation;
            const task = database.getTask(session.owner.id, taskId);
            if (task === undefined)
              throw new Error("Reserved planning task is missing");
            const endsAt = new Date(
              Date.parse(input.data.startsAt) +
                input.data.durationMinutes * 60 * 1000,
            ).toISOString();
            let remote: CalendarOperationResult<CalendarEventResource>;
            if (reservation.kind === "replayed") {
              const projection = await connector.projectEvents(
                session.owner.id,
                operation.calendarId,
                new Date(
                  Date.parse(input.data.startsAt) - 60 * 60 * 1000,
                ).toISOString(),
                new Date(Date.parse(endsAt) + 60 * 60 * 1000).toISOString(),
              );
              if (!projection.ok) {
                remote = projection;
              } else {
                const reconciled = projection.value.find(
                  (candidate) =>
                    candidate.href === operation.reservedHref &&
                    candidate.event.uid === operation.reservedUid &&
                    candidate.event.summary === task.title &&
                    Date.parse(candidate.event.startsAt) ===
                      Date.parse(input.data.startsAt) &&
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
                ownerId: session.owner.id,
                calendarId: operation.calendarId,
                href: operation.reservedHref,
                uid: operation.reservedUid,
                summary: task.title,
                startsAt: input.data.startsAt,
                endsAt,
                ...(existingBlock === undefined
                  ? {}
                  : { expectedEtag: existingBlock.remoteEtag }),
              });
            }
            if (reservation.kind === "replayed" && !remote.ok) {
              database.markCalendarWriteConflict(
                session.owner.id,
                idempotencyKey.data,
                new Date().toISOString(),
              );
              sendError(
                response,
                409,
                "CALENDAR_WRITE_RECONCILIATION_REQUIRED",
                "The prior calendar write could not be safely reconciled",
              );
              return;
            }
            if (!remote.ok) {
              if (remote.reason === "precondition-failed") {
                database.markCalendarWriteConflict(
                  session.owner.id,
                  idempotencyKey.data,
                  new Date().toISOString(),
                );
                sendJson(response, 409, {
                  code: "CALENDAR_EVENT_CONFLICT",
                  message:
                    "The calendar event changed; refresh before replanning",
                  requestId: randomUUID(),
                  action: "refresh_and_replan",
                  mappingId: existingBlock?.id ?? null,
                });
                return;
              }
              database.markCalendarWriteConflict(
                session.owner.id,
                idempotencyKey.data,
                new Date().toISOString(),
              );
              sendError(
                response,
                502,
                "CALENDAR_WRITE_UNCERTAIN",
                "Calendar outcome is uncertain and needs reconciliation",
              );
              return;
            }
            const remoteEvent = remote.value;
            const completed = database.completeCalendarWrite({
              ownerId: session.owner.id,
              idempotencyKey: idempotencyKey.data,
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
              plannedStart: input.data.startsAt,
              estimateMinutes: input.data.durationMinutes,
              now: new Date().toISOString(),
            });
            if (completed === undefined)
              throw new Error("Planning operation could not be completed");
            const body: TaskTimeBlockMutationResponse = {
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
            sendJson(response, 201, body, {
              ETag: `"${String(completed.task.revision)}"`,
            });
            return;
          }

          sendError(response, 405, "METHOD_NOT_ALLOWED", "Method not allowed");
          return;
        }

        if (method === "POST" && url.pathname === "/api/clients") {
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
            return;
          }
          const parsed = clientRegistrationRequestSchema.safeParse(
            await readJson(request),
          );
          if (!parsed.success) {
            sendError(
              response,
              400,
              "INVALID_CLIENT",
              "Client input is invalid",
            );
            return;
          }
          const now = new Date().toISOString();
          const id = randomUUID();
          const credential = randomBytes(32).toString("base64url");
          database.registerSyncClient({
            id,
            ownerId: session.owner.id,
            label: parsed.data.label,
            credentialHash: createHash("sha256")
              .update(credential)
              .digest("base64url"),
            createdAt: now,
            lastSeenAt: now,
            revokedAt: null,
          });
          const state = database.getSyncState(session.owner.id);
          const body: ClientRegistrationResponse = {
            client: {
              id,
              ownerId: session.owner.id,
              label: parsed.data.label,
              createdAt: now,
              lastSeenAt: now,
              revokedAt: null,
            },
            clientCredential: credential,
            initialCursor: cursorFor(state),
          };
          sendJson(response, 201, body);
          return;
        }
        if (method === "GET" && url.pathname === "/api/clients") {
          const session = auth.authenticate(request, false);
          if (session === undefined) {
            sendError(
              response,
              401,
              "AUTH_REQUIRED",
              "Authentication required",
            );
            return;
          }
          // Credentials are deliberately never returned from this inventory.
          const clients = database
            .listSyncClients(session.owner.id)
            .map(
              ({ id, ownerId, label, createdAt, lastSeenAt, revokedAt }) => ({
                id,
                ownerId,
                label,
                createdAt,
                lastSeenAt,
                revokedAt,
              }),
            );
          sendJson(response, 200, { clients });
          return;
        }
        const revokeMatch = /^\/api\/clients\/([0-9a-f-]{36})$/.exec(
          url.pathname,
        );
        if (method === "DELETE" && revokeMatch !== null) {
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
            return;
          }
          const clientId = revokeMatch[1];
          if (clientId === undefined) {
            sendError(response, 404, "CLIENT_NOT_FOUND", "Client not found");
            return;
          }
          if (
            !database.revokeSyncClient(
              session.owner.id,
              clientId,
              new Date().toISOString(),
            )
          ) {
            sendError(response, 404, "CLIENT_NOT_FOUND", "Client not found");
            return;
          }
          sendEmpty(response, 204);
          return;
        }
        if (
          (method === "POST" && url.pathname === "/api/sync/round") ||
          (method === "GET" && url.pathname === "/api/sync/snapshot")
        ) {
          const session = auth.authenticate(request, method === "POST");
          if (
            session === undefined ||
            (method === "POST" &&
              (!sameOrigin(request) ||
                !auth.csrfMatches(
                  session,
                  request.headers["x-csrf-token"] as string | undefined,
                )))
          ) {
            sendError(
              response,
              method === "POST" ? 403 : 401,
              method === "POST" ? "CSRF_REQUIRED" : "AUTH_REQUIRED",
              "Authenticated same-origin request required",
            );
            return;
          }
          const headers = clientAuthenticationHeadersSchema.safeParse({
            clientId: request.headers["x-suite-client-id"],
            clientCredential: request.headers["x-suite-client-credential"],
          });
          if (!headers.success) {
            sendError(
              response,
              401,
              "CLIENT_AUTH_REQUIRED",
              "Client proof required",
            );
            return;
          }
          const client = database.authenticateSyncClient(
            session.owner.id,
            headers.data.clientId,
            createHash("sha256")
              .update(headers.data.clientCredential)
              .digest("base64url"),
            new Date().toISOString(),
          );
          if (client === undefined) {
            sendError(
              response,
              401,
              "CLIENT_REVOKED",
              "Client proof is invalid or revoked",
            );
            return;
          }
          if (method === "GET") {
            const snapshot = database.fullSyncSnapshot(session.owner.id);
            const allSnapshots = [
              ...snapshot.tasks.map((task) => ({
                entityKind: "task" as const,
                value: {
                  task: taskResponse(task),
                  fieldVersions: (() => {
                    const versions = database.getTaskFieldVersions(
                      session.owner.id,
                      task.id,
                    );
                    return {
                      title: versions.title ?? task.revision,
                      notes: versions.notes ?? task.revision,
                      status: versions.status ?? task.revision,
                      estimateMinutes:
                        versions.estimateMinutes ?? task.revision,
                      projectId: versions.projectId ?? task.revision,
                      tagIds: versions.tagIds ?? task.revision,
                    };
                  })(),
                  changeSequence: task.revision,
                },
              })),
              ...snapshot.projects.map((project) => ({
                entityKind: "project" as const,
                value: projectResponse(project),
              })),
              ...snapshot.tags.map((tag) => ({
                entityKind: "tag" as const,
                value: tagResponse(tag),
              })),
              ...snapshot.subtasks.map((subtask) => ({
                entityKind: "subtask" as const,
                value: subtaskResponse(subtask),
              })),
              ...snapshot.templates.map((template) => ({
                entityKind: "template" as const,
                value: {
                  template: templateResponse(template),
                  blueprints: database
                    .listTemplateSubtaskBlueprints(template.id)
                    .map(templateBlueprintResponse),
                  poolSlots: [...database.listTemplatePoolSlots(template.id)],
                },
              })),
              ...snapshot.templateSets.map((set) => ({
                entityKind: "template_set" as const,
                value: {
                  set: templateSetResponse(set),
                  members: [...database.listTemplateSetMembers(set.id)],
                },
              })),
              ...database
                .listChoicePools(session.owner.id, true)
                .map((pool) => ({
                  entityKind: "choice_pool" as const,
                  value: {
                    pool: choicePoolResponse(pool),
                    items: database
                      .listChoicePoolItems(pool.id, true)
                      .map(choicePoolItemResponse),
                    history: database
                      .listChoicePoolHistory(pool.id)
                      .map(choicePoolHistoryResponse),
                  },
                })),
              ...database
                .listPlanningPlaceholders(session.owner.id)
                .map((placeholder) => ({
                  entityKind: "planning_placeholder" as const,
                  value: {
                    placeholder: planningPlaceholderResponse(placeholder),
                    resolution: (() => {
                      const resolution =
                        database.getPlanningPlaceholderResolution(
                          placeholder.id,
                        );
                      return resolution === undefined
                        ? null
                        : planningResolutionResponse(resolution);
                    })(),
                  },
                })),
            ];
            const offset = Number(url.searchParams.get("offset") ?? "0");
            if (!Number.isInteger(offset) || offset < 0) {
              sendError(
                response,
                400,
                "INVALID_SNAPSHOT_OFFSET",
                "Snapshot offset is invalid",
              );
              return;
            }
            const snapshots = allSnapshots.slice(offset, offset + 200);
            const body: SyncSnapshotResponse = {
              snapshots,
              nextCursor: cursorFor(snapshot.cursor),
              hasMore: offset + snapshots.length < allSnapshots.length,
              serverTimestamp: new Date().toISOString(),
            };
            sendJson(response, 200, body);
            return;
          }
          const parsed = syncRoundRequestSchema.safeParse(
            await readJson(request),
          );
          if (!parsed.success) {
            sendError(
              response,
              400,
              "INVALID_SYNC_OPERATION",
              "Sync round is invalid",
            );
            return;
          }
          const outcomes = parsed.data.operations.map((operation) => {
            const now = new Date().toISOString();
            const result =
              operation.kind === "task.create"
                ? database.applyTaskCreateSync({
                    ownerId: session.owner.id,
                    clientId: client.id,
                    operationId: operation.operationId,
                    requestHash: operation.requestHash,
                    now,
                    task: {
                      ...operation.task,
                      status: "open",
                      revision: 1,
                      createdAt: now,
                      updatedAt: now,
                    },
                  })
                : operation.kind === "task.patch"
                  ? database.applyTaskFieldSync({
                      ownerId: session.owner.id,
                      clientId: client.id,
                      operationId: operation.operationId,
                      requestHash: operation.requestHash,
                      taskId: operation.taskId,
                      baseVersions: Object.fromEntries(
                        Object.entries(operation.baseFieldVersions).filter(
                          ([, value]) => value !== undefined,
                        ),
                      ),
                      patch: Object.fromEntries(
                        Object.entries(operation.fields).filter(
                          ([, value]) => value !== undefined,
                        ),
                      ),
                      now,
                    })
                  : operation.kind === "task.complete" ||
                      operation.kind === "task.reopen"
                    ? database.applyTaskCompletionSync({
                        ownerId: session.owner.id,
                        clientId: client.id,
                        operationId: operation.operationId,
                        requestHash: operation.requestHash,
                        taskId: operation.taskId,
                        baseStatusVersion: operation.baseStatusVersion,
                        completed: operation.kind === "task.complete",
                        now,
                      })
                    : database.applyTaskDeletionSync({
                        ownerId: session.owner.id,
                        clientId: client.id,
                        operationId: operation.operationId,
                        requestHash: operation.requestHash,
                        taskId: operation.taskId,
                        baseRevision: (
                          operation as Extract<
                            typeof operation,
                            { readonly kind: "task.delete" | "task.restore" }
                          >
                        ).baseRevision,
                        restore: operation.kind === "task.restore",
                        now,
                      });
            if (result.kind === "idempotency-conflict") {
              return {
                kind: "rejected" as const,
                operationId: operation.operationId,
                code: "IDEMPOTENCY_CONFLICT" as const,
              };
            }
            if (result.kind === "conflict") {
              const conflictFields =
                "fields" in result && Array.isArray(result.fields)
                  ? result.fields.filter(
                      (
                        field,
                      ): field is
                        | "title"
                        | "notes"
                        | "status"
                        | "estimateMinutes"
                        | "projectId"
                        | "tagIds" =>
                        [
                          "title",
                          "notes",
                          "status",
                          "estimateMinutes",
                          "projectId",
                          "tagIds",
                        ].includes(String(field)),
                    )
                  : undefined;
              return {
                kind: "conflict" as const,
                operationId: operation.operationId,
                code:
                  conflictFields === undefined || conflictFields.length === 0
                    ? ("SYNC_RESOURCE_CONFLICT" as const)
                    : ("SYNC_FIELD_CONFLICT" as const),
                taskId:
                  operation.kind === "task.create"
                    ? operation.task.id
                    : operation.taskId,
                taskRevision: result.task?.revision ?? 1,
                ...(conflictFields === undefined || conflictFields.length === 0
                  ? {}
                  : { conflictingFields: conflictFields }),
              };
            }
            const task = result.task;
            if (task === undefined)
              return {
                kind: "rejected" as const,
                operationId: operation.operationId,
                code: "IDEMPOTENCY_CONFLICT" as const,
              };
            return {
              kind: result.kind,
              operationId: operation.operationId,
              entityId: task.id,
              entityRevision: task.revision,
              changeSequence: database.getSyncState(session.owner.id).cursor,
            };
          });
          const cursor =
            parsed.data.cursor === null
              ? undefined
              : parseCursor(parsed.data.cursor);
          const page =
            cursor === undefined && parsed.data.cursor !== null
              ? {
                  resetRequired: true,
                  changes: [],
                  cursor: database.getSyncState(session.owner.id).cursor,
                }
              : database.pageSyncChanges(
                  session.owner.id,
                  cursor?.epoch ??
                    database.getSyncState(session.owner.id).epoch,
                  cursor?.sequence ?? 0,
                  parsed.data.pullLimit,
                );
          if (page.resetRequired) {
            sendJson(response, 409, {
              code: "SYNC_CURSOR_EXPIRED",
              message: "Sync cursor expired",
              requestId: randomUUID(),
              action: "replace_cache_from_snapshot",
            });
            return;
          }
          const body: SyncRoundResponse = {
            outcomes,
            changes: page.changes.map((change) => {
              const task =
                change.entityType === "task"
                  ? database.getTask(session.owner.id, change.entityId, true)
                  : undefined;
              const versions =
                task === undefined
                  ? undefined
                  : database.getTaskFieldVersions(session.owner.id, task.id);
              const active =
                change.entityType === "active_session"
                  ? database.getActiveSession(session.owner.id)
                  : undefined;
              const project =
                change.entityType === "project"
                  ? database
                      .listProjects(session.owner.id)
                      .find(({ id }) => id === change.entityId)
                  : undefined;
              const tag =
                change.entityType === "tag"
                  ? database
                      .listTags(session.owner.id)
                      .find(({ id }) => id === change.entityId)
                  : undefined;
              const subtask =
                change.entityType === "subtask"
                  ? database
                      .fullSyncSnapshot(session.owner.id)
                      .subtasks.find(({ id }) => id === change.entityId)
                  : undefined;
              const template =
                change.entityType === "template"
                  ? database.getTaskTemplate(
                      session.owner.id,
                      change.entityId,
                      true,
                    )
                  : undefined;
              const templateSet =
                change.entityType === "template_set"
                  ? database
                      .listTemplateSets(session.owner.id, true)
                      .find(({ id }) => id === change.entityId)
                  : undefined;
              const choicePool =
                change.entityType === "choice_pool"
                  ? database.getChoicePool(
                      session.owner.id,
                      change.entityId,
                      true,
                    )
                  : undefined;
              const planningPlaceholder =
                change.entityType === "planning_placeholder"
                  ? database.getPlanningPlaceholder(
                      session.owner.id,
                      change.entityId,
                    )
                  : undefined;
              return {
                sequence: change.sequence,
                entityKind: change.entityType as
                  | "task"
                  | "project"
                  | "tag"
                  | "subtask"
                  | "template"
                  | "template_set"
                  | "choice_pool"
                  | "planning_placeholder"
                  | "active_session",
                entityId: change.entityId,
                kind:
                  change.kind === "deleted"
                    ? ("deleted" as const)
                    : change.kind === "session_changed"
                      ? ("session_changed" as const)
                      : ("upsert" as const),
                entityRevision: change.revision,
                changedAt: change.createdAt,
                snapshot:
                  task !== undefined && versions !== undefined
                    ? {
                        entityKind: "task" as const,
                        value: {
                          task: taskResponse(task),
                          fieldVersions: {
                            title: versions.title ?? task.revision,
                            notes: versions.notes ?? task.revision,
                            status: versions.status ?? task.revision,
                            estimateMinutes:
                              versions.estimateMinutes ?? task.revision,
                            projectId: versions.projectId ?? task.revision,
                            tagIds: versions.tagIds ?? task.revision,
                          },
                          changeSequence: change.sequence,
                        },
                      }
                    : project !== undefined
                      ? {
                          entityKind: "project" as const,
                          value: projectResponse(project),
                        }
                      : tag !== undefined
                        ? {
                            entityKind: "tag" as const,
                            value: tagResponse(tag),
                          }
                        : subtask !== undefined
                          ? {
                              entityKind: "subtask" as const,
                              value: subtaskResponse(subtask),
                            }
                          : template !== undefined
                            ? {
                                entityKind: "template" as const,
                                value: {
                                  template: templateResponse(template),
                                  blueprints: database
                                    .listTemplateSubtaskBlueprints(template.id)
                                    .map(templateBlueprintResponse),
                                  poolSlots: [
                                    ...database.listTemplatePoolSlots(
                                      template.id,
                                    ),
                                  ],
                                },
                              }
                            : templateSet !== undefined
                              ? {
                                  entityKind: "template_set" as const,
                                  value: {
                                    set: templateSetResponse(templateSet),
                                    members: [
                                      ...database.listTemplateSetMembers(
                                        templateSet.id,
                                      ),
                                    ],
                                  },
                                }
                              : choicePool !== undefined
                                ? {
                                    entityKind: "choice_pool" as const,
                                    value: {
                                      pool: choicePoolResponse(choicePool),
                                      items: database
                                        .listChoicePoolItems(
                                          choicePool.id,
                                          true,
                                        )
                                        .map(choicePoolItemResponse),
                                      history: database
                                        .listChoicePoolHistory(choicePool.id)
                                        .map(choicePoolHistoryResponse),
                                    },
                                  }
                                : planningPlaceholder !== undefined
                                  ? {
                                      entityKind:
                                        "planning_placeholder" as const,
                                      value: {
                                        placeholder:
                                          planningPlaceholderResponse(
                                            planningPlaceholder,
                                          ),
                                        resolution: (() => {
                                          const resolution =
                                            database.getPlanningPlaceholderResolution(
                                              planningPlaceholder.id,
                                            );
                                          return resolution === undefined
                                            ? null
                                            : planningResolutionResponse(
                                                resolution,
                                              );
                                        })(),
                                      },
                                    }
                                  : active?.id === change.entityId
                                    ? {
                                        entityKind: "active_session" as const,
                                        value: activeResponse(
                                          activeFromRecord(active, database),
                                        ),
                                      }
                                    : null,
              };
            }),
            nextCursor: cursorFor({
              epoch: database.getSyncState(session.owner.id).epoch,
              cursor: page.cursor,
            }),
            hasMore: page.changes.length === parsed.data.pullLimit,
            serverTimestamp: new Date().toISOString(),
          };
          sendJson(response, 200, body);
          return;
        }
        if (
          method === "GET" &&
          (url.pathname === "/api/projects" || url.pathname === "/api/tags")
        ) {
          const session = auth.authenticate(request, false);
          if (session === undefined) {
            sendError(
              response,
              401,
              "AUTH_REQUIRED",
              "Authentication required",
            );
            return;
          }
          sendJson(
            response,
            200,
            url.pathname === "/api/tags"
              ? { tags: database.listTags(session.owner.id).map(tagResponse) }
              : {
                  projects: database
                    .listProjects(session.owner.id)
                    .map(projectResponse),
                },
          );
          return;
        }
        if (
          method === "POST" &&
          (url.pathname === "/api/projects" || url.pathname === "/api/tags")
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
            return;
          }
          const input = (await readJson(request)) as {
            title?: unknown;
            normalizedName?: unknown;
          };
          if (
            typeof input.title !== "string" ||
            input.title.trim().length === 0 ||
            input.title.trim().length >
              (url.pathname === "/api/tags" ? 100 : 240)
          ) {
            sendError(
              response,
              400,
              "INVALID_ORGANIZATION",
              "A title is required",
            );
            return;
          }
          const now = new Date().toISOString();
          if (url.pathname === "/api/tags") {
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
              return;
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
          } else {
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
          }
          return;
        }

        const organizationMatch =
          /^\/api\/(projects|tags)\/([0-9a-f-]{36})$/.exec(url.pathname);
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
            return;
          }
          const revision = expectedRevision(request, response);
          if (revision === undefined) return;
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
            return;
          }
          const now = new Date().toISOString();
          const kind = organizationMatch[1];
          const id = organizationMatch[2];
          if (kind === undefined || id === undefined) {
            sendError(
              response,
              404,
              "NOT_FOUND",
              "Organization record not found",
            );
            return;
          }
          let result;
          try {
            result =
              kind === "projects"
                ? wantsArchive
                  ? database.archiveProject(session.owner.id, id, revision, now)
                  : database.renameProject(
                      session.owner.id,
                      id,
                      revision,
                      title ?? "",
                      now,
                    )
                : wantsArchive
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
            return;
          }
          if (result === undefined) {
            sendError(
              response,
              412,
              "ORGANIZATION_REVISION_CONFLICT",
              "The record changed; reload it before trying again",
            );
            return;
          }
          database.appendSyncChange(
            session.owner.id,
            kind === "projects" ? "project" : "tag",
            result.id,
            "upsert",
            result.revision,
            now,
          );
          sendJson(
            response,
            200,
            kind === "projects"
              ? { project: projectResponse(result) }
              : {
                  tag: tagResponse(result as Parameters<typeof tagResponse>[0]),
                },
            { ETag: `"${String(result.revision)}"` },
          );
          return;
        }

        const taskOrganizationMatch =
          /^\/api\/tasks\/([0-9a-f-]{36})\/(project|tags)$/.exec(url.pathname);
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
            return;
          }
          const revision = expectedRevision(request, response);
          if (revision === undefined) return;
          const input = (await readJson(request)) as {
            projectId?: unknown;
            tagIds?: unknown;
          };
          const taskId = taskOrganizationMatch[1];
          const target = taskOrganizationMatch[2];
          if (taskId === undefined || target === undefined) {
            sendError(
              response,
              404,
              "NOT_FOUND",
              "Task organization route not found",
            );
            return;
          }
          const now = new Date().toISOString();
          const result =
            target === "project"
              ? (input.projectId === null ||
                  (typeof input.projectId === "string" &&
                    /^[0-9a-f-]{36}$/.test(input.projectId))) &&
                database.assignTaskProject(
                  session.owner.id,
                  taskId,
                  input.projectId ?? null,
                  revision,
                  now,
                )
              : Array.isArray(input.tagIds) &&
                input.tagIds.every(
                  (tagId) =>
                    typeof tagId === "string" && /^[0-9a-f-]{36}$/.test(tagId),
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
            return;
          }
          sendJson(
            response,
            200,
            { task: taskResponse(task) },
            {
              ETag: `"${String(task.revision)}"`,
            },
          );
          return;
        }

        const taskSubtasksMatch =
          /^\/api\/tasks\/([0-9a-f-]{36})\/subtasks$/.exec(url.pathname);
        if (
          taskSubtasksMatch !== null &&
          (method === "GET" || method === "POST")
        ) {
          const session = auth.authenticate(request, method === "POST");
          if (
            session === undefined ||
            (method === "POST" &&
              (!sameOrigin(request) ||
                !auth.csrfMatches(
                  session,
                  request.headers["x-csrf-token"] as string | undefined,
                )))
          ) {
            sendError(
              response,
              403,
              "AUTH_REQUIRED",
              "Authentication required",
            );
            return;
          }
          const taskId = taskSubtasksMatch[1];
          if (taskId === undefined) {
            sendError(
              response,
              404,
              "NOT_FOUND",
              "Task subtask route not found",
            );
            return;
          }
          if (database.getTask(session.owner.id, taskId) === undefined) {
            sendError(response, 404, "TASK_NOT_FOUND", "Task not found");
            return;
          }
          if (method === "GET") {
            sendJson(response, 200, {
              subtasks: database
                .listSubtasks(session.owner.id, taskId)
                .map(subtaskResponse),
            });
            return;
          }
          const input = (await readJson(request)) as {
            title?: unknown;
            position?: unknown;
          };
          if (
            typeof input.title !== "string" ||
            input.title.trim().length === 0 ||
            !Number.isInteger(input.position) ||
            Number(input.position) < 0
          ) {
            sendError(
              response,
              400,
              "INVALID_SUBTASK",
              "Subtask input is invalid",
            );
            return;
          }
          const now = new Date().toISOString();
          const subtask = {
            id: randomUUID(),
            ownerId: session.owner.id,
            taskId,
            title: input.title.trim(),
            completed: false,
            position: Number(input.position),
            revision: 1,
            createdAt: now,
            updatedAt: now,
          };
          database.createSubtask(subtask);
          database.appendSyncChange(
            session.owner.id,
            "subtask",
            subtask.id,
            "upsert",
            1,
            now,
          );
          sendJson(response, 201, { subtask: subtaskResponse(subtask) });
          return;
        }

        const subtaskMatch = /^\/api\/subtasks\/([0-9a-f-]{36})$/.exec(
          url.pathname,
        );
        if (
          subtaskMatch !== null &&
          (method === "PATCH" || method === "DELETE")
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
            sendError(response, 403, "CSRF_REQUIRED", "Valid CSRF required");
            return;
          }
          const revision = expectedRevision(request, response);
          if (revision === undefined) return;
          const id = subtaskMatch[1];
          if (id === undefined) {
            sendError(response, 404, "NOT_FOUND", "Subtask route not found");
            return;
          }
          const now = new Date().toISOString();
          if (method === "DELETE") {
            if (!database.deleteSubtask(session.owner.id, id, revision)) {
              sendError(
                response,
                412,
                "SUBTASK_REVISION_CONFLICT",
                "Subtask changed",
              );
              return;
            }
            database.appendSyncChange(
              session.owner.id,
              "subtask",
              id,
              "deleted",
              revision + 1,
              now,
            );
            sendEmpty(response, 204);
            return;
          }
          const input = (await readJson(request)) as {
            title?: unknown;
            completed?: unknown;
            position?: unknown;
          };
          const patch = {
            ...(typeof input.title === "string" && input.title.trim().length > 0
              ? { title: input.title.trim() }
              : {}),
            ...(typeof input.completed === "boolean"
              ? { completed: input.completed }
              : {}),
            ...(Number.isInteger(input.position) && Number(input.position) >= 0
              ? { position: Number(input.position) }
              : {}),
          };
          if (Object.keys(patch).length === 0) {
            sendError(
              response,
              400,
              "INVALID_SUBTASK",
              "Subtask patch is empty",
            );
            return;
          }
          const updated = database.updateSubtask(
            session.owner.id,
            id,
            revision,
            patch,
            now,
          );
          if (updated === undefined) {
            sendError(
              response,
              412,
              "SUBTASK_REVISION_CONFLICT",
              "Subtask changed",
            );
            return;
          }
          database.appendSyncChange(
            session.owner.id,
            "subtask",
            id,
            "upsert",
            updated.revision,
            now,
          );
          sendJson(
            response,
            200,
            { subtask: subtaskResponse(updated) },
            {
              ETag: `"${String(updated.revision)}"`,
            },
          );
          return;
        }

        if (method === "GET" && url.pathname === "/api/active-session") {
          const session = auth.authenticate(request, false);
          if (session === undefined) {
            sendError(
              response,
              401,
              "AUTH_REQUIRED",
              "Authentication required",
            );
            return;
          }
          const headers = clientAuthenticationHeadersSchema.safeParse({
            clientId: request.headers["x-suite-client-id"],
            clientCredential: request.headers["x-suite-client-credential"],
          });
          if (
            !headers.success ||
            database.authenticateSyncClient(
              session.owner.id,
              headers.data.clientId,
              createHash("sha256")
                .update(headers.data.clientCredential)
                .digest("base64url"),
              new Date().toISOString(),
            ) === undefined
          ) {
            sendError(
              response,
              401,
              "CLIENT_AUTH_REQUIRED",
              "Valid client proof required",
            );
            return;
          }
          const stored = database.getActiveSession(session.owner.id);
          if (stored === undefined) {
            sendJson(response, 200, { session: null });
            return;
          }
          const observed = observeActiveSession(
            activeFromRecord(stored, database),
            sessionClock,
          );
          if (observed.revision !== stored.revision) {
            database.applyActiveSessionTransition({
              session: recordFromActive(observed),
              expectedRevision: stored.revision,
              clientId: stored.controllerClientId ?? "system",
              idempotencyKey: `expiry-${stored.id}-${String(stored.revision)}`,
              requestHash: createHash("sha256")
                .update(`expiry:${stored.id}:${String(stored.revision)}`)
                .digest("base64url"),
              intervals: intervalsFromActive(observed),
              events: eventsFromActive(observed),
              now: observed.updatedAt,
            });
          }
          sendJson(response, 200, { session: activeResponse(observed) });
          return;
        }
        if (
          method === "POST" &&
          url.pathname === "/api/active-session/command"
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
            return;
          }
          const headers = clientAuthenticationHeadersSchema.safeParse({
            clientId: request.headers["x-suite-client-id"],
            clientCredential: request.headers["x-suite-client-credential"],
          });
          if (!headers.success) {
            sendError(
              response,
              401,
              "CLIENT_AUTH_REQUIRED",
              "Client proof required",
            );
            return;
          }
          const client = database.authenticateSyncClient(
            session.owner.id,
            headers.data.clientId,
            createHash("sha256")
              .update(headers.data.clientCredential)
              .digest("base64url"),
            new Date().toISOString(),
          );
          if (client === undefined) {
            sendError(
              response,
              401,
              "CLIENT_REVOKED",
              "Client proof is invalid or revoked",
            );
            return;
          }
          const parsed = activeSessionCommandSchema.safeParse(
            await readJson(request),
          );
          if (!parsed.success) {
            sendError(
              response,
              400,
              "INVALID_ACTIVE_SESSION_COMMAND",
              "Active-session command is invalid",
            );
            return;
          }
          const command = parsed.data;
          const commandHash = createHash("sha256")
            .update(JSON.stringify(command))
            .digest("base64url");
          const prior = database.getActiveSessionOperationOutcome(
            session.owner.id,
            client.id,
            command.idempotencyKey,
          );
          if (prior !== undefined) {
            if (prior.requestHash !== commandHash) {
              sendError(
                response,
                409,
                "IDEMPOTENCY_CONFLICT",
                "The idempotency key was used for another command",
              );
              return;
            }
            const replayed = activeFromPersistence(
              prior.snapshot.session,
              prior.snapshot.intervals,
              prior.snapshot.events,
            );
            const opened = replayed.intervals.find(
              (interval) =>
                interval.startedAt === replayed.updatedAt &&
                interval.endedAt === null,
            );
            const closed = replayed.intervals.find(
              (interval) => interval.endedAt === replayed.updatedAt,
            );
            const interval = (value: typeof opened) =>
              value === undefined
                ? null
                : {
                    id: value.id,
                    sessionId: replayed.id,
                    taskId: value.taskId ?? "",
                    phase: value.kind,
                    ordinal: value.ordinal,
                    startedAt: value.startedAt,
                    endedAt: value.endedAt,
                  };
            sendJson(response, 200, {
              session: activeResponse(replayed),
              openedInterval: interval(opened),
              closedInterval: interval(closed),
              replayed: true,
              changeSequence: database.getSyncState(session.owner.id).cursor,
            } satisfies ActiveSessionCommandResponse);
            return;
          }
          const before = database.getActiveSession(session.owner.id);
          const beforeSession =
            before === undefined
              ? undefined
              : activeFromRecord(before, database);
          let next: ActiveSession;
          let expected: number | null;
          if (command.command === "start") {
            if (
              database.getTask(session.owner.id, command.taskId) === undefined
            ) {
              sendError(response, 404, "TASK_NOT_FOUND", "Task not found");
              return;
            }
            next = createActiveSession(
              {
                ownerId: session.owner.id,
                controllerClientId: client.id,
                taskId: command.taskId,
              },
              sessionClock,
              { sessionId: randomUUID(), intervalId: () => randomUUID() },
            );
            expected = null;
          } else {
            if (
              before?.id !== command.sessionId ||
              beforeSession === undefined
            ) {
              sendError(
                response,
                404,
                "ACTIVE_SESSION_NOT_FOUND",
                "Active session not found",
              );
              return;
            }
            const transition = transitionActiveSession(
              beforeSession,
              {
                type:
                  command.command === "start_break"
                    ? "start-break"
                    : command.command === "end_break"
                      ? "end-break"
                      : command.command,
                actorClientId: client.id,
                expectedRevision: command.expectedRevision,
              },
              sessionClock,
              { intervalId: () => randomUUID() },
            );
            if (!transition.ok) {
              sendError(
                response,
                transition.reason === "stale-revision" ? 412 : 409,
                "ACTIVE_SESSION_CONFLICT",
                transition.reason,
              );
              return;
            }
            next = transition.session;
            expected = before.revision;
          }
          const transitionResult = database.applyActiveSessionTransition({
            session: recordFromActive(next),
            expectedRevision: expected,
            clientId: client.id,
            idempotencyKey: command.idempotencyKey,
            requestHash: commandHash,
            intervals: intervalsFromActive(next),
            events: eventsFromActive(next),
            now: next.updatedAt,
          });
          if (
            transitionResult.kind === "conflict" ||
            transitionResult.kind === "stale"
          ) {
            sendError(
              response,
              409,
              "ACTIVE_SESSION_CONFLICT",
              "Session changed; reload it before trying again",
            );
            return;
          }
          const persisted =
            transitionResult.session === undefined ||
            transitionResult.intervals === undefined ||
            transitionResult.events === undefined
              ? next
              : activeFromPersistence(
                  transitionResult.session,
                  transitionResult.intervals,
                  transitionResult.events,
                );
          const oldIntervals =
            beforeSession === undefined ? [] : beforeSession.intervals;
          const opened = persisted.intervals.find(
            (interval) => !oldIntervals.some((old) => old.id === interval.id),
          );
          const closed = persisted.intervals.find(
            (interval) =>
              oldIntervals.some(
                (old) => old.id === interval.id && old.endedAt === null,
              ) && interval.endedAt !== null,
          );
          const intervalResponse = (interval: typeof opened) =>
            interval === undefined
              ? null
              : {
                  id: interval.id,
                  sessionId: persisted.id,
                  taskId: interval.taskId ?? "",
                  phase: interval.kind,
                  ordinal: interval.ordinal,
                  startedAt: interval.startedAt,
                  endedAt: interval.endedAt,
                };
          const body: ActiveSessionCommandResponse = {
            session: activeResponse(persisted),
            openedInterval: intervalResponse(opened),
            closedInterval: intervalResponse(closed),
            replayed: transitionResult.kind === "replayed",
            changeSequence: database.getSyncState(session.owner.id).cursor,
          };
          sendJson(response, 200, body);
          return;
        }

        if (url.pathname.startsWith("/api/")) {
          sendError(response, 404, "NOT_FOUND", "API route not found");
          return;
        }

        if (method !== "GET" && method !== "HEAD") {
          sendEmpty(response, 405);
          return;
        }

        let pathname: string;
        try {
          pathname = decodeURIComponent(url.pathname);
        } catch {
          sendEmpty(response, 400);
          return;
        }

        const requested = resolve(webRoot, `.${normalize(pathname)}`);
        const file =
          isInside(webRoot, requested) &&
          existsSync(requested) &&
          statSync(requested).isFile()
            ? requested
            : join(webRoot, "index.html");

        if (!isInside(webRoot, file) || !existsSync(file)) {
          sendError(
            response,
            404,
            "WEB_BUILD_NOT_FOUND",
            "Web build not found",
          );
          return;
        }

        if (method === "HEAD") {
          response.writeHead(200, securityHeaders);
          response.end();
          return;
        }
        serveFile(response, file);
      };

      void handleRequest().catch((error: unknown) => {
        const knownInputError =
          error instanceof Error &&
          ["CONTENT_TYPE", "BODY_TOO_LARGE", "INVALID_JSON"].includes(
            error.message,
          );
        if (!response.headersSent) {
          sendError(
            response,
            knownInputError ? 400 : 500,
            knownInputError ? "INVALID_REQUEST" : "INTERNAL_ERROR",
            knownInputError
              ? "Request body is invalid"
              : "Internal server error",
          );
        } else {
          response.destroy();
        }
        if (!knownInputError) console.error("request.failed");
      });
    },
  );

  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, () => {
      server.off("error", reject);
      resolveListen();
    });
  });

  const address = server.address() as AddressInfo;
  const host =
    address.address === "::" || address.address === "0.0.0.0"
      ? "127.0.0.1"
      : address.address;

  return {
    baseUrl: `http://${host}:${String(address.port)}`,
    close: async () => {
      await new Promise<void>((resolveClose, reject) => {
        server.close((error) => {
          if (error === undefined) resolveClose();
          else reject(error);
        });
      });
      database.close();
    },
  };
};
