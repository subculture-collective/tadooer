import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  apiErrorSchema,
  createAutomationTokenResponseSchema,
  dataExportDocumentSchema,
  dataRestoreApplyResponseSchema,
  dataRestorePreviewSchema,
  taskListResponseSchema,
  taskMutationResponseSchema,
  type DataExportDocument,
} from "@suite/contracts";
import { withTemporaryDirectory } from "@suite/test-support";
import type { ServerConfig } from "./config.ts";
import { startSuiteServer, type RunningSuiteServer } from "./server.ts";

// Owner data export and restore over HTTP (issue #93, ADR 0034).
const configuration = (directory: string, name: string): ServerConfig => ({
  host: "127.0.0.1",
  port: 0,
  databasePath: join(directory, name, "suite.sqlite"),
  webRoot: join(directory, "web"),
  baikalEndpoint: "http://baikal.test/dav.php/",
  credentialKeyPath: join(directory, name, "credential.key"),
  secureCookies: false,
  build: { version: "test", revision: "test", builtAt: null },
});

const owner = {
  username: "organizer",
  displayName: "Organizer",
  password: "a sufficiently long disposable password",
};

const signIn = async (server: RunningSuiteServer) => {
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
  const browser = (
    path: string,
    method: "GET" | "POST",
    body?: unknown,
    headers: Record<string, string> = {},
  ) =>
    fetch(`${server.baseUrl}${path}`, {
      method,
      headers: {
        Origin: server.baseUrl,
        Cookie: cookie,
        "X-CSRF-Token": csrfToken,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...headers,
      },
      ...(body === undefined
        ? {}
        : { body: typeof body === "string" ? body : JSON.stringify(body) }),
    });
  return { browser, cookie };
};

