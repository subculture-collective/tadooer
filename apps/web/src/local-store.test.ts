import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, describe, expect, it } from "vitest";
import type {
  ClientRegistrationResponse,
  SyncRoundResponse,
} from "@suite/contracts";
import { LocalStore } from "./local-store.ts";

const installationId = "d1054acd-c04d-4bd8-a814-254b007154ba";
const clientId = "1b34cc57-972c-42e8-bafa-0ba455dced20";
const ownerId = "728a504a-0997-4eb3-94dd-5d6ff8af5967";
const taskId = "4519c805-e478-486b-a918-616fc6d9ea98";
const operationId = "afcab502-2199-43fd-b9d3-c8b556c6f25b";
const generatedIds = [installationId, taskId, operationId] as const;

it("retains acknowledged creates through failed refresh without overwriting offline edits", async () => {
  const store = new LocalStore({ indexedDb: new IDBFactory() });
  await store.ensureClient(() => Promise.resolve(registration));
  const created = {
    ...taskSnapshot().task,
    title: "Acknowledged create",
    revision: 1,
  };
  await store.cacheCreatedTask(created);
  expect((await store.loadCachedTasks())[0]?.task.title).toBe(
    "Acknowledged create",
  );
  await store.queueTaskPatch(created.id, { title: "Offline edit" });
  await store.cacheCreatedTask(created);
  expect((await store.loadCachedTasks())[0]?.task.title).toBe("Offline edit");
  expect(await store.loadOutbox()).toHaveLength(1);
});

const registration: ClientRegistrationResponse = {
  client: {
    id: clientId,
    ownerId,
    label: "Test browser",
    createdAt: "2026-08-06T16:00:00.000Z",
    lastSeenAt: "2026-08-06T16:00:00.000Z",
    revokedAt: null,
  },
  clientCredential: "A".repeat(43),
  protocolVersion: 2 as const,
  initialCursor: "sync-v1.epoch.0.tag",
};

const taskSnapshot = (title = "Server task") => ({
  task: {
    id: taskId,
    title,
    notes: "Server notes",
    status: "open" as const,
    revision: 2,
    createdAt: "2026-08-06T16:00:00.000Z",
    updatedAt: "2026-08-06T16:01:00.000Z",
    completedAt: null,
    deletedAt: null,
    plannedStart: null,
    estimateMinutes: null,
    projectId: null,
    tagIds: [],
  },
  fieldVersions: {
    title: 2,
    notes: 2,
    status: 2,
    estimateMinutes: 2,
    projectId: 2,
    tagIds: 2,
    deadline: 2,
  },
  changeSequence: 2,
});

const response = (
  overrides: Partial<SyncRoundResponse> = {},
): SyncRoundResponse => ({
  outcomes: [],
  changes: [
    {
      sequence: 2,
      entityKind: "task",
      entityId: taskId,
      kind: "upsert",
      entityRevision: 2,
      changedAt: "2026-08-06T16:01:00.000Z",
      snapshot: { entityKind: "task", value: taskSnapshot() },
    },
  ],
  nextCursor: "sync-v1.epoch.2.tag",
  hasMore: false,
  protocolVersion: 2 as const,
  serverTimestamp: "2026-08-06T16:01:00.000Z",
  ...overrides,
});

let openStores: LocalStore[] = [];

const store = (): LocalStore => {
  let index = 0;
  const result = new LocalStore({
    indexedDb: indexedDB,
    now: () => "2026-08-06T16:00:00.000Z",
    uuid: () => generatedIds[index++] ?? crypto.randomUUID(),
  });
  openStores.push(result);
  return result;
};

afterEach(async () => {
  await Promise.all(openStores.map((value) => value.close()));
  openStores = [];
  await new Promise<void>((resolveDelete, rejectDelete) => {
    const request = indexedDB.deleteDatabase("suite-local-v1");
    request.onsuccess = () => resolveDelete();
    request.onerror = () =>
      rejectDelete(request.error ?? new Error("IndexedDB delete failed"));
  });
});

