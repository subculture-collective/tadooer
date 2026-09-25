import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { withTemporaryDirectory } from "@suite/test-support";
import { SuiteDatabase, TaskHierarchyError } from "./index.ts";

const now = "2026-09-24T12:00:00.000Z";
const later = "2026-09-24T12:05:00.000Z";
const owner = (id: string) => ({
  id,
  username: id,
  displayName: id,
  passwordHash: "hash",
  createdAt: now,
});
const ids = {
  parent: "00000000-0000-4000-8000-000000000001",
  otherParent: "00000000-0000-4000-8000-000000000002",
  childA: "00000000-0000-4000-8000-000000000003",
  childB: "00000000-0000-4000-8000-000000000004",
  childC: "00000000-0000-4000-8000-000000000005",
  foreign: "00000000-0000-4000-8000-000000000006",
};

const create = (db: SuiteDatabase, ownerId: string, id: string, title = id) => {
  const result = db.createTaskIdempotently(ownerId, `create-${id}`, id, {
    id,
    title,
    notes: "",
    status: "open",
    revision: 1,
    createdAt: now,
    updatedAt: now,
  });
  if (result.kind !== "created") throw new Error("Task was not created");
  return result.task;
};

const revision = (db: SuiteDatabase, id: string) =>
  db.getTask("owner", id, true)?.revision ?? 0;

const move = (
  db: SuiteDatabase,
  taskId: string,
  parentId: string | null,
  index?: number,
) =>
  db.taskHierarchy.move({
    ownerId: "owner",
    taskId,
    parentId,
    index: index ?? null,
    expectedRevision: revision(db, taskId),
    now,
  });

const seed = (db: SuiteDatabase, path: string) => {
  db.createOwner(owner("owner"));
  // Single-owner setup refuses a second owner; add one directly to prove isolation.
  const raw = new DatabaseSync(path);
  raw
    .prepare(
      "INSERT INTO owner_accounts (id, username, display_name, password_hash, created_at, disabled_at) VALUES ('other','other','Other','hash',?,?)",
    )
    .run(now, now);
  raw.close();
  for (const id of [
    ids.parent,
    ids.otherParent,
    ids.childA,
    ids.childB,
    ids.childC,
  ])
    create(db, "owner", id);
  create(db, "other", ids.foreign);
};

