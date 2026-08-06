import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ClientRegistrationResponse,
  SyncRoundResponse,
} from "@suite/contracts";
import { LocalStore } from "./local-store.ts";
import { installOnlineSync, SyncEngine } from "./sync-engine.ts";

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
    request.onerror = () => rejectDelete(request.error);
  });
});

describe("SyncEngine", () => {
  it("uses the persisted client proof and only queued operations", async () => {
    store = new LocalStore({ indexedDb: indexedDB });
    const syncRound = vi.fn(async (): Promise<SyncRoundResponse> => ({
      outcomes: [],
      changes: [],
      nextCursor: "sync-v1.epoch.0.tag",
      hasMore: false,
      serverTimestamp: "2026-08-06T16:00:00.000Z",
    }));
    const engine = new SyncEngine(store, {
      registerClient: async () => registration,
      syncRound,
    });

    await engine.sync();

    expect(syncRound).toHaveBeenCalledWith(
      expect.objectContaining({ clientId, clientCredential: "A".repeat(43) }),
      { cursor: "sync-v1.epoch.0.tag", operations: [], pullLimit: 100 },
    );
  });

  it("installs and removes a foreground-only online listener", async () => {
    const listeners = new Map<string, () => void>();
    const target = {
      addEventListener: (name: string, listener: () => void) =>
        listeners.set(name, listener),
      removeEventListener: (name: string) => listeners.delete(name),
    } as unknown as Window;
    const sync = vi.fn(async () => undefined);
    const remove = installOnlineSync(target, sync);

    listeners.get("online")?.();
    await Promise.resolve();
    expect(sync).toHaveBeenCalledOnce();
    remove();
    expect(listeners.has("online")).toBe(false);
  });
});
