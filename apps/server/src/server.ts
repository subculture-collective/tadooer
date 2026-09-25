import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { type AddressInfo } from "node:net";
import {
  evaluateReminder,
  zonedDayWindow,
  type SessionClock,
} from "@suite/domain";
import { SuiteDatabase } from "@suite/persistence";
import type { ServerConfig } from "./config.ts";
import { AuthService } from "./auth.ts";
import { sendError } from "./http-utils.ts";
import { BaikalConnectorService } from "./connector.ts";
import { GoogleConnectorService } from "./google-connector.ts";
import { loadNtfyPublisherConfig, NtfyPublisher } from "./notifications.ts";
import type { RouteContext } from "./routes/shared.ts";
import { handleHealth } from "./routes/health.ts";
import { handleAuthSetup } from "./routes/auth-setup.ts";
import { handleTasks } from "./routes/tasks.ts";
import { handleTaskImport } from "./routes/task-import.ts";
import { handlePlanner } from "./routes/planner.ts";
import { handleConnectors } from "./routes/connectors.ts";
import { handleSync } from "./routes/sync.ts";
import { handleActiveSession } from "./routes/active-session.ts";
import { handleProjects } from "./routes/projects.ts";
import { handleTags } from "./routes/tags.ts";
import { handleNotes } from "./routes/notes.ts";
import { handleTaskLinks } from "./routes/task-links.ts";
import { handleSubtasks } from "./routes/subtasks.ts";
import { handleTaskHierarchy } from "./routes/task-hierarchy.ts";
import { handleTaskArchive } from "./routes/task-archive.ts";
import { handleRecurrence } from "./routes/recurrence.ts";
import { handleTimeHistory } from "./routes/time-history.ts";
import { handleDayOrder } from "./routes/day-order.ts";
import { handleTemplates } from "./routes/templates.ts";
import { handleChoicePools } from "./routes/choice-pools.ts";
import { handleCalendar } from "./routes/calendar.ts";
import { handleAutomation } from "./routes/automation.ts";
import { handleNotifications } from "./routes/notifications.ts";
import { handleHabits } from "./routes/habits.ts";
import { handleStatic } from "./routes/static.ts";

export interface RunningSuiteServer {
  readonly baseUrl: string;
  runNotifications(): Promise<void>;
  close(): Promise<void>;
}

export interface SuiteServerOptions {
  readonly connectorFetch?: typeof fetch;
  readonly googleFetch?: typeof fetch;
  readonly sessionClock?: SessionClock;
  readonly notificationFetch?: typeof fetch;
  readonly notificationIntervalMs?: number;
  readonly disableNotificationTimer?: boolean;
}

