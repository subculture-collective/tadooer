import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import {
  automationConfirmationResponseSchema,
  automationPreviewResponseSchema,
  createAutomationTokenResponseSchema,
  superProductivityPreviewSchema,
  taskListResponseSchema,
  taskLinksResponseSchema,
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

const owner = {
  username: "linker",
  displayName: "Linker",
  password: "a sufficiently long disposable password",
};

const signIn = async (server: RunningSuiteServer, setup: boolean) => {
  if (setup)
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
  return (
    path: string,
    method = "GET",
    body?: unknown,
    revision?: number,
    extra: Record<string, string> = {},
  ) =>
    fetch(`${server.baseUrl}${path}`, {
      method,
      headers: {
        Origin: server.baseUrl,
        Cookie: cookie,
        "X-CSRF-Token": csrfToken,
        ...(revision === undefined
          ? {}
          : { "If-Match": `"${String(revision)}"` }),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...extra,
      },
      ...(body === undefined
        ? {}
        : { body: typeof body === "string" ? body : JSON.stringify(body) }),
    });
};

const state = (entities: Record<string, unknown>) => ({
  ids: Object.keys(entities),
  entities,
});
const providerToken = "provider-token-must-not-be-stored";
const exported = JSON.stringify({
  task: state({
    linked: {
      id: "linked",
      title: "Fix the build",
      issueId: "17",
      issueProviderId: "gitea",
      issueType: "GITEA",
      issueWasUpdated: false,
      issueLastUpdated: 1700000000000,
      attachments: [
        {
          id: "a1",
          type: "LINK",
          title: "Logs",
          path: "https://ci.test/run/9",
        },
        { id: "a2", type: "FILE", title: "Trace", path: "/home/me/trace.txt" },
        { id: "a3", type: "COMMAND", title: "Rebuild", path: "make clean all" },
      ],
    },
    orphan: {
      id: "orphan",
      title: "Old calendar item",
      issueId: "uid-1",
      issueProviderId: "removed-calendar",
      issueType: "ICAL",
    },
  }),
  issueProvider: state({
    gitea: {
      id: "gitea",
      issueProviderKey: "GITEA",
      isEnabled: true,
      pluginId: "gitea-issue-provider",
      pluginConfig: {
        host: "https://git.test",
        repoFullname: "team/app",
        token: providerToken,
      },
    },
  }),
});

it("imports, shows and edits task links through the browser API with revisions and restart", async () => {
  await withTemporaryDirectory(async (directory) => {
    await mkdir(join(directory, "web"));
    const config = configuration(directory);
    let server = await startSuiteServer(config);
    try {
      let browser = await signIn(server, true);
      const preview = superProductivityPreviewSchema.parse(
        await (
          await browser(
            "/api/imports/super-productivity/preview",
            "POST",
            exported,
          )
        ).json(),
      );
      expect(preview.canApply).toBe(true);
      expect(preview.issues.map(({ code }) => code)).toContain(
        "issue_provider_missing",
      );
      const applied = await browser(
        "/api/imports/super-productivity/apply",
        "POST",
        exported,
        undefined,
        { "X-Import-Hash": preview.inputHash },
      );
      expect(applied.status).toBe(200);
      const tasks = taskListResponseSchema.parse(
        await (await browser("/api/tasks")).json(),
      ).tasks;
      const linked = tasks.find(({ title }) => title === "Fix the build");
      const orphan = tasks.find(({ title }) => title === "Old calendar item");
      if (linked === undefined || orphan === undefined)
        throw new Error("import");
      const read = async (taskId: string) => {
        const response = await browser(`/api/tasks/${taskId}/links`);
        expect(response.status).toBe(200);
        return taskLinksResponseSchema.parse(await response.json());
      };
      const links = await read(linked.id);
      expect(links.issueLink).toMatchObject({
        providerKey: "GITEA",
        providerRecorded: true,
        displayUrl: "https://git.test/team/app/issues/17",
        connection: "authorization_required",
      });
      expect(
        links.attachments.map(({ kind, available }) => [kind, available]),
      ).toEqual([
        ["link", true],
        ["file", false],
        ["command", false],
      ]);
      expect((await read(orphan.id)).issueLink).toMatchObject({
        providerKey: "ICAL",
        providerRecorded: false,
        displayUrl: null,
      });
      // Provider configuration is never stored anywhere in the database.
      const raw = new DatabaseSync(config.databasePath);
      const dump = JSON.stringify([
        raw.prepare("SELECT * FROM task_import_sources").all(),
        raw.prepare("SELECT * FROM task_issue_links").all(),
        raw.prepare("SELECT * FROM task_attachments").all(),
      ]);
      raw.close();
      expect(dump).not.toContain(providerToken);

      // Unsafe addresses are rejected; safe ones are created.
      for (const url of [
        "javascript:alert(1)",
        "https://user:pass@example.test",
      ])
        expect(
          (
            await browser(`/api/tasks/${linked.id}/attachments`, "POST", {
              kind: "link",
              url,
            })
          ).status,
        ).toBe(400);
      const created = taskLinksResponseSchema.parse(
        await (
          await browser(`/api/tasks/${linked.id}/attachments`, "POST", {
            kind: "link",
            title: "Design",
            url: "https://example.test/design",
          })
        ).json(),
      );
      const design = created.attachments.find(
        ({ title }) => title === "Design",
      );
      if (design === undefined) throw new Error("create");
      const path = `/api/tasks/${linked.id}/attachments/${design.id}`;
      expect((await browser(path, "PATCH", { title: "x" })).status).toBe(428);
      expect((await browser(path, "PATCH", { title: "x" }, 2)).status).toBe(
        412,
      );
      expect(
        (await browser(path, "PATCH", { text: "not a note" }, 1)).status,
      ).toBe(400);
      const patched = await browser(path, "PATCH", { title: "Design v2" }, 1);
      expect(patched.status).toBe(200);
      expect(patched.headers.get("etag")).toBe('"2"');
      // A record addressed through another task is not found.
      expect(
        (
          await browser(
            `/api/tasks/${orphan.id}/attachments/${design.id}`,
            "DELETE",
            undefined,
            2,
          )
        ).status,
      ).toBe(404);
      expect((await browser(path, "DELETE", undefined, 2)).status).toBe(204);
      const orphanLink = (await read(orphan.id)).issueLink;
      if (orphanLink === null) throw new Error("orphan link");
      expect(
        (
          await browser(
            `/api/tasks/${orphan.id}/issue-link/${orphanLink.id}`,
            "DELETE",
            undefined,
            1,
          )
        ).status,
      ).toBe(204);
      expect((await read(orphan.id)).issueLink).toBeNull();

      // Replay of the same export creates nothing new.
      const replay = await browser(
        "/api/imports/super-productivity/apply",
        "POST",
        exported,
        undefined,
        { "X-Import-Hash": preview.inputHash },
      );
      expect(await replay.json()).toEqual({ created: 0, existing: 2 });
      expect((await read(linked.id)).attachments).toHaveLength(3);
      expect((await read(orphan.id)).issueLink).toBeNull();

      await server.close();
      server = await startSuiteServer(config);
      browser = await signIn(server, false);
      const restarted = await read(linked.id);
      expect(restarted.issueLink?.issueId).toBe("17");
      expect(restarted.attachments).toHaveLength(3);
      expect((await browser(`/api/tasks/${randomUUID()}/links`)).status).toBe(
        404,
      );
    } finally {
      await server.close();
    }
  });
});

it("previews and confirms task link operations with scopes, stale guards and content-safe summaries", async () => {
  await withTemporaryDirectory(async (directory) => {
    await mkdir(join(directory, "web"));
    const config = configuration(directory);
    const server = await startSuiteServer(config);
    try {
      const browser = await signIn(server, true);
      const preview = superProductivityPreviewSchema.parse(
        await (
          await browser(
            "/api/imports/super-productivity/preview",
            "POST",
            exported,
          )
        ).json(),
      );
      await browser(
        "/api/imports/super-productivity/apply",
        "POST",
        exported,
        undefined,
        { "X-Import-Hash": preview.inputHash },
      );
      const task = taskListResponseSchema
        .parse(await (await browser("/api/tasks")).json())
        .tasks.find(({ title }) => title === "Fix the build");
      if (task === undefined) throw new Error("import");
      const issue = async (scopes: string[]) =>
        createAutomationTokenResponseSchema.parse(
          await (
            await browser("/api/automation/tokens", "POST", {
              label: "Linker",
              scopes,
              expiresAt: new Date(Date.now() + 3600000).toISOString(),
            })
          ).json(),
        ).token;
      const token = await issue(["task_links:read", "task_links:write"]);
      const tasksOnly = await issue(["tasks:read", "tasks:write"]);
      const automation = (
        path: string,
        method: "GET" | "POST",
        body?: unknown,
        credential = token,
      ) =>
        fetch(`${server.baseUrl}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${credential}`,
            ...(body === undefined
              ? {}
              : { "Content-Type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      const resource = `/api/automation/v1/resources/task-links?taskId=${task.id}`;
      expect(
        (await automation(resource, "GET", undefined, tasksOnly)).status,
      ).toBe(403);
      const links = taskLinksResponseSchema.parse(
        await (await automation(resource, "GET")).json(),
      );
      expect(links.attachments).toHaveLength(3);
      const previewOf = async (input: unknown, credential = token) =>
        automation(
          "/api/automation/v1/previews",
          "POST",
          { operation: "task_links.mutate", input },
          credential,
        );
      const attachmentId = randomUUID();
      const add = {
        action: "add_attachment",
        taskId: task.id,
        id: attachmentId,
        attachment: {
          kind: "link",
          title: "",
          url: "https://docs.test/private/path?token=abc123",
        },
      };
      expect((await previewOf(add, tasksOnly)).status).toBe(403);
      const created = await previewOf(add);
      expect(created.status).toBe(201);
      const addPreview = automationPreviewResponseSchema.parse(
        await created.json(),
      ).preview;
      expect(addPreview.summary).toContain("docs.test");
      expect(addPreview.summary).not.toContain("abc123");
      expect(addPreview.summary).not.toContain("/private/path");
      const confirm = (id: string, key = randomUUID()) =>
        automation(`/api/automation/v1/previews/${id}/confirm`, "POST", {
          idempotencyKey: key,
        });
      const key = randomUUID();
      const confirmed = automationConfirmationResponseSchema.parse(
        await (await confirm(addPreview.id, key)).json(),
      );
      expect(confirmed.result).toMatchObject({ taskId: task.id });
      // Idempotent replay of the confirmation.
      expect(
        automationConfirmationResponseSchema.parse(
          await (await confirm(addPreview.id, key)).json(),
        ).replayed,
      ).toBe(true);
      // Stale edits: a browser edit between preview and confirmation.
      const editPreview = automationPreviewResponseSchema.parse(
        await (
          await previewOf({
            action: "update_attachment",
            id: attachmentId,
            expectedRevision: 1,
            patch: { title: "Docs" },
          })
        ).json(),
      ).preview;
      await browser(
        `/api/tasks/${task.id}/attachments/${attachmentId}`,
        "PATCH",
        { title: "Browser edit" },
        1,
      );
      expect((await confirm(editPreview.id)).status).toBe(412);
      const issueLink = links.issueLink;
      if (issueLink === null) throw new Error("issue");
      const removePreview = automationPreviewResponseSchema.parse(
        await (
          await previewOf({
            action: "remove_issue_link",
            id: issueLink.id,
            expectedRevision: 1,
          })
        ).json(),
      ).preview;
      expect(removePreview.summary).toContain("GITEA");
      const removed = automationConfirmationResponseSchema.parse(
        await (await confirm(removePreview.id)).json(),
      );
      expect(removed.result).toMatchObject({ issueLink: null });
      // Audit rows never carry link addresses.
      const raw = new DatabaseSync(config.databasePath);
      const audit = JSON.stringify(
        raw.prepare("SELECT * FROM automation_audit_log").all(),
      );
      const summaries = JSON.stringify(
        raw.prepare("SELECT summary FROM automation_previews").all(),
      );
      raw.close();
      expect(audit).not.toContain("abc123");
      expect(audit).not.toContain("docs.test");
      expect(summaries).not.toContain("abc123");
    } finally {
      await server.close();
    }
  });
});
