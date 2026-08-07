import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  apiErrorSchema,
  automationConfirmationResponseSchema,
  automationPreviewResponseSchema,
  automationTaskResourceSchema,
  createAutomationTokenResponseSchema,
  taskListResponseSchema,
  taskMutationResponseSchema,
} from "@suite/contracts";
import { withTemporaryDirectory } from "@suite/test-support";
import type { ServerConfig } from "./config.ts";
import { startSuiteServer, type RunningSuiteServer } from "./server.ts";

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

const browserRequest = (
  server: RunningSuiteServer,
  cookie: string,
  csrfToken: string,
  path: string,
  method: "POST" | "DELETE",
  body?: unknown,
): Promise<Response> =>
  fetch(`${server.baseUrl}${path}`, {
    method,
    headers: {
      Origin: server.baseUrl,
      Cookie: cookie,
      "X-CSRF-Token": csrfToken,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const automationRequest = (
  server: RunningSuiteServer,
  token: string,
  path: string,
  method: "GET" | "POST",
  body?: unknown,
): Promise<Response> =>
  fetch(`${server.baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

describe("Phase 4 automation HTTP integration", () => {
  it("requires scoped confirmation, preserves exact replay across restart, and revokes automation without disrupting the owner session", async () => {
    await withTemporaryDirectory(async (directory) => {
      await mkdir(join(directory, "web"));
      await writeFile(join(directory, "web", "index.html"), "<h1>Suite</h1>");
      const config = configuration(directory);
      let server = await startSuiteServer(config);
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
        expect(login.status).toBe(200);
        const cookie = login.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
        const session = (await login.json()) as { csrfToken: string };

        const issued = await browserRequest(
          server,
          cookie,
          session.csrfToken,
          "/api/automation/tokens",
          "POST",
          {
            label: "Phase 4 integration",
            scopes: ["tasks:read", "tasks:write", "focus:read", "focus:write"],
            expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          },
        );
        expect(issued.status).toBe(201);
        const credential = createAutomationTokenResponseSchema.parse(
          await issued.json(),
        );

        const scopedRead = await automationRequest(
          server,
          credential.token,
          "/api/automation/v1/resources/tasks",
          "GET",
        );
        expect(scopedRead.status).toBe(200);
        expect(
          automationTaskResourceSchema.parse(await scopedRead.json()).tasks,
        ).toEqual([]);

        const previewInput = {
          operation: "tasks.create",
          input: { title: "Created by confirmed automation", notes: "" },
        };
        const previewResponse = await automationRequest(
          server,
          credential.token,
          "/api/automation/v1/previews",
          "POST",
          previewInput,
        );
        expect(previewResponse.status).toBe(201);
        const preview = automationPreviewResponseSchema.parse(
          await previewResponse.json(),
        ).preview;
        expect(preview.operation).toBe("tasks.create");

        const beforeConfirmation = await automationRequest(
          server,
          credential.token,
          "/api/automation/v1/resources/tasks",
          "GET",
        );
        expect(
          automationTaskResourceSchema.parse(await beforeConfirmation.json())
            .tasks,
        ).toEqual([]);

        const operationKey = "phase4-confirm-task-001";
        const confirmed = await automationRequest(
          server,
          credential.token,
          `/api/automation/v1/previews/${preview.id}/confirm`,
          "POST",
          { idempotencyKey: operationKey },
        );
        expect(confirmed.status).toBe(200);
        const firstResult = automationConfirmationResponseSchema.parse(
          await confirmed.json(),
        );
        expect(firstResult).toMatchObject({
          previewId: preview.id,
          operation: "tasks.create",
          replayed: false,
          result: {
            replayed: false,
            task: { title: "Created by confirmed automation" },
          },
        });
        if (!("task" in firstResult.result)) {
          throw new Error("Task confirmation did not return a task result");
        }
        const firstTask = firstResult.result.task;

        const secondPreviewResponse = await automationRequest(
          server,
          credential.token,
          "/api/automation/v1/previews",
          "POST",
          {
            operation: "tasks.create",
            input: { title: "Must not be created", notes: "" },
          },
        );
        expect(secondPreviewResponse.status).toBe(201);
        const secondPreview = automationPreviewResponseSchema.parse(
          await secondPreviewResponse.json(),
        ).preview;
        const alteredPreview = await automationRequest(
          server,
          credential.token,
          `/api/automation/v1/previews/${secondPreview.id}/confirm`,
          "POST",
          { idempotencyKey: operationKey },
        );
        expect(alteredPreview.status).toBe(409);
        expect(apiErrorSchema.parse(await alteredPreview.json())).toMatchObject(
          {
            code: "IDEMPOTENCY_CONFLICT",
          },
        );

        await server.close();
        server = await startSuiteServer(config);
        const replay = await automationRequest(
          server,
          credential.token,
          `/api/automation/v1/previews/${preview.id}/confirm`,
          "POST",
          { idempotencyKey: operationKey },
        );
        expect(replay.status).toBe(200);
        expect(
          automationConfirmationResponseSchema.parse(await replay.json()),
        ).toMatchObject({
          previewId: preview.id,
          replayed: true,
          result: {
            task: { id: firstTask.id },
          },
        });

        const exactlyOnce = await automationRequest(
          server,
          credential.token,
          "/api/automation/v1/resources/tasks",
          "GET",
        );
        expect(
          automationTaskResourceSchema.parse(await exactlyOnce.json()).tasks,
        ).toEqual([
          expect.objectContaining({
            id: firstTask.id,
            title: "Created by confirmed automation",
          }),
        ]);

        const focusPreviewResponse = await automationRequest(
          server,
          credential.token,
          "/api/automation/v1/previews",
          "POST",
          {
            operation: "focus.start",
            input: { operation: "focus.start", taskId: firstTask.id },
          },
        );
        expect(focusPreviewResponse.status).toBe(201);
        const focusPreview = automationPreviewResponseSchema.parse(
          await focusPreviewResponse.json(),
        ).preview;
        const focusConfirmed = await automationRequest(
          server,
          credential.token,
          `/api/automation/v1/previews/${focusPreview.id}/confirm`,
          "POST",
          { idempotencyKey: "phase4-focus-start-001" },
        );
        expect(focusConfirmed.status).toBe(200);
        expect(
          automationConfirmationResponseSchema.parse(
            await focusConfirmed.json(),
          ),
        ).toMatchObject({
          operation: "focus.start",
          result: { session: { taskId: firstTask.id, state: "running" } },
        });
        const revoked = await browserRequest(
          server,
          cookie,
          session.csrfToken,
          `/api/automation/tokens/${credential.record.id}`,
          "DELETE",
        );
        expect(revoked.status).toBe(204);
        const denied = await automationRequest(
          server,
          credential.token,
          "/api/automation/v1/resources/tasks",
          "GET",
        );
        expect(denied.status).toBe(401);
        expect(apiErrorSchema.parse(await denied.json())).toMatchObject({
          code: "AUTOMATION_TOKEN_INVALID",
        });

        const interactiveCreate = await browserRequest(
          server,
          cookie,
          session.csrfToken,
          "/api/tasks",
          "POST",
          { title: "Browser remains signed in", notes: "" },
        );
        expect(interactiveCreate.status).toBe(400);
        expect(
          apiErrorSchema.parse(await interactiveCreate.json()),
        ).toMatchObject({
          code: "IDEMPOTENCY_KEY_REQUIRED",
        });
        const browserMutation = await fetch(`${server.baseUrl}/api/tasks`, {
          method: "POST",
          headers: {
            Origin: server.baseUrl,
            Cookie: cookie,
            "X-CSRF-Token": session.csrfToken,
            "Idempotency-Key": "phase4-browser-task-001",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            title: "Browser remains signed in",
            notes: "",
          }),
        });
        expect(browserMutation.status).toBe(201);
        taskMutationResponseSchema.parse(await browserMutation.json());
        const browserTasks = await fetch(`${server.baseUrl}/api/tasks`, {
          headers: { Cookie: cookie },
        });
        expect(browserTasks.status).toBe(200);
        expect(
          taskListResponseSchema.parse(await browserTasks.json()).tasks,
        ).toHaveLength(2);
      } finally {
        await server.close();
      }
    });
  });
});
