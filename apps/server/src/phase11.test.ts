import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  notificationStatusResponseSchema,
  taskMutationResponseSchema,
} from "@suite/contracts";
import { withTemporaryDirectory } from "@suite/test-support";
import type { ServerConfig } from "./config.ts";
import { startSuiteServer, type RunningSuiteServer } from "./server.ts";

const davMultiStatus = (body: string): string =>
  `<?xml version="1.0"?><D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">${body}</D:multistatus>`;

const emptyCalDav: typeof fetch = async (input, init) => {
  await Promise.resolve();
  const url =
    input instanceof URL
      ? input
      : new URL(typeof input === "string" ? input : input.url);
  const method = init?.method ?? "GET";
  if (method === "PROPFIND" && url.pathname === "/dav.php/")
    return new Response(
      davMultiStatus(
        `<D:response><D:href>/dav.php/</D:href><D:propstat><D:prop><D:current-user-principal><D:href>/dav.php/principals/alice/</D:href></D:current-user-principal></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`,
      ),
      { status: 207, headers: { "content-type": "application/xml" } },
    );
  if (method === "PROPFIND" && url.pathname === "/dav.php/principals/alice/")
    return new Response(
      davMultiStatus(
        `<D:response><D:href>/dav.php/principals/alice/</D:href><D:propstat><D:prop><C:calendar-home-set><D:href>/dav.php/calendars/alice/</D:href></C:calendar-home-set></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`,
      ),
      { status: 207, headers: { "content-type": "application/xml" } },
    );
  if (method === "PROPFIND" && url.pathname === "/dav.php/calendars/alice/")
    return new Response(
      davMultiStatus(
        `<D:response><D:href>/dav.php/calendars/alice/work/</D:href><D:propstat><D:prop><D:resourcetype><D:collection/><C:calendar/></D:resourcetype><D:displayname>Work</D:displayname><C:supported-calendar-component-set><C:comp name="VEVENT"/></C:supported-calendar-component-set></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`,
      ),
      { status: 207, headers: { "content-type": "application/xml" } },
    );
  if (method === "REPORT")
    return new Response(davMultiStatus(""), {
      status: 207,
      headers: { "content-type": "application/xml" },
    });
  return new Response("", { status: 404 });
};

