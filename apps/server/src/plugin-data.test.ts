import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import {
  createAutomationTokenResponseSchema,
  pluginDataContentResponseSchema,
  pluginDataListResponseSchema,
  superProductivityPreviewSchema,
  taskImportApplyResponseSchema,
} from "@suite/contracts";
import { withTemporaryDirectory } from "@suite/test-support";
import type { ServerConfig } from "./config.ts";
import { startSuiteServer, type RunningSuiteServer } from "./server.ts";

// Imported plugin data over HTTP and the assistant (issue #66, ADR 0026).
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
  username: "plugins",
  displayName: "Plugins",
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
    body?: string,
    extra: Record<string, string> = {},
  ) =>
    fetch(`${server.baseUrl}${path}`, {
      method,
      headers: {
        Origin: server.baseUrl,
        Cookie: cookie,
        "X-CSRF-Token": csrfToken,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...extra,
      },
      ...(body === undefined ? {} : { body }),
    });
};

const secret = "SECRET-PLUGIN-CONTENT";
const odd = `\ud800 \u0000 <script>${secret}</script> \udfff`;
const task = { ids: ["t"], entities: { t: { id: "t", title: "Task" } } };
const exportWith = (data: string) =>
  JSON.stringify({
    task,
    pluginUserData: [
      { id: "brain-dump", data },
      { id: "doc-mode:doc:1", data: `GZ1:${secret}` },
    ],
    pluginMetadata: [
      { id: "brain-dump", isEnabled: true },
      { id: "sync-md", isEnabled: false },
    ],
  });

const printed: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  printed.length = 0;
});

