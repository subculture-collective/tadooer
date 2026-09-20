import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  automationTokenScopeSchema,
  automationConfirmationResponseSchema,
  automationPreviewResponseSchema,
  createAutomationTokenResponseSchema,
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
  method: "POST" | "PUT" | "DELETE",
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

it("binds checklist previews to exact membership, revisions and atomic restart-safe receipts", async () => {
  await withTemporaryDirectory(async (directory) => {
    await mkdir(join(directory, "web"));
    const config = configuration(directory);
    let server = await startSuiteServer(config);
    try {
      const owner = {
        username: "organizer",
        displayName: "Organizer",
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
      const issue = async (scopes: string[]) =>
        createAutomationTokenResponseSchema.parse(
          await (
            await browserRequest(
              server,
              cookie,
              csrfToken,
              "/api/automation/tokens",
              "POST",
              {
                label: "Organizer",
                scopes,
                expiresAt: new Date(Date.now() + 3600000).toISOString(),
              },
            )
          ).json(),
        ).token;
      const token = await issue([...automationTokenScopeSchema.options]);
      const readOnly = await issue([
        "projects:read",
        "tags:read",
        "tasks:read",
      ]);
      const previewRequest = (
        operation: string,
        input: unknown,
        credential = token,
      ) =>
        automationRequest(
          server,
          credential,
          "/api/automation/v1/previews",
          "POST",
          { operation, input },
        );
      const preview = async (operation: string, input: unknown) => {
        const response = await previewRequest(operation, input);
        expect(response.status).toBe(201);
        return automationPreviewResponseSchema.parse(await response.json())
          .preview;
      };
      const confirm = (id: string, key = randomUUID()) =>
        automationRequest(
          server,
          token,
          `/api/automation/v1/previews/${id}/confirm`,
          "POST",
          { idempotencyKey: key },
        );
      const apply = async (operation: string, input: unknown) => {
        const p = await preview(operation, input);
        const response = await confirm(p.id);
        expect(response.status).toBe(200);
        return automationConfirmationResponseSchema.parse(
          await response.json(),
        );
      };
      const created = await apply("tasks.create", {
        title: "Checklist parent",
      });
      if (!("task" in created.result)) throw new Error("Expected task");
      const taskId = created.result.task.id,
        first = randomUUID(),
        second = randomUUID();
      const command = (value: Record<string, unknown>) => ({
        expectedTaskRevision: 1,
        command: { taskId, ...value },
      });
      const read = async () => {
        const response = await automationRequest(
          server,
          token,
          `/api/automation/v1/resources/subtasks?taskId=${taskId}`,
          "GET",
        );
        expect(response.status).toBe(200);
        return (await response.json()) as { subtasks: unknown[] };
      };
      expect(
        (
          await automationRequest(
            server,
            token,
            "/api/automation/v1/resources/subtasks",
            "GET",
          )
        ).status,
      ).toBe(400);
      expect(
        (
          await automationRequest(
            server,
            token,
            `/api/automation/v1/resources/subtasks?taskId=${randomUUID()}`,
            "GET",
          )
        ).status,
      ).toBe(404);
      expect(
        (
          await previewRequest(
            "subtasks.mutate",
            command({
              action: "create",
              id: first,
              title: "First",
              position: 0,
            }),
            readOnly,
          )
        ).status,
      ).toBe(403);
      expect(
        (
          await previewRequest("subtasks.mutate", {
            expectedTaskRevision: 1,
            command: {
              action: "create",
              taskId: randomUUID(),
              id: first,
              title: "No parent",
              position: 0,
            },
          })
        ).status,
      ).toBe(412);
      const firstPreview = await preview(
        "subtasks.mutate",
        command({ action: "create", id: first, title: "First", position: 0 }),
      );
      expect((await read()).subtasks).toEqual([]);
      expect((await confirm(firstPreview.id)).status).toBe(200);
      const staleOrder = await preview(
        "subtasks.mutate",
        command({ action: "reorder", items: [{ id: first, revision: 1 }] }),
      );
      await apply(
        "subtasks.mutate",
        command({ action: "create", id: second, title: "Second", position: 1 }),
      );
      // A new checklist member does not revise the parent; full-set validation must still reject the old order.
      expect((await confirm(staleOrder.id)).status).toBe(412);
      expect(
        (
          await previewRequest(
            "subtasks.mutate",
            command({ action: "reorder", items: [{ id: first, revision: 1 }] }),
          )
        ).status,
      ).toBe(412);
      expect(
        (
          await previewRequest(
            "subtasks.mutate",
            command({
              action: "reorder",
              items: [
                { id: first, revision: 1 },
                { id: first, revision: 1 },
              ],
            }),
          )
        ).status,
      ).toBe(400);
      const operations = [
        command({
          action: "create",
          id: randomUUID(),
          title: "Rollback",
          position: 2,
        }),
        command({
          action: "update",
          id: first,
          expectedRevision: 1,
          patch: { completed: true },
        }),
        command({
          action: "reorder",
          items: [
            { id: second, revision: 1 },
            { id: first, revision: 1 },
          ],
        }),
        command({ action: "delete", id: first, expectedRevision: 1 }),
      ];
      const before = await read();
      for (const input of operations) {
        const p = await preview("subtasks.mutate", input);
        const raw = new DatabaseSync(config.databasePath);
        raw.exec(
          "CREATE TRIGGER fail_checklist_receipt BEFORE INSERT ON automation_audit_log WHEN NEW.phase='execute' AND NEW.operation='subtasks.mutate' BEGIN SELECT RAISE(ABORT,'injected checklist receipt failure'); END;",
        );
        expect((await confirm(p.id)).status).toBe(500);
        expect(await read()).toEqual(before);
        expect(
          raw
            .prepare("SELECT consumed_at FROM automation_previews WHERE id=?")
            .get(p.id),
        ).toMatchObject({ consumed_at: null });
        raw.exec("DROP TRIGGER fail_checklist_receipt;");
        raw.close();
      }
      const stale = await preview(
        "subtasks.mutate",
        command({ action: "delete", id: first, expectedRevision: 1 }),
      );
      await apply(
        "subtasks.mutate",
        command({
          action: "update",
          id: first,
          expectedRevision: 1,
          patch: { completed: true, title: "Finished" },
        }),
      );
      expect((await confirm(stale.id)).status).toBe(412);
      const reordered = await apply(
        "subtasks.mutate",
        command({
          action: "reorder",
          items: [
            { id: second, revision: 1 },
            { id: first, revision: 2 },
          ],
        }),
      );
      expect(reordered.result).toMatchObject({
        subtasks: [
          { id: second, position: 0, revision: 2 },
          { id: first, position: 1, revision: 3 },
        ],
      });
      const deletion = await preview(
        "subtasks.mutate",
        command({ action: "delete", id: first, expectedRevision: 3 }),
      );
      expect(deletion.summary).toContain("Permanently delete");
      expect((await read()).subtasks).toHaveLength(2);
      const key = randomUUID();
      const deleted = automationConfirmationResponseSchema.parse(
        await (await confirm(deletion.id, key)).json(),
      );
      expect(deleted.result).toMatchObject({
        deletedIds: [first],
        subtasks: [{ id: second }],
      });
      await server.close();
      server = await startSuiteServer(config);
      expect(
        automationConfirmationResponseSchema.parse(
          await (await confirm(deletion.id, key)).json(),
        ),
      ).toEqual({ ...deleted, replayed: true });
      expect((await read()).subtasks).toHaveLength(1);
      expect(
        (
          await previewRequest(
            "subtasks.mutate",
            command({ action: "delete", id: first, expectedRevision: 3 }),
          )
        ).status,
      ).toBe(412);
    } finally {
      await server.close();
    }
  });
});
