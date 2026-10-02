import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import {
  clientSyncRoundResponseSchema,
  clientSyncSnapshotResponseSchema,
  syncEntityKindsSignature,
  syncOperationSchema,
  syncRoundRequestSchema,
  type ClientRegistrationResponse,
  type SavedDayOrder,
  type SyncChange,
  type SyncOperation,
  type SyncRoundResponse,
  type Task,
} from "@suite/contracts";
import { orderedDayTasks } from "./day-order.tsx";
import {
  applyDayOrderOperation,
  type DayOrderOperation,
} from "./local-day-orders.ts";
import { LocalStore } from "./local-store.ts";

/** Saved day orders in the offline cache and the outbox (ADR 0050, #114). */

const registration: ClientRegistrationResponse = {
  client: {
    id: "1b34cc57-972c-42e8-bafa-0ba455dced20",
    ownerId: "728a504a-0997-4eb3-94dd-5d6ff8af5967",
    label: "Test browser",
    createdAt: "2026-10-02T16:00:00.000Z",
    lastSeenAt: "2026-10-02T16:00:00.000Z",
    revokedAt: null,
  },
  clientCredential: "A".repeat(43),
  protocolVersion: 2 as const,
  initialCursor: "sync-v1.epoch.0.tag",
};

const now = "2026-10-02T16:00:00.000Z";
const day = "2026-10-03";
const a = "10000000-0000-4000-8000-000000000001";
const b = "10000000-0000-4000-8000-000000000002";
const c = "10000000-0000-4000-8000-000000000003";

const task = (id: string, fields: Partial<Task> = {}): Task => ({
  id,
  title: id.slice(-1),
  notes: "",
  status: "open",
  revision: 1,
  createdAt: now,
  updatedAt: now,
  completedAt: null,
  deletedAt: null,
  plannedStart: null,
  plannedDay: day,
  estimateMinutes: null,
  projectId: null,
  tagIds: [],
  ...fields,
});

const taskSnapshot = (value: Task) => ({
  entityKind: "task" as const,
  value: {
    task: value,
    fieldVersions: {
      title: 1,
      notes: 1,
      status: 1,
      estimateMinutes: 1,
      projectId: 1,
      tagIds: 1,
      deadline: 1,
      parent: 1,
      plannedStart: 1,
    },
    changeSequence: 1,
  },
});

const saved = (overrides: Partial<SavedDayOrder> = {}): SavedDayOrder => ({
  date: day,
  revision: 2,
  taskIds: [c, a, b],
  updatedAt: now,
  ...overrides,
});

const snapshotResponse = (
  orders: readonly SavedDayOrder[],
  cursor = "cursor-1",
) => ({
  snapshots: [
    ...[a, b, c].map((id) => taskSnapshot(task(id))),
    ...orders.map((value) => ({ entityKind: "day_order" as const, value })),
  ],
  nextCursor: cursor,
  hasMore: false,
  protocolVersion: 2 as const,
  serverTimestamp: now,
});

const round = (
  overrides: Partial<SyncRoundResponse> = {},
): SyncRoundResponse => ({
  outcomes: [],
  changes: [],
  nextCursor: "cursor-2",
  hasMore: false,
  protocolVersion: 2 as const,
  serverTimestamp: now,
  ...overrides,
});

const upsert = (order: SavedDayOrder, sequence: number): SyncChange => ({
  sequence,
  entityKind: "day_order",
  entityId: order.date,
  kind: "upsert",
  entityRevision: order.revision,
  changedAt: now,
  snapshot: { entityKind: "day_order", value: order },
});

const applied = (operation: SyncOperation, revision: number) => ({
  kind: "applied" as const,
  operationId: operation.operationId,
  entityId: day,
  entityRevision: revision,
  changeSequence: 1,
});

const conflict = (operation: SyncOperation, revision: number) => ({
  kind: "conflict" as const,
  operationId: operation.operationId,
  code: "SYNC_RESOURCE_CONFLICT" as const,
  entityKind: "day_order" as const,
  taskId: day,
  taskRevision: revision,
  reasons: ["revision"],
});

const openStore = async (
  orders: readonly SavedDayOrder[] = [saved()],
  indexedDb = new IDBFactory(),
) => {
  const store = new LocalStore({ indexedDb, now: () => now });
  await store.ensureClient(() => Promise.resolve(registration));
  await store.replaceFromSnapshot(snapshotResponse(orders));
  return store;
};

