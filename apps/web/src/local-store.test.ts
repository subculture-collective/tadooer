import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import type {
  ClientRegistrationResponse,
  SyncRoundResponse,
} from "@suite/contracts";
import { LocalStore } from "./local-store.ts";

const ids = [
  "d1054acd-c04d-4bd8-a814-254b007154ba",
  "1b34cc57-972c-42e8-bafa-0ba455dced20",
  "728a504a-0997-4eb3-94dd-5d6ff8af5967",
  "4519c805-e478-486b-a918-616fc6d9ea98",
  "afcab502-2199-43fd-b9d3-c8b556c6f25b",
];

const registration: ClientRegistrationResponse = {
  client: {
    id: ids[1]!,
    ownerId: ids[2]!,
    label: "Test browser",
    createdAt: "2026-08-06T16:00:00.000Z",
    lastSeenAt: "2026-08-06T16:00:00.000Z",
    revokedAt: null,
  },
  clientCredential: "A".repeat(43),
  initialCursor: "sync-v1.epoch.0.tag",
};

const taskSnapshot = (title = "Server task") => ({
  task: {
    id: ids[3]!,
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
      entityId: ids[3]!,
      kind: "upsert",
      entityRevision: 2,
      changedAt: "2026-08-06T16:01:00.000Z",
      snapshot: { entityKind: "task", value: taskSnapshot() },
    },
  ],
  nextCursor: "sync-v1.epoch.2.tag",
  hasMore: false,
  serverTimestamp: "2026-08-06T16:01:00.000Z",
  ...overrides,
});

let openStores: LocalStore[] = [];

const store = (): LocalStore => {
  let index = 0;
  const result = new LocalStore({
    indexedDb: indexedDB,
    now: () => "2026-08-06T16:00:00.000Z",
    uuid: () => ids[index++] ?? crypto.randomUUID(),
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
    request.onerror = () => rejectDelete(request.error);
  });
});

describe("LocalStore", () => {
  it("registers a client only once and persists no browser-global identity", async () => {
    const local = store();
    let registrations = 0;
    const register = async () => {
      registrations += 1;
      return registration;
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
    await local.ensureClient(async () => registration);
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
    await local.ensureClient(async () => registration);
    const operation = await local.queueTaskCreate({ title: "Offline capture" });
    await local.applySyncRound(
      response({
        outcomes: [
          {
            kind: "conflict",
            operationId: operation.operationId,
            code: "SYNC_FIELD_CONFLICT",
            taskId: ids[3]!,
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
        taskId: ids[3]!,
        taskRevision: 2,
        conflictingFields: ["title"],
        code: "SYNC_FIELD_CONFLICT",
      },
    ]);
  });

  it("exports recovery support metadata without task content or client credentials", async () => {
    const local = store();
    await local.ensureClient(async () => registration);
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
});
