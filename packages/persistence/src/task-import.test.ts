import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { withTemporaryDirectory } from "@suite/test-support";
import { SuiteDatabase } from "./index.ts";
const now = "2026-09-20T12:00:00.000Z";
const task = {
  kind: "task" as const,
  sourceId: "source",
  sourceHash: "hash",
  sourceJson: '{"title":"Imported"}',
  title: "Imported",
  notes: "Original notes",
  projectId: null,
  tagIds: [],
  plannedStart: null,
  deadlineDate: "2026-09-21",
  deadlineAt: null,
  estimateMinutes: 30,
  completedAt: "2026-09-19T12:00:00.000Z",
  createdAt: "2026-09-18T12:00:00.000Z",
};
it("keeps source identity across edits, deletion, and database restart", async () => {
  await withTemporaryDirectory((directory) => {
    const path = join(directory, "db.sqlite");
    let db = SuiteDatabase.open(path);
    db.createOwner({
      id: "owner",
      username: "owner",
      displayName: "Owner",
      passwordHash: "hash",
      createdAt: now,
    });
    expect(db.importTaskRecords("owner", [task], now)).toEqual({
      created: 1,
      existing: 0,
    });
    const imported = db.listTasks("owner")[0];
    if (!imported) throw new Error("Missing import");
    expect(imported).toMatchObject({
      notes: task.notes,
      completedAt: task.completedAt,
      createdAt: task.createdAt,
      status: "completed",
      deadlineDate: task.deadlineDate,
    });
    db.patchTask("owner", imported.id, 1, { title: "Local edit" }, now);
    db.close();
    db = SuiteDatabase.open(path);
    expect(db.importTaskRecords("owner", [task], now)).toEqual({
      created: 0,
      existing: 1,
    });
    expect(db.getTask("owner", imported.id)?.title).toBe("Local edit");
    db.deleteTask("owner", imported.id, 2, now);
    expect(db.importTaskRecords("owner", [task], now)).toEqual({
      created: 0,
      existing: 1,
    });
    expect(db.listTasks("owner")).toEqual([]);
    expect(() =>
      db.importTaskRecords(
        "owner",
        [
          { ...task, sourceId: "new" },
          { ...task, sourceHash: "changed" },
        ],
        now,
      ),
    ).toThrow("IMPORT_SOURCE_CHANGED");
    expect(db.listTasks("owner")).toEqual([]);
    expect(() => db.importTaskRecords("another-owner", [task], now)).toThrow();
    expect(db.listTasks("owner")).toEqual([]);
    db.close();
  });
});
it("rolls back tasks, source mappings, and sync changes when a receipt cannot be stored", async () => {
  await withTemporaryDirectory((directory) => {
    const path = join(directory, "db.sqlite");
    const db = SuiteDatabase.open(path);
    db.createOwner({
      id: "owner",
      username: "owner",
      displayName: "Owner",
      passwordHash: "hash",
      createdAt: now,
    });
    const before = db.getSyncState("owner");
    const fault = new DatabaseSync(path);
    fault.exec(
      "CREATE TRIGGER fail_import BEFORE INSERT ON task_import_sources BEGIN SELECT RAISE(ABORT,'synthetic failure'); END;",
    );
    expect(() => db.importTaskRecords("owner", [task], now)).toThrow();
    expect(db.listTasks("owner")).toEqual([]);
    expect(db.getSyncState("owner")).toEqual(before);
    fault.exec("DROP TRIGGER fail_import");
    fault.close();
    expect(db.importTaskRecords("owner", [task], now)).toEqual({
      created: 1,
      existing: 0,
    });
    db.close();
  });
});