it("keeps two ordered levels, rejects cycles and cross-owner parents, and survives restart", async () => {
  await withTemporaryDirectory((directory) => {
    const path = join(directory, "suite.sqlite");
    let db = SuiteDatabase.open(path);
    seed(db, path);
    expect(move(db, ids.childA, ids.parent)).toMatchObject({
      kind: "moved",
      task: { parentId: ids.parent, childPosition: 1024, revision: 2 },
    });
    expect(move(db, ids.childB, ids.parent)).toMatchObject({ kind: "moved" });
    expect(move(db, ids.childC, ids.parent, 0)).toMatchObject({
      kind: "moved",
      task: { childPosition: 0 },
    });
    const order = () =>
      db.taskHierarchy.listChildren("owner", ids.parent).map(({ id }) => id);
    expect(order()).toEqual([ids.childC, ids.childA, ids.childB]);

    // Invalid structures change nothing and append no sync change.
    const before = db.getSyncState("owner").cursor;
    expect(move(db, ids.parent, ids.parent)).toMatchObject({
      kind: "invalid",
      code: "self_parent",
    });
    expect(move(db, ids.otherParent, ids.childA)).toMatchObject({
      kind: "invalid",
      code: "parent_is_child",
    });
    expect(move(db, ids.parent, ids.otherParent)).toMatchObject({
      kind: "invalid",
      code: "task_has_children",
    });
    expect(move(db, ids.otherParent, ids.foreign)).toMatchObject({
      kind: "invalid",
      code: "parent_missing",
    });
    expect(
      db.taskHierarchy.move({
        ownerId: "other",
        taskId: ids.foreign,
        parentId: ids.parent,
        expectedRevision: 1,
        now,
      }),
    ).toMatchObject({ kind: "invalid", code: "parent_missing" });
    expect(
      db.taskHierarchy.move({
        ownerId: "owner",
        taskId: ids.childA,
        parentId: ids.otherParent,
        expectedRevision: 1,
        now,
      }),
    ).toMatchObject({ kind: "precondition-failed" });
    expect(db.getSyncState("owner").cursor).toBe(before);

    // Full reorder requires every current child revision.
    const children = db.taskHierarchy.listChildren("owner", ids.parent);
    expect(
      db.taskHierarchy.reorder({
        ownerId: "owner",
        parentId: ids.parent,
        items: children.slice(1).map(({ id, revision }) => ({ id, revision })),
        now,
      }),
    ).toEqual({ kind: "precondition-failed" });
    expect(
      db.taskHierarchy.reorder({
        ownerId: "owner",
        parentId: ids.parent,
        items: children
          .toReversed()
          .map(({ id, revision }) => ({ id, revision })),
        now,
      }),
    ).toMatchObject({ kind: "reordered" });
    expect(order()).toEqual([ids.childB, ids.childA, ids.childC]);

    // Convert child to top-level and back; the parent version follows revision.
    expect(move(db, ids.childA, null)).toMatchObject({
      kind: "moved",
      task: { parentId: null, childPosition: null },
    });
    expect(db.getTaskFieldVersions("owner", ids.childA).parent).toBe(
      revision(db, ids.childA),
    );
    expect(move(db, ids.childA, ids.otherParent)).toMatchObject({
      kind: "moved",
    });
    db.close();

    db = SuiteDatabase.open(path);
    expect(order()).toEqual([ids.childB, ids.childC]);
    expect(db.getTask("owner", ids.childA)).toMatchObject({
      parentId: ids.otherParent,
    });
    db.close();

    // The schema itself refuses a third level, cycles and cross-owner parents.
    const raw = new DatabaseSync(path);
    for (const sql of [
      `UPDATE tasks SET parent_id='${ids.childB}', child_position=1 WHERE id='${ids.childC}'`,
      `UPDATE tasks SET parent_id='${ids.childB}', child_position=1 WHERE id='${ids.parent}'`,
      `UPDATE tasks SET parent_id='${ids.parent}', child_position=1 WHERE id='${ids.parent}'`,
      `UPDATE tasks SET parent_id='${ids.parent}', child_position=1 WHERE id='${ids.foreign}'`,
      `UPDATE tasks SET parent_id='${ids.parent}', child_position=NULL WHERE id='${ids.otherParent}'`,
    ])
      expect(() => raw.exec(sql), sql).toThrow(/task hierarchy is invalid/);
    raw.close();
  });
});

it("cascades soft delete, restores co-deleted children, and detaches a child restored alone", async () => {
  await withTemporaryDirectory((directory) => {
    const path = join(directory, "suite.sqlite");
    const db = SuiteDatabase.open(path);
    seed(db, path);
    move(db, ids.childA, ids.parent);
    move(db, ids.childB, ids.parent);
    // A child deleted earlier is not resurrected by restoring the parent.
    db.deleteTask("owner", ids.childB, revision(db, ids.childB), now);
    db.deleteTask("owner", ids.parent, revision(db, ids.parent), later);
    expect(db.getTask("owner", ids.childA, true)?.deletedAt).toBe(later);
    expect(
      db.restoreTask("owner", ids.parent, revision(db, ids.parent), later),
    ).toMatchObject({ kind: "updated", task: { deletedAt: null } });
    expect(db.getTask("owner", ids.childA)).toMatchObject({
      parentId: ids.parent,
      deletedAt: null,
    });
    expect(db.getTask("owner", ids.childB, true)?.deletedAt).toBe(now);

    // Restoring a child whose parent is still deleted detaches it.
    db.deleteTask("owner", ids.parent, revision(db, ids.parent), later);
    expect(
      db.restoreTask("owner", ids.childA, revision(db, ids.childA), later),
    ).toMatchObject({
      kind: "updated",
      task: { parentId: null, deletedAt: null },
    });
    expect(db.getTaskFieldVersions("owner", ids.childA).parent).toBe(
      revision(db, ids.childA),
    );
    // Moving under a deleted parent is refused.
    expect(move(db, ids.childC, ids.parent)).toMatchObject({
      kind: "invalid",
      code: "parent_deleted",
    });
  });
});

