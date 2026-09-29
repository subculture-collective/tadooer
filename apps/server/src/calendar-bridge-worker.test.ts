import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  calendarBridgeMappingSchema,
  googleConnectorStatusResponseSchema,
  baikalStatusResponseSchema,
  readinessResponseSchema,
} from "@suite/contracts";
import { googleBridgeScope } from "@suite/google-calendar";
import { withTemporaryDirectory } from "@suite/test-support";
import {
  createFakeCalDav,
  createFakeGoogleCalendar,
} from "./calendar-bridge/fakes.ts";
import { ManualClock, settle } from "./calendar-bridge/manual-clock.ts";
import { defaultBridgeWorkerSettings } from "./calendar-bridge/worker.ts";
import type { ServerConfig } from "./config.ts";
import { startSuiteServer, type RunningSuiteServer } from "./server.ts";

// Closed-browser operation of the bridge worker (issue #46, ADR 0043): two
// server processes share one database; only the worker drives passes.
describe("calendar bridge background worker", () => {
  it("synchronizes without a browser and never runs a mapping twice at once", async () => {
    await withTemporaryDirectory(async (directory) => {
      await mkdir(join(directory, "web"));
      await writeFile(join(directory, "web", "index.html"), "<h1>Suite</h1>");
      const oauthPath = join(directory, "google-oauth.json");
      const google = createFakeGoogleCalendar();
      const baikal = createFakeCalDav();
      const clock = new ManualClock("2026-09-29T12:00:00.000Z");
      const config: ServerConfig = {
        host: "127.0.0.1",
        port: 0,
        databasePath: join(directory, "suite.sqlite"),
        webRoot: join(directory, "web"),
        baikalEndpoint: "http://baikal.test/dav.php/",
        credentialKeyPath: join(directory, "credential.key"),
        googleOAuthConfigPath: oauthPath,
        secureCookies: false,
        build: { version: "test", revision: "worker", builtAt: null },
        // Two jobs per owner so the bridge pass and projection sync overlap.
        calendarBridgeWorker: {
          ...defaultBridgeWorkerSettings,
          ownerConcurrency: 2,
        },
      };
      const start = (holder: string): Promise<RunningSuiteServer> =>
        startSuiteServer(config, {
          googleFetch: google.fetch,
          connectorFetch: baikal.fetch,
          disableNotificationTimer: true,
          disableCalendarBridgeTimer: true,
          schedulerClock: clock,
          schedulerRandom: () => 0,
          leaseHolder: holder,
        });
      const first = await start("process-a");
      let second: RunningSuiteServer | undefined;
      try {
        await writeFile(
          oauthPath,
          JSON.stringify({
            clientId: "client.apps.googleusercontent.com",
            clientSecret: "client-secret",
            redirectUri: `${first.baseUrl}/api/connectors/google/callback`,
          }),
          { mode: 0o600 },
        );
        await chmod(oauthPath, 0o600);
        const json = { "Content-Type": "application/json" };
        await fetch(`${first.baseUrl}/api/setup`, {
          method: "POST",
          headers: { Origin: first.baseUrl, ...json },
          body: JSON.stringify({
            username: "owner",
            displayName: "Owner",
            password: "correct horse battery staple",
          }),
        });
        const login = await fetch(`${first.baseUrl}/api/auth/login`, {
          method: "POST",
          headers: { Origin: first.baseUrl, ...json },
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
        ): Promise<unknown> => {
          const response = await fetch(`${first.baseUrl}${path}`, {
            method,
            redirect: "manual",
            headers: {
              Origin: first.baseUrl,
              Cookie: cookie,
              "X-CSRF-Token": csrfToken,
              ...(body === undefined ? {} : json),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          });
          const text = await response.text();
          return text === "" ? null : (JSON.parse(text) as unknown);
        };
        const baikalStatus = baikalStatusResponseSchema.parse(
          await call("/api/connectors/baikal", "PUT", {
            username: "alice",
            password: "secret",
          }),
        );
        // Read connection first, then the separate write consent (ADR 0040).
        const connectGoogle = async (access: "read" | "write") => {
          const authorization = (await call(
            "/api/connectors/google/authorize",
            "POST",
            { access },
          )) as { authorizationUrl: string };
          const state = new URL(
            authorization.authorizationUrl,
          ).searchParams.get("state");
          const callback = await fetch(
            `${first.baseUrl}/api/connectors/google/callback?state=${encodeURIComponent(state ?? "")}&code=code`,
            { redirect: "manual" },
          );
          expect(callback.status).toBe(303);
        };
        await connectGoogle("read");
        google.grantScopes = [googleBridgeScope];
        await connectGoogle("write");
        const googleStatus = googleConnectorStatusResponseSchema.parse(
          await call("/api/connectors/google"),
        );

        // Opt-in: without a mapping the worker creates no jobs.
        const worker = first.calendarBridgeWorker;
        if (worker === undefined) throw new Error("worker missing");
        await worker.tick();
        await worker.idle();
        const idle = readinessResponseSchema.parse(
          await (await fetch(`${first.baseUrl}/api/ready`)).json(),
        );
        expect(idle.checks.calendarBridge).toBe("idle");

        const mapping = calendarBridgeMappingSchema.parse(
          (
            (await call("/api/calendar-bridge/mappings", "POST", {
              googleCalendarId: googleStatus.calendars[0]?.id ?? "",
              baikalCalendarId: baikalStatus.calendars[0]?.id ?? "",
              direction: "two_way",
              initialSync: "copy_existing",
            })) as { mapping: unknown }
          ).mapping,
        );
        google.userCreate("evtworker1", {
          summary: "Worker event",
          start: { dateTime: "2026-10-01T15:00:00Z" },
          end: { dateTime: "2026-10-01T16:00:00Z" },
        });

        // A second process on the same database, as during a rolling restart.
        second = await start("process-b");
        const other = second.calendarBridgeWorker;
        if (other === undefined) throw new Error("worker missing");
        const writesBefore = baikal.writes.length;
        await Promise.all([worker.tick(), other.tick()]);
        await Promise.all([worker.idle(), other.idle()]);
        await settle();
        // One pass created the event once; the other found the lease held.
        expect(baikal.resources.size).toBe(1);
        expect(
          baikal.writes.filter(({ method }) => method === "PUT"),
        ).toHaveLength(1);
        expect(baikal.writes.length - writesBefore).toBe(1);
        const results = [
          ...worker.runCounts().entries(),
          ...other.runCounts().entries(),
        ];
        expect(results).toContainEqual(["bridge|success", 1]);
        expect(results).toContainEqual(["bridge|deferred", 1]);

        // Later passes settle; no duplicate write after the next due time.
        clock.set(clock.now().getTime() + 3_600_000);
        await Promise.all([worker.tick(), other.tick()]);
        await Promise.all([worker.idle(), other.idle()]);
        expect(baikal.writes.length - writesBefore).toBe(1);

        const ready = readinessResponseSchema.parse(
          await (await fetch(`${first.baseUrl}/api/ready`)).json(),
        );
        expect(ready).toMatchObject({
          status: "ok",
          checks: { calendarBridge: "ok" },
        });
        const metrics = await (
          await fetch(`${first.baseUrl}/api/metrics`)
        ).text();
        expect(metrics).toContain("suite_calendar_bridge_worker_enabled 1");
        expect(metrics).toContain(
          'suite_calendar_bridge_jobs{kind="google_projection"} 1',
        );
        expect(metrics).toContain(
          'suite_calendar_bridge_backlog_operations{state="uncertain"} 0',
        );
        expect(metrics).not.toContain(mapping.id);
        expect(metrics).not.toContain("evtworker1");
        expect(metrics).not.toContain("owner");

        // Provider outage: failure is classified, readiness stays ok.
        google.setUnavailable(true);
        clock.set(clock.now().getTime() + 3_600_000);
        await worker.tick();
        await worker.idle();
        const degraded = readinessResponseSchema.parse(
          await (await fetch(`${first.baseUrl}/api/ready`)).json(),
        );
        expect(degraded).toMatchObject({
          status: "ok",
          checks: { calendarBridge: "degraded" },
        });
        expect(
          await (await fetch(`${first.baseUrl}/api/metrics`)).text(),
        ).toMatch(
          /suite_calendar_bridge_jobs_failing\{kind="bridge",class="provider-offline"\} 1/,
        );
      } finally {
        await second?.close();
        await first.close();
      }
    });
  });
});
