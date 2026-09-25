import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { withTemporaryDirectory } from "@suite/test-support";
import { SuiteDatabase, type TaskRecord } from "./index.ts";

const now = "2026-09-24T12:00:00.000Z";
const owner = "planning-owner";

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
) => {
  const result = database.createTaskIdempotently(owner, id, id, {
    id,
    title: id,
    notes: "",
    status: "open",
    revision: 1,
    createdAt: now,
    updatedAt: now,
    ...fields,
  });
  if (result.kind !== "created") throw new Error("task was not created");
  return result.task;
};

const patched = (
  result: ReturnType<SuiteDatabase["patchTask"]>,
): TaskRecord => {
  if (result.kind !== "updated") throw new Error(result.kind);
  return result.task;
};

describe("date-only planning persistence", () => {
  it("stores a planned day exactly and keeps it exclusive with an exact start", async () => {
    await withTemporaryDirectory((directory) => {
      const path = join(directory, "suite.sqlite");
      let database = open(path);
      const task = create(database, "day-task", { plannedDay: "2026-03-08" });
      expect(task).toMatchObject({
        plannedDay: "2026-03-08",
        plannedStart: null,
        startReminder: { kind: "default" },
      });
      const timed = patched(
        database.patchTask(
          owner,
          task.id,
          1,
          { plannedStart: "2026-03-08T15:00:00.000Z" },
          now,
        ),
      );
      expect(timed).toMatchObject({
        plannedStart: "2026-03-08T15:00:00.000Z",
        plannedDay: null,
        revision: 2,
      });
      const dated = patched(
        database.patchTask(
          owner,
          task.id,
          2,
          { plannedDay: "2026-11-01" },
          now,
        ),
      );
      expect(dated).toMatchObject({
        plannedStart: null,
        plannedDay: "2026-11-01",
      });
      // Unrelated edits leave the plan alone and still bump the revision.
      expect(
        patched(
          database.patchTask(owner, task.id, 3, { title: "Renamed" }, now),
        ),
      ).toMatchObject({ plannedDay: "2026-11-01", revision: 4 });
      const { epoch } = database.getSyncState(owner);
      expect(
        database
          .listSyncChanges(owner, epoch, 0)
          .filter(({ entityId }) => entityId === task.id)
          .map(({ revision }) => revision),
      ).toEqual([1, 2, 3, 4]);
      database.close();
      database = open(path);
      expect(database.getTask(owner, task.id)).toMatchObject({
        plannedDay: "2026-11-01",
        plannedStart: null,
      });
      database.close();
      const raw = new DatabaseSync(path);
      expect(() =>
        raw
          .prepare("UPDATE tasks SET planned_start=? WHERE id=?")
          .run("2026-11-01T15:00:00.000Z", task.id),
      ).toThrow(/inconsistent/);
      expect(() =>
        raw
          .prepare("UPDATE tasks SET planned_day=? WHERE id=?")
          .run("2026-11-1", task.id),
      ).toThrow();
      raw.close();
    });
  });

  it("keeps reminder settings and drops a deadline reminder once the deadline has no time", async () => {
    await withTemporaryDirectory((directory) => {
      const database = open(join(directory, "suite.sqlite"));
      const task = create(database, "reminder-task", {
        plannedStart: "2026-09-24T15:00:00.000Z",
        startReminder: { kind: "before_start", minutes: 30 },
        deadlineAt: "2026-09-25T17:00:00.000Z",
        deadlineReminderMinutes: 60,
      });
      expect(task).toMatchObject({
        startReminder: { kind: "before_start", minutes: 30 },
        deadlineReminderMinutes: 60,
      });
      const cleared = patched(
        database.patchTask(
          owner,
          task.id,
          1,
          { deadlineDate: "2026-09-25", deadlineAt: null },
          now,
        ),
      );
      expect(cleared).toMatchObject({
        deadlineDate: "2026-09-25",
        deadlineReminderMinutes: null,
        startReminder: { kind: "before_start", minutes: 30 },
      });
      expect(database.getTask(owner, task.id)).toMatchObject({
        deadlineReminderMinutes: null,
      });
      database.close();
    });
  });

  it("round-trips an imported planned day and reminder intent", async () => {
    await withTemporaryDirectory((directory) => {
      const database = open(join(directory, "suite.sqlite"));
      const record = {
        kind: "task" as const,
        sourceHash: "hash",
        title: "Imported",
        notes: "",
        projectId: null,
        tagIds: [],
        deadlineDate: null,
        estimateMinutes: null,
        completedAt: null,
        createdAt: null,
      };
      expect(
        database.importTaskRecords(
          owner,
          [
            {
              ...record,
              sourceId: "day",
              sourceJson: '{"dueDay":"2026-03-08"}',
              plannedStart: null,
              plannedDay: "2026-03-08",
              deadlineAt: null,
            },
            {
              ...record,
              sourceId: "timed",
              sourceJson: "{}",
              plannedStart: "2026-09-24T15:00:00.000Z",
              startReminder: { kind: "none" },
              deadlineAt: "2026-09-25T17:00:00.000Z",
              deadlineReminderMinutes: 15,
            },
          ],
          now,
        ),
      ).toEqual({ created: 2, existing: 0 });
      const imported = database.listTasks(owner);
      expect(imported.map((task) => task.plannedDay).toSorted()).toEqual([
        "2026-03-08",
        null,
      ]);
      expect(
        imported.find(({ plannedStart }) => plannedStart !== null),
      ).toMatchObject({
        startReminder: { kind: "none" },
        deadlineReminderMinutes: 15,
      });
      database.close();
    });
  });
});

