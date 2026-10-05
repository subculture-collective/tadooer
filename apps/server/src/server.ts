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
import { liveSyncPath } from "@suite/contracts";
import { AuthService, sessionCookie } from "./auth.ts";
import { sendError } from "./http-utils.ts";
import { BaikalConnectorService } from "./connector.ts";
import { GoogleConnectorService } from "./google-connector.ts";
import {
  CalendarSubscriptionService,
  type AddressLookup,
} from "./calendar-subscriptions.ts";
import { CalendarBridgeService } from "./calendar-bridge/service.ts";
import { BridgeLeaseManager } from "./calendar-bridge/leases.ts";
import { ProviderThrottle } from "./calendar-bridge/throttle.ts";
import {
  systemSchedulerClock,
  type SchedulerClock,
} from "./calendar-bridge/scheduler-clock.ts";
import {
  CalendarBridgeWorker,
  classifyBridgeReason,
  type ProjectionSyncOutcome,
} from "./calendar-bridge/worker.ts";
import { loadNtfyPublisherConfig, NtfyPublisher } from "./notifications.ts";
import type { RouteContext } from "./routes/shared.ts";
import { LiveSyncService } from "./live-sync/service.ts";
import type { LiveSyncTimers } from "./live-sync/hub.ts";
import { handleHealth } from "./routes/health.ts";
import { handleAuthSetup } from "./routes/auth-setup.ts";
import { handleTasks } from "./routes/tasks.ts";
import { handleCapture } from "./routes/capture.ts";
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
import { handleCounters } from "./routes/counters.ts";
import { handlePluginData } from "./routes/plugin-data.ts";
import { handleDayOrder } from "./routes/day-order.ts";
import { handleBoards } from "./routes/boards.ts";
import { handleBoardViews } from "./routes/board-views.ts";
import { handleFocus } from "./routes/focus.ts";
import { runFocusReminders } from "./focus-reminders.ts";
import { createSyncFeedPruner } from "./sync-retention.ts";
import { handleApplicationPreferences } from "./routes/application-preferences.ts";
import { handleDataExport } from "./routes/data-export.ts";
import { handleTemplates } from "./routes/templates.ts";
import { handleChoicePools } from "./routes/choice-pools.ts";
import { handleCalendar } from "./routes/calendar.ts";
import { handleCalendarSubscriptions } from "./routes/calendar-subscriptions.ts";
import { handleCalendarBridge } from "./routes/calendar-bridge.ts";
import { handleAutomation } from "./routes/automation.ts";
import { handleNotifications } from "./routes/notifications.ts";
import { handleHabits } from "./routes/habits.ts";
import { handleStatic } from "./routes/static.ts";
import { HostedOAuthService } from "./hosted-oauth.ts";
import { handleHostedOAuth } from "./routes/hosted-oauth.ts";

export interface RunningSuiteServer {
  readonly baseUrl: string;
  runNotifications(): Promise<void>;
  /** ADR 0043 worker; undefined when the configuration has none. */
  readonly calendarBridgeWorker: CalendarBridgeWorker | undefined;
  close(): Promise<void>;
}

export interface SuiteServerOptions {
  readonly connectorFetch?: typeof fetch;
  readonly googleFetch?: typeof fetch;
  /** iCal subscription fetches (ADR 0032); tests supply fakes. */
  readonly subscriptionFetch?: typeof fetch;
  readonly subscriptionLookup?: AddressLookup;
  readonly sessionClock?: SessionClock;
  readonly notificationFetch?: typeof fetch;
  readonly notificationIntervalMs?: number;
  readonly disableNotificationTimer?: boolean;
  /** ADR 0043: worker, lease and throttle time source; tests use a manual clock. */
  readonly schedulerClock?: SchedulerClock;
  /** Deterministic jitter for tests. */
  readonly schedulerRandom?: () => number;
  /** Leaves the worker constructed but without its periodic timer. */
  readonly disableCalendarBridgeTimer?: boolean;
  /** Lease holder identity; defaults to a random ID per process start. */
  readonly leaseHolder?: string;
  /** ADR 0045: hint stream timers; tests use a manual clock. */
  readonly liveSyncTimers?: LiveSyncTimers;
}

