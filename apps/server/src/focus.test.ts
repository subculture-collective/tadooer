import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import {
  activeSessionCommandResponseSchema,
  automationConfirmationResponseSchema,
  automationPreviewResponseSchema,
  automationTokenScopeSchema,
  clientRegistrationResponseSchema,
  createAutomationTokenResponseSchema,
  defaultFocusPreferences,
  focusIdleResponseSchema,
  focusPreferencesResponseSchema,
  focusTimerSchema,
  taskMutationResponseSchema,
  timeReportResponseSchema,
} from "@suite/contracts";
import { ManualSessionClock } from "@suite/domain";
import { withTemporaryDirectory } from "@suite/test-support";
import type { ServerConfig } from "./config.ts";
import { startSuiteServer, type RunningSuiteServer } from "./server.ts";

const minutes = (value: number) => value * 60_000;

/** Focus reminder rows straight from the ledger, oldest first. */
const focusDeliveries = (databasePath: string) => {
  const db = new DatabaseSync(databasePath);
  try {
    return (
      db
        .prepare(
          "SELECT reminder_kind AS kind, state, occurrence_start AS occurrenceStart FROM notification_deliveries WHERE reminder_kind LIKE 'focus_%' ORDER BY created_at, id",
        )
        .all() as { kind: string; state: string; occurrenceStart: string }[]
    ).map(({ kind, state, occurrenceStart }) => ({
      kind,
      state,
      occurrenceStart,
    }));
  } finally {
    db.close();
  }
};

const configuration = async (directory: string): Promise<ServerConfig> => {
  await mkdir(join(directory, "web"));
  const ntfyPublisherConfigPath = join(directory, "ntfy.json");
  await writeFile(
    ntfyPublisherConfigPath,
    JSON.stringify({
      baseUrl: "http://ntfy",
      topic: "private",
      token: "private-test-token-for-disposable-test",
    }),
    { mode: 0o600 },
  );
  return {
    host: "127.0.0.1",
    port: 0,
    databasePath: join(directory, "suite.sqlite"),
    webRoot: join(directory, "web"),
    baikalEndpoint: "http://baikal.test/dav.php/",
    credentialKeyPath: join(directory, "credential.key"),
    ntfyPublisherConfigPath,
    secureCookies: false,
    build: { version: "test", revision: "test", builtAt: null },
  };
};

