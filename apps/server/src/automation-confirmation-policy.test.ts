import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  apiErrorSchema,
  automationConfirmationResponseSchema,
  automationPreviewResponseSchema,
  automationTaskResourceSchema,
  automationTokenListResponseSchema,
  createAutomationTokenResponseSchema,
} from "@suite/contracts";
import { withTemporaryDirectory } from "@suite/test-support";
import type { ServerConfig } from "./config.ts";
import { startSuiteServer, type RunningSuiteServer } from "./server.ts";

// ADR 0035 / issue #33: the declared confirmation policy is enforced on the
// server for every branch: ordinary versus consequential command, confirm_all
// versus execute_ordinary token, replay across restart, denial without effect,
// and a complete audit ledger.

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
  method: "GET" | "POST" | "DELETE",
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

interface AuditEntry {
  readonly operation: string;
  readonly phase: string;
  readonly outcome: string;
  readonly errorCode: string | null;
  readonly previewId: string | null;
}

it("executes ordinary edits only under an execute_ordinary token, always confirms consequential actions, and keeps the ledger complete", async () => {
  await withTemporaryDirectory(async (directory) => {
    await mkdir(join(directory, "web"));
    const config = configuration(directory);
    let server = await startSuiteServer(config);
    try {
      const owner = {
        username: "policy-owner",
        displayName: "Policy Owner",
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
      const issueRequest = (extra: Record<string, unknown>) =>
        browserRequest(
          server,
          cookie,
          csrfToken,
          "/api/automation/tokens",
          "POST",
          {
            label: "Policy",
            scopes: ["tasks:read", "tasks:write"],
            expiresAt: new Date(Date.now() + 3600000).toISOString(),
            ...extra,
          },
        );

      // The owner sets the policy at issuance; unknown values are rejected.
      const invalid = await issueRequest({ confirmationPolicy: "auto" });
      expect(invalid.status).toBe(400);
      expect(apiErrorSchema.parse(await invalid.json()).code).toBe(
        "INVALID_AUTOMATION_TOKEN",
      );
      const confirmAllIssued = await issueRequest({});
      expect(confirmAllIssued.status).toBe(201);
      const confirmAll = createAutomationTokenResponseSchema.parse(
        await confirmAllIssued.json(),
      );
      expect(confirmAll.record.confirmationPolicy).toBe("confirm_all");
      const executeOrdinary = createAutomationTokenResponseSchema.parse(
        await (
          await issueRequest({ confirmationPolicy: "execute_ordinary" })
        ).json(),
      );
      expect(executeOrdinary.record.confirmationPolicy).toBe(
        "execute_ordinary",
      );
      const inventory = automationTokenListResponseSchema.parse(
        await (
          await browserRequest(
            server,
            cookie,
            csrfToken,
            "/api/automation/tokens",
            "GET",
          )
        ).json(),
      );
      expect(inventory.tokens.map((t) => t.confirmationPolicy)).toEqual([
        "confirm_all",
        "execute_ordinary",
      ]);

      const previewRequest = (
        token: string,
        operation: string,
        input: unknown,
        execute?: unknown,
      ) =>
        automationRequest(
          server,
          token,
          "/api/automation/v1/previews",
          "POST",
          {
            operation,
            input,
            ...(execute === undefined ? {} : { execute }),
          },
        );
      const confirm = (token: string, id: string, key: string) =>
        automationRequest(
          server,
          token,
          `/api/automation/v1/previews/${id}/confirm`,
          "POST",
          { idempotencyKey: key },
        );
      const tasks = async () =>
        automationTaskResourceSchema.parse(
          await (
            await automationRequest(
              server,
              executeOrdinary.token,
              "/api/automation/v1/resources/tasks",
              "GET",
            )
          ).json(),
        ).tasks;
      const audit = async (): Promise<readonly AuditEntry[]> =>
        (
          (await (
            await browserRequest(
              server,
              cookie,
              csrfToken,
              "/api/automation/audit",
              "GET",
            )
          ).json()) as { entries: readonly AuditEntry[] }
        ).entries;
      const failure = async (response: Response, status: number) => {
        expect(response.status).toBe(status);
        return apiErrorSchema.parse(await response.json()).code;
      };

      // Ordinary + execute_ordinary: applied in the preview call.
      const created = await previewRequest(
        executeOrdinary.token,
        "tasks.create",
        { title: "Water the plants" },
        { idempotencyKey: "create-0001" },
      );
      expect(created.status).toBe(201);
      const createdBody = automationPreviewResponseSchema.parse(
        await created.json(),
      );
      expect(createdBody.preview.requiresConfirmation).toBe(false);
      expect(createdBody.preview.confirmation).toEqual({
        policy: "ordinary",
        category: null,
        tokenPolicy: "execute_ordinary",
      });
      const executed = automationConfirmationResponseSchema.parse(
        createdBody.executed,
      );
      expect(executed.replayed).toBe(false);
      expect(executed.previewId).toBe(createdBody.preview.id);
      if (!("task" in executed.result)) throw new Error("Expected task");
      const taskId = executed.result.task.id;
      expect((await tasks()).map((t) => t.title)).toEqual(["Water the plants"]);
      expect(
        (await audit())
          .filter((e) => e.previewId === createdBody.preview.id)
          .map((e) => [e.phase, e.outcome]),
      ).toEqual([
        ["preview", "succeeded"],
        ["execute", "succeeded"],
      ]);

      // Same key and command: replayed, still one task.
      const replayed = automationPreviewResponseSchema.parse(
        await (
          await previewRequest(
            executeOrdinary.token,
            "tasks.create",
            { title: "Water the plants" },
            { idempotencyKey: "create-0001" },
          )
        ).json(),
      );
      expect(replayed.executed?.replayed).toBe(true);
      expect(replayed.executed?.result).toEqual(executed.result);
      expect(await tasks()).toHaveLength(1);
      // Same key, other command: conflict, nothing created.
      expect(
        await failure(
          await previewRequest(
            executeOrdinary.token,
            "tasks.create",
            { title: "Another task" },
            { idempotencyKey: "create-0001" },
          ),
          409,
        ),
      ).toBe("IDEMPOTENCY_CONFLICT");
      expect(await tasks()).toHaveLength(1);
      // Malformed execute: rejected before any preview exists.
      const auditBefore = (await audit()).length;
      expect(
        await failure(
          await previewRequest(
            executeOrdinary.token,
            "tasks.update",
            { taskId, expectedRevision: 1, patch: { title: "Short key" } },
            { idempotencyKey: "x" },
          ),
          400,
        ),
      ).toBe("INVALID_AUTOMATION_PREVIEW");
      expect((await audit()).length).toBe(auditBefore);

      // Ordinary + confirm_all: denied, no effect, preview stays confirmable.
      const rename = {
        taskId,
        expectedRevision: 1,
        patch: { title: "Water the garden" },
      };
      expect(
        await failure(
          await previewRequest(confirmAll.token, "tasks.update", rename, {
            idempotencyKey: "rename-0001",
          }),
          409,
        ),
      ).toBe("AUTOMATION_CONFIRMATION_REQUIRED");
      expect((await tasks())[0]).toMatchObject({
        title: "Water the plants",
        revision: 1,
      });
      const deniedRename = (await audit()).findLast(
        (e) =>
          e.operation === "tasks.update" &&
          e.errorCode === "AUTOMATION_CONFIRMATION_REQUIRED",
      );
      expect(deniedRename).toMatchObject({
        phase: "confirm",
        outcome: "denied",
      });
      const renamePreviewId = deniedRename?.previewId ?? "";
      const renamed = await confirm(
        confirmAll.token,
        renamePreviewId,
        "rename-0001",
      );
      expect(renamed.status).toBe(200);
      expect((await tasks())[0]).toMatchObject({
        title: "Water the garden",
        revision: 2,
      });
      // A plain preview under confirm_all still reports the policy.
      const plain = automationPreviewResponseSchema.parse(
        await (
          await previewRequest(confirmAll.token, "tasks.set_completed", {
            taskId,
            expectedRevision: 2,
            completed: true,
          })
        ).json(),
      );
      expect(plain.executed).toBeUndefined();
      expect(plain.preview.requiresConfirmation).toBe(true);
      expect(plain.preview.confirmation).toEqual({
        policy: "ordinary",
        category: null,
        tokenPolicy: "confirm_all",
      });

      // Consequential + execute_ordinary: denied whatever the token says.
      expect(
        await failure(
          await previewRequest(
            executeOrdinary.token,
            "tasks.delete",
            { taskId, expectedRevision: 2 },
            { idempotencyKey: "delete-0001" },
          ),
          409,
        ),
      ).toBe("AUTOMATION_CONFIRMATION_REQUIRED");
      expect(await tasks()).toHaveLength(1);
      const deniedDelete = (await audit()).findLast(
        (e) =>
          e.operation === "tasks.delete" &&
          e.errorCode === "AUTOMATION_CONFIRMATION_REQUIRED",
      );
      expect(deniedDelete?.previewId).toBeTypeOf("string");
      expect(
        (await audit()).some(
          (e) =>
            e.previewId === deniedDelete?.previewId && e.phase === "execute",
        ),
      ).toBe(false);
      const deletePreview = automationPreviewResponseSchema.parse(
        await (
          await previewRequest(executeOrdinary.token, "tasks.delete", {
            taskId,
            expectedRevision: 2,
          })
        ).json(),
      ).preview;
      expect(deletePreview.confirmation).toEqual({
        policy: "consequential",
        category: "deletion",
        tokenPolicy: "execute_ordinary",
      });
      expect(deletePreview.requiresConfirmation).toBe(true);
      // The user declines: nothing happens. The user approves: explicit confirm.
      expect(await tasks()).toHaveLength(1);
      expect(
        (
          await confirm(
            executeOrdinary.token,
            deniedDelete?.previewId ?? "",
            "delete-0001",
          )
        ).status,
      ).toBe(200);
      expect(await tasks()).toHaveLength(0);
      // The unconsumed sibling preview is now stale, not silently applied.
      expect(
        await failure(
          await confirm(executeOrdinary.token, deletePreview.id, "delete-0002"),
          412,
        ),
      ).toBe("AUTOMATION_PREVIEW_STALE");

      // Restore (ordinary) executes; by_action: checklist create executes,
      // checklist delete is refused.
      const restored = automationPreviewResponseSchema.parse(
        await (
          await previewRequest(
            executeOrdinary.token,
            "tasks.restore",
            { taskId, expectedRevision: 3 },
            { idempotencyKey: "restore-0001" },
          )
        ).json(),
      );
      expect(restored.executed?.replayed).toBe(false);
      const [restoredTask] = await tasks();
      expect(restoredTask?.revision).toBe(4);
      const itemId = randomUUID();
      const item = automationPreviewResponseSchema.parse(
        await (
          await previewRequest(
            executeOrdinary.token,
            "subtasks.mutate",
            {
              expectedTaskRevision: 4,
              command: {
                action: "create",
                taskId,
                id: itemId,
                title: "Fill the can",
                position: 0,
              },
            },
            { idempotencyKey: "item-0001" },
          )
        ).json(),
      );
      expect(item.preview.confirmation.policy).toBe("ordinary");
      expect(item.executed).toBeDefined();
      const itemDelete = await previewRequest(
        executeOrdinary.token,
        "subtasks.mutate",
        {
          expectedTaskRevision: 4,
          command: {
            action: "delete",
            taskId,
            id: itemId,
            expectedRevision: 1,
          },
        },
        { idempotencyKey: "item-0002" },
      );
      expect(await failure(itemDelete, 409)).toBe(
        "AUTOMATION_CONFIRMATION_REQUIRED",
      );
      const itemDeletePreview = automationPreviewResponseSchema.parse(
        await (
          await previewRequest(executeOrdinary.token, "subtasks.mutate", {
            expectedTaskRevision: 4,
            command: {
              action: "delete",
              taskId,
              id: itemId,
              expectedRevision: 1,
            },
          })
        ).json(),
      ).preview;
      expect(itemDeletePreview.confirmation).toEqual({
        policy: "consequential",
        category: "deletion",
        tokenPolicy: "execute_ordinary",
      });

      // Replay survives a restart; a revoked token cannot execute.
      await server.close();
      server = await startSuiteServer(config);
      const afterRestart = automationPreviewResponseSchema.parse(
        await (
          await previewRequest(
            executeOrdinary.token,
            "tasks.create",
            { title: "Water the plants" },
            { idempotencyKey: "create-0001" },
          )
        ).json(),
      );
      expect(afterRestart.executed?.replayed).toBe(true);
      expect(await tasks()).toHaveLength(1);
      expect(
        (
          await browserRequest(
            server,
            cookie,
            csrfToken,
            `/api/automation/tokens/${executeOrdinary.record.id}`,
            "DELETE",
          )
        ).status,
      ).toBe(204);
      expect(
        await failure(
          await previewRequest(
            executeOrdinary.token,
            "tasks.create",
            { title: "After revocation" },
            { idempotencyKey: "create-0002" },
          ),
          401,
        ),
      ).toBe("AUTOMATION_TOKEN_INVALID");

      // Ledger: every executed-in-preview command has a preview and an execute
      // row; every refusal has a denied confirm row and no execute row.
      const entries = await audit();
      const executeRows = entries.filter((e) => e.phase === "execute");
      expect(executeRows.map((e) => e.operation)).toEqual([
        "tasks.create",
        "tasks.update",
        "tasks.delete",
        "tasks.restore",
        "subtasks.mutate",
      ]);
      for (const row of executeRows)
        expect(
          entries.some(
            (e) => e.previewId === row.previewId && e.phase === "preview",
          ),
        ).toBe(true);
      const denied = entries.filter(
        (e) => e.errorCode === "AUTOMATION_CONFIRMATION_REQUIRED",
      );
      expect(denied.map((e) => e.operation)).toEqual([
        "tasks.update",
        "tasks.delete",
        "subtasks.mutate",
      ]);
      expect(denied.every((e) => e.phase === "confirm")).toBe(true);
    } finally {
      await server.close();
    }
  });
});