describe("LocalStore", () => {
  it("caches planning preferences without changing the IndexedDB schema", async () => {
    const local = store();
    const preferences = {
      workingDays: [1, 2, 3, 4, 5],
      workdayStart: "09:00",
      workdayEnd: "17:00",
      breakStart: "12:00",
      breakEnd: "12:30",
      timeZone: "America/Chicago",
    };

    expect(await local.loadPlanningPreferences()).toBeUndefined();
    await local.savePlanningPreferences(preferences);
    expect(await local.loadPlanningPreferences()).toEqual(preferences);
  });

  it("registers a client only once and persists no browser-global identity", async () => {
    const local = store();
    let registrations = 0;
    const register = () => {
      registrations += 1;
      return Promise.resolve(registration);
    };
    const [first, second] = await Promise.all([
      local.ensureClient(register),
      local.ensureClient(register),
    ]);

    expect(first).toEqual(second);
    expect(registrations).toBe(1);
  });

  it("queues immutable optimistic task mutations without Cache Storage", async () => {
    const local = store();
    await local.ensureClient(() => Promise.resolve(registration));
    const created = await local.queueTaskCreate({
      title: "Offline capture",
      notes: "Local only until sync",
    });
    const createdTaskId = "task" in created ? created.task.id : "";
    await local.queueTaskPatch(createdTaskId, { title: "Offline rename" });
    await local.queueTaskStatus(createdTaskId, true);
    await local.queueTaskDelete(createdTaskId);
    await local.queueTaskRestore(createdTaskId);

    const tasks = await local.loadCachedTasks();
    const outbox = await local.loadOutbox();
    expect(tasks[0]?.task.title).toBe("Offline rename");
    expect(tasks[0]?.task.status).toBe("completed");
    expect(tasks[0]?.task.deletedAt).toBeNull();
    expect(outbox.map(({ operation }) => operation.kind)).toEqual([
      "task.create",
      "task.patch",
      "task.complete",
      "task.delete",
      "task.restore",
    ]);
    expect(outbox.every(({ state }) => state === "queued")).toBe(true);
    expect(
      "caches" in globalThis ? await globalThis.caches.keys() : [],
    ).toEqual([]);
  });

  it("atomically applies changes, acknowledgements, conflicts, and a new cursor", async () => {
    const local = store();
    await local.ensureClient(() => Promise.resolve(registration));
    const operation = await local.queueTaskCreate({ title: "Offline capture" });
    await local.applySyncRound(
      response({
        outcomes: [
          {
            kind: "conflict",
            operationId: operation.operationId,
            code: "SYNC_FIELD_CONFLICT",
            taskId,
            taskRevision: 2,
            conflictingFields: ["title"],
          },
        ],
      }),
    );

    expect((await local.clientIdentity())?.cursor).toBe("sync-v1.epoch.2.tag");
    expect((await local.loadCachedTasks())[0]?.task.title).toBe("Server task");
    expect((await local.loadOutbox())[0]?.state).toBe("conflicted");
    expect(await local.loadConflicts()).toEqual([
      {
        operationId: operation.operationId,
        taskId,
        taskRevision: 2,
        conflictingFields: ["title"],
        code: "SYNC_FIELD_CONFLICT",
      },
    ]);

    const conflictBefore = await local.loadConflicts();
    const outboxBefore = await local.loadOutbox();
    await local.replaceFromSnapshot({
      snapshots: [{ entityKind: "task", value: taskSnapshot() }],
      nextCursor: "sync-v1.new-epoch.2.tag",
      hasMore: false,
      protocolVersion: 2 as const,
      serverTimestamp: "2026-08-06T16:02:00.000Z",
    });
    expect(await local.loadConflicts()).toEqual(conflictBefore);
    expect(await local.loadOutbox()).toEqual(outboxBefore);

    await local.queueTaskPatch(taskId, { title: "Reviewed resolution" });
    expect(await local.loadConflicts()).toEqual([]);
    expect((await local.loadOutbox()).map(({ state }) => state)).toEqual([
      "acknowledged",
      "queued",
    ]);
  });

  it("waits for canonical habit occurrences and preserves queued completions through reset", async () => {
    const local = store();
    await local.ensureClient(() => Promise.resolve(registration));
    const habit = {
      id: taskId,
      ownerId,
      title: "Read",
      cadence: { kind: "daily" as const },
      startedOn: "2026-08-06",
      timeZone: "UTC",
      revision: 1,
      createdAt: "2026-08-06T12:00:00.000Z",
      updatedAt: "2026-08-06T12:00:00.000Z",
      archivedAt: null,
    };
    await local.replaceFromSnapshot({
      protocolVersion: 2,
      snapshots: [{ entityKind: "habit", value: habit }],
      nextCursor: "sync-v1.epoch.1.tag",
      hasMore: false,
      serverTimestamp: habit.createdAt,
    });
    const queued = await local.queueHabitCommand({
      kind: "habit.complete",
      habitId: taskId,
      baseRevision: 1,
      periodKey: "2026-08-06",
    });
    expect((await local.loadCachedHabits()).occurrences).toEqual([]);
    await local.close();
    const reopened = store();
    const occurrence = {
      id: "a4f90881-652b-4411-b18b-5f5f643d20d6",
      habitId: taskId,
      periodKey: "2026-08-06",
      completedAt: habit.createdAt,
      createdAt: habit.createdAt,
    };
    await reopened.replaceFromSnapshot({
      protocolVersion: 2,
      snapshots: [
        { entityKind: "habit", value: habit },
        { entityKind: "habit_occurrence", value: occurrence },
      ],
      nextCursor: "sync-v1.next.2.tag",
      hasMore: false,
      serverTimestamp: habit.createdAt,
    });
    expect((await reopened.loadOutbox())[0]?.operation).toEqual(queued);
    await reopened.applySyncRound({
      protocolVersion: 2,
      outcomes: [
        {
          kind: "applied",
          operationId: queued.operationId,
          entityId: occurrence.id,
          entityRevision: 1,
          changeSequence: 2,
        },
      ],
      changes: [],
      nextCursor: "sync-v1.next.2.tag",
      hasMore: false,
      serverTimestamp: habit.createdAt,
    });
    expect((await reopened.loadCachedHabits()).occurrences).toEqual([
      occurrence,
    ]);
    expect((await reopened.loadOutbox())[0]?.state).toBe("acknowledged");
  });

  it("upgrades a v1 cache without changing client identity, sequence, outbox, or conflicts", async () => {
    const now = "2026-09-19T12:00:00.000Z";
    const legacy = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("suite-local-v1", 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore("metadata");
        request.result.createObjectStore("entities", {
          keyPath: ["entityKind", "id"],
        });
        request.result.createObjectStore("outbox", {
          keyPath: "operation.operationId",
        });
        request.result.createObjectStore("conflicts", {
          keyPath: "operationId",
        });
        request.result.createObjectStore("diagnostics", {
          autoIncrement: true,
        });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () =>
        reject(request.error ?? new Error("Failed to create v1 cache"));
    });
    const identity = {
      installationId,
      clientId,
      clientCredential: registration.clientCredential,
      cursor: registration.initialCursor,
      nextClientSequence: 17,
    };
    const operation = {
      kind: "task.create" as const,
      operationId,
      clientSequence: 16,
      createdAt: now,
      requestHash: "a".repeat(43),
      task: {
        id: taskId,
        title: "Old outbox",
        notes: "",
        estimateMinutes: null,
      },
    };
    const conflict = {
      operationId: "other-operation",
      taskId,
      taskRevision: 2,
      code: "SYNC_FIELD_CONFLICT",
      conflictingFields: ["title"],
    };
    const write = legacy.transaction(
      ["metadata", "outbox", "conflicts"],
      "readwrite",
    );
    write.objectStore("metadata").put(identity, "local-state");
    write
      .objectStore("outbox")
      .put({ operation, state: "sending", safeErrorCode: null });
    write.objectStore("conflicts").put(conflict);
    await new Promise<void>((resolve, reject) => {
      write.oncomplete = () => resolve();
      write.onerror = () =>
        reject(write.error ?? new Error("Legacy cache write failed"));
    });
    legacy.close();
    const local = store();
    expect(await local.clientIdentity()).toMatchObject(identity);
    expect(await local.requiresSnapshot()).toBe(true);
    expect(await local.loadOutbox()).toEqual([
      { operation, state: "sending", safeErrorCode: null },
    ]);
    expect(await local.loadConflicts()).toEqual([conflict]);
    await local.replaceFromSnapshot({
      snapshots: [],
      nextCursor: "sync-v1.next.0.tag",
      hasMore: false,
      protocolVersion: 2 as const,
      serverTimestamp: now,
    });
    expect(await local.requiresSnapshot()).toBe(false);
    expect(await local.loadConflicts()).toEqual([conflict]);
    expect((await local.loadOutbox())[0]?.operation).toEqual(operation);
    expect(
      (await local.queueTaskCreate({ title: "Next task" })).clientSequence,
    ).toBe(17);
  });

  it("retains an offline deadline edit across restart and canonical snapshot reset", async () => {
    const local = store();
    await local.ensureClient(() => Promise.resolve(registration));
    await local.applySyncRound(response());
    const deadline = { kind: "date" as const, value: "2026-09-20" };
    const operation = await local.queueTaskPatch(taskId, { deadline });
    expect(operation).toMatchObject({
      fields: { deadline },
      baseFieldVersions: { deadline: 2 },
    });
    await local.close();
    const reopened = store();
    expect((await reopened.loadCachedTasks())[0]?.task.deadline).toEqual(
      deadline,
    );
    await reopened.replaceFromSnapshot({
      snapshots: [{ entityKind: "task", value: taskSnapshot() }],
      nextCursor: "sync-v1.next.3.tag",
      hasMore: false,
      protocolVersion: 2 as const,
      serverTimestamp: "2026-09-19T12:00:00.000Z",
    });
    expect((await reopened.loadCachedTasks())[0]?.task.deadline).toEqual(
      deadline,
    );
    expect((await reopened.loadOutbox())[0]?.operation).toEqual(operation);
  });

  it("preserves cache and outbox when a snapshot is incomplete or invalid", async () => {
    const local = store();
    await local.ensureClient(() => Promise.resolve(registration));
    await local.queueTaskCreate({ title: "Offline task" });
    const tasks = await local.loadCachedTasks();
    const outbox = await local.loadOutbox();
    const identity = await local.clientIdentity();
    const snapshot = {
      snapshots: [{ entityKind: "task" as const, value: taskSnapshot() }],
      nextCursor: "sync-v1.other.3.tag",
      hasMore: true,
      protocolVersion: 2 as const,
      serverTimestamp: "2026-08-06T16:02:00.000Z",
    };
    await expect(local.replaceFromSnapshot(snapshot)).rejects.toThrow(
      "complete snapshot",
    );
    await expect(
      local.replaceFromSnapshot({
        ...snapshot,
        hasMore: false,
        snapshots: [
          {
            entityKind: "task",
            value: {
              ...taskSnapshot(),
              task: { ...taskSnapshot().task, id: "invalid" },
            },
          },
        ],
      }),
    ).rejects.toThrow();
    expect(await local.loadCachedTasks()).toEqual(tasks);
    expect(await local.loadOutbox()).toEqual(outbox);
    expect(await local.clientIdentity()).toEqual(identity);
  });

  it("atomically resets canonical state and reapplies the immutable outbox", async () => {
    const local = store();
    await local.ensureClient(() => Promise.resolve(registration));
    await local.applySyncRound(response());
    await local.queueTaskPatch(taskId, { title: "Pending local title" });

    await local.replaceFromSnapshot({
      snapshots: [
        {
          entityKind: "task",
          value: taskSnapshot("Canonical title"),
        },
      ],
      nextCursor: "sync-v1.epoch.3.tag",
      hasMore: false,
      protocolVersion: 2 as const,
      serverTimestamp: "2026-08-06T16:02:00.000Z",
    });

    expect((await local.clientIdentity())?.cursor).toBe("sync-v1.epoch.3.tag");
    expect((await local.loadCachedTasks())[0]?.task).toMatchObject({
      title: "Pending local title",
      notes: "Server notes",
    });
    expect((await local.loadOutbox())[0]?.state).toBe("queued");
  });

  it("exports recovery support metadata without task content or client credentials", async () => {
    const local = store();
    await local.ensureClient(() => Promise.resolve(registration));
    await local.queueTaskCreate({
      title: "Sensitive task title",
      notes: "Sensitive task notes",
    });

    const manifest = await local.recoverySupportManifest();
    const rendered = JSON.stringify(manifest);
    expect(rendered).not.toContain("Sensitive task title");
    expect(rendered).not.toContain("Sensitive task notes");
    expect(rendered).not.toContain(registration.clientCredential);
    expect(manifest.operations[0]?.kind).toBe("task.create");
  });

  it("retains only the latest content-free sync diagnostic", async () => {
    const local = store();
    await local.ensureClient(() => Promise.resolve(registration));
    await local.applySyncRound(response());
    await local.applySyncRound(
      response({ serverTimestamp: "2026-08-06T16:02:00.000Z" }),
    );

    const database = await new Promise<IDBDatabase>(
      (resolveOpen, rejectOpen) => {
        const request = indexedDB.open("suite-local-v1");
        request.onsuccess = () => resolveOpen(request.result);
        request.onerror = () =>
          rejectOpen(request.error ?? new Error("IndexedDB open failed"));
      },
    );
    try {
      const count = await new Promise<number>((resolveCount, rejectCount) => {
        const request = database
          .transaction("diagnostics", "readonly")
          .objectStore("diagnostics")
          .count();
        request.onsuccess = () => resolveCount(request.result);
        request.onerror = () =>
          rejectCount(request.error ?? new Error("IndexedDB count failed"));
      });
      expect(count).toBe(1);
    } finally {
      database.close();
    }
  });
});
