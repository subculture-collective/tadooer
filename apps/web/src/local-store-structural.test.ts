import { IDBFactory } from "fake-indexeddb";
import { expect, it } from "vitest";
import type {
  ClientRegistrationResponse,
  SyncRoundResponse,
} from "@suite/contracts";
import { LocalStore } from "./local-store.ts";

const registration: ClientRegistrationResponse = {
  client: {
    id: "1b34cc57-972c-42e8-bafa-0ba455dced20",
    ownerId: "728a504a-0997-4eb3-94dd-5d6ff8af5967",
    label: "Test browser",
    createdAt: "2026-09-25T16:00:00.000Z",
    lastSeenAt: "2026-09-25T16:00:00.000Z",
    revokedAt: null,
  },
  clientCredential: "A".repeat(43),
  protocolVersion: 2 as const,
  initialCursor: "sync-v1.epoch.0.tag",
};

const now = "2026-09-25T16:00:00.000Z";
const taskId = "4519c805-e478-486b-a918-616fc6d9ea98";
const serverProjectId = "6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f";

const taskSnapshot = () => ({
  task: {
    id: taskId,
    title: "Server task",
    notes: "",
    status: "open" as const,
    revision: 2,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    deletedAt: null,
    plannedStart: null,
    plannedDay: "2026-09-26",
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
    plannedStart: 2,
  },
  changeSequence: 2,
});

const serverProject = {
  id: serverProjectId,
  ownerId: registration.client.ownerId,
  title: "Server project",
  revision: 3,
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
  color: null,
  icon: null,
  position: 0,
  hiddenFromMenu: false,
  completedAt: null,
  backlogEnabled: false,
  backlogTaskIds: [],
};

const snapshotResponse = (cursor: string) => ({
  snapshots: [
    { entityKind: "task" as const, value: taskSnapshot() },
    { entityKind: "project" as const, value: serverProject },
  ],
  nextCursor: cursor,
  hasMore: false,
  protocolVersion: 2 as const,
  serverTimestamp: now,
});

const emptyRound = (
  overrides: Partial<SyncRoundResponse> = {},
): SyncRoundResponse => ({
  outcomes: [],
  changes: [],
  nextCursor: "sync-v1.epoch.3.tag",
  hasMore: false,
  protocolVersion: 2 as const,
  serverTimestamp: now,
  ...overrides,
});

it("queues planning, assignment, project, tag and checklist writes and replays them over a snapshot reset", async () => {
  const store = new LocalStore({ indexedDb: new IDBFactory(), now: () => now });
  await store.ensureClient(() => Promise.resolve(registration));
  await store.replaceFromSnapshot(snapshotResponse("sync-v1.epoch.2.tag"));

  const project = await store.queueOrganizationCreate("project", "Home");
  const projectId = project.kind === "project.create" ? project.project.id : "";
  const tag = await store.queueOrganizationCreate("tag", "Errand");
  const tagId = tag.kind === "tag.create" ? tag.tag.id : "";
  expect((await store.loadCachedProjects()).map(({ title }) => title)).toEqual([
    "Server project",
    "Home",
  ]);
  expect((await store.loadCachedTags())[0]).toMatchObject({
    displayName: "Errand",
    normalizedName: "errand",
    revision: 1,
  });

  const assignment = await store.queueTaskPatch(taskId, {
    projectId,
    tagIds: [tagId],
    plannedStart: "2026-09-27T09:00:00.000Z",
  });
  expect(assignment).toMatchObject({
    kind: "task.patch",
    fields: { projectId, tagIds: [tagId] },
    baseFieldVersions: { projectId: 2, tagIds: 2, plannedStart: 2 },
  });
  const cachedTask = (await store.loadCachedTasks())[0]?.task;
  expect(cachedTask).toMatchObject({
    projectId,
    tagIds: [tagId],
    plannedStart: "2026-09-27T09:00:00.000Z",
    plannedDay: null,
  });
  const day = await store.queueTaskPatch(taskId, { plannedDay: "2026-09-28" });
  expect(day).toMatchObject({ baseFieldVersions: { plannedStart: 2 } });
  expect((await store.loadCachedTasks())[0]?.task).toMatchObject({
    plannedStart: null,
    plannedDay: "2026-09-28",
  });

  await store.queueOrganizationPatch("project", serverProjectId, {
    completed: true,
    title: "Done project",
  });
  expect(
    (await store.loadCachedProjects()).find(({ id }) => id === serverProjectId),
  ).toMatchObject({
    title: "Done project",
    archivedAt: now,
    completedAt: now,
    revision: 3,
  });
  await store.queueOrganizationPatch("tag", tagId, { archived: true });
  expect((await store.loadCachedTags())[0]?.archivedAt).toBe(now);

  const item = await store.queueSubtaskCreate(taskId, "Step", 0);
  const itemId = item.kind === "subtask.create" ? item.subtask.id : "";
  await store.queueSubtaskPatch(itemId, { completed: true, position: 1 });
  expect((await store.loadCachedSubtasks())[0]).toMatchObject({
    id: itemId,
    taskId,
    completed: true,
    position: 1,
  });
  const removed = await store.queueSubtaskCreate(taskId, "Gone", 2);
  await store.queueSubtaskDelete(
    removed.kind === "subtask.create" ? removed.subtask.id : "",
  );
  expect(await store.loadCachedSubtasks()).toHaveLength(1);

  const kinds = (await store.loadOutbox()).map(
    ({ operation }) => operation.kind,
  );
  expect(kinds).toEqual([
    "project.create",
    "tag.create",
    "task.patch",
    "task.patch",
    "project.patch",
    "tag.patch",
    "subtask.create",
    "subtask.patch",
    "subtask.create",
    "subtask.delete",
  ]);
  const manifest = await store.recoverySupportManifest();
  expect(manifest.operations.map(({ entityId }) => entityId)).toEqual([
    projectId,
    tagId,
    taskId,
    taskId,
    serverProjectId,
    tagId,
    itemId,
    itemId,
    manifest.operations[8]?.entityId,
    manifest.operations[8]?.entityId,
  ]);
  expect(manifest.operations[4]).toMatchObject({
    kind: "project.patch",
    baseRevision: 3,
  });
  expect(JSON.stringify(manifest)).not.toContain("Home");

  // A cursor reset replays the immutable outbox over the canonical records.
  await store.markResetRequired();
  await store.replaceFromSnapshot(snapshotResponse("sync-v1.new.2.tag"));
  expect(
    (await store.loadCachedProjects()).map(({ title, archivedAt }) => ({
      title,
      archivedAt,
    })),
  ).toEqual([
    { title: "Home", archivedAt: null },
    { title: "Done project", archivedAt: now },
  ]);
  expect((await store.loadCachedTags())[0]).toMatchObject({
    displayName: "Errand",
    archivedAt: now,
  });
  expect(await store.loadCachedSubtasks()).toEqual([
    expect.objectContaining({ id: itemId, completed: true, position: 1 }),
  ]);
  expect((await store.loadCachedTasks())[0]?.task).toMatchObject({
    projectId,
    tagIds: [tagId],
    plannedStart: null,
    plannedDay: "2026-09-28",
  });
  expect(await store.loadOutbox()).toHaveLength(10);
});

