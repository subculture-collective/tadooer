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

it("confirms scoped organization lifecycle and assignments with stale guards, atomic receipts and restart replay", async () => {
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
      const projectId = randomUUID(),
        tagId = randomUUID();
      for (const [operation, id] of [
        ["projects.mutate", projectId],
        ["tags.mutate", tagId],
      ] as const) {
        const input = { action: "create", id, title: "Home" };
        expect((await previewRequest(operation, input, readOnly)).status).toBe(
          403,
        );
        const p = await preview(operation, input);
        expect(p.summary).toContain("Home");
        const listPath = operation === "projects.mutate" ? "projects" : "tags";
        expect(
          await (
            await automationRequest(
              server,
              token,
              `/api/automation/v1/resources/${listPath}`,
              "GET",
            )
          ).json(),
        ).toEqual({ [listPath]: [] });
        const fault = new DatabaseSync(config.databasePath);
        fault.exec(
          "CREATE TRIGGER fail_org_receipt BEFORE INSERT ON automation_audit_log WHEN NEW.phase='execute' BEGIN SELECT RAISE(ABORT, 'injected organization receipt failure'); END;",
        );
        expect((await confirm(p.id)).status).toBe(500);
        expect(
          await (
            await automationRequest(
              server,
              token,
              `/api/automation/v1/resources/${listPath}`,
              "GET",
            )
          ).json(),
        ).toEqual({ [listPath]: [] });
        expect(
          fault
            .prepare("SELECT consumed_at FROM automation_previews WHERE id=?")
            .get(p.id),
        ).toMatchObject({ consumed_at: null });
        fault.exec("DROP TRIGGER fail_org_receipt;");
        fault.close();
        const key = randomUUID();
        const created = automationConfirmationResponseSchema.parse(
          await (await confirm(p.id, key)).json(),
        );
        expect(Object.values(created.result)[0]).toMatchObject({
          id,
          revision: 1,
        });
        await apply(operation, {
          action: "rename",
          id,
          expectedRevision: 1,
          title: "Office",
        });
        await apply(operation, { action: "archive", id, expectedRevision: 2 });
        const restored = await apply(operation, {
          action: "restore",
          id,
          expectedRevision: 3,
        });
        expect(Object.values(restored.result)[0]).toMatchObject({
          revision: 4,
          archivedAt: null,
        });
        await server.close();
        server = await startSuiteServer(config);
        expect(
          automationConfirmationResponseSchema.parse(
            await (await confirm(p.id, key)).json(),
          ),
        ).toEqual({ ...created, replayed: true });
        const list = (await (
          await automationRequest(
            server,
            token,
            `/api/automation/v1/resources/${listPath}`,
            "GET",
          )
        ).json()) as Record<string, unknown[]>;
        expect(list[listPath]?.[0]).toMatchObject({
          revision: 4,
          archivedAt: null,
        });
        expect(
          (
            await previewRequest(operation, {
              action: "rename",
              id,
              expectedRevision: 1,
              title: "Stale",
            })
          ).status,
        ).toBe(412);
        expect(
          (
            await previewRequest(operation, {
              action: "restore",
              id: randomUUID(),
              expectedRevision: 1,
            })
          ).status,
        ).toBe(412);
      }
      expect(
        (
          await previewRequest("tags.mutate", {
            action: "create",
            id: randomUUID(),
            title: "ＯＦＦＩＣＥ",
          })
        ).status,
      ).toBe(409);
      const created = await apply("tasks.create", { title: "Organize me" });
      if (!("task" in created.result)) throw new Error("Task required");
      const taskId = created.result.task.id;
      const assignment = { taskId, expectedRevision: 1, projectId };
      expect(
        (await previewRequest("tasks.assign_project", assignment, readOnly))
          .status,
      ).toBe(403);
      expect(
        (
          await previewRequest("tasks.assign_project", {
            ...assignment,
            projectId: randomUUID(),
          })
        ).status,
      ).toBe(400);
      const staleProject = await preview("tasks.assign_project", assignment);
      await apply("projects.mutate", {
        action: "rename",
        id: projectId,
        expectedRevision: 4,
        title: "Work",
      });
      expect((await confirm(staleProject.id)).status).toBe(412);
      expect(
        (await apply("tasks.assign_project", assignment)).result,
      ).toMatchObject({ task: { projectId, revision: 2 } });
      const tags = { taskId, expectedRevision: 2, tagIds: [tagId] };
      expect(
        (
          await previewRequest("tasks.set_tags", {
            ...tags,
            tagIds: [tagId, tagId],
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await previewRequest("tasks.set_tags", {
            ...tags,
            tagIds: [randomUUID()],
          })
        ).status,
      ).toBe(400);
      const staleTag = await preview("tasks.set_tags", tags);
      await apply("tags.mutate", {
        action: "archive",
        id: tagId,
        expectedRevision: 4,
      });
      expect((await confirm(staleTag.id)).status).toBe(412);
      expect((await previewRequest("tasks.set_tags", tags)).status).toBe(400);
      await apply("tags.mutate", {
        action: "restore",
        id: tagId,
        expectedRevision: 5,
      });
      const p = await preview("tasks.set_tags", tags);
      const key = randomUUID();
      const tagged = automationConfirmationResponseSchema.parse(
        await (await confirm(p.id, key)).json(),
      );
      expect(tagged.result).toMatchObject({
        task: { tagIds: [tagId], revision: 3 },
      });
      expect(
        (
          await apply("tasks.set_tags", {
            taskId,
            expectedRevision: 3,
            tagIds: [],
          })
        ).result,
      ).toMatchObject({ task: { tagIds: [], revision: 4 } });
      expect(
        (
          await apply("tasks.assign_project", {
            taskId,
            expectedRevision: 4,
            projectId: null,
          })
        ).result,
      ).toMatchObject({ task: { projectId: null, revision: 5 } });
      expect(
        automationConfirmationResponseSchema.parse(
          await (await confirm(p.id, key)).json(),
        ),
      ).toEqual({ ...tagged, replayed: true });
    } finally {
      await server.close();
    }
  });
});
