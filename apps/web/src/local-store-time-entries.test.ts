import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import {
  syncOperationSchema,
  syncRoundRequestSchema,
  syncTimeEntryWindowDays,
  syncTimeEntryWindowStart,
  type ClientRegistrationResponse,
  type SyncChange,
  type SyncOperation,
  type SyncRoundResponse,
  type Task,
  type TimeEntry,
} from "@suite/contracts";
import { LocalStore } from "./local-store.ts";
import {
  applyTimeEntryOperation,
  cachedTimeEntryWindowStart,
  cachedTimeReport,
  inCachedTimeEntryWindow,
  type TimeEntryOperation,
} from "./local-time-entries.ts";

/** Stored time entries in the offline cache and the outbox (ADR 0050, #114). */

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
const day = "2026-10-02";
const taskId = "10000000-0000-4000-8000-000000000001";
const childId = "10000000-0000-4000-8000-000000000002";
const projectId = "10000000-0000-4000-8000-0000000000aa";
const entryId = "30000000-0000-4000-8000-000000000001";
const minutes = (value: number) => value * 60_000;

const task = (id: string, fields: Partial<Task> = {}): Task => ({
  id,
  title: id === taskId ? "Write report" : "Collect numbers",
  notes: "",
  status: "open",
  revision: 1,
  createdAt: now,
  updatedAt: now,
  completedAt: null,
  deletedAt: null,
  plannedStart: null,
  plannedDay: null,
  estimateMinutes: null,
  projectId: null,
  tagIds: [],
  ...fields,
});

const tasks = [
  task(taskId, { projectId, estimateMinutes: 60 }),
  task(childId, { parentId: taskId, estimateMinutes: 30 }),
];

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

const serverEntry = (overrides: Partial<TimeEntry> = {}): TimeEntry => ({
  id: entryId,
  taskId,
  workDate: day,
  durationMs: minutes(30),
  source: "manual",
  revision: 2,
  note: "",
  startedAt: null,
  endedAt: null,
  running: false,
  provenance: null,
  createdAt: now,
  updatedAt: now,
  ...overrides,
});

