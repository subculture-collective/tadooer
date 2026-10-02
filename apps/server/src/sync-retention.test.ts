import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clientRegistrationResponseSchema,
  syncRoundResponseSchema,
  syncSnapshotResponseSchema,
  type SyncRoundResponse,
  type SyncSnapshotResponse,
} from "@suite/contracts";
import { SuiteDatabase } from "@suite/persistence";
import { withTemporaryDirectory } from "@suite/test-support";
import type { ServerConfig } from "./config.ts";
import { startSuiteServer, type RunningSuiteServer } from "./server.ts";
import { createSyncFeedPruner, syncFeedMetricLines } from "./sync-retention.ts";

// Feed maintenance over HTTP (issue #113, ADR 0045).
const hash = "a".repeat(43);
const uuid = (n: number): string =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const dayMs = 86_400_000;

const configuration = (directory: string): ServerConfig => ({
  host: "127.0.0.1",
  port: 0,
  databasePath: join(directory, "suite.sqlite"),
  webRoot: join(directory, "web"),
  baikalEndpoint: "http://baikal.test/dav.php/",
  credentialKeyPath: join(directory, "credential.key"),
  secureCookies: false,
  syncRetentionDays: 30,
  build: { version: "test", revision: "test", builtAt: null },
});

interface Harness {
  readonly cookie: string;
  readonly csrf: string;
}

const signIn = async (
  server: RunningSuiteServer,
  setup: boolean,
): Promise<Harness> => {
  const headers = {
    "Content-Type": "application/json",
    Origin: server.baseUrl,
  };
  const credentials = {
    username: "owner",
    password: "correct horse battery staple",
  };
  if (setup)
    expect(
      (
        await fetch(`${server.baseUrl}/api/setup`, {
          method: "POST",
          headers,
          body: JSON.stringify({ ...credentials, displayName: "Owner" }),
        })
      ).status,
    ).toBe(201);
  const login = await fetch(`${server.baseUrl}/api/auth/login`, {
    method: "POST",
    headers,
    body: JSON.stringify(credentials),
  });
  expect(login.status).toBe(200);
  return {
    cookie: login.headers.get("set-cookie")?.split(";", 1)[0] ?? "",
    csrf: ((await login.json()) as { csrfToken: string }).csrfToken,
  };
};

