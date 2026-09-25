import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import {
  historicalReferenceSchema,
  taskArchiveReviewReasonSchema,
} from "@suite/contracts";
import {
  historicalReferenceKinds,
  historicalReferenceReasons,
  taskArchiveReviewReasons,
} from "@suite/domain";
import { withTemporaryDirectory } from "@suite/test-support";
import { SuiteDatabase, TaskHistoryCursorError } from "./index.ts";

const now = "2026-09-24T12:00:00.000Z";
const later = "2026-09-24T13:00:00.000Z";
const ids = {
  parent: "00000000-0000-4000-8000-000000000001",
  childA: "00000000-0000-4000-8000-000000000002",
  childB: "00000000-0000-4000-8000-000000000003",
  other: "00000000-0000-4000-8000-000000000004",
};

const open = (directory: string) => {
  const db = SuiteDatabase.open(join(directory, "suite.sqlite"));
  db.createOwner({
    id: "owner",
    username: "owner",
    displayName: "Owner",
    passwordHash: "hash",
    createdAt: now,
  });
  return db;
};

const create = (db: SuiteDatabase, id: string, title: string, notes = "") => {
  const result = db.createTaskIdempotently("owner", `create-${id}`, id, {
    id,
    title,
    notes,
    status: "open",
    revision: 1,
    createdAt: now,
    updatedAt: now,
  });
  if (result.kind !== "created") throw new Error("Task was not created");
};

const revision = (db: SuiteDatabase, id: string) =>
  db.getTask("owner", id, true)?.revision ?? 0;

const family = (db: SuiteDatabase) => {
  create(db, ids.parent, "Quarterly report", "Draft and send");
  create(db, ids.childA, "Collect numbers");
  create(db, ids.childB, "Obsolete step");
  create(db, ids.other, "Water plants");
  for (const child of [ids.childA, ids.childB])
    db.taskHierarchy.move({
      ownerId: "owner",
      taskId: child,
      parentId: ids.parent,
      expectedRevision: revision(db, child),
      now,
    });
  db.setTaskCompleted("owner", ids.childA, revision(db, ids.childA), true, now);
  db.deleteTask("owner", ids.childB, revision(db, ids.childB), now);
};

it("keeps domain and contract history vocabularies identical", () => {
  expect(taskArchiveReviewReasonSchema.options).toEqual([
    ...taskArchiveReviewReasons,
  ]);
  expect(historicalReferenceSchema.shape.kind.options).toEqual([
    ...historicalReferenceKinds,
  ]);
  expect(historicalReferenceSchema.shape.reason.options).toEqual([
    ...historicalReferenceReasons,
  ]);
});

