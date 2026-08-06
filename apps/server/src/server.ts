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
  ReadinessResponse,
} from "@suite/contracts";
import {
  baikalConnectRequestSchema,
  createTaskRequestSchema,
  idempotencyKeySchema,
  loginRequestSchema,
  ownerSetupRequestSchema,
} from "@suite/contracts";
import { SuiteDatabase } from "@suite/persistence";
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

export const startSuiteServer = async (
  config: ServerConfig,
): Promise<RunningSuiteServer> => {
  const database = SuiteDatabase.open(config.databasePath);
  const webRoot = resolve(config.webRoot);
  const auth = new AuthService(database);
  const loginLimiter = new LoginRateLimiter();
  const connector = new BaikalConnectorService(
    database,
    new URL(config.baikalEndpoint),
    config.credentialKeyPath,
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
            tasks: database.listTasks(session.owner.id).map((task) => ({
              id: task.id,
              title: task.title,
              notes: task.notes,
              status: task.status,
              revision: task.revision,
              createdAt: task.createdAt,
              updatedAt: task.updatedAt,
            })),
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
            task: {
              id: result.task.id,
              title: result.task.title,
              notes: result.task.notes,
              status: result.task.status,
              revision: result.task.revision,
              createdAt: result.task.createdAt,
              updatedAt: result.task.updatedAt,
            },
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
