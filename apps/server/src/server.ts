import { createReadStream, existsSync, statSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
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
} from "@suite/contracts";
import {
  SuiteDatabase,
  type TaskRecord,
  type ConditionalTaskResult,
} from "@suite/persistence";
import type { ServerConfig } from "./config.ts";
import {
  AuthService,
  clearSessionCookie,
  LoginRateLimiter,
  passwordMeetsPolicy,
  sessionCookie,
} from "./auth.ts";
import { BaikalConnectorService, type ConnectorFailure } from "./connector.ts";

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

export interface RunningSuiteServer {
  readonly baseUrl: string;
  close(): Promise<void>;
}

export interface SuiteServerOptions {
  readonly connectorFetch?: typeof fetch;
}

export const startSuiteServer = async (
  config: ServerConfig,
  options: SuiteServerOptions = {},
): Promise<RunningSuiteServer> => {
  const database = SuiteDatabase.open(config.databasePath);
  const webRoot = resolve(config.webRoot);
  const auth = new AuthService(database);
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
              if (task === undefined || block === undefined)
                throw new Error("Completed planning operation is incomplete");
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
            const remote = await connector.putTaskBlock({
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
            const completed = database.completeCalendarWrite({
              ownerId: session.owner.id,
              idempotencyKey: idempotencyKey.data,
              event: {
                id: randomUUID(),
                providerId: operation.providerId,
                calendarId: operation.calendarId,
                href: remote.value.href,
                uid: remote.value.event.uid,
                etag: remote.value.etag,
                rawIcs: remote.value.rawIcs,
                summary: remote.value.event.summary,
                startsAt: new Date(remote.value.event.startsAt).toISOString(),
                endsAt: new Date(remote.value.event.endsAt).toISOString(),
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
