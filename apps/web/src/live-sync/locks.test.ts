import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import type {
  ClientRegistrationResponse,
  SyncRoundRequest,
  SyncRoundResponse,
} from "@suite/contracts";
import { LocalStore, type LocalClientIdentity } from "../local-store.ts";
import {
  SyncEngine,
  type SyncRoundTrigger,
  type SyncTransport,
} from "../sync-engine.ts";
import {
  holdLock,
  liveSyncLeaderLockName,
  syncRoundExclusive,
  syncRoundLockName,
} from "./locks.ts";
import { FakeLocks } from "./test-fakes.ts";

const registration: ClientRegistrationResponse = {
  client: {
    id: "d1054acd-c04d-4bd8-a814-254b007154ba",
    ownerId: "1b34cc57-972c-42e8-bafa-0ba455dced20",
    label: "Test client",
  },
  clientCredential: "A".repeat(43),
  protocolVersion: 2 as const,
  initialCursor: "epoch.0",
};

const stores: LocalStore[] = [];
const openStore = (): LocalStore => {
  const store = new LocalStore({ indexedDb: indexedDB });
  stores.push(store);
  return store;
};

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  await new Promise<void>((resolveDelete, rejectDelete) => {
    const request = indexedDB.deleteDatabase("suite-local-v1");
    request.onsuccess = () => resolveDelete();
    request.onerror = () =>
      rejectDelete(request.error ?? new Error("IndexedDB delete failed"));
  });
});

/**
 * A server that acknowledges every operation it is sent, after a delay long
 * enough for a second tab to start its own round.
 */
const acknowledgingServer = () => {
  const sent: string[] = [];
  const triggers: (SyncRoundTrigger | undefined)[] = [];
  let sequence = 0;
  let inFlight = 0;
  let overlapped = false;
  const transport: SyncTransport = {
    registerClient: () => Promise.resolve(registration),
    snapshot: () =>
      Promise.resolve({
        snapshots: [],
        nextCursor: "epoch.0",
        hasMore: false,
        protocolVersion: 2 as const,
        serverTimestamp: "2026-10-02T12:00:00.000Z",
      }),
    syncRound: async (
      _client: LocalClientIdentity,
      request: SyncRoundRequest,
      trigger?: SyncRoundTrigger,
    ): Promise<SyncRoundResponse> => {
      inFlight += 1;
      if (inFlight > 1) overlapped = true;
      triggers.push(trigger);
      sent.push(...request.operations.map(({ operationId }) => operationId));
      await new Promise((resolve) => setTimeout(resolve, 50));
      const outcomes = request.operations.map((operation) => {
        sequence += 1;
        return {
          kind: "applied" as const,
          operationId: operation.operationId,
          entityId: operation.operationId,
          entityRevision: 1,
          changeSequence: sequence,
        };
      });
      inFlight -= 1;
      return {
        outcomes,
        changes: [],
        nextCursor: `epoch.${String(sequence)}`,
        hasMore: false,
        protocolVersion: 2 as const,
        serverTimestamp: "2026-10-02T12:00:00.000Z",
      };
    },
  };
  return { transport, sent, triggers, overlapped: () => overlapped };
};

