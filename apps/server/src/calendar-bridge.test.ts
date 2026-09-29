import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  baikalStatusResponseSchema,
  calendarBridgeLinksResponseSchema,
  calendarBridgeMappingSchema,
  calendarBridgeRunResponseSchema,
  googleConnectorStatusResponseSchema,
} from "@suite/contracts";
import { googleBridgeScope } from "@suite/google-calendar";
import { withTemporaryDirectory } from "@suite/test-support";
import {
  createFakeCalDav,
  createFakeGoogleCalendar,
} from "./calendar-bridge/fakes.ts";
import { startSuiteServer } from "./server.ts";

// Owner routes for the calendar bridge (issue #40, ADR 0041).
describe("calendar bridge routes", () => {
  it("creates, runs, approves, disables and removes a mapping", async () => {
    await withTemporaryDirectory(async (directory) => {
      await mkdir(join(directory, "web"));
      await writeFile(join(directory, "web", "index.html"), "<h1>Suite</h1>");
      const oauthPath = join(directory, "google-oauth.json");
      const google = createFakeGoogleCalendar();
      const baikal = createFakeCalDav();
      const server = await startSuiteServer(
        {
          host: "127.0.0.1",
          port: 0,
          databasePath: join(directory, "suite.sqlite"),
          webRoot: join(directory, "web"),
          baikalEndpoint: "http://baikal.test/dav.php/",
          credentialKeyPath: join(directory, "credential.key"),
          googleOAuthConfigPath: oauthPath,
          secureCookies: false,
          build: { version: "test", revision: "bridge", builtAt: null },
        },
        {
          googleFetch: google.fetch,
          connectorFetch: baikal.fetch,
          disableNotificationTimer: true,
        },
      );
      const bodies: string[] = [];
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
        const json = { "Content-Type": "application/json" };
        await fetch(`${server.baseUrl}/api/setup`, {
          method: "POST",
          headers: { Origin: server.baseUrl, ...json },
          body: JSON.stringify({
            username: "owner",
            displayName: "Owner",
            password: "correct horse battery staple",
          }),
        });
        const login = await fetch(`${server.baseUrl}/api/auth/login`, {
          method: "POST",
          headers: { Origin: server.baseUrl, ...json },
          body: JSON.stringify({
            username: "owner",
            password: "correct horse battery staple",
          }),
        });
        const cookie = login.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
        const { csrfToken } = (await login.json()) as { csrfToken: string };
        const call = async (
          path: string,
          method = "GET",
          body?: unknown,
          headers: Record<string, string> = {},
        ): Promise<{ status: number; body: unknown }> => {
          const response = await fetch(`${server.baseUrl}${path}`, {
            method,
            redirect: "manual",
            headers: {
              Origin: server.baseUrl,
              Cookie: cookie,
              "X-CSRF-Token": csrfToken,
              ...(body === undefined ? {} : json),
              ...headers,
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          });
          const text = await response.text();
          bodies.push(text);
          return {
            status: response.status,
            body: text === "" ? null : (JSON.parse(text) as unknown),
          };
        };
        const connectGoogle = async () => {
          const authorization = await call(
            "/api/connectors/google/authorize",
            "POST",
          );
          const state = new URL(
            (authorization.body as { authorizationUrl: string })
              .authorizationUrl,
          ).searchParams.get("state");
          const callback = await fetch(
            `${server.baseUrl}/api/connectors/google/callback?state=${encodeURIComponent(state ?? "")}&code=code`,
            { redirect: "manual" },
          );
          expect(callback.status).toBe(303);
        };

        const baikalStatus = baikalStatusResponseSchema.parse(
          (
            await call("/api/connectors/baikal", "PUT", {
              username: "alice",
              password: "secret",
            })
          ).body,
        );
        const baikalCalendarId = baikalStatus.calendars[0]?.id ?? "";
        await connectGoogle();
        const googleStatus = googleConnectorStatusResponseSchema.parse(
          (await call("/api/connectors/google")).body,
        );
        const googleCalendarId = googleStatus.calendars[0]?.id ?? "";
        const request = {
          googleCalendarId,
          baikalCalendarId,
          direction: "two_way",
          initialSync: "copy_existing",
        };

        // Without the event write scope (#36) no mapping is created.
        expect(
          await call("/api/calendar-bridge/mappings", "POST", request),
        ).toMatchObject({
          status: 409,
          body: { code: "BRIDGE_WRITE_CONSENT_REQUIRED" },
        });
        google.grantScopes = [googleBridgeScope];
        await connectGoogle();

        const anonymous = await fetch(
          `${server.baseUrl}/api/calendar-bridge/mappings`,
        );
        expect(anonymous.status).toBe(401);
        const noCsrf = await fetch(
          `${server.baseUrl}/api/calendar-bridge/mappings`,
          {
            method: "POST",
            headers: { Origin: server.baseUrl, Cookie: cookie, ...json },
            body: JSON.stringify(request),
          },
        );
        expect(noCsrf.status).toBe(403);
        expect(
          (
            await call("/api/calendar-bridge/mappings", "POST", {
              ...request,
              direction: "all",
            })
          ).status,
        ).toBe(400);

        const created = await call(
          "/api/calendar-bridge/mappings",
          "POST",
          request,
        );
        expect(created.status).toBe(201);
        const mapping = calendarBridgeMappingSchema.parse(
          (created.body as { mapping: unknown }).mapping,
        );
        expect(
          (await call("/api/calendar-bridge/mappings", "POST", request)).body,
        ).toMatchObject({ code: "BRIDGE_CALENDAR_IN_USE" });
        expect(
          (
            (await call("/api/calendar-bridge/mappings")).body as {
              mappings: unknown[];
            }
          ).mappings,
        ).toHaveLength(1);

        const base = `/api/calendar-bridge/mappings/${mapping.id}`;
        google.userCreate("evtroute1", {
          summary: "Route event",
          start: { dateTime: "2026-10-01T15:00:00Z" },
          end: { dateTime: "2026-10-01T16:00:00Z" },
        });
        const run = await call(`${base}/run`, "POST");
        expect(run.status).toBe(200);
        expect(calendarBridgeRunResponseSchema.parse(run.body)).toMatchObject({
          outcome: "completed",
          counts: { applied: 1 },
        });
        expect(baikal.resources.size).toBe(1);
        const links = calendarBridgeLinksResponseSchema.parse(
          (await call(`${base}/links`)).body,
        );
        expect(links).toMatchObject({
          links: [{ status: "active", googleEventId: "evtroute1" }],
          conflicts: [],
          operations: [],
        });

        // Deletion needs a revision-bound owner approval.
        google.userDelete("evtroute1");
        await call(`${base}/run`, "POST");
        const blocked = calendarBridgeLinksResponseSchema.parse(
          (await call(`${base}/links`)).body,
        ).links[0];
        expect(blocked).toMatchObject({
          status: "blocked",
          statusReason: "deletion-approval",
        });
        const approvePath = `${base}/links/${blocked?.id ?? ""}/approve-deletion`;
        expect((await call(approvePath, "POST")).status).toBe(428);
        expect(
          (
            await call(approvePath, "POST", undefined, {
              "If-Match": `"${String((blocked?.revision ?? 0) + 5)}"`,
            })
          ).status,
        ).toBe(412);
        expect(
          (
            await call(approvePath, "POST", undefined, {
              "If-Match": `"${String(blocked?.revision ?? 0)}"`,
            })
          ).status,
        ).toBe(200);
        await call(`${base}/run`, "POST");
        expect(baikal.resources.size).toBe(0);

        const disabled = await call(
          base,
          "PATCH",
          { enabled: false },
          { "If-Match": `"${String(mapping.revision)}"` },
        );
        expect(disabled.status).toBe(200);
        expect(
          calendarBridgeRunResponseSchema.parse(
            (await call(`${base}/run`, "POST")).body,
          ).outcome,
        ).toBe("disabled");
        const revision = calendarBridgeMappingSchema.parse(
          (disabled.body as { mapping: unknown }).mapping,
        ).revision;
        expect((await call(base, "DELETE")).status).toBe(428);
        expect(
          (
            await call(base, "DELETE", undefined, {
              "If-Match": `"${String(revision)}"`,
            })
          ).status,
        ).toBe(204);
        expect((await call(`${base}/run`, "POST")).status).toBe(404);
        expect(google.events.has("evtroute1")).toBe(true);

        for (const body of bodies) {
          expect(body).not.toContain("bridge-refresh-secret");
          expect(body).not.toContain("bridge-access");
          expect(body).not.toContain('secret"');
        }
      } finally {
        await server.close();
      }
    });
  });
});
