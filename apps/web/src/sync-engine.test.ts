import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ClientRegistrationResponse,
  SyncRoundResponse,
} from "@suite/contracts";
import { LocalStore } from "./local-store.ts";
import {
  installOnlineSync,
  SyncCursorResetRequired,
  SyncEngine,
} from "./sync-engine.ts";

const clientId = "d1054acd-c04d-4bd8-a814-254b007154ba";
const registration: ClientRegistrationResponse = {
  client: {
    id: clientId,
    ownerId: "1b34cc57-972c-42e8-bafa-0ba455dced20",
    label: "Test client",
  },
  clientCredential: "A".repeat(43),
  initialCursor: "sync-v1.epoch.0.tag",
};

let store: LocalStore | undefined;

afterEach(async () => {
  await store?.close();
  store = undefined;
  await new Promise<void>((resolveDelete, rejectDelete) => {
    const request = indexedDB.deleteDatabase("suite-local-v1");
    request.onsuccess = () => resolveDelete();
    request.onerror = () =>
      rejectDelete(request.error ?? new Error("IndexedDB delete failed"));
  });
});

describe("SyncEngine", () => {
  it("does not send the outbox until a failed upgrade snapshot succeeds, including after restart", async () => {
    store = new LocalStore({ indexedDb: indexedDB });
    await store.ensureClient(() => Promise.resolve(registration));
    await store.queueTaskCreate({ title: "Preserved offline task" });
    const before = await store.loadOutbox();
    const proofBefore = await store.clientIdentity();
    const syncRound = vi.fn(() =>
      Promise.resolve({
        outcomes: [],
        changes: [],
        nextCursor: "sync-v1.epoch.4.tag",
        hasMore: false,
        serverTimestamp: "2026-08-06T16:00:00.000Z",
      } satisfies SyncRoundResponse),
    );
    const transport = {
      registerClient: vi.fn(() => Promise.resolve(registration)),
      snapshot: vi.fn(() => Promise.reject(new Error("Snapshot unavailable"))),
      syncRound,
    };
    await expect(new SyncEngine(store, transport).sync()).rejects.toThrow(
      "Snapshot unavailable",
    );
    expect(syncRound).not.toHaveBeenCalled();
    expect(await store.loadOutbox()).toEqual(before);
    expect(await store.clientIdentity()).toEqual(proofBefore);
    await store.close();
    store = new LocalStore({ indexedDb: indexedDB });
    await new SyncEngine(store, {
      ...transport,
      snapshot: () =>
        Promise.resolve({
          snapshots: [],
          nextCursor: "sync-v1.epoch.4.tag",
          hasMore: false,
          serverTimestamp: "2026-08-06T16:00:00.000Z",
        }),
    }).sync();
    expect(syncRound).toHaveBeenCalledWith(
      expect.objectContaining({ clientId }),
      {
        cursor: "sync-v1.epoch.4.tag",
        operations: before.map(({ operation }) => operation),
        pullLimit: 100,
      },
    );
    expect(transport.registerClient).not.toHaveBeenCalled();
    expect(await store.requiresSnapshot()).toBe(false);
  });

  it("uses the persisted client proof and only queued operations", async () => {
    store = new LocalStore({ indexedDb: indexedDB });
    const syncRound = vi.fn(() =>
      Promise.resolve({
        outcomes: [],
        changes: [],
        nextCursor: "sync-v1.epoch.0.tag",
        hasMore: false,
        serverTimestamp: "2026-08-06T16:00:00.000Z",
      } satisfies SyncRoundResponse),
    );
    const engine = new SyncEngine(store, {
      registerClient: () => Promise.resolve(registration),
      snapshot: () =>
        Promise.resolve({
          snapshots: [],
          nextCursor: "sync-v1.epoch.0.tag",
          hasMore: false,
          serverTimestamp: "2026-08-06T16:00:00.000Z",
        }),
      syncRound,
    });

    await engine.sync();

    expect(syncRound).toHaveBeenCalledWith(
      expect.objectContaining({ clientId, clientCredential: "A".repeat(43) }),
      { cursor: "sync-v1.epoch.0.tag", operations: [], pullLimit: 100 },
    );
  });

  it("resets from a bounded snapshot and retries an expired cursor", async () => {
    store = new LocalStore({ indexedDb: indexedDB });
    let attempts = 0;
    const snapshot = vi.fn(() =>
      Promise.resolve({
        snapshots: [],
        nextCursor: "sync-v1.epoch.4.tag",
        hasMore: false,
        serverTimestamp: "2026-08-06T16:00:00.000Z",
      }),
    );
    const engine = new SyncEngine(store, {
      registerClient: () => Promise.resolve(registration),
      snapshot,
      syncRound: (_client, request) => {
        attempts += 1;
        if (attempts === 1)
          return Promise.reject(new SyncCursorResetRequired());
        if (request.cursor === null)
          return Promise.reject(new Error("Cursor missing"));
        return Promise.resolve({
          outcomes: [],
          changes: [],
          nextCursor: request.cursor,
          hasMore: false,
          serverTimestamp: "2026-08-06T16:00:01.000Z",
        });
      },
    });

    const response = await engine.sync();

    expect(snapshot).toHaveBeenCalledTimes(2);
    expect(attempts).toBe(2);
    expect(response.nextCursor).toBe("sync-v1.epoch.4.tag");
  });

  it("installs and removes a foreground-only online listener", async () => {
    const listeners = new Map<string, () => void>();
    const target = {
      addEventListener: (name: string, listener: () => void) =>
        listeners.set(name, listener),
      removeEventListener: (name: string) => listeners.delete(name),
    } as unknown as Window;
    const sync = vi.fn(() => Promise.resolve(undefined));
    const remove = installOnlineSync(target, sync);

    listeners.get("online")?.();
    await Promise.resolve();
    expect(sync).toHaveBeenCalledOnce();
    remove();
    expect(listeners.has("online")).toBe(false);
  });
});