it("records the conflicting entity, refuses local retries for records and dismisses after review", async () => {
  const store = new LocalStore({ indexedDb: new IDBFactory(), now: () => now });
  await store.ensureClient(() => Promise.resolve(registration));
  await store.replaceFromSnapshot(snapshotResponse("sync-v1.epoch.2.tag"));
  const patch = await store.queueOrganizationPatch("project", serverProjectId, {
    title: "Stale rename",
  });
  const planning = await store.queueTaskPatch(taskId, { plannedDay: null });
  await store.applySyncRound(
    emptyRound({
      outcomes: [
        {
          kind: "conflict",
          operationId: patch.operationId,
          code: "SYNC_RESOURCE_CONFLICT",
          entityKind: "project",
          taskId: serverProjectId,
          taskRevision: 4,
        },
        {
          kind: "conflict",
          operationId: planning.operationId,
          code: "SYNC_FIELD_CONFLICT",
          taskId,
          taskRevision: 3,
          conflictingFields: ["plannedStart"],
        },
      ],
      changes: [
        {
          sequence: 3,
          entityKind: "project",
          entityId: serverProjectId,
          kind: "upsert",
          entityRevision: 4,
          changedAt: now,
          snapshot: {
            entityKind: "project",
            value: { ...serverProject, revision: 4, title: "Renamed online" },
          },
        },
      ],
    }),
  );
  expect(await store.loadConflicts()).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        operationId: patch.operationId,
        entityKind: "project",
        taskId: serverProjectId,
        taskRevision: 4,
      }),
      expect.objectContaining({
        operationId: planning.operationId,
        entityKind: "task",
        conflictingFields: ["plannedStart"],
      }),
    ]),
  );
  expect(await store.loadConflicts()).toHaveLength(2);
  expect((await store.loadCachedProjects())[0]?.title).toBe("Renamed online");
  const reviews = await store.loadConflictReviews();
  const projectReview = reviews.find(
    ({ conflict }) => conflict.operationId === patch.operationId,
  );
  expect(projectReview).toMatchObject({
    canonical: null,
    retryLocalSupported: false,
    retryLocalUnavailableReason: "unsupported",
  });
  await expect(
    store.resolveTaskConflict({
      operationId: patch.operationId,
      choice: "retry-local",
      reviewedTaskRevision: 4,
      reviewedFieldVersions: {},
    }),
  ).rejects.toThrow("cannot be retried locally");
  await expect(
    store.resolveTaskConflict({
      operationId: patch.operationId,
      choice: "keep-current",
      reviewedTaskRevision: 3,
      reviewedFieldVersions: {},
    }),
  ).rejects.toThrow("review the latest values");
  expect(
    await store.resolveTaskConflict({
      operationId: patch.operationId,
      choice: "keep-current",
      reviewedTaskRevision: 4,
      reviewedFieldVersions: {},
    }),
  ).toBeNull();
  expect(
    (await store.loadConflicts()).map(({ entityKind }) => entityKind),
  ).toEqual(["task"]);
  expect(
    (await store.loadOutbox()).find(
      ({ operation }) => operation.operationId === patch.operationId,
    ),
  ).toMatchObject({ state: "resolved", resolutionChoice: "keep-current" });
  // The task planning conflict keeps the field review and local retry path;
  // the retry bases the planned day on the planning slot version.
  const taskReview = (await store.loadConflictReviews())[0];
  expect(taskReview).toMatchObject({
    retryLocalSupported: true,
    attemptedFields: { plannedDay: null },
  });
  const retry = await store.resolveTaskConflict({
    operationId: planning.operationId,
    choice: "retry-local",
    reviewedTaskRevision: 2,
    reviewedFieldVersions: { plannedStart: 2 },
  });
  expect(retry).toMatchObject({
    kind: "task.patch",
    fields: { plannedDay: null },
    baseFieldVersions: { plannedStart: 2 },
  });
  expect(await store.loadConflicts()).toEqual([]);
  expect((await store.loadCachedTasks())[0]?.task.plannedDay).toBeNull();
});