describe("per-task reminder ledger", () => {
  const preferences = {
    enabled: true,
    leadReminderEnabled: true,
    atStartReminderEnabled: true,
    detailedContentEnabled: false,
  };
  const deliver = (database: SuiteDatabase, at: string): number => {
    let count = 0;
    for (const due of database.listDueNotificationDeliveries(at)) {
      if (database.claimNotificationDelivery(due.id, at) === undefined)
        continue;
      database.finishNotificationDelivery(due.id, "delivered", null, at);
      count++;
    }
    return count;
  };

  it("moves unattempted rows on offset changes, never recreates delivered reminders, and survives restart", async () => {
    await withTemporaryDirectory((directory) => {
      const path = join(directory, "suite.sqlite");
      let database = open(path);
      const reconcile = (at: string): void =>
        database.reconcileNotificationDeliveries({
          ownerId: owner,
          tasks: database.listTasks(owner),
          preferences,
          now: at,
        });
      const task = create(database, "offset-task", {
        plannedStart: "2026-09-24T15:00:00.000Z",
        startReminder: { kind: "before_start", minutes: 30 },
      });
      reconcile(now);
      expect(
        database.listDueNotificationDeliveries("2026-09-24T14:30:00.000Z"),
      ).toEqual([
        expect.objectContaining({
          kind: "lead",
          dueAt: "2026-09-24T14:30:00.000Z",
        }),
      ]);
      // Offset change before any attempt moves the same ledger row.
      patched(
        database.patchTask(
          owner,
          task.id,
          1,
          { startReminder: { kind: "before_start", minutes: 60 } },
          now,
        ),
      );
      reconcile(now);
      const moved = database.listDueNotificationDeliveries(
        "2026-09-24T14:00:00.000Z",
      );
      expect(moved).toEqual([
        expect.objectContaining({
          kind: "lead",
          dueAt: "2026-09-24T14:00:00.000Z",
        }),
      ]);
      expect(deliver(database, "2026-09-24T14:00:00.000Z")).toBe(1);
      // A later offset change cannot resend the delivered lead reminder.
      patched(
        database.patchTask(
          owner,
          task.id,
          2,
          { startReminder: { kind: "before_start", minutes: 5 } },
          "2026-09-24T14:01:00.000Z",
        ),
      );
      reconcile("2026-09-24T14:01:00.000Z");
      expect(
        database.listDueNotificationDeliveries("2026-09-24T14:55:00.000Z"),
      ).toEqual([]);
      database.close();
      database = open(path);
      reconcile("2026-09-24T14:56:00.000Z");
      expect(
        database.listDueNotificationDeliveries("2026-09-24T15:00:00.000Z"),
      ).toEqual([]);
      // An at-start row cancelled by "none" was never published, so returning
      // to the default reactivates it; the delivered lead stays final.
      patched(
        database.patchTask(
          owner,
          task.id,
          3,
          { startReminder: { kind: "before_start", minutes: 0 } },
          "2026-09-24T14:56:00.000Z",
        ),
      );
      reconcile("2026-09-24T14:56:00.000Z");
      patched(
        database.patchTask(
          owner,
          task.id,
          4,
          { startReminder: { kind: "none" } },
          "2026-09-24T14:56:30.000Z",
        ),
      );
      reconcile("2026-09-24T14:56:30.000Z");
      expect(
        database.listDueNotificationDeliveries("2026-09-24T15:00:00.000Z"),
      ).toEqual([]);
      patched(
        database.patchTask(
          owner,
          task.id,
          5,
          { startReminder: { kind: "default" } },
          "2026-09-24T14:57:00.000Z",
        ),
      );
      reconcile("2026-09-24T14:57:00.000Z");
      expect(
        database
          .listDueNotificationDeliveries("2026-09-24T15:00:00.000Z")
          .map(({ kind }) => kind),
      ).toEqual(["at_start"]);
      expect(deliver(database, "2026-09-24T15:00:00.000Z")).toBe(1);
      reconcile("2026-09-24T15:01:00.000Z");
      expect(
        database.listDueNotificationDeliveries("2026-09-24T16:00:00.000Z"),
      ).toEqual([]);
      database.close();
    });
  });

  it("gives deadline reminders their own ledger kind and no reminders to date-only plans", async () => {
    await withTemporaryDirectory((directory) => {
      const database = open(join(directory, "suite.sqlite"));
      create(database, "deadline-task", {
        deadlineAt: "2026-09-25T17:00:00.000Z",
        deadlineReminderMinutes: 15,
      });
      create(database, "day-task", {
        plannedDay: "2026-09-24",
        startReminder: { kind: "before_start", minutes: 0 },
      });
      database.reconcileNotificationDeliveries({
        ownerId: owner,
        tasks: database.listTasks(owner),
        preferences,
        now,
      });
      expect(
        database.listDueNotificationDeliveries("2026-09-26T00:00:00.000Z"),
      ).toEqual([
        expect.objectContaining({
          kind: "deadline",
          occurrenceStart: "2026-09-25T17:00:00.000Z",
          dueAt: "2026-09-25T16:45:00.000Z",
        }),
      ]);
      database.close();
    });
  });
});
