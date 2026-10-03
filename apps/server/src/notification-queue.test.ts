import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { SuiteDatabase } from "@suite/persistence";
import { withTemporaryDirectory } from "@suite/test-support";
import { startSuiteServer } from "./server.ts";

it("delivers durable tests with reminders disabled, bounds retries, and never replays ambiguous sends", async () => {
  await withTemporaryDirectory(async (directory) => {
    const databasePath = join(directory, "suite.sqlite");
    const webRoot = join(directory, "web");
    const ntfyPublisherConfigPath = join(directory, "ntfy.json");
    await mkdir(webRoot);
    await writeFile(
      ntfyPublisherConfigPath,
      JSON.stringify({
        baseUrl: "http://ntfy",
        topic: "private",
        token: "private-test-token-for-disposable-test",
      }),
      { mode: 0o600 },
    );
    let now = new Date("2026-09-20T10:00:00.000Z");
    const db = SuiteDatabase.open(databasePath);
    db.createOwner({
      id: "owner",
      username: "owner",
      displayName: "Owner",
      passwordHash: "hash",
      createdAt: now.toISOString(),
    });
    const config = {
      host: "127.0.0.1",
      port: 0,
      databasePath,
      webRoot,
      baikalEndpoint: "http://baikal.test/dav.php/",
      credentialKeyPath: join(directory, "key"),
      ntfyPublisherConfigPath,
      secureCookies: false,
      build: { version: "test", revision: "test", builtAt: null },
    };
    const publisher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("ok"));
    const options = {
      disableNotificationTimer: true,
      notificationFetch: publisher,
      sessionClock: { now: () => now },
    };
    let server = await startSuiteServer(config, options);
    try {
      db.queueNotificationTest("owner", "successful", now.toISOString());
      expect(
        db.listDueNotificationTests("other-owner", now.toISOString()),
      ).toEqual([]);
      expect(() =>
        db.queueNotificationTest("owner", "successful", now.toISOString()),
      ).toThrow();
      await Promise.all([server.runNotifications(), server.runNotifications()]);
      expect(publisher).toHaveBeenCalledTimes(1);
      expect(db.getNotificationDelivery("successful")).toMatchObject({
        state: "delivered",
        attemptCount: 1,
      });
      expect(publisher.mock.calls[0]?.[1]?.body).toBe(
        "Test reminder from Tadooer. Nothing is due.",
      );
      db.queueNotificationTest("owner", "uncertain", now.toISOString());
      publisher.mockRejectedValueOnce(new Error("response lost"));
      await server.runNotifications();
      expect(db.getNotificationDelivery("uncertain")).toMatchObject({
        state: "failed",
      });
      db.queueNotificationTest("owner", "interrupted", now.toISOString());
      db.claimNotificationDelivery("interrupted", now.toISOString());
      await server.close();
      server = await startSuiteServer(config, options);
      await server.runNotifications();
      expect(publisher).toHaveBeenCalledTimes(2);
      expect(db.getNotificationDelivery("interrupted")).toMatchObject({
        state: "failed",
        errorCode: "DELIVERY_UNCERTAIN",
      });
      db.queueNotificationTest("owner", "retry", now.toISOString());
      publisher.mockResolvedValue(new Response("later", { status: 503 }));
      for (let attempt = 1; attempt <= 5; attempt++) {
        await server.runNotifications();
        expect(db.getNotificationDelivery("retry")).toMatchObject({
          attemptCount: attempt,
          state: attempt === 5 ? "failed" : "retry",
        });
        await server.runNotifications();
        expect(publisher).toHaveBeenCalledTimes(2 + attempt);
        now = new Date(now.getTime() + 31 * 60_000);
      }
      expect(db.getNotificationDelivery("retry")).toMatchObject({
        errorCode: "NTFY_RETRY_EXHAUSTED",
      });
    } finally {
      await server.close();
      db.close();
    }
  });
});
