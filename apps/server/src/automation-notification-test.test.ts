import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
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

it("queues test delivery atomically and gates scopes, stale revisions and replay without sending inline", async () => {
  await withTemporaryDirectory(async (directory) => {
    await mkdir(join(directory, "web"));
    const ntfyPublisherConfigPath = join(directory, "ntfy.json");
    await writeFile(
      ntfyPublisherConfigPath,
      JSON.stringify({
        baseUrl: "http://ntfy",
        topic: "private",
        token: "private-disposable-publisher-token",
      }),
      { mode: 0o600 },
    );
    const config = { ...configuration(directory), ntfyPublisherConfigPath };
    const publisher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("ok"));
    const options = {
      notificationFetch: publisher,
      disableNotificationTimer: true,
    };
    let server = await startSuiteServer(config, options);
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
                label: "Tests",
                scopes,
                expiresAt: new Date(Date.now() + 3600000).toISOString(),
              },
            )
          ).json(),
        );
      const token = await issue([...automationTokenScopeSchema.options]);
      const readOnly = await issue([
        "notifications:read",
        "notifications:write",
      ]);
      const preview = (revision = 0, credential = token.token) =>
        automationRequest(
          server,
          credential,
          "/api/automation/v1/previews",
          "POST",
          {
            operation: "notifications.send_test",
            input: { expectedRevision: revision },
          },
        );
      const confirm = (id: string, key = randomUUID()) =>
        automationRequest(
          server,
          token.token,
          `/api/automation/v1/previews/${id}/confirm`,
          "POST",
          { idempotencyKey: key },
        );
      expect((await preview(0, readOnly.token)).status).toBe(403);
      expect((await preview(42)).status).toBe(412);
      const p = automationPreviewResponseSchema.parse(
        await (await preview()).json(),
      ).preview;
      const stale = automationPreviewResponseSchema.parse(
        await (await preview()).json(),
      ).preview;
      expect(p.summary).toContain("does not prove delivery");
      const raw = new DatabaseSync(config.databasePath);
      try {
        const count = () =>
          Number(
            raw
              .prepare("SELECT count(*) AS n FROM notification_deliveries")
              .get()?.n,
          );
        expect(count()).toBe(0);
        raw.exec(
          "CREATE TRIGGER fail_test_audit BEFORE INSERT ON automation_audit_log WHEN NEW.phase='execute' BEGIN SELECT RAISE(ABORT,'injected receipt failure'); END;",
        );
        expect((await confirm(p.id)).status).toBe(500);
        expect(count()).toBe(0);
        expect(
          raw
            .prepare("SELECT consumed_at FROM automation_previews WHERE id=?")
            .get(p.id),
        ).toMatchObject({ consumed_at: null });
        raw.exec("DROP TRIGGER fail_test_audit;");
        const key = randomUUID();
        const response = await confirm(p.id, key);
        expect(response.status).toBe(200);
        const receipt = automationConfirmationResponseSchema.parse(
          await response.json(),
        );
        expect(receipt.result).toEqual({
          notificationTest: { deliveryId: p.id, state: "pending" },
        });
        const deliveryRead = (id: string, credential = readOnly.token) =>
          automationRequest(
            server,
            credential,
            `/api/automation/v1/resources/notification-delivery?deliveryId=${encodeURIComponent(id)}`,
            "GET",
          );
        expect((await deliveryRead(randomUUID())).status).toBe(404);
        expect((await deliveryRead("")).status).toBe(400);
        const noRead = await issue(["notifications:test"]);
        expect((await deliveryRead(p.id, noRead.token)).status).toBe(403);
        const pending: unknown = await (await deliveryRead(p.id)).json();
        expect(pending).toMatchObject({
          delivery: {
            id: p.id,
            kind: "test",
            state: "pending",
            attemptCount: 0,
            deliveredAt: null,
            errorCode: null,
          },
        });
        expect(count()).toBe(1);
        expect(publisher).not.toHaveBeenCalled();
        await server.runNotifications();
        expect(publisher).toHaveBeenCalledTimes(1);
        expect(await (await deliveryRead(p.id)).json()).toMatchObject({
          delivery: {
            state: "delivered",
            attemptCount: 1,
          },
        });
        // Owner isolation even if a valid delivery ID is known.
        raw.exec("PRAGMA foreign_keys=OFF");
        raw
          .prepare(
            "UPDATE notification_deliveries SET owner_id='other-owner' WHERE id=?",
          )
          .run(p.id);
        expect((await deliveryRead(p.id)).status).toBe(404);
        raw
          .prepare("UPDATE notification_deliveries SET owner_id=? WHERE id=?")
          .run(token.record.ownerId, p.id);
        raw.exec("PRAGMA foreign_keys=ON");
        await server.close();
        server = await startSuiteServer(config, options);
        expect(await (await confirm(p.id, key)).json()).toEqual({
          ...receipt,
          replayed: true,
        });
        await server.runNotifications();
        expect(count()).toBe(1);
        expect(publisher).toHaveBeenCalledTimes(1);
        const preferences = {
          enabled: false,
          leadReminderEnabled: true,
          atStartReminderEnabled: true,
          detailedContentEnabled: false,
        };
        expect(
          (
            await browserRequest(
              server,
              cookie,
              csrfToken,
              "/api/notifications/preferences",
              "PUT",
              preferences,
            )
          ).status,
        ).toBe(200);
        expect((await confirm(stale.id)).status).toBe(412);
        const revoked = automationPreviewResponseSchema.parse(
          await (await preview(1)).json(),
        ).preview;
        expect(
          (
            await browserRequest(
              server,
              cookie,
              csrfToken,
              `/api/automation/tokens/${token.record.id}`,
              "DELETE",
            )
          ).status,
        ).toBe(204);
        expect((await confirm(revoked.id)).status).toBe(401);
        expect(count()).toBe(1);
      } finally {
        raw.close();
      }
    } finally {
      await server.close();
    }
  });
});