it("archives a parent with its active children, keeps them read-only and restores them together", async () => {
  await withTemporaryDirectory((directory) => {
    const db = open(directory);
    family(db);
    const completedAt = db.getTask("owner", ids.childA)?.completedAt;
    const parentRevision = revision(db, ids.parent);

    expect(
      db.taskArchive.archive({
        ownerId: "owner",
        taskId: ids.childA,
        expectedRevision: revision(db, ids.childA),
        now: later,
      }),
    ).toMatchObject({ kind: "invalid", code: "task_is_child" });
    expect(
      db.taskArchive.archive({
        ownerId: "owner",
        taskId: ids.parent,
        expectedRevision: parentRevision - 1,
        now: later,
      }),
    ).toMatchObject({ kind: "precondition-failed" });

    const archived = db.taskArchive.archive({
      ownerId: "owner",
      taskId: ids.parent,
      expectedRevision: parentRevision,
      now: later,
    });
    expect(archived).toMatchObject({
      kind: "archived",
      task: { id: ids.parent, archivedAt: later, revision: parentRevision + 1 },
      children: [{ id: ids.childA, archivedAt: later, completedAt }],
    });
    // Archived tasks leave every active surface and cannot be edited.
    expect(db.listTasks("owner").map(({ id }) => id)).toEqual([ids.other]);
    expect(db.getTask("owner", ids.parent)).toBeUndefined();
    expect(db.listDeletedTasks("owner").map(({ id }) => id)).toEqual([
      ids.childB,
    ]);
    expect(
      db.patchTask(
        "owner",
        ids.parent,
        parentRevision + 1,
        { title: "x" },
        later,
      ),
    ).toEqual({ kind: "not-found" });
    expect(
      db.deleteTask("owner", ids.parent, parentRevision + 1, later),
    ).toEqual({ kind: "not-found" });
    expect(
      db.taskHierarchy.move({
        ownerId: "owner",
        taskId: ids.other,
        parentId: ids.parent,
        expectedRevision: revision(db, ids.other),
        now: later,
      }),
    ).toMatchObject({ kind: "invalid", code: "parent_missing" });
    // The trigger keeps history read-only even if application checks fail.
    const raw = new DatabaseSync(join(directory, "suite.sqlite"));
    expect(() =>
      raw
        .prepare("UPDATE tasks SET title='changed' WHERE id=?")
        .run(ids.parent),
    ).toThrow(/read-only/);
    expect(() =>
      raw
        .prepare("UPDATE tasks SET deleted_at=? WHERE id=?")
        .run(later, ids.parent),
    ).toThrow(/cannot be deleted/);
    raw.close();

    expect(db.taskArchive.history({ ownerId: "owner" })).toMatchObject({
      total: 1,
      nextCursor: null,
      entries: [
        {
          task: { id: ids.parent, createdAt: now },
          provenance: null,
          children: [{ task: { id: ids.childA } }],
        },
      ],
    });
    // A child match returns its family; LIKE wildcards are literal.
    expect(
      db.taskArchive.history({ ownerId: "owner", query: "NUMBERS" }).total,
    ).toBe(1);
    expect(db.taskArchive.history({ ownerId: "owner", query: "%" }).total).toBe(
      0,
    );
    expect(
      db.taskArchive.history({ ownerId: "owner", query: "plants" }).total,
    ).toBe(0);

    expect(
      db.taskArchive.restore({
        ownerId: "owner",
        taskId: ids.childA,
        expectedRevision: revision(db, ids.childA),
        now: later,
      }),
    ).toMatchObject({ kind: "invalid", code: "task_is_child" });
    expect(
      db.taskArchive.restore({
        ownerId: "owner",
        taskId: ids.other,
        expectedRevision: revision(db, ids.other),
        now: later,
      }),
    ).toEqual({ kind: "not-found" });
    const restored = db.taskArchive.restore({
      ownerId: "owner",
      taskId: ids.parent,
      expectedRevision: parentRevision + 1,
      now: later,
    });
    expect(restored).toMatchObject({
      kind: "restored",
      task: { archivedAt: null, revision: parentRevision + 2 },
      children: [{ id: ids.childA, status: "completed", completedAt }],
    });
    expect(
      db.taskHierarchy.listChildren("owner", ids.parent).map(({ id }) => id),
    ).toEqual([ids.childA]);
    expect(db.getTask("owner", ids.childB, true)?.deletedAt).toBe(now);
    expect(db.taskArchive.history({ ownerId: "owner" }).total).toBe(0);
    db.close();
  });
});

it("emits sync changes, rejects offline edits to archived tasks and pages history deterministically", async () => {
  await withTemporaryDirectory((directory) => {
    const db = open(directory);
    db.registerSyncClient({
      id: "client",
      ownerId: "owner",
      label: "Browser",
      credentialHash: "digest",
      createdAt: now,
      lastSeenAt: now,
      revokedAt: null,
    });
    const titles = ["Alpha", "Beta", "Gamma"];
    const taskIds = titles.map(
      (_, index) => `00000000-0000-4000-8000-00000000010${String(index)}`,
    );
    titles.forEach((title, index) => create(db, taskIds[index] ?? "", title));
    const before = db.getSyncState("owner").cursor;
    for (const [index, id] of taskIds.entries())
      db.taskArchive.archive({
        ownerId: "owner",
        taskId: id,
        expectedRevision: 1,
        now: `2026-09-24T12:0${String(index)}:00.000Z`,
      });
    const changes = db.listSyncChanges(
      "owner",
      db.getSyncState("owner").epoch,
      before,
    );
    expect(changes.map(({ kind, entityId }) => [kind, entityId])).toEqual(
      taskIds.map((id) => ["archived", id]),
    );
    // A patch queued offline before the archive conflicts, replay-stably.
    const patch = {
      ownerId: "owner",
      clientId: "client",
      operationId: "00000000-0000-4000-8000-0000000000c1",
      requestHash: "patch",
      taskId: taskIds[0] ?? "",
      baseVersions: { title: 1 },
      patch: { title: "Edited offline" },
      now: later,
    };
    expect(db.applyTaskFieldSync(patch)).toMatchObject({
      kind: "conflict",
      fields: ["archivedAt"],
    });
    expect(db.applyTaskFieldSync(patch)).toMatchObject({
      kind: "conflict",
      fields: ["archivedAt"],
    });
    expect(
      db.applyTaskDeletionSync({
        ownerId: "owner",
        clientId: "client",
        operationId: "00000000-0000-4000-8000-0000000000c2",
        requestHash: "delete",
        taskId: taskIds[1] ?? "",
        baseRevision: 2,
        restore: false,
        now: later,
      }),
    ).toMatchObject({ kind: "conflict" });
    expect(db.getTask("owner", taskIds[0] ?? "", true)?.title).toBe("Alpha");

    const first = db.taskArchive.history({ ownerId: "owner", limit: 2 });
    expect(first.entries.map(({ task }) => task.title)).toEqual([
      "Gamma",
      "Beta",
    ]);
    expect(first.total).toBe(3);
    const second = db.taskArchive.history({
      ownerId: "owner",
      limit: 2,
      cursor: first.nextCursor ?? "",
    });
    expect(second.entries.map(({ task }) => task.title)).toEqual(["Alpha"]);
    expect(second.nextCursor).toBeNull();
    expect(() =>
      db.taskArchive.history({ ownerId: "owner", cursor: "bm90LWEtY3Vyc29y" }),
    ).toThrow(TaskHistoryCursorError);
    db.close();
  });
});

