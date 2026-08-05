import { createReadStream, existsSync, statSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import type { AddressInfo } from "node:net";
import type {
  BuildResponse,
  HealthResponse,
  ReadinessResponse,
} from "@suite/contracts";
import { SuiteDatabase } from "@suite/persistence";
import type { ServerConfig } from "./config.ts";

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

const sendJson = (
  response: ServerResponse,
  status: number,
  body: unknown,
): void => {
  response.writeHead(status, {
    ...securityHeaders,
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(body));
};

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

  const server = createServer(
    (request: IncomingMessage, response: ServerResponse) => {
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

      if (url.pathname.startsWith("/api/")) {
        sendJson(response, 404, {
          code: "NOT_FOUND",
          message: "API route not found",
        });
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
        sendJson(response, 404, {
          code: "WEB_BUILD_NOT_FOUND",
          message: "Web build not found",
        });
        return;
      }

      if (method === "HEAD") {
        response.writeHead(200, securityHeaders);
        response.end();
        return;
      }
      serveFile(response, file);
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
