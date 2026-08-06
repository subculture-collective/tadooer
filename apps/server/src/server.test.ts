import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  apiErrorSchema,
  buildResponseSchema,
  healthResponseSchema,
  readinessResponseSchema,
  sessionResponseSchema,
  setupStatusResponseSchema,
  taskListResponseSchema,
  taskMutationResponseSchema,
} from "@suite/contracts";
import { withTemporaryDirectory } from "@suite/test-support";
import type { ServerConfig } from "./config.ts";
import { startSuiteServer } from "./server.ts";

describe("Suite HTTP server", () => {
  it("serves valid health, readiness, build, and web responses", async () => {
    await withTemporaryDirectory(async (directory) => {
      const webRoot = join(directory, "web");
      await mkdir(webRoot);
      await writeFile(join(webRoot, "index.html"), "<h1>Suite shell</h1>");

      const config: ServerConfig = {
        host: "127.0.0.1",
        port: 0,
        databasePath: join(directory, "suite.sqlite"),
        webRoot,
        baikalEndpoint: "http://baikal.test/dav.php/",
        credentialKeyPath: join(directory, "credential.key"),
        secureCookies: false,
        build: {
          version: "0.0.0-test",
          revision: "test-revision",
          builtAt: "2026-08-05T00:00:00.000Z",
        },
      };
      const server = await startSuiteServer(config);

      try {
        const health = await fetch(`${server.baseUrl}/api/health`);
        expect(health.status).toBe(200);
        healthResponseSchema.parse(await health.json());

        const ready = await fetch(`${server.baseUrl}/api/ready`);
        expect(ready.status).toBe(200);
        const readiness = readinessResponseSchema.parse(await ready.json());
        expect(readiness.checks).toEqual({
          database: "ok",
          migrations: "current",
        });
        expect(readiness.migrationCount).toBe(5);

        const build = await fetch(`${server.baseUrl}/api/build`);
        expect(build.status).toBe(200);
        buildResponseSchema.parse(await build.json());

        const shell = await fetch(server.baseUrl);
        expect(await shell.text()).toContain("Suite shell");

        const missingApi = await fetch(`${server.baseUrl}/api/nope`);
        expect(missingApi.status).toBe(404);
      } finally {
        await server.close();
      }
    });
  });

  it("enforces first-run, origin, cookie, CSRF, and logout boundaries", async () => {
    await withTemporaryDirectory(async (directory) => {
      const webRoot = join(directory, "web");
      await mkdir(webRoot);
      await writeFile(join(webRoot, "index.html"), "<h1>Suite shell</h1>");
      const config: ServerConfig = {
        host: "127.0.0.1",
        port: 0,
        databasePath: join(directory, "suite.sqlite"),
        webRoot,
        baikalEndpoint: "http://baikal.test/dav.php/",
        credentialKeyPath: join(directory, "credential.key"),
        secureCookies: false,
        build: { version: "test", revision: "test", builtAt: null },
      };
      const server = await startSuiteServer(config);
      const jsonHeaders = { "Content-Type": "application/json" };

      try {
        const initial = await fetch(`${server.baseUrl}/api/setup/status`);
        expect(setupStatusResponseSchema.parse(await initial.json())).toEqual({
          setupRequired: true,
        });

        const crossOriginSetup = await fetch(`${server.baseUrl}/api/setup`, {
          method: "POST",
          headers: jsonHeaders,
          body: JSON.stringify({
            username: "owner",
            displayName: "Owner",
            password: "correct horse battery staple",
          }),
        });
        expect(crossOriginSetup.status).toBe(403);

        const setup = await fetch(`${server.baseUrl}/api/setup`, {
          method: "POST",
          headers: { ...jsonHeaders, Origin: server.baseUrl },
          body: JSON.stringify({
            username: "owner",
            displayName: "Owner",
            password: "correct horse battery staple",
          }),
        });
        expect(setup.status).toBe(201);

        const duplicate = await fetch(`${server.baseUrl}/api/setup`, {
          method: "POST",
          headers: { ...jsonHeaders, Origin: server.baseUrl },
          body: JSON.stringify({
            username: "other",
            displayName: "Other",
            password: "another correct horse password",
          }),
        });
        expect(duplicate.status).toBe(409);

        const unauthenticatedTasks = await fetch(`${server.baseUrl}/api/tasks`);
        expect(unauthenticatedTasks.status).toBe(401);

        const login = await fetch(`${server.baseUrl}/api/auth/login`, {
          method: "POST",
          headers: { ...jsonHeaders, Origin: server.baseUrl },
          body: JSON.stringify({
            username: "owner",
            password: "correct horse battery staple",
          }),
        });
        expect(login.status).toBe(200);
        const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
        expect(cookie).toMatch(/^suite_session=/);
        const loggedIn = sessionResponseSchema.parse(await login.json());

        const resumedResponse = await fetch(
          `${server.baseUrl}/api/auth/session`,
          {
            headers: { Cookie: cookie ?? "" },
          },
        );
        expect(resumedResponse.status).toBe(200);
        const resumed = sessionResponseSchema.parse(
          await resumedResponse.json(),
        );
        expect(resumed.owner).toEqual(loggedIn.owner);
        expect(resumed.csrfToken).not.toBe(loggedIn.csrfToken);

        const connector = await fetch(
          `${server.baseUrl}/api/connectors/baikal`,
          {
            headers: { Cookie: cookie ?? "" },
          },
        );
        expect(connector.status).toBe(200);
        expect(await connector.json()).toMatchObject({
          connected: false,
          calendars: [],
        });

        const rejectedTaskRequests = [
          {
            headers: {
              ...jsonHeaders,
              Origin: server.baseUrl,
              "X-CSRF-Token": resumed.csrfToken,
              "Idempotency-Key": "capture-request-no-session",
            },
            expectedCode: "AUTH_REQUIRED",
          },
          {
            headers: {
              ...jsonHeaders,
              Cookie: cookie ?? "",
              "X-CSRF-Token": resumed.csrfToken,
              "Idempotency-Key": "capture-request-cross-origin",
            },
            expectedCode: "ORIGIN_REQUIRED",
          },
          {
            headers: {
              ...jsonHeaders,
              Cookie: cookie ?? "",
              Origin: server.baseUrl,
              "Idempotency-Key": "capture-request-no-csrf",
            },
            expectedCode: "CSRF_INVALID",
          },
          {
            headers: {
              ...jsonHeaders,
              Cookie: cookie ?? "",
              Origin: server.baseUrl,
              "X-CSRF-Token": "B".repeat(43),
              "Idempotency-Key": "capture-request-stale-csrf",
            },
            expectedCode: "CSRF_INVALID",
          },
          {
            headers: {
              ...jsonHeaders,
              Cookie: cookie ?? "",
              Origin: server.baseUrl,
              "X-CSRF-Token": resumed.csrfToken,
            },
            expectedCode: "IDEMPOTENCY_KEY_REQUIRED",
          },
          {
            headers: {
              ...jsonHeaders,
              Cookie: cookie ?? "",
              Origin: server.baseUrl,
              "X-CSRF-Token": resumed.csrfToken,
              "Idempotency-Key": "bad key",
            },
            expectedCode: "IDEMPOTENCY_KEY_REQUIRED",
          },
        ];
        for (const rejected of rejectedTaskRequests) {
          const response = await fetch(`${server.baseUrl}/api/tasks`, {
            method: "POST",
            headers: rejected.headers,
            body: JSON.stringify({ title: "Must not be created" }),
          });
          expect([400, 401, 403]).toContain(response.status);
          expect(await response.json()).toMatchObject({
            code: rejected.expectedCode,
          });
        }

        const taskHeaders = {
          ...jsonHeaders,
          Cookie: cookie ?? "",
          Origin: server.baseUrl,
          "X-CSRF-Token": resumed.csrfToken,
          "Idempotency-Key": "capture-request-0001",
        };
        const taskBody = JSON.stringify({
          title: "Capture the first task",
          notes: "Prove the Phase 0 contract",
        });
        const createdTask = await fetch(`${server.baseUrl}/api/tasks`, {
          method: "POST",
          headers: taskHeaders,
          body: taskBody,
        });
        expect(createdTask.status).toBe(201);
        expect(createdTask.headers.get("etag")).toBe('"1"');
        const created = taskMutationResponseSchema.parse(
          await createdTask.json(),
        );
        expect(created.replayed).toBe(false);

        const replayedTask = await fetch(`${server.baseUrl}/api/tasks`, {
          method: "POST",
          headers: taskHeaders,
          body: taskBody,
        });
        expect(replayedTask.status).toBe(200);
        const replayed = taskMutationResponseSchema.parse(
          await replayedTask.json(),
        );
        expect(replayed).toEqual({ ...created, replayed: true });

        const idempotencyConflict = await fetch(`${server.baseUrl}/api/tasks`, {
          method: "POST",
          headers: taskHeaders,
          body: JSON.stringify({ title: "A different task" }),
        });
        expect(idempotencyConflict.status).toBe(409);
        expect(await idempotencyConflict.json()).toMatchObject({
          code: "IDEMPOTENCY_CONFLICT",
        });

        const maximumNotes = "n".repeat(20_000);
        const taskAtContractLimit = await fetch(`${server.baseUrl}/api/tasks`, {
          method: "POST",
          headers: {
            ...taskHeaders,
            "Idempotency-Key": "capture-request-maximum-notes",
          },
          body: JSON.stringify({
            title: "Task at the notes boundary",
            notes: maximumNotes,
          }),
        });
        expect(taskAtContractLimit.status).toBe(201);
        expect(
          taskMutationResponseSchema.parse(await taskAtContractLimit.json())
            .task.notes,
        ).toHaveLength(20_000);

        const tasks = await fetch(`${server.baseUrl}/api/tasks`, {
          headers: { Cookie: cookie ?? "" },
        });
        const listedTasks = taskListResponseSchema.parse(
          await tasks.json(),
        ).tasks;
        expect(listedTasks).toHaveLength(2);
        expect(listedTasks).toContainEqual(created.task);

        const staleCsrf = await fetch(`${server.baseUrl}/api/auth/logout`, {
          method: "POST",
          headers: {
            Cookie: cookie ?? "",
            Origin: server.baseUrl,
            "X-CSRF-Token": loggedIn.csrfToken,
          },
        });
        expect(staleCsrf.status).toBe(403);
        apiErrorSchema.parse(await staleCsrf.json());

        const logout = await fetch(`${server.baseUrl}/api/auth/logout`, {
          method: "POST",
          headers: {
            Cookie: cookie ?? "",
            Origin: server.baseUrl,
            "X-CSRF-Token": resumed.csrfToken,
          },
        });
        expect(logout.status).toBe(200);

        const revoked = await fetch(`${server.baseUrl}/api/auth/session`, {
          headers: { Cookie: cookie ?? "" },
        });
        expect(revoked.status).toBe(401);
      } finally {
        await server.close();
      }
    });
  });
});