it("blocks archiving a family with a running focus session", async () => {
  await withTemporaryDirectory((directory) => {
    const db = open(directory);
    family(db);
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
    expect(
      db.taskArchive.archive({
        ownerId: "owner",
        taskId: ids.parent,
        expectedRevision: revision(db, ids.parent),
        now: later,
      }),
    ).toMatchObject({ kind: "invalid", code: "task_blocked" });
    expect(db.getTask("owner", ids.parent)?.archivedAt).toBeNull();
    db.close();
  });
});

it("imports archived history with provenance, replays idempotently and survives restart and backup", async () => {
  await withTemporaryDirectory((directory) => {
    const db = open(directory);
    const record = (sourceId: string, extra: object = {}) => ({
      kind: "task" as const,
      sourceId,
      sourceHash: sourceId,
      sourceJson: "{}",
      title: sourceId,
      notes: "",
      projectId: null,
      tagIds: [],
      plannedStart: null,
      deadlineDate: null,
      deadlineAt: null,
      estimateMinutes: null,
      completedAt: "2026-01-02T03:04:05.000Z",
      createdAt: "2025-12-01T00:00:00.000Z",
      ...extra,
    });
    const records = [
      record("live"),
      record("old-parent", {
        archived: true,
        archiveStore: "archiveOld",
        historicalReferences: [
          { kind: "project", sourceId: "gone", reason: "missing_from_export" },
          { kind: "tag", sourceId: "EM_URGENT", reason: "system_tag" },
        ],
      }),
      record("old-child", {
        archived: true,
        archiveStore: "archiveOld",
        parentSourceId: "old-parent",
        childIndex: 0,
        title: "Untitled archived task",
        review: ["blank_title"],
      }),
      record("detached", {
        completedAt: null,
        historicalReferences: [
          {
            kind: "parent",
            sourceId: "old-parent",
            reason: "lifecycle_mismatch",
          },
        ],
      }),
    ];
    expect(db.importTaskRecords("owner", records, now)).toEqual({
      created: 4,
      existing: 0,
    });
    expect(db.importTaskRecords("owner", records, later)).toEqual({
      created: 0,
      existing: 4,
    });
    const check = (database: SuiteDatabase) => {
      expect(
        database
          .listTasks("owner")
          .map(({ title }) => title)
          .toSorted(),
      ).toEqual(["detached", "live"]);
      const page = database.taskArchive.history({ ownerId: "owner" });
      expect(page.total).toBe(1);
      expect(page.entries[0]).toMatchObject({
        task: {
          title: "old-parent",
          createdAt: "2025-12-01T00:00:00.000Z",
          completedAt: "2026-01-02T03:04:05.000Z",
          archivedAt: now,
          projectId: null,
        },
        provenance: {
          source: "super_productivity",
          sourceStore: "archiveOld",
          review: [],
          historicalReferences: [
            {
              kind: "project",
              sourceId: "gone",
              reason: "missing_from_export",
            },
            { kind: "tag", sourceId: "EM_URGENT", reason: "system_tag" },
          ],
        },
        children: [
          {
            task: { title: "Untitled archived task" },
            provenance: { review: ["blank_title"], historicalReferences: [] },
          },
        ],
      });
      const detached = database
        .listTasks("owner")
        .find(({ title }) => title === "detached");
      expect(detached?.parentId).toBeNull();
      expect(
        database.taskArchive.provenance("owner", detached?.id ?? ""),
      ).toMatchObject({
        sourceStore: "task",
        historicalReferences: [
          { kind: "parent", reason: "lifecycle_mismatch" },
        ],
      });
    };
    check(db);
    const backupPath = join(directory, "backup", "suite.sqlite");
    db.backup(backupPath);
    db.close();
    const reopened = SuiteDatabase.open(join(directory, "suite.sqlite"));
    check(reopened);
    reopened.close();
    const restoredBackup = SuiteDatabase.open(backupPath);
    check(restoredBackup);
    restoredBackup.close();
  });
});
