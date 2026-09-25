import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { withTemporaryDirectory } from "@suite/test-support";
import { SuiteDatabase, type TaskRecord } from "./index.ts";

const now = "2026-09-24T12:00:00.000Z";
const owner = "order-owner";
const day = "2026-09-25";

const open = (path: string): SuiteDatabase => {
  const database = SuiteDatabase.open(path);
  if (database.findOwnerById(owner) === undefined)
    database.createOwner({
      id: owner,
      username: owner,
      displayName: "Owner",
      passwordHash: "hash",
      createdAt: now,
    });
  return database;
};

const create = (
  database: SuiteDatabase,
  id: string,
  fields: Partial<TaskRecord> = {},
): TaskRecord => {
  const result = database.createTaskIdempotently(owner, id, id, {
    id,
    title: id,
    notes: "",
    status: "open",
    revision: 1,
    createdAt: now,
    updatedAt: now,
    plannedDay: day,
    ...fields,
  });
  if (result.kind !== "created") throw new Error("task was not created");
  return result.task;
};

const withDatabase = async (
  run: (database: SuiteDatabase, path: string) => void,
) =>
  withTemporaryDirectory((directory) => {
    const path = join(directory, "suite.sqlite");
    const database = open(path);
    try {
      run(database, path);
    } finally {
      database.close();
    }
  });