it("imports, lists, downloads and deletes plugin data without leaking it", async () => {
  for (const method of ["log", "info", "warn", "error", "debug"] as const)
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      printed.push(args.map(String).join(" "));
    });
  await withTemporaryDirectory(async (directory) => {
    await mkdir(join(directory, "web"));
    const config = configuration(directory);
    let server = await startSuiteServer(config);
    try {
      let browser = await signIn(server, true);
      const exported = exportWith(odd);
      const apply = async (body: string) => {
        const preview = superProductivityPreviewSchema.parse(
          await (
            await browser(
              "/api/imports/super-productivity/preview",
              "POST",
              body,
            )
          ).json(),
        );
        return {
          preview,
          response: await browser(
            "/api/imports/super-productivity/apply",
            "POST",
            body,
            { "X-Import-Hash": preview.inputHash },
          ),
        };
      };
      const first = await apply(exported);
      expect(first.preview.canApply).toBe(true);
      expect(JSON.stringify(first.preview)).not.toContain(secret);
      expect(
        taskImportApplyResponseSchema.parse(await first.response.json())
          .pluginData,
      ).toEqual({ created: 4, existing: 0 });
      const replay = await apply(exported);
      expect(
        taskImportApplyResponseSchema.parse(await replay.response.json())
          .pluginData,
      ).toEqual({ created: 0, existing: 4 });

      const listResponse = await browser("/api/plugin-data");
      const listText = await listResponse.text();
      expect(listText).not.toContain(secret);
      const list = pluginDataListResponseSchema.parse(JSON.parse(listText));
      expect(
        list.entries.map(({ pluginId, key, format }) => [
          pluginId,
          key,
          format,
        ]),
      ).toEqual([
        ["brain-dump", null, "text"],
        ["doc-mode", "doc:1", "gzip_base64"],
      ]);
      expect(
        list.plugins.map(({ pluginId, enabled }) => [pluginId, enabled]),
      ).toEqual([
        ["brain-dump", true],
        ["sync-md", false],
      ]);
      const [entry, compressed] = list.entries;
      if (entry === undefined || compressed === undefined)
        throw new Error("entries");
      const content = pluginDataContentResponseSchema.parse(
        await (await browser(`/api/plugin-data/entries/${entry.id}`)).json(),
      );
      expect(content.data).toBe(odd);

      // A changed value blocks the whole import; the error names no data.
      const changed = await apply(exportWith(`${odd}!`));
      expect(changed.response.status).toBe(409);
      expect(await changed.response.text()).not.toContain(secret);

      // Deletes need a session, CSRF and the current revision.
      const path = `/api/plugin-data/entries/${entry.id}`;
      expect(
        (
          await fetch(`${server.baseUrl}${path}`, {
            method: "DELETE",
            headers: { Origin: server.baseUrl, "If-Match": '"1"' },
          })
        ).status,
      ).toBe(401);
      expect((await browser(path, "DELETE")).status).toBe(428);
      expect(
        (await browser(path, "DELETE", undefined, { "If-Match": '"2"' }))
          .status,
      ).toBe(412);
      expect(
        (await browser(path, "DELETE", undefined, { "If-Match": '"1"' }))
          .status,
      ).toBe(204);
      expect((await browser(path)).status).toBe(404);
      const plugin = list.plugins[1];
      expect(
        (
          await browser(
            `/api/plugin-data/plugins/${plugin?.id ?? ""}`,
            "DELETE",
            undefined,
            { "If-Match": '"1"' },
          )
        ).status,
      ).toBe(204);

      // The assistant lists names and sizes with its own scope only.
      const issue = async (scopes: string[]) =>
        createAutomationTokenResponseSchema.parse(
          await (
            await browser(
              "/api/automation/tokens",
              "POST",
              JSON.stringify({
                label: "Plugins",
                scopes,
                expiresAt: new Date(Date.now() + 3600000).toISOString(),
              }),
            )
          ).json(),
        ).token;
      const read = await issue(["plugin_data:read"]);
      const tasksOnly = await issue(["tasks:read"]);
      const automation = (credential: string) =>
        fetch(`${server.baseUrl}/api/automation/v1/resources/plugin-data`, {
          headers: { Authorization: `Bearer ${credential}` },
        });
      expect((await automation(tasksOnly)).status).toBe(403);
      const assistantText = await (await automation(read)).text();
      expect(assistantText).not.toContain(secret);
      expect(
        pluginDataListResponseSchema.parse(JSON.parse(assistantText)),
      ).toMatchObject({
        entries: [{ id: compressed.id, pluginId: "doc-mode" }],
        plugins: [{ pluginId: "brain-dump", enabled: true }],
      });

      // Restart keeps the records; the second entry still downloads.
      await server.close();
      server = await startSuiteServer(config);
      browser = await signIn(server, false);
      const restarted = pluginDataListResponseSchema.parse(
        await (await browser("/api/plugin-data")).json(),
      );
      expect(restarted.entries.map(({ id }) => id)).toEqual([compressed.id]);
      expect(
        pluginDataContentResponseSchema.parse(
          await (
            await browser(`/api/plugin-data/entries/${compressed.id}`)
          ).json(),
        ).data,
      ).toBe(`GZ1:${secret}`);

      const raw = new DatabaseSync(config.databasePath);
      const audit = JSON.stringify(
        raw.prepare("SELECT * FROM automation_audit_log").all(),
      );
      const provenance = JSON.stringify(
        raw.prepare("SELECT * FROM task_import_sources").all(),
      );
      raw.close();
      expect(audit).toContain("plugin_data.list");
      expect(audit).not.toContain(secret);
      expect(provenance).not.toContain(secret);
    } finally {
      await server.close();
    }
  });
  expect(printed.join("\n")).not.toContain(secret);
});

it("blocks a malformed plugin section with content-safe findings", async () => {
  await withTemporaryDirectory(async (directory) => {
    await mkdir(join(directory, "web"));
    const server = await startSuiteServer(configuration(directory));
    try {
      const browser = await signIn(server, true);
      const body = JSON.stringify({
        task,
        pluginUserData: [{ id: "p", data: { nested: secret } }, secret],
      });
      const response = await browser(
        "/api/imports/super-productivity/preview",
        "POST",
        body,
      );
      const text = await response.text();
      expect(text).not.toContain(secret);
      const preview = superProductivityPreviewSchema.parse(JSON.parse(text));
      expect(preview.canApply).toBe(false);
      expect(
        preview.issues.filter(({ code }) => code === "plugin_data_invalid"),
      ).toHaveLength(2);
      expect((await browser("/api/plugin-data")).status).toBe(200);
      expect((await fetch(`${server.baseUrl}/api/plugin-data`)).status).toBe(
        401,
      );
    } finally {
      await server.close();
    }
  });
});