const signIn = async (server: RunningSuiteServer) => {
  const owner = {
    username: "focus",
    displayName: "Focus",
    password: "a sufficiently long disposable password",
  };
  await fetch(`${server.baseUrl}/api/setup`, {
    method: "POST",
    headers: { Origin: server.baseUrl, "Content-Type": "application/json" },
    body: JSON.stringify(owner),
  });
  const login = await fetch(`${server.baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { Origin: server.baseUrl, "Content-Type": "application/json" },
    body: JSON.stringify(owner),
  });
  const cookie = login.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
  const { csrfToken } = (await login.json()) as { csrfToken: string };
  const call = (
    path: string,
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
    body?: unknown,
    headers: Record<string, string> = {},
  ) =>
    fetch(`${server.baseUrl}${path}`, {
      method,
      headers: {
        Origin: server.baseUrl,
        Cookie: cookie,
        "X-CSRF-Token": csrfToken,
        // The server restarts mid-test; never reuse a socket to the old one.
        Connection: "close",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  expect(
    (
      await call("/api/planning/preferences", "PUT", {
        workingDays: [1, 2, 3, 4, 5],
        workdayStart: "09:00",
        workdayEnd: "17:00",
        breakStart: null,
        breakEnd: null,
        timeZone: "America/Chicago",
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await call("/api/notifications/preferences", "PUT", {
        enabled: true,
        leadReminderEnabled: true,
        atStartReminderEnabled: true,
        detailedContentEnabled: true,
      })
    ).status,
  ).toBe(200);
  const client = clientRegistrationResponseSchema.parse(
    await (await call("/api/clients", "POST", { label: "Laptop" })).json(),
  );
  const proof = {
    "X-Suite-Client-Id": client.client.id,
    "X-Suite-Client-Credential": client.clientCredential,
  };
  const task = taskMutationResponseSchema.parse(
    await (
      await call(
        "/api/tasks",
        "POST",
        { title: "Write report", estimateMinutes: 90 },
        { "Idempotency-Key": randomUUID() },
      )
    ).json(),
  ).task;
  return { call, proof, task, clientId: client.client.id };
};
type Session = Awaited<ReturnType<typeof signIn>>;

const command = async (
  { call, proof }: Session,
  body: Record<string, unknown>,
) =>
  activeSessionCommandResponseSchema.parse(
    await (
      await call(
        "/api/active-session/command",
        "POST",
        { idempotencyKey: randomUUID(), ...body },
        proof,
      )
    ).json(),
  );

const timer = async ({ call, proof }: Session) =>
  focusTimerSchema.parse(
    await (await call("/api/focus/timer", "GET", undefined, proof)).json(),
  );

/** Advances the clock a minute at a time, heartbeating a running session. */
const advance = async (
  session: Session,
  clock: ManualSessionClock,
  count: number,
) => {
  let current = (await timer(session)).session;
  for (let step = 0; step < count; step++) {
    clock.advanceSeconds(60);
    if (current?.state === "running")
      current = (
        await command(session, {
          command: "heartbeat",
          sessionId: current.id,
          expectedRevision: current.revision,
        })
      ).session;
  }
  return current;
};

describe("focus preferences, presets, idle disposition and reminders (ADR 0029)", () => {
  it("versions preferences with If-Match and rejects stale browser and assistant writes", async () => {
    await withTemporaryDirectory(async (directory) => {
      const server = await startSuiteServer(await configuration(directory), {
        disableNotificationTimer: true,
      });
      try {
        const session = await signIn(server);
        const { call } = session;
        const initial = focusPreferencesResponseSchema.parse(
          await (await call("/api/focus/preferences", "GET")).json(),
        );
        expect(initial).toEqual({
          preferences: defaultFocusPreferences,
          revision: 0,
          imported: null,
        });
        const edited = {
          ...defaultFocusPreferences,
          pomodoro: { ...defaultFocusPreferences.pomodoro, workMinutes: 50 },
        };
        expect(
          (await call("/api/focus/preferences", "PUT", edited)).status,
        ).toBe(428);
        const saved = await call("/api/focus/preferences", "PUT", edited, {
          "If-Match": '"0"',
        });
        expect(saved.status).toBe(200);
        expect(
          focusPreferencesResponseSchema.parse(await saved.json()),
        ).toMatchObject({
          revision: 1,
          preferences: { pomodoro: { workMinutes: 50 } },
        });
        const stale = await call("/api/focus/preferences", "PUT", edited, {
          "If-Match": '"0"',
        });
        expect(stale.status).toBe(412);
        expect(await stale.json()).toMatchObject({
          code: "FOCUS_PREFERENCES_CONFLICT",
        });
        expect(
          (
            await call(
              "/api/focus/preferences",
              "PUT",
              { ...edited, countdownMinutes: 0 },
              { "If-Match": '"1"' },
            )
          ).status,
        ).toBe(400);

        const token = createAutomationTokenResponseSchema.parse(
          await (
            await call("/api/automation/tokens", "POST", {
              label: "Assistant",
              scopes: [...automationTokenScopeSchema.options],
              expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
            })
          ).json(),
        ).token;
        const assistant = (
          path: string,
          method: "GET" | "POST",
          body?: unknown,
        ) =>
          fetch(`${server.baseUrl}${path}`, {
            method,
            headers: {
              Authorization: `Bearer ${token}`,
              ...(body === undefined
                ? {}
                : { "Content-Type": "application/json" }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          });
        const resource = await assistant(
          "/api/automation/v1/resources/focus-preferences",
          "GET",
        );
        expect(resource.status).toBe(200);
        expect(await resource.json()).toMatchObject({
          revision: 1,
          pomodoro: { workMinutes: 50 },
        });
        const stalePreview = await assistant(
          "/api/automation/v1/previews",
          "POST",
          {
            operation: "focus.update_preferences",
            input: { expectedRevision: 0, preferences: edited },
          },
        );
        expect(stalePreview.status).toBe(412);
        const preview = automationPreviewResponseSchema.parse(
          await (
            await assistant("/api/automation/v1/previews", "POST", {
              operation: "focus.update_preferences",
              input: {
                expectedRevision: 1,
                preferences: { ...edited, countdownMinutes: 30 },
              },
            })
          ).json(),
        ).preview;
        expect(preview.baseRevisions).toEqual([
          {
            entityKind: "focus_preferences",
            entityId: expect.any(String) as string,
            revision: 1,
          },
        ]);
        // A browser save after the preview makes it stale.
        expect(
          (
            await call(
              "/api/focus/preferences",
              "PUT",
              { ...edited, breakEndAlarm: true },
              { "If-Match": '"1"' },
            )
          ).status,
        ).toBe(200);
        const denied = await assistant(
          `/api/automation/v1/previews/${preview.id}/confirm`,
          "POST",
          { idempotencyKey: randomUUID() },
        );
        expect(denied.status).toBe(412);
        const fresh = automationPreviewResponseSchema.parse(
          await (
            await assistant("/api/automation/v1/previews", "POST", {
              operation: "focus.update_preferences",
              input: {
                expectedRevision: 2,
                preferences: {
                  ...edited,
                  breakEndAlarm: true,
                  countdownMinutes: 30,
                },
              },
            })
          ).json(),
        ).preview;
        const confirmed = automationConfirmationResponseSchema.parse(
          await (
            await assistant(
              `/api/automation/v1/previews/${fresh.id}/confirm`,
              "POST",
              { idempotencyKey: randomUUID() },
            )
          ).json(),
        );
        expect(confirmed.result).toMatchObject({
          focusPreferences: { revision: 3, countdownMinutes: 30 },
        });
      } finally {
        await server.close();
      }
    });
  });

  it("drives a Pomodoro plan, queues countdown and break-end reminders once, and applies idle dispositions to the worklog", async () => {
    await withTemporaryDirectory(async (directory) => {
      // 10:00 CDT on Thursday, September 24: inside working hours.
      const clock = new ManualSessionClock("2026-09-24T15:00:00.000Z");
      const publisher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response("ok"));
      const config = await configuration(directory);
      const options = {
        sessionClock: clock,
        disableNotificationTimer: true,
        notificationFetch: publisher,
      };
      let server = await startSuiteServer(config, options);
      // Restarts reuse the port so the signed-in client keeps its base URL.
      const port = Number(new URL(server.baseUrl).port);
      try {
        const session = await signIn(server);
        const { call, proof, task } = session;
        const started = await command(session, {
          command: "start",
          taskId: task.id,
        });
        const empty = await timer(session);
        expect(empty).toMatchObject({
          plan: null,
          countdown: null,
          breakReminder: { due: false, workingWithoutBreakMs: 0 },
          trackingReminder: {
            enabled: false,
            due: false,
            suppressedReason: null,
          },
          idle: { enabled: true, minIdleMs: minutes(5), suppressed: false },
        });

        // Only the controller sets a plan, with the current revision.
        const stalePlan = await call(
          "/api/focus/plan",
          "PUT",
          {
            sessionId: started.session.id,
            expectedRevision: 99,
            mode: "pomodoro",
          },
          proof,
        );
        expect(stalePlan.status).toBe(412);
        const planned = await call(
          "/api/focus/plan",
          "PUT",
          {
            sessionId: started.session.id,
            expectedRevision: started.session.revision,
            mode: "pomodoro",
          },
          proof,
        );
        expect(planned.status).toBe(200);
        expect(focusTimerSchema.parse(await planned.json())).toMatchObject({
          plan: { mode: "pomodoro", workMs: minutes(25) },
          countdown: {
            phase: "focus",
            elapsedMs: 0,
            targetMs: minutes(25),
            cycle: 1,
          },
        });

        // Idle from 10:10 to 10:20, counted as a break: focus time is trimmed.
        let current = await advance(session, clock, 20);
        const idleKey = randomUUID();
        const idleBody = {
          sessionId: started.session.id,
          expectedRevision: current?.revision ?? 0,
          idleStartedAt: "2026-09-24T15:10:00.000Z",
          disposition: "break",
          idempotencyKey: idleKey,
        };
        const idle = await call("/api/focus/idle", "POST", idleBody, proof);
        expect(idle.status).toBe(200);
        const applied = focusIdleResponseSchema.parse(await idle.json());
        expect(applied).toMatchObject({
          replayed: false,
          correction: {
            disposition: "break",
            idleStartedAt: "2026-09-24T15:10:00.000Z",
            idleEndedAt: "2026-09-24T15:20:00.000Z",
            trimmedMs: minutes(10),
          },
          session: { phase: "focus", state: "running" },
        });
        // Replay returns the same outcome; a reused key with another body conflicts.
        const replayed = await call("/api/focus/idle", "POST", idleBody, proof);
        expect(replayed.status).toBe(200);
        expect(
          focusIdleResponseSchema.parse(await replayed.json()),
        ).toMatchObject({
          replayed: true,
          correction: { trimmedMs: minutes(10) },
          session: { revision: applied.session.revision },
        });
        expect(
          (
            await call(
              "/api/focus/idle",
              "POST",
              { ...idleBody, disposition: "discard" },
              proof,
            )
          ).status,
        ).toBe(409);
        // The stale revision from before the correction is refused.
        expect(
          (
            await call(
              "/api/focus/idle",
              "POST",
              { ...idleBody, idempotencyKey: randomUUID() },
              proof,
            )
          ).status,
        ).toBe(412);
        const report = timeReportResponseSchema.parse(
          await (
            await call("/api/time/report?from=2026-09-24&to=2026-09-24", "GET")
          ).json(),
        );
        expect(report.bySource.focus).toBe(minutes(10));
        // The break split the stretch: the countdown restarts, the cycle stays.
        expect((await timer(session)).countdown).toMatchObject({
          elapsedMs: 0,
          cycle: 1,
          done: false,
        });

        // Complete the focus stretch: the ledger queues one countdown row.
        current = await advance(session, clock, 26);
        await server.runNotifications();
        await server.runNotifications();
        expect(focusDeliveries(config.databasePath)).toEqual([
          {
            kind: "focus_countdown",
            state: "delivered",
            occurrenceStart: "2026-09-24T15:45:00.000Z",
          },
        ]);
        expect(publisher).toHaveBeenCalledTimes(1);
        expect(publisher.mock.calls[0]?.[1]?.body).toBe(
          "Focus time complete · 0:25 · Write report",
        );

        // Start the break; the cycle stays 1 until the break ends.
        current = (
          await command(session, {
            command: "start_break",
            sessionId: started.session.id,
            expectedRevision: current?.revision ?? 0,
          })
        ).session;
        expect((await timer(session)).countdown).toMatchObject({
          phase: "break",
          targetMs: minutes(5),
          isLongBreak: false,
          cycle: 1,
        });
        current = await advance(session, clock, 6);
        // Restart: the break-end row is queued exactly once across restarts.
        await server.close();
        server = await startSuiteServer({ ...config, port }, options);
        await server.runNotifications();
        await server.runNotifications();
        expect(
          focusDeliveries(config.databasePath).filter(
            ({ kind }) => kind === "focus_break_end",
          ),
        ).toEqual([
          {
            kind: "focus_break_end",
            state: "delivered",
            occurrenceStart: "2026-09-24T15:51:00.000Z",
          },
        ]);
        expect(publisher).toHaveBeenCalledTimes(2);
        current = (
          await command(session, {
            command: "end_break",
            sessionId: started.session.id,
            expectedRevision: current?.revision ?? 0,
          })
        ).session;
        expect((await timer(session)).countdown).toMatchObject({
          phase: "focus",
          cycle: 2,
          elapsedMs: 0,
        });
        // Idle during focus, discarded: the span belongs to no interval.
        current = await advance(session, clock, 5);
        const discarded = await call(
          "/api/focus/idle",
          "POST",
          {
            sessionId: started.session.id,
            expectedRevision: current?.revision ?? 0,
            idleStartedAt: "2026-09-24T15:55:00.000Z",
            disposition: "discard",
            idempotencyKey: randomUUID(),
          },
          proof,
        );
        expect(discarded.status).toBe(200);
        const after = timeReportResponseSchema.parse(
          await (
            await call("/api/time/report?from=2026-09-24&to=2026-09-24", "GET")
          ).json(),
        );
        // 10 (before the idle break) + 26 (to the Pomodoro break) + 3 (after
        // the break, before the discarded span).
        expect(after.bySource.focus).toBe(minutes(39));
        expect(after.totalMs).toBe(minutes(39));
      } finally {
        await server.close();
      }
    });
  });

  it("raises take-a-break and tracking reminders, honours snooze and working hours, and lets the assistant assign idle time", async () => {
    await withTemporaryDirectory(async (directory) => {
      // 10:00 CDT on Thursday, September 24.
      const clock = new ManualSessionClock("2026-09-24T15:00:00.000Z");
      const publisher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response("ok"));
      const config = await configuration(directory);
      const server = await startSuiteServer(config, {
        sessionClock: clock,
        disableNotificationTimer: true,
        notificationFetch: publisher,
      });
      try {
        const session = await signIn(server);
        const { call, proof, task } = session;
        expect(
          (
            await call(
              "/api/focus/preferences",
              "PUT",
              {
                ...defaultFocusPreferences,
                takeABreak: {
                  ...defaultFocusPreferences.takeABreak,
                  minWorkingMinutes: 5,
                  snoozeMinutes: 3,
                  message: "Working ${duration}; stretch.",
                },
                trackingReminder: { enabled: true, minMinutes: 5 },
              },
              { "If-Match": '"0"' },
            )
          ).status,
        ).toBe(200);
        // Nothing tracked yet at 10:00: the day started at 00:00, so it is due.
        expect((await timer(session)).trackingReminder).toMatchObject({
          enabled: true,
          due: true,
          suppressedReason: null,
        });
        await server.runNotifications();
        await server.runNotifications();
        expect(publisher).toHaveBeenCalledTimes(1);
        expect(publisher.mock.calls[0]?.[1]?.body).toContain(
          "Nothing is being tracked",
        );

        const started = await command(session, {
          command: "start",
          taskId: task.id,
        });
        expect((await timer(session)).trackingReminder.suppressedReason).toBe(
          "tracking",
        );
        let current = await advance(session, clock, 6);
        const due = await timer(session);
        expect(due.breakReminder).toMatchObject({
          due: true,
          workingWithoutBreakMs: minutes(6),
          snoozedUntil: null,
        });
        await server.runNotifications();
        await server.runNotifications();
        expect(publisher).toHaveBeenCalledTimes(2);
        expect(publisher.mock.calls[1]?.[1]?.body).toBe(
          "Working 0:06; stretch.",
        );
        const snoozed = await call(
          "/api/focus/break-reminder/snooze",
          "POST",
          {},
        );
        expect(snoozed.status).toBe(200);
        expect(await snoozed.json()).toEqual({
          snoozedUntil: "2026-09-24T15:09:00.000Z",
        });
        expect((await timer(session)).breakReminder.due).toBe(false);
        current = await advance(session, clock, 4);
        expect((await timer(session)).breakReminder).toMatchObject({
          due: true,
          snoozedUntil: null,
        });
        await server.runNotifications();
        expect(publisher).toHaveBeenCalledTimes(3);

        // The assistant assigns idle time for the owner with a bound revision.
        const token = createAutomationTokenResponseSchema.parse(
          await (
            await call("/api/automation/tokens", "POST", {
              label: "Assistant",
              scopes: ["focus:read", "focus:write"],
              expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
            })
          ).json(),
        ).token;
        const assistant = (path: string, body: unknown) =>
          fetch(`${server.baseUrl}${path}`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(body),
          });
        const preview = automationPreviewResponseSchema.parse(
          await (
            await assistant("/api/automation/v1/previews", {
              operation: "focus.idle_disposition",
              input: {
                sessionId: started.session.id,
                expectedRevision: current?.revision ?? 0,
                idleStartedAt: "2026-09-24T15:08:00.000Z",
                disposition: "assign",
              },
            })
          ).json(),
        ).preview;
        expect(preview.summary).toContain("keep it as focus time");
        expect(preview.baseRevisions).toEqual([
          {
            entityKind: "active_session",
            entityId: started.session.id,
            revision: current?.revision ?? 0,
          },
        ]);
        const confirmed = await assistant(
          `/api/automation/v1/previews/${preview.id}/confirm`,
          { idempotencyKey: randomUUID() },
        );
        expect(confirmed.status).toBe(200);
        expect(
          automationConfirmationResponseSchema.parse(await confirmed.json())
            .result,
        ).toMatchObject({
          correction: { disposition: "assign", trimmedMs: 0 },
          session: { revision: (current?.revision ?? 0) + 1 },
        });
        expect((await timer(session)).session?.revision).toBe(
          (current?.revision ?? 0) + 1,
        );

        // After hours nothing is tracked, but the tracking reminder is held.
        current = (
          await command(session, {
            command: "complete",
            sessionId: started.session.id,
            expectedRevision: (current?.revision ?? 0) + 1,
          })
        ).session;
        clock.advanceSeconds(8 * 3_600);
        expect((await timer(session)).trackingReminder).toMatchObject({
          due: false,
          suppressedReason: "finished_for_today",
        });
        await server.runNotifications();
        expect(publisher).toHaveBeenCalledTimes(3);
        void proof;
      } finally {
        await server.close();
      }
    });
  });
});
