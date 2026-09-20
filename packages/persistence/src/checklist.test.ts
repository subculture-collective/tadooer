import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { withTemporaryDirectory } from "@suite/test-support";
import { SuiteDatabase } from "./index.ts";

it("keeps checklist changes and sync atomic, validates complete ordering and protects missing parents", async () => {
  await withTemporaryDirectory((directory) => {
    const now = "2026-09-20T12:00:00.000Z",
      ownerId = randomUUID(),
      taskId = randomUUID(),
      first = randomUUID(),
      second = randomUUID();
    const path = join(directory, "suite.sqlite");
    let db = SuiteDatabase.open(path);
    db.createOwner({
      id: ownerId,
      username: "owner",
      displayName: "Owner",
      passwordHash: "hash",
      createdAt: now,
    });
    db.createTaskIdempotently(ownerId, taskId, "create", {
      id: taskId,
      title: "Parent",
      notes: "",
      status: "open",
      revision: 1,
      createdAt: now,
      updatedAt: now,
    });
    for (const [id, position] of [
      [first, 0],
      [second, 1],
    ] as const)
      expect(
        db.mutateChecklist(
          ownerId,
          { action: "create", taskId, id, title: "Step", position },
          now,
          1,
        ),
      ).toBeDefined();
    const before = db.getSyncState(ownerId);
    expect(
      db.mutateChecklist(
        ownerId,
        { action: "reorder", taskId, items: [{ id: first, revision: 1 }] },
        now,
      ),
    ).toBeUndefined();
    expect(
      db.mutateChecklist(
        ownerId,
        {
          action: "reorder",
          taskId,
          items: [
            { id: first, revision: 1 },
            { id: second, revision: 2 },
          ],
        },
        now,
      ),
    ).toBeUndefined();
    expect(
      db.mutateChecklist(
        ownerId,
        {
          action: "update",
          taskId,
          id: first,
          expectedRevision: 1,
          patch: { title: " " },
        },
        now,
      ),
    ).toBeUndefined();
    expect(
      db.mutateChecklist(
        "other",
        { action: "delete", taskId, id: first, expectedRevision: 1 },
        now,
      ),
    ).toBeUndefined();
    expect(
      db.mutateChecklist(
        ownerId,
        { action: "delete", taskId, id: first, expectedRevision: 1 },
        now,
        2,
      ),
    ).toBeUndefined();
    expect(db.getSyncState(ownerId)).toEqual(before);
    const raw = new DatabaseSync(path);
    raw.exec(
      "CREATE TRIGGER fail_checklist_sync BEFORE INSERT ON sync_changes WHEN NEW.entity_type='subtask' BEGIN SELECT RAISE(ABORT, 'injected checklist sync failure'); END;",
    );
    expect(() =>
      db.mutateChecklist(
        ownerId,
        { action: "delete", taskId, id: first, expectedRevision: 1 },
        now,
      ),
    ).toThrow("injected checklist sync failure");
    expect(() =>
      db.mutateChecklist(
        ownerId,
        {
          action: "update",
          taskId,
          id: first,
          expectedRevision: 1,
          patch: { completed: true },
        },
        now,
      ),
    ).toThrow("injected checklist sync failure");
    expect(() =>
      db.mutateChecklist(
        ownerId,
        {
          action: "reorder",
          taskId,
          items: [
            { id: second, revision: 1 },
            { id: first, revision: 1 },
          ],
        },
        now,
      ),
    ).toThrow("injected checklist sync failure");
    expect(db.listSubtasks(ownerId, taskId)).toMatchObject([
      { id: first, revision: 1, completed: false, position: 0 },
      { id: second, revision: 1, position: 1 },
    ]);
    expect(db.getSyncState(ownerId)).toEqual(before);
    raw.exec("DROP TRIGGER fail_checklist_sync;");
    expect(
      db.mutateChecklist(
        ownerId,
        {
          action: "reorder",
          taskId,
          items: [
            { id: second, revision: 1 },
            { id: first, revision: 1 },
          ],
        },
        now,
      ),
    ).toMatchObject([
      { id: second, revision: 2, position: 0 },
      { id: first, revision: 2, position: 1 },
    ]);
    db.mutateChecklist(
      ownerId,
      {
        action: "update",
        taskId,
        id: first,
        expectedRevision: 2,
        patch: { completed: true, title: "Done" },
      },
      now,
    );
    db.mutateChecklist(
      ownerId,
      { action: "delete", taskId, id: second, expectedRevision: 2 },
      now,
    );
    expect(
      raw
        .prepare(
          "SELECT kind,revision FROM sync_changes WHERE entity_id=? ORDER BY sequence DESC LIMIT 1",
        )
        .get(second),
    ).toMatchObject({ kind: "deleted", revision: 3 });
    raw.close();
    db.close();
    db = SuiteDatabase.open(path);
    expect(db.listSubtasks(ownerId, taskId)).toMatchObject([
      { id: first, title: "Done", completed: true, revision: 3 },
    ]);
    db.deleteTask(ownerId, taskId, 1, now);
    expect(db.getSubtask(ownerId, first)).toBeUndefined();
    expect(
      db.mutateChecklist(
        ownerId,
        { action: "delete", taskId, id: first, expectedRevision: 3 },
        now,
      ),
    ).toBeUndefined();
    expect(
      db.mutateChecklist(
        ownerId,
        {
          action: "create",
          taskId,
          id: randomUUID(),
          title: "No parent",
          position: 0,
        },
        now,
      ),
    ).toBeUndefined();
    db.close();
  });
});
