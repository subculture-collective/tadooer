import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  applicationPreferenceSnapshotSchema,
  automationConfirmationResponseSchema,
  automationPreviewResponseSchema,
  automationTokenScopeSchema,
  createAutomationTokenResponseSchema,
  defaultApplicationPreferences,
  superProductivityPreviewSchema,
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

const marker = "CREDENTIAL-MARKER-2b9c";
const store = (entities: Record<string, unknown>) => ({
  ids: Object.keys(entities),
  entities,
});

// Application preferences (#67, ADR 0030): browser and assistant writes share
// one revision; imports apply once; credentials never reach the database.
it("revisions application preferences across browser, assistant and import paths", async () => {
  await withTemporaryDirectory(async (directory) => {
    await mkdir(join(directory, "web"));
    const config = configuration(directory);
    let server: RunningSuiteServer = await startSuiteServer(config);
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
      const browser = (
        path: string,
        method: "GET" | "PUT" | "POST",
        body?: unknown,
        headers: Record<string, string> = {},
      ) =>
        fetch(`${server.baseUrl}${path}`, {
          method,
          headers: {
            Origin: server.baseUrl,
            Cookie: cookie,
            "X-CSRF-Token": csrfToken,
            ...(body === undefined
              ? {}
              : { "Content-Type": "application/json" }),
            ...headers,
          },
          ...(body === undefined
            ? {}
            : { body: typeof body === "string" ? body : JSON.stringify(body) }),
        });
      const read = async () =>
        applicationPreferenceSnapshotSchema.parse(
          await (await browser("/api/application/preferences", "GET")).json(),
        );
      expect(await read()).toEqual({
        revision: 0,
        preferences: defaultApplicationPreferences,
      });

      // Browser writes: invalid, conflicting and applied.
      const desired = {
        ...defaultApplicationPreferences,
        theme: "light" as const,
        confirmBeforeDelete: false,
        shortcuts: { "sync.now": "Ctrl+Shift+S" },
      };
      expect(
        (
          await browser("/api/application/preferences", "PUT", {
            expectedRevision: 0,
            preferences: { ...desired, shortcuts: { "sync.now": "D" } },
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await browser("/api/application/preferences", "PUT", {
            expectedRevision: 0,
            preferences: { ...desired, defaultProjectId: randomUUID() },
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await browser("/api/application/preferences", "PUT", {
            expectedRevision: 1,
            preferences: desired,
          })
        ).status,
      ).toBe(412);
      const saved = await browser("/api/application/preferences", "PUT", {
        expectedRevision: 0,
        preferences: desired,
      });
      expect(saved.status).toBe(200);
      expect(await read()).toEqual({ revision: 1, preferences: desired });
      expect(
        (
          await fetch(`${server.baseUrl}/api/application/preferences`, {
            method: "PUT",
            headers: { Cookie: cookie, "Content-Type": "application/json" },
            body: JSON.stringify({ expectedRevision: 1, preferences: desired }),
          })
        ).status,
      ).toBe(403);

      // Assistant: resource, preview, stale confirmation, replay.
      const issue = async (scopes: string[]) =>
        createAutomationTokenResponseSchema.parse(
          await (
            await browser("/api/automation/tokens", "POST", {
              label: "Organizer",
              scopes,
              expiresAt: new Date(Date.now() + 3600000).toISOString(),
            })
          ).json(),
        ).token;
      const token = await issue([...automationTokenScopeSchema.options]);
      const readOnly = await issue(["tasks:read"]);
      const automation = (
        path: string,
        method: "GET" | "POST",
        credential = token,
        body?: unknown,
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
      expect(
        (
          await automation(
            "/api/automation/v1/resources/application-preferences",
            "GET",
            readOnly,
          )
        ).status,
      ).toBe(403);
      const resource = await automation(
        "/api/automation/v1/resources/application-preferences",
        "GET",
      );
      expect(resource.status).toBe(200);
      expect(
        applicationPreferenceSnapshotSchema.parse(await resource.json()),
      ).toEqual({
        revision: 1,
        preferences: desired,
      });
      const previewRequest = (input: unknown, credential = token) =>
        automation("/api/automation/v1/previews", "POST", credential, {
          operation: "application.update_preferences",
          input,
        });
      const next = {
        ...desired,
        theme: "system" as const,
        autoMarkParentDone: true,
      };
      expect(
        (
          await previewRequest(
            { expectedRevision: 1, preferences: next },
            readOnly,
          )
        ).status,
      ).toBe(403);
      expect(
        (await previewRequest({ expectedRevision: 0, preferences: next }))
          .status,
      ).toBe(412);
      expect(
        (
          await previewRequest({
            expectedRevision: 1,
            preferences: { ...next, theme: "sepia" },
          })
        ).status,
      ).toBe(400);
      const previewed = await previewRequest({
        expectedRevision: 1,
        preferences: next,
      });
      expect(previewed.status).toBe(201);
      const preview = automationPreviewResponseSchema.parse(
        await previewed.json(),
      ).preview;
      expect(preview.summary).toContain("theme, autoMarkParentDone");
      expect(preview.baseRevisions).toEqual([
        {
          entityKind: "application_preferences",
          entityId: expect.any(String) as string,
          revision: 1,
        },
      ]);
      const stale = automationPreviewResponseSchema.parse(
        await (
          await previewRequest({ expectedRevision: 1, preferences: next })
        ).json(),
      ).preview;
      // A browser save between preview and confirmation makes it stale.
      expect(
        (
          await browser("/api/application/preferences", "PUT", {
            expectedRevision: 1,
            preferences: { ...desired, dailySummaryNote: "Ship it" },
          })
        ).status,
      ).toBe(200);
      const confirm = (id: string, key = randomUUID()) =>
        automation(`/api/automation/v1/previews/${id}/confirm`, "POST", token, {
          idempotencyKey: key,
        });
      const rejected = await confirm(stale.id);
      expect(rejected.status).toBe(412);
      expect(await rejected.json()).toMatchObject({
        code: "AUTOMATION_PREVIEW_STALE",
      });
      expect((await read()).revision).toBe(2);
      const fresh = automationPreviewResponseSchema.parse(
        await (
          await previewRequest({ expectedRevision: 2, preferences: next })
        ).json(),
      ).preview;
      const key = randomUUID();
      const confirmed = automationConfirmationResponseSchema.parse(
        await (await confirm(fresh.id, key)).json(),
      );
      expect(confirmed.result).toEqual({
        applicationPreferences: { revision: 3, preferences: next },
      });
      expect((await confirm(preview.id)).status).toBe(412);
      await server.close();
      server = await startSuiteServer(config);
      expect(
        automationConfirmationResponseSchema.parse(
          await (await confirm(fresh.id, key)).json(),
        ),
      ).toEqual({ ...confirmed, replayed: true });
      expect(await read()).toEqual({ revision: 3, preferences: next });

      // Import: saved preferences are kept; the export's credentials are
      // reported by count and never stored.
      const raw = JSON.stringify({
        task: store({ t: { id: "t", title: "Task" } }),
        project: store({ p: { id: "p", title: "Project" } }),
        tag: store({}),
        globalConfig: {
          tasks: { isConfirmBeforeDelete: true, defaultProjectId: "p" },
          sync: {
            webDav: { password: marker },
            superSync: { accessToken: marker },
          },
          misc: { unsplashApiKey: marker, startOfNextDayTime: "04:00" },
          keyboard: { triggerSync: "Ctrl+S" },
        },
      });
      const previewImport = await browser(
        "/api/imports/super-productivity/preview",
        "POST",
        raw,
      );
      expect(previewImport.status).toBe(200);
      const report = superProductivityPreviewSchema.parse(
        await previewImport.json(),
      );
      expect(report.canApply).toBe(true);
      expect(JSON.stringify(report)).not.toContain(marker);
      expect(report.issues.map(({ code }) => code)).toEqual(
        expect.arrayContaining([
          "config_field_excluded",
          "config_applied",
          "day_order_notice",
        ]),
      );
      const applied = await browser(
        "/api/imports/super-productivity/apply",
        "POST",
        raw,
        {
          "X-Import-Hash": report.inputHash,
        },
      );
      expect(applied.status).toBe(200);
      expect(await applied.json()).toMatchObject({
        created: 2,
        applicationPreferences: 1,
      });
      // Application preferences were saved (revision 3), so only the
      // planning day start (never saved) applied.
      expect(await read()).toEqual({ revision: 3, preferences: next });
      const planning = (await (
        await browser("/api/planning/preferences", "GET")
      ).json()) as {
        dayStartsAt?: string;
      };
      expect(planning.dayStartsAt).toBe("04:00");
      await server.close();
      const checkpoint = new DatabaseSync(config.databasePath);
      checkpoint.exec("PRAGMA wal_checkpoint(TRUNCATE);");
      checkpoint.close();
      const bytes = readFileSync(config.databasePath, "latin1");
      expect(bytes).toContain('"theme":"system"');
      expect(bytes).not.toContain(marker);
      server = await startSuiteServer(config);
    } finally {
      await server.close();
    }
  });
});