const post = (
  server: RunningSuiteServer,
  { cookie, csrf }: Harness,
  path: string,
  body: unknown,
  extra: Record<string, string> = {},
): Promise<Response> =>
  fetch(`${server.baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: server.baseUrl,
      Cookie: cookie,
      "X-CSRF-Token": csrf,
      ...extra,
    },
    body: JSON.stringify(body),
  });

/** What a client does after SYNC_CURSOR_EXPIRED: read every snapshot page. */
const readSnapshot = async (
  server: RunningSuiteServer,
  cookie: string,
  proof: Record<string, string>,
): Promise<{
  readonly snapshots: SyncSnapshotResponse["snapshots"];
  readonly cursor: string;
  readonly pages: number;
}> => {
  const snapshots: SyncSnapshotResponse["snapshots"][number][] = [];
  let cursor: string | undefined;
  let pages = 0;
  for (;;) {
    const response = await fetch(
      `${server.baseUrl}/api/sync/snapshot?offset=${String(snapshots.length)}`,
      { headers: { Cookie: cookie, ...proof } },
    );
    expect(response.status).toBe(200);
    const page = syncSnapshotResponseSchema.parse(await response.json());
    cursor ??= page.nextCursor;
    expect(page.nextCursor).toBe(cursor);
    snapshots.push(...page.snapshots);
    pages += 1;
    if (!page.hasMore) return { snapshots, cursor, pages };
    expect(page.snapshots).toHaveLength(200);
  }
};

describe("sync feed retention over HTTP", () => {
  it("expires a pruned cursor and lets the client recover by snapshot, then round", async () => {
    await withTemporaryDirectory(async (directory) => {
      await mkdir(join(directory, "web"));
      await writeFile(join(directory, "web", "index.html"), "<h1>Suite</h1>");
      const config = configuration(directory);
      let server = await startSuiteServer(config, {
        disableNotificationTimer: true,
        disableCalendarBridgeTimer: true,
      });
      try {
        let harness = await signIn(server, true);
        const registration = clientRegistrationResponseSchema.parse(
          await (
            await post(server, harness, "/api/clients", { label: "Laptop" })
          ).json(),
        );
        const proof = {
          "X-Suite-Client-Id": registration.client.id,
          "X-Suite-Client-Credential": registration.clientCredential,
          "X-Suite-Sync-Version": "2",
        };
        const round = (
          cursor: string | null,
          operations: readonly unknown[] = [],
          pullLimit = 100,
        ) =>
          post(
            server,
            harness,
            "/api/sync/round",
            { cursor, operations, pullLimit },
            proof,
          );
        // The device was registered at the start of the feed and then stayed
        // offline with one queued task.
        const staleCursor = registration.initialCursor;
        const epoch = staleCursor.slice(0, staleCursor.lastIndexOf("."));
        expect(staleCursor).toBe(`${epoch}.0`);
        const queued = {
          kind: "task.create",
          operationId: uuid(900_001),
          clientSequence: 1,
          createdAt: new Date().toISOString(),
          requestHash: hash,
          task: {
            id: uuid(900_000),
            title: "Written offline",
            notes: "",
            estimateMinutes: null,
          },
        };

        // Meanwhile 1005 tasks were created 60 days ago, outside the
        // 30-day window.
        const seeded = 1005;
        const old = new Date(Date.now() - 60 * dayMs).toISOString();
        const direct = SuiteDatabase.open(config.databasePath);
        const ownerId = direct.getActiveOwnerId() ?? "";
        for (let index = 1; index <= seeded; index += 1)
          direct.createTaskIdempotently(ownerId, uuid(index), uuid(index), {
            id: uuid(index),
            title: `Task ${String(index)}`,
            notes: "",
            status: "open",
            revision: 1,
            createdAt: old,
            updatedAt: old,
          });
        const head = direct.getSyncState(ownerId).cursor;
        expect(head).toBeGreaterThanOrEqual(seeded);
        const floor = head - 1000;

        // Before the tick prunes, the stale cursor is still served.
        const before = await round(staleCursor);
        expect(before.status).toBe(200);
        expect(
          syncRoundResponseSchema.parse(await before.json()),
        ).toMatchObject({ hasMore: true });

        const info = vi
          .spyOn(console, "info")
          .mockImplementation(() => undefined);
        await server.runNotifications();
        expect(direct.getSyncRetention(ownerId).floor).toBe(floor);
        expect(direct.listSyncChanges(ownerId, epoch, 0)).toHaveLength(1000);
        // A count-only log line.
        expect(
          info.mock.calls.filter(([name]) => name === "sync.feed.pruned"),
        ).toEqual([["sync.feed.pruned", { deleted: floor }]]);
        // A second tick inside the hour does not prune again.
        await server.runNotifications();
        expect(
          info.mock.calls.filter(([name]) => name === "sync.feed.pruned"),
        ).toHaveLength(1);
        info.mockRestore();
        direct.close();

        const metrics = await (
          await fetch(`${server.baseUrl}/api/metrics`)
        ).text();
        expect(metrics).toContain(
          `suite_sync_feed_pruned_changes ${String(floor)}`,
        );
        expect(metrics).toMatch(
          /^suite_sync_feed_oldest_change_age_seconds 51[0-9]{5}$/m,
        );

        // Below the floor: expired, and the queued operation is not applied.
        for (const cursor of [staleCursor, `${epoch}.${String(floor - 1)}`]) {
          const expired = await round(cursor, [queued]);
          expect(expired.status).toBe(409);
          expect(await expired.json()).toMatchObject({
            code: "SYNC_CURSOR_EXPIRED",
            action: "replace_cache_from_snapshot",
          });
        }
        // A round without a cursor asks for the feed from its start, which
        // is no longer retained.
        expect((await round(null)).status).toBe(409);

        // Recovery: replace the cache from a snapshot, then run a round
        // from the snapshot cursor with the queued operation.
        const snapshot = await readSnapshot(server, harness.cookie, proof);
        expect(snapshot.cursor).toBe(`${epoch}.${String(head)}`);
        expect(snapshot.pages).toBe(Math.ceil(seeded / 200));
        const snapshotTaskIds = snapshot.snapshots.flatMap((entry) =>
          entry.entityKind === "task" ? [entry.value.task.id] : [],
        );
        expect(snapshotTaskIds).toHaveLength(seeded);
        expect(new Set(snapshotTaskIds).size).toBe(seeded);
        expect(snapshotTaskIds).not.toContain(queued.task.id);
        expect(
          snapshot.snapshots.find(
            (entry) =>
              entry.entityKind === "task" && entry.value.task.id === uuid(1),
          ),
        ).toMatchObject({
          value: { task: { title: "Task 1" }, fieldVersions: { title: 1 } },
        });

        const recovered = await round(snapshot.cursor, [queued]);
        expect(recovered.status).toBe(200);
        const recoveredBody = syncRoundResponseSchema.parse(
          await recovered.json(),
        );
        expect(recoveredBody.outcomes).toMatchObject([
          { kind: "applied", entityId: queued.task.id },
        ]);
        expect(recoveredBody.hasMore).toBe(false);
        expect(recoveredBody.changes.map(({ entityId }) => entityId)).toContain(
          queued.task.id,
        );
        const settled = syncRoundResponseSchema.parse(
          await (await round(recoveredBody.nextCursor)).json(),
        );
        expect(settled).toMatchObject({ changes: [], hasMore: false });
        expect(settled.nextCursor).toBe(recoveredBody.nextCursor);
        // The queued operation is replay-safe after recovery.
        expect(
          syncRoundResponseSchema.parse(
            await (await round(recoveredBody.nextCursor, [queued])).json(),
          ).outcomes,
        ).toMatchObject([{ kind: "replayed" }]);

        // A cursor exactly at the floor is served to the end of the feed.
        const walked: SyncRoundResponse["changes"][number][] = [];
        let cursor = `${epoch}.${String(floor)}`;
        for (;;) {
          const response = await round(cursor, [], 100);
          expect(response.status).toBe(200);
          const page = syncRoundResponseSchema.parse(await response.json());
          walked.push(...page.changes);
          cursor = page.nextCursor;
          expect(page.hasMore).toBe(page.changes.length === 100);
          if (!page.hasMore) break;
        }
        expect(cursor).toBe(recoveredBody.nextCursor);
        expect(walked.map(({ sequence }) => sequence)).toEqual(
          Array.from(
            { length: walked.length },
            (_, index) => floor + 1 + index,
          ),
        );
        expect(walked.length).toBeGreaterThan(1000);

        // The floor survives a restart.
        await server.close();
        server = await startSuiteServer(config, {
          disableNotificationTimer: true,
          disableCalendarBridgeTimer: true,
        });
        harness = await signIn(server, false);
        expect((await round(staleCursor)).status).toBe(409);
        expect((await round(`${epoch}.${String(floor)}`)).status).toBe(200);
      } finally {
        await server.close();
      }
    });
  }, 60_000);

  it("leaves the feed alone when retention is switched off", async () => {
    await withTemporaryDirectory(async (directory) => {
      await mkdir(join(directory, "web"));
      await writeFile(join(directory, "web", "index.html"), "<h1>Suite</h1>");
      const config = { ...configuration(directory), syncRetentionDays: 0 };
      const server = await startSuiteServer(config, {
        disableNotificationTimer: true,
        disableCalendarBridgeTimer: true,
      });
      try {
        await signIn(server, true);
        const direct = SuiteDatabase.open(config.databasePath);
        const ownerId = direct.getActiveOwnerId() ?? "";
        const old = new Date(Date.now() - 400 * dayMs).toISOString();
        for (let index = 1; index <= 1010; index += 1)
          direct.appendSyncChange(
            ownerId,
            "task",
            uuid(index),
            "upsert",
            1,
            old,
          );
        await server.runNotifications();
        expect(direct.getSyncRetention(ownerId).floor).toBe(0);
        expect(
          direct.listSyncChanges(
            ownerId,
            direct.getSyncState(ownerId).epoch,
            0,
          ),
        ).toHaveLength(1010);
        direct.close();
      } finally {
        await server.close();
      }
    });
  }, 60_000);
});

describe("sync feed pruner", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const fake = (deleted: number | Error) => {
    const calls: { ownerId: string; olderThan: string; now: string }[] = [];
    return {
      calls,
      database: {
        pruneSyncChanges: (ownerId: string, olderThan: string, now: string) => {
          calls.push({ ownerId, olderThan, now });
          if (deleted instanceof Error) throw deleted;
          return { deleted, floor: deleted };
        },
      },
    };
  };

  it("prunes with the configured window at most once per hour", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const { calls, database } = fake(12);
    const prune = createSyncFeedPruner(database, 30);
    prune("owner", "2026-10-02T10:00:00.000Z");
    prune("owner", "2026-10-02T10:01:00.000Z");
    prune("owner", "2026-10-02T10:59:59.999Z");
    expect(calls).toEqual([
      {
        ownerId: "owner",
        olderThan: "2026-09-02T10:00:00.000Z",
        now: "2026-10-02T10:00:00.000Z",
      },
    ]);
    prune("owner", "2026-10-02T11:00:00.000Z");
    expect(calls).toHaveLength(2);
    expect(calls[1]?.olderThan).toBe("2026-09-02T11:00:00.000Z");
    // A clock that jumped backwards still prunes.
    prune("owner", "2026-10-01T00:00:00.000Z");
    expect(calls).toHaveLength(3);
    // The log line carries a count and nothing else.
    expect(info.mock.calls).toEqual([
      ["sync.feed.pruned", { deleted: 12 }],
      ["sync.feed.pruned", { deleted: 12 }],
      ["sync.feed.pruned", { deleted: 12 }],
    ]);
  });

  it("stays quiet when nothing was pruned and never runs when disabled", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const nothing = fake(0);
    createSyncFeedPruner(nothing.database, 7)(
      "owner",
      "2026-10-02T10:00:00.000Z",
    );
    expect(nothing.calls).toHaveLength(1);
    expect(nothing.calls[0]?.olderThan).toBe("2026-09-25T10:00:00.000Z");
    expect(info).not.toHaveBeenCalled();

    for (const days of [0, undefined]) {
      const disabled = fake(5);
      createSyncFeedPruner(disabled.database, days)(
        "owner",
        "2026-10-02T10:00:00.000Z",
      );
      expect(disabled.calls).toEqual([]);
    }
  });

  it("reports a failed prune without throwing and retries after an hour", () => {
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const failing = fake(new Error("database is locked"));
    const prune = createSyncFeedPruner(failing.database, 30);
    expect(() => {
      prune("owner", "2026-10-02T10:00:00.000Z");
    }).not.toThrow();
    expect(error.mock.calls).toEqual([["sync.feed.prune_failed"]]);
    prune("owner", "2026-10-02T10:30:00.000Z");
    expect(failing.calls).toHaveLength(1);
    prune("owner", "2026-10-02T11:00:00.000Z");
    expect(failing.calls).toHaveLength(2);
  });

  it("reports content-free metrics before setup and for an empty feed", () => {
    const now = Date.parse("2026-10-02T10:00:00.000Z");
    const zero = [
      "suite_sync_feed_pruned_changes 0",
      "suite_sync_feed_oldest_change_age_seconds 0",
    ];
    const value = (lines: readonly string[]) =>
      lines.filter((line) => !line.startsWith("#"));
    expect(
      value(
        syncFeedMetricLines(
          {
            getActiveOwnerId: () => undefined,
            getSyncRetention: () => {
              throw new Error("not reached");
            },
          },
          now,
        ),
      ),
    ).toEqual(zero);
    expect(
      value(
        syncFeedMetricLines(
          {
            getActiveOwnerId: () => "owner",
            getSyncRetention: () => ({ floor: 0, oldestRetainedAt: null }),
          },
          now,
        ),
      ),
    ).toEqual(zero);
    expect(
      value(
        syncFeedMetricLines(
          {
            getActiveOwnerId: () => "owner",
            getSyncRetention: () => ({
              floor: 42,
              oldestRetainedAt: "2026-10-01T10:00:00.000Z",
            }),
          },
          now,
        ),
      ),
    ).toEqual([
      "suite_sync_feed_pruned_changes 42",
      "suite_sync_feed_oldest_change_age_seconds 86400",
    ]);
  });
});
