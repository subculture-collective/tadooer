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

it("confirms revisioned preferences atomically and rejects browser ABA changes without replaying settings", async () => {
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
      for (const kind of ["planning", "notifications"] as const) {
        const operation = `${kind}.update_preferences`;
        const resource =
          kind === "planning"
            ? "planning-preferences"
            : "notification-preferences";
        const read = async () => {
          const response = await automationRequest(
            server,
            token,
            `/api/automation/v1/resources/${resource}`,
            "GET",
          );
          expect(response.status).toBe(200);
          return (await response.json()) as Record<string, unknown>;
        };
        const original = await read();
        const { revision, ...preferences } = original;
        expect(revision).toBe(0);
        const desired =
          kind === "planning"
            ? { ...preferences, timeZone: "UTC" }
            : { ...preferences, enabled: true };
        const input = { expectedRevision: 0, preferences: desired };
        expect((await previewRequest(operation, input, readOnly)).status).toBe(
          403,
        );
        if (kind === "planning") {
          for (const invalid of [
            { ...desired, timeZone: "Invalid/Zone" },
            { ...desired, workdayEnd: "01:00" },
            { ...desired, breakStart: "23:00" },
          ])
            expect(
              (
                await previewRequest(operation, {
                  ...input,
                  preferences: invalid,
                })
              ).status,
            ).toBe(400);
        }
        const p = await preview(operation, input);
        const stale = await preview(operation, input);
        expect(p.baseRevisions).toHaveLength(1);
        expect(p.baseRevisions[0]?.revision).toBe(0);
        expect(await read()).toEqual(original);
        const raw = new DatabaseSync(config.databasePath);
        raw.exec(
          "CREATE TRIGGER fail_preferences_receipt BEFORE INSERT ON automation_audit_log WHEN NEW.phase='execute' BEGIN SELECT RAISE(ABORT,'injected preferences receipt failure'); END;",
        );
        expect((await confirm(p.id)).status).toBe(500);
        expect(await read()).toEqual(original);
        expect(
          raw
            .prepare("SELECT consumed_at FROM automation_previews WHERE id=?")
            .get(p.id),
        ).toMatchObject({ consumed_at: null });
        raw.exec("DROP TRIGGER fail_preferences_receipt;");
        raw.close();
        const key = randomUUID();
        const confirmed = automationConfirmationResponseSchema.parse(
          await (await confirm(p.id, key)).json(),
        );
        expect(await read()).toEqual({ ...desired, revision: 1 });
        expect((await confirm(stale.id)).status).toBe(412);
        const aba = await preview(operation, {
          expectedRevision: 1,
          preferences,
        });
        const browserPut = async (value: unknown) =>
          fetch(
            `${server.baseUrl}/api/${kind === "planning" ? "planning" : "notifications"}/preferences`,
            {
              method: "PUT",
              headers: {
                Origin: server.baseUrl,
                Cookie: cookie,
                "X-CSRF-Token": csrfToken,
                "Content-Type": "application/json",
              },
              body: JSON.stringify(value),
            },
          );
        expect((await browserPut(preferences)).status).toBe(200);
        expect((await browserPut(desired)).status).toBe(200);
        expect(await read()).toEqual({ ...desired, revision: 3 });
        expect((await confirm(aba.id)).status).toBe(412);
        await server.close();
        server = await startSuiteServer(config);
        expect(
          automationConfirmationResponseSchema.parse(
            await (await confirm(p.id, key)).json(),
          ),
        ).toEqual({ ...confirmed, replayed: true });
        expect(await read()).toEqual({ ...desired, revision: 3 });
        await apply(operation, { expectedRevision: 3, preferences });
        expect(await read()).toEqual({ ...preferences, revision: 4 });
      }
    } finally {
      await server.close();
    }
  });
});