const browserWrite = (
  server: RunningSuiteServer,
  cookie: string,
  csrfToken: string,
  path: string,
  method: "POST" | "PUT" | "PATCH",
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): Promise<Response> =>
  fetch(`${server.baseUrl}${path}`, {
    method,
    headers: {
      Origin: server.baseUrl,
      Cookie: cookie,
      "X-CSRF-Token": csrfToken,
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });

describe("Phase 11 durable notifications", () => {
  it("delivers detailed reminders once across repeated ticks and restart without exposing the publisher token", async () => {
    await withTemporaryDirectory(async (directory) => {
      const webRoot = join(directory, "web");
      const ntfyConfigPath = join(directory, "ntfy.json");
      await mkdir(webRoot);
      await writeFile(join(webRoot, "index.html"), "<h1>Suite</h1>");
      await writeFile(
        ntfyConfigPath,
        JSON.stringify({
          baseUrl: "http://ntfy",
          topic: "tadooer-reminders",
          token: "tk_phase11_secret_that_must_not_escape",
        }),
        { mode: 0o600 },
      );
      const config: ServerConfig = {
        host: "127.0.0.1",
        port: 0,
        databasePath: join(directory, "suite.sqlite"),
        webRoot,
        baikalEndpoint: "http://baikal.test/dav.php/",
        credentialKeyPath: join(directory, "credential.key"),
        ntfyPublisherConfigPath: ntfyConfigPath,
        secureCookies: false,
        build: { version: "test", revision: "test", builtAt: null },
      };
      let now = new Date("2026-08-10T14:45:00.000Z");
      let nextNtfyStatus = 200;
      const published: { body: string; headers: Headers }[] = [];
      const ntfyFetch: typeof fetch = async (_input, init) => {
        await Promise.resolve();
        published.push({
          body: typeof init?.body === "string" ? init.body : "",
          headers: new Headers(init?.headers),
        });
        const status = nextNtfyStatus;
        nextNtfyStatus = 200;
        return new Response("{}", { status });
      };
      const options = {
        connectorFetch: emptyCalDav,
        notificationFetch: ntfyFetch,
        disableNotificationTimer: true,
        sessionClock: { now: () => now },
      } as const;
      let server = await startSuiteServer(config, options);
      try {
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

        const connected = await browserWrite(
          server,
          cookie,
          csrfToken,
          "/api/connectors/baikal",
          "PUT",
          { username: "alice", password: "calendar password" },
        );
        expect(connected.status).toBe(200);

        const createdResponse = await browserWrite(
          server,
          cookie,
          csrfToken,
          "/api/tasks",
          "POST",
          { title: "Prepare daily review", notes: "PRIVATE NOTES SENTINEL" },
          { "Idempotency-Key": "phase11-reminder-task" },
        );
        expect(createdResponse.status).toBe(201);
        const created = taskMutationResponseSchema.parse(
          await createdResponse.json(),
        );
        const planned = await browserWrite(
          server,
          cookie,
          csrfToken,
          `/api/tasks/${created.task.id}`,
          "PATCH",
          { plannedStart: "2026-08-10T15:00:00.000Z" },
          { "If-Match": '"1"' },
        );
        expect(planned.status).toBe(200);

        const preferences = await browserWrite(
          server,
          cookie,
          csrfToken,
          "/api/notifications/preferences",
          "PUT",
          {
            enabled: true,
            leadReminderEnabled: true,
            atStartReminderEnabled: true,
            detailedContentEnabled: true,
          },
        );
        expect(preferences.status).toBe(200);
        expect(published).toHaveLength(1);
        expect(published[0]?.body).toContain("Prepare daily review");
        expect(published[0]?.body).toContain("Aug 10, 2026");
        expect(published[0]?.body).not.toContain("PRIVATE NOTES SENTINEL");
        expect(published[0]?.headers.get("click")).toBe(
          `http://localhost/tasks?task=${created.task.id}`,
        );

        await server.runNotifications();
        expect(published).toHaveLength(1);
        await server.close();
        server = await startSuiteServer(config, options);
        await server.runNotifications();
        expect(published).toHaveLength(1);

        now = new Date("2026-08-10T15:00:00.000Z");
        await server.runNotifications();
        expect(published).toHaveLength(2);
        await server.runNotifications();
        expect(published).toHaveLength(2);

        const retryTaskResponse = await browserWrite(
          server,
          cookie,
          csrfToken,
          "/api/tasks",
          "POST",
          { title: "Retry bounded delivery" },
          { "Idempotency-Key": "phase11-retry-task" },
        );
        const retryTask = taskMutationResponseSchema.parse(
          await retryTaskResponse.json(),
        );
        expect(
          (
            await browserWrite(
              server,
              cookie,
              csrfToken,
              `/api/tasks/${retryTask.task.id}`,
              "PATCH",
              { plannedStart: "2026-08-10T15:30:00.000Z" },
              { "If-Match": '"1"' },
            )
          ).status,
        ).toBe(200);
        now = new Date("2026-08-10T15:15:00.000Z");
        nextNtfyStatus = 503;
        await server.runNotifications();
        expect(published).toHaveLength(3);
        now = new Date("2026-08-10T15:16:00.000Z");
        await server.runNotifications();
        expect(published).toHaveLength(4);
        const completed = await browserWrite(
          server,
          cookie,
          csrfToken,
          `/api/tasks/${retryTask.task.id}/complete`,
          "POST",
          {},
          { "If-Match": '"2"' },
        );
        expect(completed.status).toBe(200);
        await server.runNotifications();

        const statusResponse = await fetch(
          `${server.baseUrl}/api/notifications/status`,
          { headers: { Cookie: cookie } },
        );
        const rawStatus = await statusResponse.text();
        expect(
          notificationStatusResponseSchema.parse(JSON.parse(rawStatus)),
        ).toMatchObject({
          configured: true,
          enabled: true,
          state: "ready",
          pendingCount: 0,
          failedCount: 0,
        });
        expect(rawStatus).not.toContain("tk_phase11_secret");
      } finally {
        await server.close();
      }
    });
  });
});
