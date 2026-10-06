import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import {
  defaultFocusPreferences,
  type ClientRegistrationResponse,
} from "@suite/contracts";
import { LocalStore } from "./local-store.ts";

const ownerId = "10000000-0000-4000-8000-000000000001";
const registration: ClientRegistrationResponse = {
  client: {
    id: "10000000-0000-4000-8000-000000000002",
    ownerId,
    label: "Test browser",
    createdAt: "2026-10-05T12:00:00.000Z",
    lastSeenAt: "2026-10-05T12:00:00.000Z",
    revokedAt: null,
  },
  clientCredential: "A".repeat(43),
  protocolVersion: 2,
  initialCursor: "sync-v1.epoch.0.tag",
};

const snapshot = (revision: number, workMinutes: number) => ({
  protocolVersion: 2 as const,
  snapshots: [
    {
      entityKind: "focus_preferences" as const,
      value: {
        id: ownerId,
        preferences: {
          ...defaultFocusPreferences,
          pomodoro: { ...defaultFocusPreferences.pomodoro, workMinutes },
        },
        revision,
        imported: null,
      },
    },
  ],
  nextCursor: `cursor-${String(revision)}`,
  hasMore: false,
  serverTimestamp: "2026-10-05T12:00:00.000Z",
});

describe("issue #114 cached focus preferences", () => {
  it("reads preferences offline and replaces them without changing the outbox", async () => {
    const store = new LocalStore({ indexedDb: new IDBFactory() });
    await store.ensureClient(() => Promise.resolve(registration));
    await store.replaceFromSnapshot(snapshot(0, 25));
    await store.queueTaskCreate({ title: "Keep queued" });
    const before = await store.loadOutbox();

    await store.replaceFromSnapshot(snapshot(1, 50));

    expect(await store.loadCachedFocusPreferences()).toMatchObject({
      revision: 1,
      preferences: { pomodoro: { workMinutes: 50 } },
    });
    expect(await store.loadOutbox()).toEqual(before);
  });
});