describe("saved day order persistence (ADR 0027)", () => {
  it("derives members and falls back to task ID order before any save", async () => {
    await withDatabase((database) => {
      create(database, "c");
      create(database, "a");
      create(database, "b");
      create(database, "timed", {
        plannedDay: null,
        plannedStart: "2026-09-25T15:00:00.000Z",
      });
      create(database, "other-day", { plannedDay: "2026-09-26" });
      expect(database.dayOrders.get(owner, day)).toEqual({
        date: day,
        revision: 0,
        taskIds: ["a", "b", "c"],
      });
      expect(
        database.dayOrders.list(owner, "2026-09-24", "2026-09-26"),
      ).toEqual([
        { date: day, revision: 0, taskIds: ["a", "b", "c"] },
        { date: "2026-09-26", revision: 0, taskIds: ["other-day"] },
      ]);
    });
  });

  it("rejects stale revisions and partial lists without changing the order", async () => {
    await withDatabase((database) => {
      for (const id of ["a", "b", "c"]) create(database, id);
      const reorder = (expectedRevision: number, taskIds: string[]) =>
        database.dayOrders.reorder({
          ownerId: owner,
          date: day,
          expectedRevision,
          taskIds,
          now,
        });
      expect(reorder(0, ["c", "a"])).toMatchObject({
        kind: "conflict",
        reason: "membership",
      });
      expect(reorder(0, ["c", "a", "b", "timed"])).toMatchObject({
        kind: "conflict",
        reason: "membership",
      });
      expect(reorder(1, ["c", "a", "b"])).toMatchObject({
        kind: "conflict",
        reason: "revision",
      });
      expect(reorder(0, ["c", "a", "b"])).toEqual({
        kind: "applied",
        dayOrder: { date: day, revision: 1, taskIds: ["c", "a", "b"] },
      });
      // A replay of the same request is stale; the order is unchanged.
      expect(reorder(0, ["c", "a", "b"])).toMatchObject({
        kind: "conflict",
        reason: "revision",
        dayOrder: { revision: 1, taskIds: ["c", "a", "b"] },
      });
      // Resubmitting the saved order at the current revision is a no-op.
      expect(reorder(1, ["c", "a", "b"])).toEqual({
        kind: "applied",
        dayOrder: { date: day, revision: 1, taskIds: ["c", "a", "b"] },
      });
    });
  });

  it("ignores tasks that leave the day and prunes them on the next write", async () => {
    await withDatabase((database) => {
      for (const id of ["a", "b", "c", "d", "e"]) create(database, id);
      database.dayOrders.reorder({
        ownerId: owner,
        date: day,
        expectedRevision: 0,
        taskIds: ["e", "d", "c", "b", "a"],
        now,
      });
      // Complete, reschedule, give a time, delete and archive one task each.
      expect(database.setTaskCompleted(owner, "e", 1, true, now).kind).toBe(
        "updated",
      );
      expect(
        database.patchTask(owner, "d", 1, { plannedDay: "2026-09-26" }, now)
          .kind,
      ).toBe("updated");
      expect(
        database.patchTask(
          owner,
          "c",
          1,
          { plannedStart: "2026-09-25T15:00:00.000Z" },
          now,
        ).kind,
      ).toBe("updated");
      expect(database.deleteTask(owner, "b", 1, now).kind).toBe("updated");
      create(database, "f");
      expect(database.dayOrders.get(owner, day)).toEqual({
        date: day,
        revision: 1,
        taskIds: ["a", "f"],
      });
      expect(
        database.taskArchive.archive({
          ownerId: owner,
          taskId: "f",
          expectedRevision: 1,
          now,
        }).kind,
      ).toBe("archived");
      expect(database.dayOrders.get(owner, day).taskIds).toEqual(["a"]);
      // The next write keeps only current members.
      expect(
        database.dayOrders.reorder({
          ownerId: owner,
          date: day,
          expectedRevision: 1,
          taskIds: ["a"],
          now,
        }),
      ).toMatchObject({ kind: "applied", dayOrder: { revision: 2 } });
      // A restored task returns to the derived position, not its old slot.
      expect(database.restoreTask(owner, "b", 2, now).kind).toBe("updated");
      expect(database.dayOrders.get(owner, day).taskIds).toEqual(["a", "b"]);
    });
  });

  it("plans tasks for a date in order, all or nothing", async () => {
    await withDatabase((database) => {
      create(database, "member");
      create(database, "inbox", { plannedDay: null });
      create(database, "timed", {
        plannedDay: null,
        plannedStart: "2026-09-24T15:00:00.000Z",
      });
      create(database, "done", { plannedDay: null });
      database.setTaskCompleted(owner, "done", 1, true, now);
      const plan = (
        tasks: { taskId: string; expectedRevision: number }[],
        expectedRevision = 0,
      ) =>
        database.dayOrders.plan({
          ownerId: owner,
          date: day,
          expectedRevision,
          tasks,
          now,
        });
      expect(
        plan([
          { taskId: "inbox", expectedRevision: 1 },
          { taskId: "timed", expectedRevision: 9 },
        ]),
      ).toEqual({ kind: "task-conflict", taskId: "timed" });
      // The failed plan rolled back the first task as well.
      expect(database.getTask(owner, "inbox")).toMatchObject({
        plannedDay: null,
        revision: 1,
      });
      expect(plan([{ taskId: "done", expectedRevision: 2 }])).toEqual({
        kind: "task-invalid",
        taskId: "done",
      });
      expect(plan([{ taskId: "inbox", expectedRevision: 1 }], 3)).toMatchObject(
        { kind: "conflict" },
      );
      expect(
        plan([
          { taskId: "timed", expectedRevision: 1 },
          { taskId: "inbox", expectedRevision: 1 },
        ]),
      ).toEqual({
        kind: "applied",
        dayOrder: {
          date: day,
          revision: 1,
          taskIds: ["member", "timed", "inbox"],
        },
        taskIds: ["timed", "inbox"],
      });
      // Planning a day clears the exact start (ADR 0020).
      expect(database.getTask(owner, "timed")).toMatchObject({
        plannedStart: null,
        plannedDay: day,
        revision: 2,
      });
    });
  });

  it("keeps saved orders and the day start across a restart", async () => {
    await withTemporaryDirectory((directory) => {
      const path = join(directory, "suite.sqlite");
      let database = open(path);
      for (const id of ["a", "b"]) create(database, id);
      database.dayOrders.reorder({
        ownerId: owner,
        date: day,
        expectedRevision: 0,
        taskIds: ["b", "a"],
        now,
      });
      const preferences = database.getPlanningPreferences(owner);
      expect(preferences.dayStartsAt).toBe("00:00");
      database.putPlanningPreferences(
        owner,
        { ...preferences, dayStartsAt: "04:30" },
        now,
      );
      // A client that omits the field keeps the saved value.
      database.putPlanningPreferences(
        owner,
        {
          workingDays: preferences.workingDays,
          workdayStart: "08:00",
          workdayEnd: preferences.workdayEnd,
          breakStart: preferences.breakStart,
          breakEnd: preferences.breakEnd,
          timeZone: preferences.timeZone,
        },
        now,
      );
      database.close();
      database = open(path);
      expect(database.dayOrders.get(owner, day)).toEqual({
        date: day,
        revision: 1,
        taskIds: ["b", "a"],
      });
      expect(database.getPlanningPreferences(owner)).toMatchObject({
        dayStartsAt: "04:30",
        workdayStart: "08:00",
      });
      expect(database.state()).toMatchObject({
        appliedMigrationCount: database.state().expectedMigrationCount,
      });
      database.close();
    });
  });

  it("imports an order once and never overwrites a saved order", async () => {
    await withDatabase((database) => {
      for (const id of ["a", "b", "c"]) create(database, id);
      create(database, "done", { plannedDay: day });
      database.setTaskCompleted(owner, "done", 1, true, now);
      expect(
        database.dayOrders.importOrders(
          owner,
          [{ date: day, taskIds: ["c", "done", "missing", "a", "c"] }],
          now,
        ),
      ).toBe(1);
      expect(database.dayOrders.get(owner, day)).toEqual({
        date: day,
        revision: 1,
        taskIds: ["c", "a", "b"],
      });
      expect(
        database.dayOrders.importOrders(
          owner,
          [{ date: day, taskIds: ["b", "a", "c"] }],
          now,
        ),
      ).toBe(0);
      expect(database.dayOrders.get(owner, day).taskIds).toEqual([
        "c",
        "a",
        "b",
      ]);
    });
  });
});
