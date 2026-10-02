import type {
  HealthResponse,
  BuildResponse,
  ReadinessResponse,
} from "@suite/contracts";
import { sendJson, securityHeaders } from "../http-utils.ts";
import { calendarBridgeMetricLines } from "../calendar-bridge/worker.ts";
import { syncFeedMetricLines } from "../sync-retention.ts";
import type { RouteHandler } from "./shared.ts";

const startedAt = Date.now();

export const handleHealth: RouteHandler = async (
  request,
  response,
  url,
  ctx,
) => {
  await Promise.resolve();
  const { stores: database, config, requestCounts } = ctx;
  const method = request.method ?? "GET";
  const timestamp = new Date().toISOString();

  if (method === "GET" && url.pathname === "/api/health") {
    const body: HealthResponse = {
      service: "productivity-suite",
      status: "ok",
      timestamp,
    };
    sendJson(response, 200, body);
    return true;
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
      ...syncFeedMetricLines(database, Date.now()),
      "# HELP suite_http_requests_total Completed HTTP responses by status.",
      "# TYPE suite_http_requests_total counter",
      ...[...requestCounts.entries()]
        .sort(([left], [right]) => left - right)
        .map(
          ([status, count]) =>
            `suite_http_requests_total{status="${String(status)}"} ${String(count)}`,
        ),
      ...calendarBridgeMetricLines({
        snapshot: database.calendarBridgeWorker.health(),
        nowMs: Date.now(),
        worker: ctx.calendarBridgeWorker,
        throttle: ctx.googleThrottle,
      }),
      "",
    ];
    response.writeHead(200, {
      ...securityHeaders,
      "Cache-Control": "no-store",
      "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
    });
    response.end(lines.join("\n"));
    return true;
  }

  if (method === "GET" && url.pathname === "/api/build") {
    const body: BuildResponse = {
      service: "productivity-suite",
      ...config.build,
    };
    sendJson(response, 200, body);
    return true;
  }

  if (method === "GET" && url.pathname === "/api/ready") {
    try {
      database.check();
      const state = database.state();
      const current =
        state.appliedMigrationCount === state.expectedMigrationCount;
      let calendarBridge: ReadinessResponse["checks"]["calendarBridge"];
      try {
        calendarBridge =
          ctx.calendarBridgeWorker?.healthState(
            database.calendarBridgeWorker.health(),
          ) ?? "disabled";
      } catch {
        calendarBridge = undefined;
      }
      const body: ReadinessResponse = {
        service: "productivity-suite",
        status: current ? "ok" : "not_ready",
        checks: {
          database: "ok",
          migrations: current ? "current" : "pending",
          ...(calendarBridge === undefined ? {} : { calendarBridge }),
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
    return true;
  }

  return false;
};