export const startSuiteServer = async (
  config: ServerConfig,
  options: SuiteServerOptions = {},
): Promise<RunningSuiteServer> => {
  const database = SuiteDatabase.open(config.databasePath);
  const auth = new AuthService(
    database,
    undefined,
    undefined,
    config.trustedProxyCidrs ?? [],
  );
  const sessionClock = options.sessionClock ?? { now: () => new Date() };
  const hostedOAuth =
    config.hostedOAuth?.enabled === true &&
    config.publicOrigin !== undefined &&
    config.hostedOAuth.clientConfigPath !== undefined &&
    config.hostedOAuth.resource !== undefined
      ? new HostedOAuthService(
          database,
          config.publicOrigin,
          config.hostedOAuth.resource,
          config.hostedOAuth.clientConfigPath,
          () => sessionClock.now().toISOString(),
        )
      : undefined;
  const schedulerClock = options.schedulerClock ?? systemSchedulerClock;
  // ADR 0043: every Google request (routes and worker) feeds one cooldown.
  const googleThrottle = new ProviderThrottle(schedulerClock);
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
    googleThrottle.wrap(options.googleFetch ?? fetch),
  );
  const calendarSubscriptions = new CalendarSubscriptionService(
    database,
    config.credentialKeyPath,
    {
      ...(options.subscriptionFetch === undefined
        ? {}
        : { fetch: options.subscriptionFetch }),
      ...(options.subscriptionLookup === undefined
        ? {}
        : { lookup: options.subscriptionLookup }),
    },
  );
  // ADR 0043: the lease excludes passes of one mapping across processes, for
  // both the worker and the owner's manual run route.
  const bridgeLeases = new BridgeLeaseManager(database.calendarBridgeWorker, {
    clock: schedulerClock,
    ...(options.leaseHolder === undefined
      ? {}
      : { holder: options.leaseHolder }),
  });
  const calendarBridge = new CalendarBridgeService(
    database,
    connector,
    google,
    bridgeLeases,
  );
  const runProjection = async (
    ownerId: string,
    now: Date,
  ): Promise<ProjectionSyncOutcome> => {
    let status: Awaited<ReturnType<typeof google.synchronize>>["status"];
    try {
      ({ status } = await google.synchronize(ownerId, now));
    } catch {
      return {
        kind: "failed",
        failureClass: "provider-offline",
        errorCode: "google-transport",
      };
    }
    if (!status.configured || status.state === "disconnected")
      return {
        kind: "failed",
        failureClass: "grant-expired",
        errorCode: "google-not-connected",
      };
    if (status.state === "reconnect_required")
      return {
        kind: "failed",
        failureClass: "grant-expired",
        errorCode: "google-reconnect-required",
      };
    if (status.state === "stale")
      return {
        kind: "failed",
        failureClass: classifyBridgeReason("google-stale"),
        errorCode: "google-stale",
      };
    return { kind: "ok" };
  };
  const calendarBridgeWorker =
    config.calendarBridgeWorker === undefined
      ? undefined
      : new CalendarBridgeWorker(config.calendarBridgeWorker, {
          store: database.calendarBridgeWorker,
          leases: bridgeLeases,
          clock: schedulerClock,
          runBridge: (ownerId, mappingId, now) =>
            calendarBridge.runOnce(ownerId, mappingId, now),
          runProjection,
          throttle: googleThrottle,
          ...(options.schedulerRandom === undefined
            ? {}
            : { random: options.schedulerRandom }),
        });
  const requestCounts = new Map<number, number>();
  const liveSync = new LiveSyncService(database, auth, options.liveSyncTimers);
  const notificationConfig = loadNtfyPublisherConfig(
    config.ntfyPublisherConfigPath,
  );
  const notificationPublisher =
    notificationConfig === undefined
      ? undefined
      : new NtfyPublisher(notificationConfig, options.notificationFetch);
  database.failUncertainNotificationDeliveries(new Date().toISOString());

  const pruneSyncFeed = createSyncFeedPruner(
    database,
    config.syncRetentionDays,
  );

  const runNotifications = async (): Promise<void> => {
    const ownerId = database.getActiveOwnerId();
    if (ownerId === undefined) return;
    const now = sessionClock.now().toISOString();
    // ADR 0045: feed retention, at most once per hour.
    pruneSyncFeed(ownerId, now);
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
    // ADR 0032: fetch due iCal subscriptions, then create today's tasks for
    // auto-import subscriptions. Failures are recorded per subscription.
    try {
      await calendarSubscriptions.refreshDue(now);
      calendarSubscriptions.autoImport(ownerId, now);
    } catch {
      console.error("calendar_subscriptions.tick_failed");
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
          message: "Test reminder from Tadooer. Nothing is due.",
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
    // ADR 0029: focus reminders share the ledger but not the task loop below.
    try {
      await runFocusReminders({
        database,
        sessionClock,
        ownerId,
        publisher: notificationPublisher,
        detailedContentEnabled: preferences.detailedContentEnabled,
        clickOrigin: config.publicOrigin ?? "http://localhost",
      });
    } catch {
      console.error("focus.reminders_failed");
    }
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
      if (
        due.ownerId !== ownerId ||
        due.taskId === null ||
        (due.kind !== "lead" &&
          due.kind !== "at_start" &&
          due.kind !== "deadline")
      )
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
    calendarSubscriptions,
    calendarBridge,
    calendarBridgeWorker,
    googleThrottle,
    ntfy: notificationPublisher,
    sessionClock,
    requestCounts,
    triggerNotifications,
    liveSync,
    hostedOAuth,
  };

  const routes = [
    handleHostedOAuth,
    handleHealth,
    handleAuthSetup,
    handleConnectors,
    handleSync,
    handleActiveSession,
    handleCalendar,
    handleCalendarSubscriptions,
    handleCalendarBridge,
    handleAutomation,
    handleNotifications,
    handleHabits,
    handleTasks,
    handleCapture,
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
    handleCounters,
    handlePluginData,
    handleDayOrder,
    handleBoards,
    handleBoardViews,
    handleFocus,
    handleApplicationPreferences,
    handleDataExport,
    handleChoicePools,
    handleTemplates,
    handleStatic,
  ];

  const server = createServer(
    (request: IncomingMessage, response: ServerResponse) => {
      response.once("finish", () => {
        requestCounts.set(
          response.statusCode,
          (requestCounts.get(response.statusCode) ?? 0) + 1,
        );
        // ADR 0045: announce what a finished mutation changed.
        liveSync.afterRequest(request, response);
      });
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
        // ADR 0048: a trusted device's token is replaced on use. The hint
        // stream never rotates it, and `rotateDeviceToken` skips requests
        // caused by a hint. A route that sets its own session cookie (sign
        // in, sign out) overrides this header.
        if (url.pathname.startsWith("/api/") && url.pathname !== liveSyncPath) {
          const rotated = auth.rotateDeviceToken(request);
          if (rotated !== undefined)
            response.setHeader(
              "Set-Cookie",
              sessionCookie(rotated, config.secureCookies),
            );
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
  if (!options.disableCalendarBridgeTimer) calendarBridgeWorker?.start();

  return {
    baseUrl: `http://${host}:${String(address.port)}`,
    runNotifications: triggerNotifications,
    calendarBridgeWorker,
    close: async () => {
      if (notificationTimer !== undefined) clearInterval(notificationTimer);
      // ADR 0045: streams get `bye: shutdown` before the listener stops;
      // an open stream would otherwise hold `server.close` open.
      liveSync.close();
      // Let in-flight passes finish or reach a checkpoint before the
      // database closes (ADR 0043).
      await calendarBridgeWorker?.stop();
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
