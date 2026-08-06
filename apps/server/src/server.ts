import { createReadStream, existsSync, statSync } from "node:fs";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import type { AddressInfo } from "node:net";
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
} from "@suite/contracts";
import {
  SuiteDatabase,
  type TaskRecord,
  type ConditionalTaskResult,
  type ActiveSessionRecord,
  type ActiveSessionIntervalRecord,
  type ActiveSessionEventRecord,
} from "@suite/persistence";
import {
  createActiveSession,
  observeActiveSession,
  transitionActiveSession,
  type ActiveSession,
  type SessionClock,
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
} as const;

const maxJsonBytes = 128 * 1024;

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

  const server = createServer(
    (request: IncomingMessage, response: ServerResponse) => {
      const handleRequest = async (): Promise<void> => {
        const method = request.method ?? "GET";
        const url = new URL(request.url ?? "/", "http://suite.local");
        const timestamp = new Date().toISOString();

        if (method === "GET" && url.pathname === "/api/health") {
          const body: HealthResponse = {
            service: "productivity-suite",
            status: "ok",
            timestamp,
          };
          sendJson(response, 200, body);
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
          const limiterKey = `${request.socket.remoteAddress ?? "unknown"}:${parsed.data.username.toLowerCase()}`;
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
          let fresh = true;
          let projectedAt: string | null = null;
          if (status.ok && status.status.connected) {
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
                result.value
                  .filter((resource) => !resource.event.allDay)
                  .map((resource) => ({
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
                    allDay: false,
                    freshness: "current" as const,
                    mutable: false,
                    revision: 1,
                    projectedAt: now,
                  })),
              );
            }
          } else {
            fresh = false;
          }
          const events = database.listCalendarEvents(
            session.owner.id,
            window.data.from,
            window.data.to,
          );
          const body: PlannerResponse = {
            window: window.data,
            tasks: database.listTasks(session.owner.id).map(taskResponse),
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
              recurrence: "none",
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
          if (
            !database.revokeSyncClient(
              session.owner.id,
              revokeMatch[1]!,
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
                    task: {
                      ...operation.task,
                      status: "open",
                      revision: 1,
                      createdAt: operation.createdAt,
                      updatedAt: operation.createdAt,
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
                        ].includes(field),
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
              return {
                sequence: change.sequence,
                entityKind: change.entityType as
                  "task" | "project" | "tag" | "subtask" | "active_session",
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
                          : active !== undefined &&
                              active.id === change.entityId
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
          const kind = organizationMatch[1]!;
          const id = organizationMatch[2]!;
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
                      title!,
                      now,
                    )
                : wantsArchive
                  ? database.archiveTag(session.owner.id, id, revision, now)
                  : database.renameTag(
                      session.owner.id,
                      id,
                      revision,
                      title!,
                      title!.normalize("NFKC").toLocaleLowerCase(),
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
          const taskId = taskOrganizationMatch[1]!;
          const target = taskOrganizationMatch[2]!;
          const now = new Date().toISOString();
          const result =
            target === "project"
              ? (input.projectId === null ||
                  (typeof input.projectId === "string" &&
                    /^[0-9a-f-]{36}$/.test(input.projectId))) &&
                database.assignTaskProject(
                  session.owner.id,
                  taskId,
                  input.projectId as string | null,
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
          const taskId = taskSubtasksMatch[1]!;
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
          const id = subtaskMatch[1]!;
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
            if (before === undefined || before.id !== command.sessionId) {
              sendError(
                response,
                404,
                "ACTIVE_SESSION_NOT_FOUND",
                "Active session not found",
              );
              return;
            }
            const transition = transitionActiveSession(
              beforeSession!,
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