describe("sync round lock", () => {
  it("never sends the same outbox entry from two tabs of one client", async () => {
    const locks = new FakeLocks();
    // Two tabs of one browser profile: separate connections to one database.
    const first = openStore();
    const second = openStore();
    await first.ensureClient(() => Promise.resolve(registration));
    await first.applySyncRound({
      outcomes: [],
      changes: [],
      nextCursor: "epoch.0",
      hasMore: false,
      protocolVersion: 2 as const,
      serverTimestamp: "2026-10-02T12:00:00.000Z",
    });
    const operation = await first.queueTaskCreate({ title: "Written once" });
    // The second tab already has its database connection open.
    expect(await second.loadOutbox()).toHaveLength(1);
    const server = acknowledgingServer();
    const tabs = [first, second].map(
      (store) =>
        new SyncEngine(
          store,
          server.transport,
          syncRoundExclusive(locks.tab()),
        ),
    );
    await Promise.all(tabs.map((engine) => engine.sync()));
    expect(server.sent).toEqual([operation.operationId]);
    expect(server.overlapped()).toBe(false);
    expect(locks.holder(syncRoundLockName)).toBeUndefined();
  });

  it("sends the entry twice without the lock, which is the gap it closes", async () => {
    const first = openStore();
    const second = openStore();
    await first.ensureClient(() => Promise.resolve(registration));
    await first.applySyncRound({
      outcomes: [],
      changes: [],
      nextCursor: "epoch.0",
      hasMore: false,
      protocolVersion: 2 as const,
      serverTimestamp: "2026-10-02T12:00:00.000Z",
    });
    const operation = await first.queueTaskCreate({ title: "Written twice" });
    // The second tab already has its database connection open.
    expect(await second.loadOutbox()).toHaveLength(1);
    const server = acknowledgingServer();
    const tabs = [first, second].map(
      (store) =>
        new SyncEngine(store, server.transport, syncRoundExclusive(undefined)),
    );
    await Promise.all(tabs.map((engine) => engine.sync()));
    expect(server.sent).toEqual([operation.operationId, operation.operationId]);
  });

  it("passes the push trigger through to the transport", async () => {
    const store = openStore();
    const server = acknowledgingServer();
    const engine = new SyncEngine(
      store,
      server.transport,
      syncRoundExclusive(new FakeLocks().tab()),
    );
    await engine.sync(100, "push");
    await engine.sync();
    expect(server.triggers).toEqual(["push", undefined]);
  });

  it("releases the lock when a round fails", async () => {
    const locks = new FakeLocks();
    const store = openStore();
    const engine = new SyncEngine(
      store,
      {
        registerClient: () => Promise.resolve(registration),
        snapshot: () => Promise.reject(new Error("Snapshot unavailable")),
        syncRound: () => Promise.reject(new Error("unreachable")),
      },
      syncRoundExclusive(locks.tab()),
    );
    await expect(engine.sync()).rejects.toThrow("Snapshot unavailable");
    expect(locks.holder(syncRoundLockName)).toBeUndefined();
  });
});

describe("holdLock", () => {
  const settle = (): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, 0));

  it("keeps the lock until released and then hands it to the next tab", async () => {
    const locks = new FakeLocks();
    const order: string[] = [];
    const releaseFirst = holdLock(locks.tab(), liveSyncLeaderLockName, () =>
      order.push("first"),
    );
    holdLock(locks.tab(), liveSyncLeaderLockName, () => order.push("second"));
    await settle();
    expect(order).toEqual(["first"]);
    releaseFirst();
    await settle();
    expect(order).toEqual(["first", "second"]);
  });

  it("hands the lock over when the holding tab closes", async () => {
    const locks = new FakeLocks();
    const order: string[] = [];
    const firstTab = locks.tab();
    holdLock(firstTab, liveSyncLeaderLockName, () => order.push("first"));
    holdLock(locks.tab(), liveSyncLeaderLockName, () => order.push("second"));
    await settle();
    firstTab.close();
    await settle();
    expect(order).toEqual(["first", "second"]);
  });

  it("never acquires after being cancelled while waiting", async () => {
    const locks = new FakeLocks();
    const order: string[] = [];
    const releaseFirst = holdLock(locks.tab(), liveSyncLeaderLockName, () =>
      order.push("first"),
    );
    const cancelSecond = holdLock(locks.tab(), liveSyncLeaderLockName, () =>
      order.push("second"),
    );
    await settle();
    cancelSecond();
    releaseFirst();
    await settle();
    expect(order).toEqual(["first"]);
    expect(locks.holder(liveSyncLeaderLockName)).toBeUndefined();
  });
});