export const startSuiteServer = async (
  config: ServerConfig,
  options: SuiteServerOptions = {},
): Promise<RunningSuiteServer> => {
  const database = SuiteDatabase.open(config.databasePath);
  const auth = new AuthService(database);
  const sessionClock = options.sessionClock ?? { now: () => new Date() };
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
  const requestCounts = new Map<number, number>();
  const notificationConfig = loadNtfyPublisherConfig(
    config.ntfyPublisherConfigPath,
  );
  const notificationPublisher =
    notificationConfig === undefined
      ? undefined
      : new NtfyPublisher(notificationConfig, options.notificationFetch);
  database.failUncertainNotificationDeliveries(new Date().toISOString());

  const runNotifications = async (): Promise<void> => {
    const ownerId = database.getActiveOwnerId();
    if (ownerId === undefined) return;
    const now = sessionClock.now().toISOString();
    // ADR 0023: materialize due recurring occurrences before reminders are
    // reconciled, so a new instance's reminder is scheduled in the same tick.
    try {
      database.recurrence.generateDue({
        ownerId,
        timeZone: database.getPlanningPreferences(ownerId).timeZone,
        now,
      });
    } catch {
      console.error("recurrence.generate_failed");
    }
    const preferences = database.getNotificationPreferences(ownerId);
    const tasks = database.listTasks(ownerId);
    database.reconcileNotificationDeliveries({
      ownerId,
      tasks,
      preferences,
      now,
    });
    // Explicit test requests are independent of scheduled reminder preferences and
    // calendar availability. Claim before sending; ambiguous delivery is terminal.
    if (notificationPublisher !== undefined) {
      for (const due of database.listDueNotificationTests(ownerId, now)) {
        const claimed = database.claimNotificationDelivery(due.id, now);
        if (claimed === undefined) continue;
        const result = await notificationPublisher.publish({
          message: "Tadooer test reminder",
          click: `${config.publicOrigin ?? "http://localhost"}/settings`,
        });
        if (result.kind === "delivered")
          database.finishNotificationDelivery(due.id, "delivered", null, now);
        else if (result.kind === "retry" && claimed.attemptCount < 5) {
          const minutes = [1, 5, 15, 30][claimed.attemptCount - 1] ?? 30;
          database.deferNotificationDelivery(
            due.id,
            new Date(Date.parse(now) + minutes * 60_000).toISOString(),
            result.errorCode,
            now,
          );
        } else
          database.finishNotificationDelivery(
            due.id,
            "failed",
            result.kind === "retry" ? "NTFY_RETRY_EXHAUSTED" : result.errorCode,
            now,
          );
      }
    }
    if (!preferences.enabled || notificationPublisher === undefined) return;
    const planning = database.getPlanningPreferences(ownerId);
    const window = zonedDayWindow(now, planning.timeZone);
    const events = database.listCalendarEvents(ownerId, window.from, window.to);
    const googleStatus = google.status(ownerId);
    const baikalStatus = await connector.status(ownerId);
    const freshness: boolean[] = [];
    if (baikalStatus.ok && baikalStatus.status.connected) freshness.push(true);
    if (googleStatus.connected)
      freshness.push(
        googleStatus.state === "connected" &&
          googleStatus.freshness.every(({ state }) => state === "fresh"),
      );
    const calendarFresh =
      freshness.length > 0 && freshness.every((state) => state);
    const active = database.getActiveSession(ownerId);
    const activeFocusTaskId =
      active?.state === "running" && active.phase === "focus"
        ? active.taskId
        : null;
    for (const due of database.listDueNotificationDeliveries(now)) {
      if (due.ownerId !== ownerId || due.taskId === null || due.kind === "test")
        continue;
      const claimed = database.claimNotificationDelivery(due.id, now);
      if (claimed === undefined) continue;
      const task = database.getTask(ownerId, due.taskId);
      // The occurrence is the planned start, or the timed deadline for a
      // deadline reminder (ADR 0020).
      if (
        task?.deletedAt !== null ||
        (due.kind === "deadline" ? task.deadlineAt : task.plannedStart) !==
          due.occurrenceStart
      ) {
        database.finishNotificationDelivery(
          due.id,
          "cancelled",
          "OBSOLETE",
          now,
        );
        continue;
      }
      const taskBlock = database.getTaskCalendarBlock(ownerId, task.id);
      const decision = evaluateReminder({
        now,
        taskId: task.id,
        taskStatus: task.status,
        occurrenceStart: due.occurrenceStart,
        kind: due.kind,
        preferences: planning,
        calendarFresh,
        busy: events
          .filter(
            (event) =>
              taskBlock?.calendarId !== event.calendarId ||
              taskBlock.eventHref !== event.href,
          )
          .map(({ startsAt, endsAt }) => ({ startsAt, endsAt })),
        activeFocusTaskId,
      });
      if (decision.action === "defer") {
        database.deferNotificationDelivery(
          due.id,
          decision.nextEligibleAt,
          decision.reason.toUpperCase(),
          now,
        );
        continue;
      }
      if (decision.action === "suppress") {
        database.finishNotificationDelivery(
          due.id,
          "suppressed",
          decision.reason.toUpperCase(),
          now,
        );
        continue;
      }
      const localTime = new Intl.DateTimeFormat("en-US", {
        timeZone: planning.timeZone,
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(due.occurrenceStart));
      const result = await notificationPublisher.publish({
        message:
          due.kind === "deadline"
            ? preferences.detailedContentEnabled
              ? `Deadline · ${task.title} · ${localTime}`
              : `Task deadline reminder · ${localTime}`
            : preferences.detailedContentEnabled
              ? `${task.title} · ${localTime}`
              : `Planned task reminder · ${localTime}`,
        click: `${config.publicOrigin ?? "http://localhost"}/tasks?task=${encodeURIComponent(task.id)}`,
      });
      if (result.kind === "delivered")
        database.finishNotificationDelivery(due.id, "delivered", null, now);
      else if (result.kind === "retry" && claimed.attemptCount < 5) {
        const backoffMinutes = [1, 5, 15, 30][claimed.attemptCount - 1] ?? 30;
        database.deferNotificationDelivery(
          due.id,
          new Date(Date.parse(now) + backoffMinutes * 60_000).toISOString(),
          result.errorCode,
          now,
        );
      } else
        database.finishNotificationDelivery(
          due.id,
          "failed",
          result.kind === "retry" ? "NTFY_RETRY_EXHAUSTED" : result.errorCode,
          now,
        );
    }
  };

  let notificationRunning = false;
  const triggerNotifications = async (): Promise<void> => {
    if (notificationRunning) return;
    notificationRunning = true;
    try {
      await runNotifications();
    } catch {
      console.error("notifications.tick_failed");
    } finally {
      notificationRunning = false;
    }
  };

  const ctx: RouteContext = {
    stores: database,
    auth,
    config,
    baikal: connector,
    google,
    ntfy: notificationPublisher,
    sessionClock,
    requestCounts,
    triggerNotifications,
  };

  const routes = [
    handleHealth,
    handleAuthSetup,
    handleConnectors,
    handleSync,
    handleActiveSession,
    handleCalendar,
    handleAutomation,
    handleNotifications,
    handleHabits,
    handleTasks,
    handleTaskImport,
    handlePlanner,
    handleProjects,
    handleTags,
    handleNotes,
    handleTaskLinks,
    handleSubtasks,
    handleTaskHierarchy,
    handleTaskArchive,
    handleRecurrence,
    handleTimeHistory,
    handleDayOrder,
    handleChoicePools,
    handleTemplates,
    handleStatic,
  ];

  const server = createServer(
    (request: IncomingMessage, response: ServerResponse) => {
      response.once("finish", () =>
        requestCounts.set(
          response.statusCode,
          (requestCounts.get(response.statusCode) ?? 0) + 1,
        ),
      );
      const handleRequest = async (): Promise<void> => {
        const url = new URL(
          request.url ?? "/",
          `http://${request.headers.host ?? "localhost"}`,
        );
        if (config.publicOrigin !== undefined) {
          const expected = new URL(config.publicOrigin);
          let requestHost: URL | undefined;
          try {
            requestHost = new URL(`http://${request.headers.host ?? ""}`);
          } catch {
            requestHost = undefined;
          }
          const requestHostMatches =
            requestHost?.username === "" &&
            requestHost.password === "" &&
            requestHost.pathname === "/" &&
            requestHost.search === "" &&
            requestHost.hash === "" &&
            requestHost.hostname.toLowerCase() ===
              expected.hostname.toLowerCase();
          if (!requestHostMatches) {
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
        for (const handler of routes) {
          if (await handler(request, response, url, ctx)) return;
        }
        sendError(response, 404, "NOT_FOUND", "Route not found");
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

  const notificationTimer = options.disableNotificationTimer
    ? undefined
    : setInterval(
        () => void triggerNotifications(),
        options.notificationIntervalMs ?? 60_000,
      );
  notificationTimer?.unref();

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

  if (!options.disableNotificationTimer) void triggerNotifications();

  return {
    baseUrl: `http://${host}:${String(address.port)}`,
    runNotifications: triggerNotifications,
    close: async () => {
      if (notificationTimer !== undefined) clearInterval(notificationTimer);
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