it("exports, previews and restores the owner's data with explicit choices", async () => {
  await withTemporaryDirectory(async (directory) => {
    await mkdir(join(directory, "web"));
    const a = await startSuiteServer(configuration(directory, "a"), {
      disableNotificationTimer: true,
    });
    const b = await startSuiteServer(configuration(directory, "b"), {
      disableNotificationTimer: true,
    });
    try {
      const sourceSession = await signIn(a);
      const source = sourceSession.browser;
      // Anonymous and automation-token requests never reach the export.
      expect((await fetch(`${a.baseUrl}/api/data/export`)).status).toBe(401);
      const token = createAutomationTokenResponseSchema.parse(
        await (
          await source("/api/automation/tokens", "POST", {
            label: "assistant",
            scopes: ["tasks:read"],
            expiresAt: "2027-01-01T00:00:00.000Z",
          })
        ).json(),
      );
      expect(
        (
          await fetch(`${a.baseUrl}/api/data/export`, {
            headers: { Authorization: `Bearer ${token.token}` },
          })
        ).status,
      ).toBe(401);

      const created = taskMutationResponseSchema.parse(
        await (
          await source(
            "/api/tasks",
            "POST",
            { title: "Prune roses", notes: "Before the frost" },
            { "Idempotency-Key": "data-export-source-task" },
          )
        ).json(),
      );

      const exportResponse = await source("/api/data/export", "GET");
      expect(exportResponse.status).toBe(200);
      expect(exportResponse.headers.get("content-disposition")).toMatch(
        /^attachment; filename="tadooer-export-\d{4}-\d{2}-\d{2}\.json"$/,
      );
      expect(exportResponse.headers.get("cache-control")).toBe("no-store");
      const text = await exportResponse.text();
      const exported: DataExportDocument = dataExportDocumentSchema.parse(
        JSON.parse(text),
      );
      expect(exported.tables.tasks).toHaveLength(1);
      expect(exported.owner.username).toBe("organizer");
      expect(text).not.toContain(token.token.slice(-20));
      expect(exported.tables).not.toHaveProperty("automation_tokens");
      expect(exported.tables).not.toHaveProperty("web_sessions");

      // Restore needs a same-origin session with the CSRF token.
      const targetSession = await signIn(b);
      const target = targetSession.browser;
      expect(
        (
          await fetch(`${b.baseUrl}/api/data/restore/preview`, {
            method: "POST",
            headers: {
              Origin: b.baseUrl,
              Cookie: targetSession.cookie,
              "Content-Type": "application/json",
            },
            body: text,
          })
        ).status,
      ).toBe(403);
      const notExport = await target("/api/data/restore/preview", "POST", {
        hello: "world",
      });
      expect(notExport.status).toBe(400);
      expect(apiErrorSchema.parse(await notExport.json()).code).toBe(
        "INVALID_RESTORE",
      );

      const preview = dataRestorePreviewSchema.parse(
        await (await target("/api/data/restore/preview", "POST", text)).json(),
      );
      expect(preview).toMatchObject({
        sameOwner: false,
        sameInstance: false,
        canApply: true,
        target: { empty: true, totalRows: 0 },
      });
      expect(preview.counts).toContainEqual({ table: "tasks", rows: 1 });
      expect(await (await target("/api/tasks", "GET")).json()).toMatchObject({
        tasks: [],
      });

      // Apply needs the previewed hash and an explicit mode.
      const staleHash = await target("/api/data/restore/apply", "POST", text, {
        "X-Restore-Hash": "0".repeat(64),
        "X-Restore-Mode": "empty-only",
      });
      expect(staleHash.status).toBe(409);
      const noMode = await target("/api/data/restore/apply", "POST", text, {
        "X-Restore-Hash": preview.inputHash,
      });
      expect(noMode.status).toBe(400);
      expect(apiErrorSchema.parse(await noMode.json()).code).toBe(
        "RESTORE_MODE_REQUIRED",
      );
      const applied = dataRestoreApplyResponseSchema.parse(
        await (
          await target("/api/data/restore/apply", "POST", text, {
            "X-Restore-Hash": preview.inputHash,
            "X-Restore-Mode": "empty-only",
          })
        ).json(),
      );
      expect(applied).toMatchObject({
        mode: "empty-only",
        deletedRows: 0,
        totalRows: preview.totalRows,
      });
      const restoredTasks = taskListResponseSchema.parse(
        await (await target("/api/tasks", "GET")).json(),
      );
      expect(
        restoredTasks.tasks.map(({ id, title }) => ({ id, title })),
      ).toEqual([{ id: created.task.id, title: "Prune roses" }]);

      // A second restore into the now populated target must be chosen.
      const again = dataRestorePreviewSchema.parse(
        await (await target("/api/data/restore/preview", "POST", text)).json(),
      );
      expect(again.target.empty).toBe(false);
      const refused = await target("/api/data/restore/apply", "POST", text, {
        "X-Restore-Hash": again.inputHash,
        "X-Restore-Mode": "empty-only",
      });
      expect(refused.status).toBe(409);
      expect(apiErrorSchema.parse(await refused.json()).code).toBe(
        "RESTORE_TARGET_NOT_EMPTY",
      );
      await target(
        "/api/tasks",
        "POST",
        { title: "Added on the target", notes: "" },
        { "Idempotency-Key": "data-export-target-task" },
      );
      const replaced = dataRestoreApplyResponseSchema.parse(
        await (
          await target("/api/data/restore/apply", "POST", text, {
            "X-Restore-Hash": again.inputHash,
            "X-Restore-Mode": "replace",
          })
        ).json(),
      );
      expect(replaced.mode).toBe("replace");
      expect(replaced.deletedRows).toBeGreaterThan(0);
      const afterReplace = taskListResponseSchema.parse(
        await (await target("/api/tasks", "GET")).json(),
      );
      expect(afterReplace.tasks.map(({ title }) => title)).toEqual([
        "Prune roses",
      ]);

      // The target's own export matches the source apart from instance fields.
      const targetExport = dataExportDocumentSchema.parse(
        await (await target("/api/data/export", "GET")).json(),
      );
      const strip = (document: DataExportDocument, ownerId: string) =>
        Object.fromEntries(
          Object.entries(document.tables).map(([table, rows]) => [
            table,
            rows.map((row) => ({
              ...row,
              ...("owner_id" in row && row.owner_id === ownerId
                ? { owner_id: "<owner>" }
                : {}),
            })),
          ]),
        );
      expect(strip(targetExport, targetExport.owner.id)).toEqual(
        strip(exported, exported.owner.id),
      );

      // A newer export is refused with the reason.
      const newer = await target("/api/data/restore/preview", "POST", {
        ...exported,
        source: { ...exported.source, migrationCount: 999 },
      });
      const newerPreview = dataRestorePreviewSchema.parse(await newer.json());
      expect(newerPreview.canApply).toBe(false);
      expect(newerPreview.issues.map(({ code }) => code)).toEqual([
        "NEWER_SCHEMA",
      ]);
      const notReady = await target(
        "/api/data/restore/apply",
        "POST",
        {
          ...exported,
          source: { ...exported.source, migrationCount: 999 },
        },
        {
          "X-Restore-Hash": newerPreview.inputHash,
          "X-Restore-Mode": "replace",
        },
      );
      expect(notReady.status).toBe(422);
      expect(apiErrorSchema.parse(await notReady.json()).code).toBe(
        "RESTORE_NOT_READY",
      );
    } finally {
      await a.close();
      await b.close();
    }
  });
});
