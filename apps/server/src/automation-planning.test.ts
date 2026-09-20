import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  dayPlanResponseSchema,
  planningPreferencesSchema,
  notificationPreferencesSchema,
  notificationStatusResponseSchema,
  createAutomationTokenResponseSchema,
} from "@suite/contracts";
import { withTemporaryDirectory } from "@suite/test-support";
import type { ServerConfig } from "./config.ts";
import { startSuiteServer } from "./server.ts";
const configuration = (directory: string): ServerConfig => ({
  host: "127.0.0.1",
  port: 0,
  databasePath: join(directory, "suite.sqlite"),
  webRoot: join(directory, "web"),
  baikalEndpoint: "http://baikal.test/dav.php/",
  credentialKeyPath: join(directory, "credential.key"),
  secureCookies: false,
  build: { version: "test", revision: "test", builtAt: null },
});

it("shares browser planning reads and redacted notification health with explicit, revocable scopes", async () => {
  await withTemporaryDirectory(async (directory) => {
    await mkdir(join(directory, "web"));
    const server = await startSuiteServer(configuration(directory));
    try {
      const owner = {
        username: "reader",
        displayName: "Reader",
        password: "a long disposable local test password",
      };
      const post = (
        path: string,
        body: unknown,
        headers: Record<string, string> = {},
      ) =>
        fetch(server.baseUrl + path, {
          method: "POST",
          headers: {
            Origin: server.baseUrl,
            "Content-Type": "application/json",
            ...headers,
          },
          body: JSON.stringify(body),
        });
      await post("/api/setup", owner);
      const login = await post("/api/auth/login", owner);
      const cookie = login.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
      const { csrfToken } = (await login.json()) as { csrfToken: string };
      const issue = async (scopes: string[]) =>
        createAutomationTokenResponseSchema.parse(
          await (
            await post(
              "/api/automation/tokens",
              {
                label: "Reader",
                scopes,
                expiresAt: new Date(Date.now() + 3600000).toISOString(),
              },
              { Cookie: cookie, "X-CSRF-Token": csrfToken },
            )
          ).json(),
        );
      const schedule = await issue(["schedule:read"]),
        notifications = await issue(["notifications:read"]);
      const read = (token: string, path: string) =>
        fetch(server.baseUrl + "/api/automation/v1/resources/" + path, {
          headers: { Authorization: `Bearer ${token}` },
        });
      const browser = (path: string) =>
        fetch(server.baseUrl + path, { headers: { Cookie: cookie } });
      const preferences = {
        workingDays: [0, 1, 2, 3, 4, 5, 6],
        workdayStart: "08:00",
        workdayEnd: "17:00",
        breakStart: "12:00",
        breakEnd: "13:00",
        timeZone: "America/Chicago",
      };
      expect(
        (
          await fetch(server.baseUrl + "/api/planning/preferences", {
            method: "PUT",
            headers: {
              Origin: server.baseUrl,
              Cookie: cookie,
              "X-CSRF-Token": csrfToken,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(preferences),
          })
        ).status,
      ).toBe(200);
      expect(
        planningPreferencesSchema.parse(
          await (await read(schedule.token, "planning-preferences")).json(),
        ),
      ).toEqual(preferences);
      for (const at of [
        "2026-03-08T07:30:00.000Z",
        "2026-11-01T07:30:00.000Z",
      ]) {
        const response = await read(
          schedule.token,
          `day-plan?at=${encodeURIComponent(at)}`,
        );
        expect(response.status).toBe(200);
        const actual = dayPlanResponseSchema.parse(await response.json());
        expect(actual).toEqual(
          dayPlanResponseSchema.parse(
            await (
              await browser(`/api/day-plan?at=${encodeURIComponent(at)}`)
            ).json(),
          ),
        );
        expect(actual.preferences.timeZone).toBe("America/Chicago");
        expect(actual.freshness.state).toBe("unavailable");
      }
      for (const invalid of [
        "day-plan",
        "day-plan?at=tomorrow",
        "day-plan?at=2026-09-20",
      ])
        expect((await read(schedule.token, invalid)).status).toBe(400);
      expect(
        (await read(notifications.token, "planning-preferences")).status,
      ).toBe(403);
      expect((await read(schedule.token, "notification-status")).status).toBe(
        403,
      );
      expect(
        (await read(schedule.token, "notification-preferences")).status,
      ).toBe(403);
      const prefs = notificationPreferencesSchema.parse(
        await (
          await read(notifications.token, "notification-preferences")
        ).json(),
      );
      expect(prefs).toEqual(
        notificationPreferencesSchema.parse(
          await (await browser("/api/notifications/preferences")).json(),
        ),
      );
      const status = notificationStatusResponseSchema.parse(
        await (await read(notifications.token, "notification-status")).json(),
      );
      expect(status).toEqual(
        notificationStatusResponseSchema.parse(
          await (await browser("/api/notifications/status")).json(),
        ),
      );
      expect(status).toMatchObject({
        configured: false,
        state: "unavailable",
        pendingCount: 0,
        failedCount: 0,
        lastDelivery: null,
      });
      expect(Object.keys(status).sort()).toEqual([
        "configured",
        "enabled",
        "failedCount",
        "lastDelivery",
        "pendingCount",
        "state",
      ]);
      expect(
        (
          await fetch(
            `${server.baseUrl}/api/automation/tokens/${notifications.record.id}`,
            {
              method: "DELETE",
              headers: {
                Origin: server.baseUrl,
                Cookie: cookie,
                "X-CSRF-Token": csrfToken,
              },
            },
          )
        ).status,
      ).toBe(204);
      expect(
        (await read(notifications.token, "notification-status")).status,
      ).toBe(401);
    } finally {
      await server.close();
    }
  });
});