it("blocks a cascade that would delete a child with an active focus session", async () => {
  await withTemporaryDirectory((directory) => {
    const path = join(directory, "suite.sqlite");
    const db = SuiteDatabase.open(path);
    seed(db, path);
    move(db, ids.childA, ids.parent);
    db.registerSyncClient({
      id: "client",
      ownerId: "owner",
      label: "Browser",
      credentialHash: "digest",
      createdAt: now,
      lastSeenAt: now,
      revokedAt: null,
    });
    db.putActiveSession({
      id: "session",
      ownerId: "owner",
      taskId: ids.childA,
      controllerClientId: "client",
      state: "running",
      phase: "focus",
      revision: 1,
      startedAt: now,
      leaseExpiresAt: later,
      hardExpiresAt: later,
      createdAt: now,
      updatedAt: now,
      endedAt: null,
    });
    expect(db.taskHierarchy.blockedChildIds("owner", ids.parent)).toEqual([
      ids.childA,
    ]);
    const parentRevision = revision(db, ids.parent);
    expect(() =>
      db.deleteTask("owner", ids.parent, parentRevision, now),
    ).toThrow(TaskHierarchyError);
    expect(db.getTask("owner", ids.parent)?.revision).toBe(parentRevision);
    expect(
      db.applyTaskDeletionSync({
        ownerId: "owner",
        clientId: "client",
        operationId: "00000000-0000-4000-8000-0000000000aa",
        requestHash: "delete",
        taskId: ids.parent,
        baseRevision: parentRevision,
        restore: false,
        now,
      }),
    ).toMatchObject({ kind: "conflict" });
  });
});

it("replays offline moves idempotently and turns stale or invalid moves into conflicts", async () => {
  await withTemporaryDirectory((directory) => {
    const path = join(directory, "suite.sqlite");
    const db = SuiteDatabase.open(path);
    seed(db, path);
    db.registerSyncClient({
      id: "client",
      ownerId: "owner",
      label: "Browser",
      credentialHash: "digest",
      createdAt: now,
      lastSeenAt: now,
      revokedAt: null,
    });
    const base = db.getTaskFieldVersions("owner", ids.childA).parent ?? 0;
    const operation = {
      ownerId: "owner",
      clientId: "client",
      operationId: "00000000-0000-4000-8000-0000000000b1",
      requestHash: "move-a",
      taskId: ids.childA,
      parentId: ids.parent,
      index: null,
      baseParentVersion: base,
      now,
    };
    expect(db.taskHierarchy.applyMoveSync(operation)).toMatchObject({
      kind: "applied",
      task: { parentId: ids.parent },
    });
    const cursor = db.getSyncState("owner").cursor;
    expect(db.taskHierarchy.applyMoveSync(operation)).toMatchObject({
      kind: "replayed",
      task: { parentId: ids.parent },
    });
    expect(
      db.taskHierarchy.applyMoveSync({ ...operation, requestHash: "other" }),
    ).toEqual({ kind: "idempotency-conflict" });
    expect(db.getSyncState("owner").cursor).toBe(cursor);

    // Stale base: another client already moved the task.
    expect(
      db.taskHierarchy.applyMoveSync({
        ...operation,
        operationId: "00000000-0000-4000-8000-0000000000b2",
        requestHash: "move-a-stale",
        parentId: ids.otherParent,
      }),
    ).toMatchObject({ kind: "conflict", fields: ["parent"] });
    // A queued move into a task that became a child would form a third level.
    const current = db.getTaskFieldVersions("owner", ids.otherParent).parent;
    expect(
      db.taskHierarchy.applyMoveSync({
        ...operation,
        operationId: "00000000-0000-4000-8000-0000000000b3",
        requestHash: "move-under-child",
        taskId: ids.otherParent,
        parentId: ids.childA,
        baseParentVersion: current ?? 0,
      }),
    ).toMatchObject({ kind: "conflict" });
    expect(db.getTask("owner", ids.otherParent)?.parentId).toBeNull();
    expect(db.getTask("owner", ids.childA)?.parentId).toBe(ids.parent);
  });
});