/** The order Today and the Planner show for the day, from the cache alone. */
const shown = async (store: LocalStore) =>
  orderedDayTasks(
    (await store.loadCachedTasks()).map(({ task: value }) => value),
    day,
    (await store.loadCachedDayOrders()).find(({ date }) => date === day),
  ).map(({ task: value }) => value.id);

describe("applyDayOrderOperation", () => {
  it("predicts the saved order and revision the server will produce", () => {
    const operation = syncOperationSchema.parse({
      operationId: "00000000-0000-4000-8000-000000000001",
      clientSequence: 1,
      createdAt: now,
      requestHash: "a".repeat(43),
      kind: "day_order.reorder",
      date: day,
      taskIds: [b, a],
      baseRevision: 0,
    }) as DayOrderOperation;
    expect(applyDayOrderOperation(operation)).toEqual({
      date: day,
      revision: 1,
      taskIds: [b, a],
      updatedAt: now,
    });
  });
});

describe("LocalStore day orders", () => {
  it("caches saved day orders from the snapshot and the feed without a schema change", async () => {
    const indexedDb = new IDBFactory();
    const store = await openStore([saved()], indexedDb);
    expect(await store.loadCachedDayOrders()).toEqual([saved()]);
    expect(await shown(store)).toEqual([c, a, b]);
    await store.applySyncRound(
      round({
        changes: [upsert(saved({ revision: 3, taskIds: [b, c, a] }), 5)],
      }),
    );
    expect(await shown(store)).toEqual([b, c, a]);
    await store.close();

    // Offline render after a restart: same database version, no network.
    const reopened = new LocalStore({ indexedDb, now: () => now });
    expect(await shown(reopened)).toEqual([b, c, a]);
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDb.open("suite-local-v1");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error("open failed"));
    });
    expect(database.version).toBe(2);
    database.close();
    await reopened.close();
  });

  it("derives members from cached tasks: a saved rank for a task that left the day is ignored", async () => {
    const store = await openStore([saved({ taskIds: [c, a, b] })]);
    // Offline, the task is completed: it leaves the day at once.
    await store.queueTaskStatus(a, true);
    expect(await shown(store)).toEqual([c, b]);
    await store.close();
  });

  it("queues reorders offline, each based on the revision the previous one produces", async () => {
    const store = await openStore([]);
    // No saved order: the derived order, and base revision 0.
    expect(await shown(store)).toEqual([a, b, c]);
    const first = await store.queueDayOrderReorder(day, [c, a, b]);
    const second = await store.queueDayOrderReorder(day, [c, b, a]);
    expect(first).toMatchObject({
      kind: "day_order.reorder",
      date: day,
      baseRevision: 0,
      taskIds: [c, a, b],
    });
    expect(second).toMatchObject({ baseRevision: 1, taskIds: [c, b, a] });
    expect(await shown(store)).toEqual([c, b, a]);
    expect(await store.loadCachedDayOrders()).toMatchObject([
      { date: day, revision: 2, taskIds: [c, b, a] },
    ]);
    const outbox = await store.loadOutbox();
    expect(outbox.map(({ state }) => state)).toEqual(["queued", "queued"]);
    // The queued operations form a valid sync round.
    expect(
      syncRoundRequestSchema.safeParse({
        cursor: null,
        operations: outbox.map(({ operation }) => operation),
        pullLimit: 100,
      }).success,
    ).toBe(true);
    const manifest = await store.recoverySupportManifest();
    expect(manifest.operations).toMatchObject([
      { kind: "day_order.reorder", entityId: day, baseRevision: 0 },
      { kind: "day_order.reorder", entityId: day, baseRevision: 1 },
    ]);

    // The server applied both; where it reconciled membership, its
    // canonical order replaces the optimistic one in the same round.
    await store.applySyncRound(
      round({
        outcomes: [applied(first, 1), applied(second, 2)],
        changes: [
          upsert(saved({ revision: 1, taskIds: [c, a, b] }), 3),
          upsert(saved({ revision: 2, taskIds: [c, b] }), 4),
        ],
      }),
    );
    expect(await store.loadCachedDayOrders()).toEqual([
      saved({ revision: 2, taskIds: [c, b] }),
    ]);
    expect((await store.loadOutbox()).map(({ state }) => state)).toEqual([
      "acknowledged",
      "acknowledged",
    ]);
    await store.close();
  });

  it("keeps a reorder queued during a round visible after the round", async () => {
    const store = await openStore();
    const pending = await store.queueDayOrderReorder(day, [a, b, c]);
    // A round that was already in flight delivers the order this reorder
    // was based on; the pending reorder is re-applied over it.
    await store.applySyncRound(round({ changes: [upsert(saved(), 5)] }));
    expect(await shown(store)).toEqual([a, b, c]);
    expect(pending).toMatchObject({ baseRevision: 2 });
    expect(await store.queueDayOrderReorder(day, [b, a, c])).toMatchObject({
      baseRevision: 3,
    });
    await store.close();
  });

  it("replays a queued reorder over a snapshot after a cursor reset", async () => {
    const indexedDb = new IDBFactory();
    const store = await openStore([saved()], indexedDb);
    await store.queueDayOrderReorder(day, [a, c, b]);
    await store.markResetRequired();
    expect(await store.requiresSnapshot()).toBe(true);
    // The epoch was reset: the snapshot still holds revision 2.
    await store.replaceFromSnapshot(snapshotResponse([saved()], "cursor-9"));
    expect(await shown(store)).toEqual([a, c, b]);
    expect(await store.loadCachedDayOrders()).toMatchObject([
      { revision: 3, taskIds: [a, c, b] },
    ]);
    expect((await store.loadOutbox()).map(({ state }) => state)).toEqual([
      "queued",
    ]);
    expect((await store.clientIdentity())?.cursor).toBe("cursor-9");
    await store.close();
  });

  it("shows a conflicting reorder for review and keeps the saved order until the owner chooses", async () => {
    const store = await openStore();
    const mine = await store.queueDayOrderReorder(day, [a, b, c]);
    // Another device saved revision 3 first.
    const theirs = saved({ revision: 3, taskIds: [b, c, a] });
    await store.applySyncRound(
      round({ outcomes: [conflict(mine, 3)], changes: [upsert(theirs, 7)] }),
    );
    expect(await shown(store)).toEqual([b, c, a]);
    const [review] = await store.loadConflictReviews();
    expect(review).toMatchObject({
      conflict: { entityKind: "day_order", taskId: day, reasons: ["revision"] },
      retryLocalSupported: true,
      dayOrder: { date: day, canonical: theirs, attempted: [a, b, c] },
    });
    // A review of an older revision is refused.
    await expect(
      store.resolveTaskConflict({
        operationId: mine.operationId,
        choice: "retry-local",
        reviewedTaskRevision: 2,
        reviewedFieldVersions: {},
      }),
    ).rejects.toThrow("The day order changed");
    await expect(
      store.resolveTaskConflict({
        operationId: mine.operationId,
        choice: "keep-both",
        reviewedTaskRevision: 3,
        reviewedFieldVersions: {},
      }),
    ).rejects.toThrow();
    // "Use my order" queues the local order against the reviewed revision.
    const retry = await store.resolveTaskConflict({
      operationId: mine.operationId,
      choice: "retry-local",
      reviewedTaskRevision: 3,
      reviewedFieldVersions: {},
    });
    expect(retry).toMatchObject({
      kind: "day_order.reorder",
      baseRevision: 3,
      taskIds: [a, b, c],
    });
    expect(await shown(store)).toEqual([a, b, c]);
    expect(await store.loadConflicts()).toEqual([]);
    const outbox = await store.loadOutbox();
    expect(outbox.map(({ state }) => state)).toEqual(["resolved", "queued"]);
    expect(outbox[0]).toMatchObject({
      resolutionChoice: "retry-local",
      replacementOperationId: retry?.operationId,
    });
    await store.close();
  });

  it("drops a refused reorder from the cache and dismisses its conflict", async () => {
    const store = await openStore([]);
    const mine = await store.queueDayOrderReorder(day, [c, b, a]);
    expect(await shown(store)).toEqual([c, b, a]);
    // The server has a saved order this client never saw, and its change
    // has not arrived yet: the refused order must not linger.
    await store.applySyncRound(round({ outcomes: [conflict(mine, 1)] }));
    expect(await store.loadCachedDayOrders()).toEqual([]);
    expect(await shown(store)).toEqual([a, b, c]);
    const [review] = await store.loadConflictReviews();
    expect(review?.dayOrder).toEqual({
      date: day,
      canonical: null,
      attempted: [c, b, a],
    });
    expect(
      await store.resolveTaskConflict({
        operationId: mine.operationId,
        choice: "keep-current",
        reviewedTaskRevision: 1,
        reviewedFieldVersions: {},
      }),
    ).toBeNull();
    expect(await store.loadConflicts()).toEqual([]);
    expect((await store.loadOutbox())[0]).toMatchObject({
      state: "resolved",
      resolutionChoice: "keep-current",
    });
    await store.close();
  });
});

