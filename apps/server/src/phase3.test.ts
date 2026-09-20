import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  dayPlanResponseSchema,
  googleAuthorizationResponseSchema,
  googleConnectorStatusResponseSchema,
  googleSyncResponseSchema,
  plannerResponseSchema,
  planningPreferencesSchema,
  taskListResponseSchema,
} from "@suite/contracts";
import { withTemporaryDirectory } from "@suite/test-support";
import type { ServerConfig } from "./config.ts";
import { startSuiteServer, type RunningSuiteServer } from "./server.ts";

const configuration = (
  directory: string,
  googleOAuthConfigPath: string,
): ServerConfig => ({
  host: "127.0.0.1",
  port: 0,
  databasePath: join(directory, "suite.sqlite"),
  webRoot: join(directory, "web"),
  baikalEndpoint: "http://baikal.test/dav.php/",
  credentialKeyPath: join(directory, "credential.key"),
  googleOAuthConfigPath,
  secureCookies: false,
  build: { version: "test", revision: "phase3", builtAt: null },
});

const browserRequest = (
  server: RunningSuiteServer,
  cookie: string,
  csrfToken: string,
  path: string,
  method: "POST" | "PUT" | "DELETE",
  body?: unknown,
): Promise<Response> =>
  fetch(`${server.baseUrl}${path}`, {
    method,
    redirect: "manual",
    headers: {
      Origin: server.baseUrl,
      Cookie: cookie,
      "X-CSRF-Token": csrfToken,
      "Idempotency-Key": "phase3-browser-request",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const googleFixture = () => {
  let eventRound = 0;
  let invalidGrant = false;
  let revokeAttempted = false;
  let failEvents = false;
  const fetcher: typeof fetch = async (input, init) => {
    await Promise.resolve();
    const url =
      input instanceof URL
        ? input
        : new URL(typeof input === "string" ? input : input.url);
    if (url.href === "https://oauth2.googleapis.com/token") {
      const requestBody = init?.body;
      const body = new URLSearchParams(
        typeof requestBody === "string"
          ? requestBody
          : requestBody instanceof URLSearchParams
            ? requestBody.toString()
            : "",
      );
      if (body.get("grant_type") === "authorization_code")
        return Response.json({
          access_token: "access-code",
          refresh_token: "refresh-secret",
          expires_in: 3600,
          scope: [
            "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
            "https://www.googleapis.com/auth/calendar.events.readonly",
          ].join(" "),
        });
      if (invalidGrant)
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      return Response.json({
        access_token: `access-${String(eventRound)}`,
        expires_in: 3600,
        scope: [
          "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
          "https://www.googleapis.com/auth/calendar.events.readonly",
        ].join(" "),
      });
    }
    if (
      url.href.startsWith(
        "https://www.googleapis.com/calendar/v3/users/me/calendarList",
      )
    )
      return Response.json({
        items: [
          {
            id: "owner@example.test",
            etag: '"calendar-1"',
            summary: "Primary",
            accessRole: "owner",
            primary: true,
            timeZone: "UTC",
          },
        ],
      });
    if (
      url.href.startsWith(
        "https://www.googleapis.com/calendar/v3/calendars/owner%40example.test/events",
      )
    ) {
      const syncToken = url.searchParams.get("syncToken");
      if (failEvents) return new Response("", { status: 503 });
      if (eventRound === 0) {
        eventRound += 1;
        return Response.json({
          items: [
            {
              id: "event-1",
              iCalUID: "event-1@example.test",
              etag: '"event-1"',
              summary: "Initial appointment",
              start: { dateTime: "2026-08-07T13:00:00Z" },
              end: { dateTime: "2026-08-07T14:00:00Z" },
            },
          ],
          nextSyncToken: "sync-1",
        });
      }
      if (eventRound === 1) {
        expect(syncToken).toBe("sync-1");
        eventRound += 1;
        return Response.json({
          items: [
            {
              id: "event-1",
              iCalUID: "event-1@example.test",
              etag: '"event-1-deleted"',
              status: "cancelled",
            },
            {
              id: "event-2",
              recurringEventId: "series-1",
              iCalUID: "series-1@example.test",
              etag: '"event-2"',
              summary: "Recurring all-day instance",
              start: { date: "2026-08-07" },
              end: { date: "2026-08-08" },
            },
          ],
          nextSyncToken: "sync-2",
        });
      }
      if (eventRound === 2 && syncToken === "sync-2") {
        eventRound += 1;
        return new Response("", { status: 410 });
      }
      expect(syncToken).toBeNull();
      eventRound += 1;
      return Response.json({
        items: [
          {
            id: "event-3",
            iCalUID: "event-3@example.test",
            etag: '"event-3"',
            summary: "Reset appointment",
            start: { dateTime: "2026-08-07T15:00:00Z" },
            end: { dateTime: "2026-08-07T16:00:00Z" },
          },
        ],
        nextSyncToken: "sync-3",
      });
    }
    if (url.href === "https://oauth2.googleapis.com/revoke") {
      revokeAttempted = true;
      return new Response("", { status: 503 });
    }
    return new Response("", { status: 404 });
  };
  return {
    fetcher,
    setInvalidGrant: () => {
      invalidGrant = true;
    },
    revokeAttempted: () => revokeAttempted,
    failEvents: (value: boolean) => {
      failEvents = value;
    },
  };
};

describe("Phase 3 Google federation foundation", () => {
  it("authorizes, incrementally projects, resets, reconnects, and disconnects safely", async () => {
    await withTemporaryDirectory(async (directory) => {
      await mkdir(join(directory, "web"));
      await writeFile(join(directory, "web", "index.html"), "<h1>Suite</h1>");
      const oauthPath = join(directory, "google-oauth.json");
      const google = googleFixture();
      const server = await startSuiteServer(
        configuration(directory, oauthPath),
        {
          googleFetch: google.fetcher,
        },
      );
      try {
        await writeFile(
          oauthPath,
          JSON.stringify({
            clientId: "client.apps.googleusercontent.com",
            clientSecret: "client-secret",
            redirectUri: `${server.baseUrl}/api/connectors/google/callback`,
          }),
          { mode: 0o600 },
        );
        await chmod(oauthPath, 0o600);
        const setup = await fetch(`${server.baseUrl}/api/setup`, {
          method: "POST",
          headers: {
            Origin: server.baseUrl,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            username: "owner",
            displayName: "Owner",
            password: "correct horse battery staple",
          }),
        });
        expect(setup.status).toBe(201);
        const login = await fetch(`${server.baseUrl}/api/auth/login`, {
          method: "POST",
          headers: {
            Origin: server.baseUrl,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            username: "owner",
            password: "correct horse battery staple",
          }),
        });
        const cookie = login.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
        const { csrfToken } = (await login.json()) as { csrfToken: string };

        const missingCsrf = await fetch(
          `${server.baseUrl}/api/connectors/google/authorize`,
          {
            method: "POST",
            headers: { Origin: server.baseUrl, Cookie: cookie },
          },
        );
        expect(missingCsrf.status).toBe(403);
        const authorizationResponse = await browserRequest(
          server,
          cookie,
          csrfToken,
          "/api/connectors/google/authorize",
          "POST",
        );
        expect(authorizationResponse.headers.get("cache-control")).toBe(
          "no-store",
        );
        const authorization = googleAuthorizationResponseSchema.parse(
          await authorizationResponse.json(),
        );
        const authorizationUrl = new URL(authorization.authorizationUrl);
        expect(authorizationUrl.origin).toBe("https://accounts.google.com");
        expect(authorizationUrl.searchParams.get("access_type")).toBe(
          "offline",
        );
        const state = authorizationUrl.searchParams.get("state") ?? "";

        const callback = await fetch(
          `${server.baseUrl}/api/connectors/google/callback?state=${encodeURIComponent(state)}&code=authorized-code`,
          { redirect: "manual" },
        );
        expect(callback.status).toBe(303);
        expect(callback.headers.get("location")).toBe("/?google=connected");
        const replayedCallback = await fetch(
          `${server.baseUrl}/api/connectors/google/callback?state=${encodeURIComponent(state)}&code=authorized-code`,
          { redirect: "manual" },
        );
        expect(replayedCallback.status).toBe(400);

        const statusResponse = await fetch(
          `${server.baseUrl}/api/connectors/google`,
          { headers: { Cookie: cookie } },
        );
        expect(
          googleConnectorStatusResponseSchema.parse(
            await statusResponse.json(),
          ),
        ).toMatchObject({
          configured: true,
          connected: true,
          state: "connected",
          accountLabel: "owner@example.test",
          freshness: [{ state: "fresh" }],
        });
        const raw = new DatabaseSync(join(directory, "suite.sqlite"), {
          readOnly: true,
        });
        const credential = raw
          .prepare(
            "SELECT credential_ciphertext, granted_scopes_json FROM google_connectors",
          )
          .get() as unknown as {
          readonly credential_ciphertext: Uint8Array;
          readonly granted_scopes_json: string;
        };
        expect(
          Buffer.from(credential.credential_ciphertext).toString(),
        ).not.toBe("refresh-secret");
        expect(credential.granted_scopes_json).not.toContain("refresh-secret");
        raw.close();

        const initialPlanner = await fetch(
          `${server.baseUrl}/api/planner?from=2026-08-07T00%3A00%3A00.000Z&to=2026-08-08T00%3A00%3A00.000Z`,
          { headers: { Cookie: cookie } },
        );
        expect(
          plannerResponseSchema.parse(await initialPlanner.json()),
        ).toMatchObject({
          events: [
            {
              summary: "Initial appointment",
              recurrence: "none",
              source: {
                providerKind: "google",
                providerDisplayLabel: "Google Calendar",
                calendarName: "Primary",
              },
            },
          ],
          freshness: { state: "fresh" },
        });

        const incremental = await browserRequest(
          server,
          cookie,
          csrfToken,
          "/api/connectors/google/sync",
          "POST",
        );
        expect(
          googleSyncResponseSchema.parse(await incremental.json()),
        ).toMatchObject({ status: { state: "connected" }, resetCalendars: [] });
        const incrementalPlanner = plannerResponseSchema.parse(
          await (
            await fetch(
              `${server.baseUrl}/api/planner?from=2026-08-07T00%3A00%3A00.000Z&to=2026-08-08T00%3A00%3A00.000Z`,
              { headers: { Cookie: cookie } },
            )
          ).json(),
        );
        expect(incrementalPlanner.events).toMatchObject([
          {
            summary: "Recurring all-day instance",
            allDay: true,
            recurrence: "instance",
          },
        ]);

        const reset = googleSyncResponseSchema.parse(
          await (
            await browserRequest(
              server,
              cookie,
              csrfToken,
              "/api/connectors/google/sync",
              "POST",
            )
          ).json(),
        );
        expect(reset.resetCalendars).toHaveLength(1);
        const resetPlanner = plannerResponseSchema.parse(
          await (
            await fetch(
              `${server.baseUrl}/api/planner?from=2026-08-07T00%3A00%3A00.000Z&to=2026-08-08T00%3A00%3A00.000Z`,
              { headers: { Cookie: cookie } },
            )
          ).json(),
        );
        expect(resetPlanner.events.map(({ summary }) => summary)).toEqual([
          "Reset appointment",
        ]);

        // Explicit resync ignores a still-valid cursor and replaces only a
        // successfully fetched calendar. Failed refreshes retain prior events.
        const full = await browserRequest(
          server,
          cookie,
          csrfToken,
          "/api/connectors/google/sync",
          "POST",
          { full: true },
        );
        expect(full.status).toBe(200);
        const fullResult = googleSyncResponseSchema.parse(await full.json());
        expect(fullResult.resetCalendars).toHaveLength(1);
        expect(fullResult.status.state).toBe("connected");
        google.failEvents(true);
        const failedFull = await browserRequest(
          server,
          cookie,
          csrfToken,
          "/api/connectors/google/sync",
          "POST",
          { full: true },
        );
        expect(
          googleSyncResponseSchema.parse(await failedFull.json()).status.state,
        ).toBe("stale");
        const savedPlanner = plannerResponseSchema.parse(
          await (
            await fetch(
              `${server.baseUrl}/api/planner?from=2026-08-07T00%3A00%3A00.000Z&to=2026-08-08T00%3A00%3A00.000Z`,
              { headers: { Cookie: cookie } },
            )
          ).json(),
        );
        expect(savedPlanner.events.map(({ summary }) => summary)).toEqual([
          "Reset appointment",
        ]);
        google.failEvents(false);
        await browserRequest(
          server,
          cookie,
          csrfToken,
          "/api/connectors/google/sync",
          "POST",
          { full: true },
        );
        const invalidSync = await browserRequest(
          server,
          cookie,
          csrfToken,
          "/api/connectors/google/sync",
          "POST",
          { full: "yes" },
        );
        expect(invalidSync.status).toBe(400);
        const anonymousSync = await browserRequest(
          server,
          "",
          csrfToken,
          "/api/connectors/google/sync",
          "POST",
          { full: true },
        );
        expect(anonymousSync.status).toBe(401);

        const invalidPreferences = await browserRequest(
          server,
          cookie,
          csrfToken,
          "/api/planning/preferences",
          "PUT",
          {
            workingDays: [1],
            workdayStart: "17:00",
            workdayEnd: "09:00",
            breakStart: null,
            breakEnd: null,
            timeZone: "UTC",
          },
        );
        expect(invalidPreferences.status).toBe(400);
        const preferencesResponse = await browserRequest(
          server,
          cookie,
          csrfToken,
          "/api/planning/preferences",
          "PUT",
          {
            workingDays: [5],
            workdayStart: "08:00",
            workdayEnd: "18:00",
            breakStart: "12:00",
            breakEnd: "12:30",
            timeZone: "America/Chicago",
          },
        );
        expect(
          planningPreferencesSchema.parse(await preferencesResponse.json()),
        ).toMatchObject({ timeZone: "America/Chicago" });
        const invalidTimeZone = await browserRequest(
          server,
          cookie,
          csrfToken,
          "/api/planning/preferences",
          "PUT",
          {
            workingDays: [5],
            workdayStart: "08:00",
            workdayEnd: "18:00",
            breakStart: null,
            breakEnd: null,
            timeZone: "Central-ish/Nowhere",
          },
        );
        expect(invalidTimeZone.status).toBe(400);
        const dayPlan = dayPlanResponseSchema.parse(
          await (
            await fetch(
              `${server.baseUrl}/api/day-plan?at=2026-08-07T15:30:00Z`,
              {
                headers: { Cookie: cookie },
              },
            )
          ).json(),
        );
        expect(dayPlan).toMatchObject({
          state: "unavailable",
          reminder: { suppressed: true, reason: "calendar_busy" },
        });

        google.setInvalidGrant();
        const reconnect = googleSyncResponseSchema.parse(
          await (
            await browserRequest(
              server,
              cookie,
              csrfToken,
              "/api/connectors/google/sync",
              "POST",
            )
          ).json(),
        );
        expect(reconnect.status).toMatchObject({
          connected: false,
          state: "reconnect_required",
        });
        const createdTask = await browserRequest(
          server,
          cookie,
          csrfToken,
          "/api/tasks",
          "POST",
          { title: "Preserved local task", notes: "" },
        );
        expect(createdTask.status).toBe(201);
        const disconnected = await browserRequest(
          server,
          cookie,
          csrfToken,
          "/api/connectors/google",
          "DELETE",
        );
        expect(await disconnected.json()).toEqual({
          disconnected: true,
          remoteRevoked: false,
        });
        expect(google.revokeAttempted()).toBe(true);
        expect(
          googleConnectorStatusResponseSchema.parse(
            await (
              await fetch(`${server.baseUrl}/api/connectors/google`, {
                headers: { Cookie: cookie },
              })
            ).json(),
          ),
        ).toMatchObject({
          connected: false,
          state: "disconnected",
          calendars: [],
        });
        expect(
          taskListResponseSchema
            .parse(
              await (
                await fetch(`${server.baseUrl}/api/tasks`, {
                  headers: { Cookie: cookie },
                })
              ).json(),
            )
            .tasks.map(({ title }) => title),
        ).toEqual(["Preserved local task"]);
      } finally {
        await server.close();
      }
    });
  });
});