it("creates a child atomically and round-trips hierarchy through a backup", async () => {
  await withTemporaryDirectory((directory) => {
    const path = join(directory, "suite.sqlite");
    const db = SuiteDatabase.open(path);
    seed(db, path);
    const createChild = (key: string, parentId: string) =>
      db.taskHierarchy.createChild({
        ownerId: "owner",
        parentId,
        now,
        create: () =>
          db.createTaskIdempotently("owner", key, `hash-${key}`, {
            id: crypto.randomUUID(),
            title: "Child",
            notes: "",
            status: "open",
            revision: 1,
            createdAt: now,
            updatedAt: now,
          }),
      });
    const created = createChild("child-key", ids.parent);
    expect(created).toMatchObject({
      kind: "created",
      task: { parentId: ids.parent },
    });
    expect(createChild("child-key", ids.parent)).toMatchObject({
      kind: "replayed",
    });
    // An invalid parent rolls back the task and its idempotency record.
    expect(
      createChild("bad-key", created.kind === "created" ? created.task.id : ""),
    ).toEqual({
      kind: "invalid",
      code: "parent_is_child",
    });
    expect(db.listTasks("owner")).toHaveLength(6);
    const backupPath = join(directory, "backup", "suite.sqlite");
    db.backup(backupPath);
    db.close();
    const restored = SuiteDatabase.open(backupPath);
    expect(
      restored.taskHierarchy
        .listChildren("owner", ids.parent)
        .map(({ title }) => title),
    ).toEqual(["Child"]);
    restored.close();
  });
});

it("imports source children after their parents in source order", async () => {
  await withTemporaryDirectory((directory) => {
    const db = SuiteDatabase.open(join(directory, "suite.sqlite"));
    db.createOwner(owner("owner"));
    const record = (sourceId: string, extra: object = {}) => ({
      kind: "task" as const,
      sourceId,
      sourceHash: sourceId,
      sourceJson: "{}",
      title: sourceId,
      notes: `${sourceId} notes`,
      projectId: null,
      tagIds: [],
      plannedStart: null,
      deadlineDate: null,
      deadlineAt: null,
      estimateMinutes: 15,
      completedAt: null,
      createdAt: now,
      ...extra,
    });
    const records = [
      record("second", { parentSourceId: "parent", childIndex: 1 }),
      record("parent", { estimateMinutes: null }),
      record("first", {
        parentSourceId: "parent",
        childIndex: 0,
        completedAt: now,
      }),
    ];
    expect(db.importTaskRecords("owner", records, now)).toEqual({
      created: 3,
      existing: 0,
    });
    const parent = db
      .listTasks("owner")
      .find(({ title }) => title === "parent");
    expect(
      db.taskHierarchy
        .listChildren("owner", parent?.id ?? "")
        .map((task) => [task.title, task.status, task.notes]),
    ).toEqual([
      ["first", "completed", "first notes"],
      ["second", "open", "second notes"],
    ]);
    expect(db.importTaskRecords("owner", records, now)).toEqual({
      created: 0,
      existing: 3,
    });
  });
});