describe("LocalStore unknown entity kinds (ADR 0050)", () => {
  const unknownChange = {
    sequence: 9,
    entityKind: "kanban_lane",
    entityId: "20000000-0000-4000-8000-000000000001",
    kind: "upsert",
    entityRevision: 1,
    changedAt: now,
    snapshot: {
      entityKind: "kanban_lane",
      value: { id: "20000000-0000-4000-8000-000000000001" },
    },
  };

  it("skips a change of an unknown kind, counts it and keeps the cursor advancing", async () => {
    const indexedDb = new IDBFactory();
    const store = await openStore([saved()], indexedDb);
    expect(await store.requiresSnapshot()).toBe(false);
    // A newer server sends a kind this build does not know, between two
    // changes it does know.
    const wire = {
      ...round({ nextCursor: "cursor-after-unknown" }),
      changes: [
        upsert(saved({ revision: 3, taskIds: [b, a, c] }), 8),
        unknownChange,
        upsert(saved({ revision: 4, taskIds: [a, b, c] }), 10),
      ],
    };
    await store.applySyncRound(clientSyncRoundResponseSchema.parse(wire));
    // The known changes were applied, the cursor moved past all three.
    expect(await store.loadCachedDayOrders()).toEqual([
      saved({ revision: 4, taskIds: [a, b, c] }),
    ]);
    expect((await store.clientIdentity())?.cursor).toBe("cursor-after-unknown");
    expect(
      (await store.loadCachedEntities()).some(
        ({ entityKind }) => (entityKind as string) === "kanban_lane",
      ),
    ).toBe(false);
    // The count accumulates and is in the support manifest.
    await store.applySyncRound(
      clientSyncRoundResponseSchema.parse({
        ...round({ nextCursor: "cursor-later" }),
        changes: [unknownChange, { ...unknownChange, sequence: 11 }],
      }),
    );
    expect(
      (await store.recoverySupportManifest()).skippedUnknownKindCount,
    ).toBe(3);
    // The same build keeps syncing without a snapshot.
    expect(await store.requiresSnapshot()).toBe(false);
    await store.close();

    // A build that knows another set of kinds replaces the cache from a
    // snapshot, so the skipped records are not lost.
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDb.open("suite-local-v1");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error("open failed"));
    });
    const write = database.transaction("metadata", "readwrite");
    const metadata = write.objectStore("metadata");
    const current = await new Promise<Record<string, unknown>>((resolve) => {
      const request = metadata.get("local-state");
      request.onsuccess = () =>
        resolve(request.result as Record<string, unknown>);
    });
    expect(current.skippedByKinds).toBe(syncEntityKindsSignature);
    metadata.put(
      { ...current, skippedByKinds: "an,older,build" },
      "local-state",
    );
    await new Promise<void>((resolve) => {
      write.oncomplete = () => resolve();
    });
    database.close();
    const upgraded = new LocalStore({ indexedDb, now: () => now });
    expect(await upgraded.requiresSnapshot()).toBe(true);
    await upgraded.replaceFromSnapshot(snapshotResponse([saved()], "cursor-x"));
    expect(await upgraded.requiresSnapshot()).toBe(false);
    expect(
      (await upgraded.recoverySupportManifest()).skippedUnknownKindCount,
    ).toBe(0);
    await upgraded.close();
  });

  it("skips snapshot records of an unknown kind and records the count", async () => {
    const store = new LocalStore({
      indexedDb: new IDBFactory(),
      now: () => now,
    });
    await store.ensureClient(() => Promise.resolve(registration));
    const page = clientSyncSnapshotResponseSchema.parse({
      ...snapshotResponse([saved()]),
      snapshots: [
        ...snapshotResponse([saved()]).snapshots,
        unknownChange.snapshot,
      ],
    });
    expect(page.skippedUnknownKinds).toBe(1);
    await store.replaceFromSnapshot(page);
    expect(await store.loadCachedDayOrders()).toEqual([saved()]);
    expect(
      (await store.recoverySupportManifest()).skippedUnknownKindCount,
    ).toBe(1);
    // The build that skipped it does not loop on snapshots.
    expect(await store.requiresSnapshot()).toBe(false);
    await store.close();
  });
});