const snapshotResponse = (
  entries: readonly TimeEntry[],
  cursor = "cursor-1",
) => ({
  snapshots: [
    ...tasks.map(taskSnapshot),
    ...entries.map((value) => ({ entityKind: "time_entry" as const, value })),
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

const upsert = (entry: TimeEntry, sequence: number): SyncChange => ({
  sequence,
  entityKind: "time_entry",
  entityId: entry.id,
  kind: "upsert",
  entityRevision: entry.revision ?? 1,
  changedAt: now,
  snapshot: { entityKind: "time_entry", value: entry },
});

const applied = (operation: SyncOperation, id: string, revision: number) => ({
  kind: "applied" as const,
  operationId: operation.operationId,
  entityId: id,
  entityRevision: revision,
  changeSequence: 1,
});

const conflict = (
  operation: SyncOperation,
  id: string,
  revision: number,
  reasons: readonly string[],
) => ({
  kind: "conflict" as const,
  operationId: operation.operationId,
  code: "SYNC_RESOURCE_CONFLICT" as const,
  entityKind: "time_entry" as const,
  taskId: id,
  taskRevision: revision,
  reasons: [...reasons],
});

const openStore = async (
  entries: readonly TimeEntry[] = [serverEntry()],
  indexedDb = new IDBFactory(),
) => {
  const store = new LocalStore({ indexedDb, now: () => now });
  await store.ensureClient(() => Promise.resolve(registration));
  await store.replaceFromSnapshot(snapshotResponse(entries));
  return store;
};

const durations = async (store: LocalStore) =>
  (await store.loadCachedTimeEntries()).map(({ durationMs }) => durationMs);

describe("applyTimeEntryOperation", () => {
  const base = {
    operationId: "00000000-0000-4000-8000-000000000001",
    clientSequence: 1,
    createdAt: now,
    requestHash: "a".repeat(43),
  };
  const parse = (operation: object) =>
    syncOperationSchema.parse({ ...base, ...operation }) as TimeEntryOperation;

  it("predicts the server's result for create, patch and delete", () => {
    expect(
      applyTimeEntryOperation(
        undefined,
        parse({
          kind: "time_entry.create",
          timeEntry: {
            id: entryId,
            taskId,
            workDate: day,
            durationMs: minutes(20),
            note: "New",
          },
        }),
      ),
    ).toEqual(
      serverEntry({ durationMs: minutes(20), note: "New", revision: 1 }),
    );
    expect(
      applyTimeEntryOperation(
        serverEntry(),
        parse({
          kind: "time_entry.patch",
          timeEntryId: entryId,
          fields: { durationMs: minutes(50), workDate: "2026-10-01" },
          baseRevision: 2,
        }),
      ),
    ).toMatchObject({
      durationMs: minutes(50),
      workDate: "2026-10-01",
      note: "",
      revision: 3,
    });
    const remove = parse({
      kind: "time_entry.delete",
      timeEntryId: entryId,
      baseRevision: 2,
    });
    expect(applyTimeEntryOperation(serverEntry(), remove)).toBeNull();
    // Nothing cached: nothing to patch or delete.
    expect(applyTimeEntryOperation(undefined, remove)).toBeUndefined();
  });
});

describe("cached time entry window", () => {
  it("keeps the server's window plus one day of zone tolerance", () => {
    const first = syncTimeEntryWindowStart(day);
    const tolerated = syncTimeEntryWindowStart(
      day,
      syncTimeEntryWindowDays + 1,
    );
    const outside = syncTimeEntryWindowStart(day, syncTimeEntryWindowDays + 2);
    expect(cachedTimeEntryWindowStart(now)).toBe(tolerated);
    expect(inCachedTimeEntryWindow(first, now)).toBe(true);
    expect(inCachedTimeEntryWindow(tolerated, now)).toBe(true);
    expect(inCachedTimeEntryWindow(outside, now)).toBe(false);
    // A future date is inside.
    expect(inCachedTimeEntryWindow("2027-01-01", now)).toBe(true);
  });
});

describe("cachedTimeReport", () => {
  it("builds the offline Worklog from cached entries, tasks and projects", () => {
    const report = cachedTimeReport({
      entries: [
        serverEntry(),
        serverEntry({
          id: "30000000-0000-4000-8000-000000000002",
          taskId: childId,
          durationMs: minutes(15),
          source: "import",
          workDate: "2026-10-01",
        }),
        // Outside the range, and a task that is not cached: left out.
        serverEntry({
          id: "30000000-0000-4000-8000-000000000003",
          workDate: "2026-09-20",
        }),
        serverEntry({
          id: "30000000-0000-4000-8000-000000000004",
          taskId: "10000000-0000-4000-8000-000000000009",
        }),
      ],
      tasks,
      projects: [{ id: projectId, title: "Quarterly" }],
      from: "2026-09-28",
      to: "2026-10-04",
      timeZone: "UTC",
      generatedAt: now,
    });
    expect(report).toMatchObject({
      totalMs: minutes(45),
      // Focus time is never in the cache.
      bySource: { focus: 0, import: minutes(15), manual: minutes(30) },
      weeks: [{ weekStart: "2026-09-28", totalMs: minutes(45), daysWorked: 2 }],
      projects: [
        { projectId, title: "Quarterly", totalMs: minutes(30) },
        { projectId: null, title: "No project", totalMs: minutes(15) },
      ],
    });
    expect(report.days.map(({ date, totalMs }) => [date, totalMs])).toEqual([
      ["2026-10-01", minutes(15)],
      [day, minutes(30)],
    ]);
    expect(report.tasks).toMatchObject([
      {
        taskId,
        ownMs: minutes(30),
        childrenMs: minutes(15),
        rollupEstimateMinutes: 90,
      },
      { taskId: childId, ownMs: minutes(15), childrenMs: 0, parentId: taskId },
    ]);
    expect(report.entries).toHaveLength(2);
  });
});

describe("LocalStore time entries", () => {
  it("caches entries from the snapshot and the feed without a schema change", async () => {
    const indexedDb = new IDBFactory();
    const other = serverEntry({
      id: "30000000-0000-4000-8000-000000000002",
      workDate: "2026-10-01",
      durationMs: minutes(10),
    });
    const store = await openStore([serverEntry(), other], indexedDb);
    // Sorted by work date.
    expect(await durations(store)).toEqual([minutes(10), minutes(30)]);
    const mark = await store.loadTimeEntryFeedMark();
    await store.applySyncRound(
      round({
        changes: [
          upsert(serverEntry({ durationMs: minutes(40), revision: 3 }), 5),
          {
            sequence: 6,
            entityKind: "time_entry",
            entityId: other.id,
            kind: "deleted",
            entityRevision: 2,
            changedAt: now,
            snapshot: null,
          },
        ],
      }),
    );
    expect(await store.loadCachedTimeEntries()).toEqual([
      serverEntry({ durationMs: minutes(40), revision: 3 }),
    ]);
    // The mark moved, so views that read the server report reload.
    expect(await store.loadTimeEntryFeedMark()).toBe("cursor-2");
    expect(await store.loadTimeEntryFeedMark()).not.toBe(mark);
    // A round without time entry changes leaves the mark alone.
    await store.applySyncRound(round({ nextCursor: "cursor-3" }));
    expect(await store.loadTimeEntryFeedMark()).toBe("cursor-2");
    await store.close();

    // Offline render after a restart: same database version, no network.
    const reopened = new LocalStore({ indexedDb, now: () => now });
    expect(await durations(reopened)).toEqual([minutes(40)]);
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDb.open("suite-local-v1");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error("open failed"));
    });
    expect(database.version).toBe(2);
    database.close();
    await reopened.close();
  });

  it("holds only the rolling window: at the boundary, from the snapshot, the feed and over time", async () => {
    const indexedDb = new IDBFactory();
    const edge = cachedTimeEntryWindowStart(now);
    const outside = syncTimeEntryWindowStart(day, syncTimeEntryWindowDays + 2);
    const atEdge = serverEntry({
      id: "30000000-0000-4000-8000-0000000000e1",
      workDate: edge,
    });
    const tooOld = serverEntry({
      id: "30000000-0000-4000-8000-0000000000e2",
      workDate: outside,
    });
    // A snapshot from a server in a zone ahead may carry the edge day; an
    // entry beyond the window is not cached even if it is sent.
    const store = await openStore([serverEntry(), atEdge, tooOld], indexedDb);
    expect(
      (await store.loadCachedTimeEntries()).map(({ id }) => id).toSorted(),
    ).toEqual([entryId, atEdge.id].toSorted());
    // A feed change for old history is not kept, and an entry moved out of
    // the window leaves the cache.
    await store.applySyncRound(
      round({
        changes: [
          upsert(tooOld, 5),
          upsert(serverEntry({ workDate: outside, revision: 3 }), 6),
        ],
      }),
    );
    expect((await store.loadCachedTimeEntries()).map(({ id }) => id)).toEqual([
      atEdge.id,
    ]);
    expect(
      (await store.loadCachedEntities()).filter(
        ({ entityKind }) => entityKind === "time_entry",
      ),
    ).toHaveLength(1);
    // The change still moved the mark: the online report reloads.
    expect(await store.loadTimeEntryFeedMark()).toBe("cursor-2");
    await store.close();

    // The next day the edge entry has aged out: it is no longer read, and
    // the next round that delivers a time entry deletes it.
    const tomorrow = "2026-10-03T16:00:00.000Z";
    const later = new LocalStore({ indexedDb, now: () => tomorrow });
    expect(await later.loadCachedTimeEntries()).toEqual([]);
    await later.applySyncRound(
      round({
        nextCursor: "cursor-4",
        changes: [upsert(serverEntry({ revision: 4 }), 9)],
      }),
    );
    expect(
      (await later.loadCachedEntities())
        .filter(({ entityKind }) => entityKind === "time_entry")
        .map(({ id }) => id),
    ).toEqual([entryId]);
    await later.close();
  });

  it("queues create, patch and delete offline, each based on the revision the previous one produces", async () => {
    const store = await openStore([]);
    const created = await store.queueTimeEntryCreate({
      id: entryId,
      taskId,
      workDate: day,
      durationMs: minutes(25),
      note: "Offline",
    });
    expect(created).toMatchObject({
      kind: "time_entry.create",
      timeEntry: { id: entryId, taskId, durationMs: minutes(25) },
    });
    const first = await store.queueTimeEntryPatch(entryId, {
      durationMs: minutes(35),
    });
    const second = await store.queueTimeEntryPatch(entryId, { note: "Later" });
    expect(first).toMatchObject({ kind: "time_entry.patch", baseRevision: 1 });
    expect(second).toMatchObject({ baseRevision: 2 });
    // Offline render: the Worklog report comes from the cache.
    expect(await store.loadCachedTimeEntries()).toMatchObject([
      {
        id: entryId,
        durationMs: minutes(35),
        note: "Later",
        source: "manual",
        revision: 3,
      },
    ]);
    const outbox = await store.loadOutbox();
    expect(outbox.map(({ state }) => state)).toEqual([
      "queued",
      "queued",
      "queued",
    ]);
    expect(
      syncRoundRequestSchema.safeParse({
        cursor: null,
        operations: outbox.map(({ operation }) => operation),
        pullLimit: 100,
      }).success,
    ).toBe(true);
    // A deleted or unknown task cannot receive time, and an entry that is
    // not cached cannot be edited offline.
    await store.queueTaskDelete(childId);
    await expect(
      store.queueTimeEntryCreate({
        taskId: childId,
        workDate: day,
        durationMs: minutes(5),
        note: "",
      }),
    ).rejects.toThrow("active tasks");
    await expect(
      store.queueTimeEntryPatch("30000000-0000-4000-8000-0000000000ff", {
        note: "x",
      }),
    ).rejects.toThrow();

    await store.applySyncRound(
      round({
        outcomes: [
          applied(created, entryId, 1),
          applied(first, entryId, 2),
          applied(second, entryId, 3),
        ],
        changes: [
          upsert(
            serverEntry({
              durationMs: minutes(35),
              note: "Later",
              revision: 3,
            }),
            4,
          ),
        ],
      }),
    );
    const remove = await store.queueTimeEntryDelete(entryId);
    expect(remove).toMatchObject({
      kind: "time_entry.delete",
      baseRevision: 3,
    });
    expect(await store.loadCachedTimeEntries()).toEqual([]);
    await store.close();
  });

  it("keeps an edit queued during a round visible after the round", async () => {
    const store = await openStore();
    await store.queueTimeEntryPatch(entryId, { durationMs: minutes(55) });
    // A round already in flight delivers the entry this edit was based on.
    await store.applySyncRound(round({ changes: [upsert(serverEntry(), 5)] }));
    expect(await durations(store)).toEqual([minutes(55)]);
    expect(
      await store.queueTimeEntryPatch(entryId, { note: "Again" }),
    ).toMatchObject({ baseRevision: 3 });
    await store.close();
  });

  it("replays queued time entry writes over a snapshot after a cursor reset", async () => {
    const store = await openStore();
    const added = "30000000-0000-4000-8000-000000000005";
    await store.queueTimeEntryCreate({
      id: added,
      taskId,
      workDate: "2026-10-01",
      durationMs: minutes(12),
      note: "",
    });
    await store.queueTimeEntryPatch(entryId, { durationMs: minutes(48) });
    await store.markResetRequired();
    await store.replaceFromSnapshot(
      snapshotResponse([serverEntry()], "cursor-9"),
    );
    expect(await durations(store)).toEqual([minutes(12), minutes(48)]);
    expect((await store.loadOutbox()).map(({ state }) => state)).toEqual([
      "queued",
      "queued",
    ]);
    expect((await store.clientIdentity())?.cursor).toBe("cursor-9");
    await store.close();
  });

  it("removes a refused create, restores a refused edit and shows the reason for review", async () => {
    const store = await openStore();
    const added = "30000000-0000-4000-8000-000000000005";
    const create = await store.queueTimeEntryCreate({
      id: added,
      taskId,
      workDate: day,
      durationMs: minutes(1200),
      note: "",
    });
    const edit = await store.queueTimeEntryPatch(entryId, {
      durationMs: minutes(5),
    });
    expect(await durations(store)).toEqual([minutes(5), minutes(1200)]);
    // The server counted focus time the cache does not hold: the create
    // would exceed the day. Another device had edited the entry first.
    const theirs = serverEntry({ durationMs: minutes(40), revision: 3 });
    await store.applySyncRound(
      round({
        outcomes: [
          conflict(create, added, 1, ["day_total_exceeds_day"]),
          conflict(edit, entryId, 3, ["revision"]),
        ],
        changes: [upsert(theirs, 7)],
      }),
    );
    expect(await store.loadCachedTimeEntries()).toEqual([theirs]);
    const reviews = await store.loadConflictReviews();
    expect(
      reviews
        .map(({ conflict: item }) => [item.entityKind, item.reasons])
        .toSorted(),
    ).toEqual(
      [
        ["time_entry", ["day_total_exceeds_day"]],
        ["time_entry", ["revision"]],
      ].toSorted(),
    );
    expect(reviews.every((review) => !review.retryLocalSupported)).toBe(true);
    // Nothing is retried for the owner; the conflict is dismissed.
    await expect(
      store.resolveTaskConflict({
        operationId: edit.operationId,
        choice: "retry-local",
        reviewedTaskRevision: 3,
        reviewedFieldVersions: {},
      }),
    ).rejects.toThrow("cannot be retried locally");
    for (const [operation, revision] of [
      [create, 1],
      [edit, 3],
    ] as const)
      expect(
        await store.resolveTaskConflict({
          operationId: operation.operationId,
          choice: "keep-current",
          reviewedTaskRevision: revision,
          reviewedFieldVersions: {},
        }),
      ).toBeNull();
    expect(await store.loadConflicts()).toEqual([]);
    expect((await store.loadOutbox()).map(({ state }) => state)).toEqual([
      "resolved",
      "resolved",
    ]);
    await store.close();
  });
});
