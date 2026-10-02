import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { withTemporaryDirectory } from "@suite/test-support";
import { SuiteDatabase, type TaskRecord } from "./index.ts";

/** Saved day orders in the sync feed (ADR 0050, issue #114). */

const owner = "owner-1";
const client = "client-1";
const now = "2026-10-02T12:00:00.000Z";
const later = "2026-10-02T13:00:00.000Z";
const day = "2026-10-03";
const otherDay = "2026-10-04";

const open = (directory: string): SuiteDatabase => {
  const database = SuiteDatabase.open(join(directory, "suite.sqlite"));
  // A reopened database already has its owner and client.
  if (
    !database.createOwner({
      id: owner,
      username: "owner",
      displayName: "Owner",
      passwordHash: "hash",
      createdAt: now,
    })
  )
    return database;
  database.registerSyncClient({
    id: client,
    ownerId: owner,
    label: "Laptop",
    credentialHash: "credential-hash",
    createdAt: now,
    lastSeenAt: now,
    revokedAt: null,
  });
  return database;
};

const task = (
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

/** The task leaves the day: it is planned for another date. */
const leaveDay = (database: SuiteDatabase, id: string): void => {
  const current = database.getTask(owner, id);
  if (current === undefined) throw new Error("task is missing");
  const result = database.patchTask(
    owner,
    id,
    current.revision,
    { plannedDay: "2026-10-09" },
    later,
  );
  if (result.kind !== "updated") throw new Error("task did not move");
};

const reorder = (
  operationId: string,
  baseRevision: number,
  taskIds: readonly string[],
  at = now,
) => ({
  ownerId: owner,
  clientId: client,
  operationId,
  requestHash: `${operationId}-hash`,
  date: day,
  baseRevision,
  taskIds,
  now: at,
});

const dayOrderChanges = (database: SuiteDatabase) =>
  database
    .listSyncChanges(owner, database.getSyncState(owner).epoch, 0)
    .filter(({ entityType }) => entityType === "day_order")
    .map(({ entityId, kind, revision }) => ({ entityId, kind, revision }));

describe("ADR 0050 saved day orders in the sync feed", () => {
  it("applies a reorder from the outbox idempotently and across a restart", async () => {
    await withTemporaryDirectory((directory) => {
      let database = open(directory);
      for (const id of ["a", "b", "c"]) task(database, id);
      const first = reorder("first", 0, ["c", "a", "b"]);
      expect(database.applyDayOrderSync(first)).toEqual({
        kind: "applied",
        revision: 1,
        record: {
          date: day,
          revision: 1,
          taskIds: ["c", "a", "b"],
          updatedAt: now,
        },
      });
      // A replay returns the stored outcome and writes nothing.
      expect(database.applyDayOrderSync(first)).toMatchObject({
        kind: "replayed",
        revision: 1,
      });
      // The same operation ID with another payload is refused.
      expect(
        database.applyDayOrderSync({ ...first, requestHash: "other" }).kind,
      ).toBe("idempotency-conflict");
      // Two offline reorders in a row: the second is based on the revision
      // the first produces.
      expect(
        database.applyDayOrderSync(
          reorder("second", 1, ["b", "c", "a"], later),
        ),
      ).toMatchObject({
        kind: "applied",
        revision: 2,
        record: { taskIds: ["b", "c", "a"], updatedAt: later },
      });
      expect(dayOrderChanges(database)).toEqual([
        { entityId: day, kind: "upsert", revision: 1 },
        { entityId: day, kind: "upsert", revision: 2 },
      ]);
      database.close();

      database = open(directory);
      expect(database.applyDayOrderSync(first)).toMatchObject({
        kind: "replayed",
        revision: 1,
      });
      expect(database.dayOrders.getSaved(owner, day)).toEqual({
        date: day,
        revision: 2,
        taskIds: ["b", "c", "a"],
        updatedAt: later,
      });
      expect(dayOrderChanges(database)).toHaveLength(2);
      database.close();
    });
  });

  it("makes a reorder of a stale revision a conflict that changes nothing", async () => {
    await withTemporaryDirectory((directory) => {
      let database = open(directory);
      for (const id of ["a", "b", "c"]) task(database, id);
      // Another device saved an order first.
      database.dayOrders.reorder({
        ownerId: owner,
        date: day,
        expectedRevision: 0,
        taskIds: ["b", "a", "c"],
        now,
      });
      const stale = reorder("stale", 0, ["c", "b", "a"], later);
      expect(database.applyDayOrderSync(stale)).toEqual({
        kind: "conflict",
        fields: ["revision"],
        revision: 1,
        record: {
          date: day,
          revision: 1,
          taskIds: ["b", "a", "c"],
          updatedAt: now,
        },
      });
      // The saved order is untouched and is re-sent to the client.
      expect(database.dayOrders.get(owner, day).taskIds).toEqual([
        "b",
        "a",
        "c",
      ]);
      expect(dayOrderChanges(database)).toEqual([
        { entityId: day, kind: "upsert", revision: 1 },
        { entityId: day, kind: "upsert", revision: 1 },
      ]);
      // A base revision for a date with no saved order is a conflict with
      // no record to re-send.
      expect(
        database.applyDayOrderSync({
          ...reorder("ahead", 3, ["a"]),
          date: otherDay,
        }),
      ).toEqual({ kind: "conflict", fields: ["revision"] });
      expect(database.dayOrders.getSaved(owner, otherDay)).toBeUndefined();

      // A stored conflict replays as the same conflict after a restart.
      database.close();
      database = open(directory);
      const changes = dayOrderChanges(database).length;
      expect(database.applyDayOrderSync(stale)).toMatchObject({
        kind: "conflict",
        fields: ["revision"],
        record: { taskIds: ["b", "a", "c"] },
      });
      expect(dayOrderChanges(database)).toHaveLength(changes);
      database.close();
    });
  });

  it("reconciles membership instead of refusing a reorder", async () => {
    await withTemporaryDirectory((directory) => {
      const database = open(directory);
      for (const id of ["a", "b", "c", "d"]) task(database, id);
      task(database, "elsewhere", { plannedDay: otherDay });
      // Since the client reordered: "b" was moved to another date on another device and
      // "d" was planned for the day. The client still names "b", names a
      // task of another day and a task that does not exist, and repeats
      // "c"; it does not know "d".
      leaveDay(database, "b");
      expect(
        database.applyDayOrderSync(
          reorder("offline", 0, ["c", "b", "elsewhere", "ghost", "c", "a"]),
        ),
      ).toMatchObject({
        kind: "applied",
        revision: 1,
        // Named members in the named order, then the member not named.
        record: { taskIds: ["c", "a", "d"] },
      });
      expect(database.dayOrders.get(owner, day)).toEqual({
        date: day,
        revision: 1,
        taskIds: ["c", "a", "d"],
      });
      // Every task left the day: the reorder still applies and saves an
      // empty order at the next revision, as the client assumed.
      for (const id of ["a", "c", "d"]) leaveDay(database, id);
      expect(
        database.applyDayOrderSync(reorder("empty", 1, ["a", "c", "d"], later)),
      ).toMatchObject({
        kind: "applied",
        revision: 2,
        record: { taskIds: [] },
      });
      database.close();
    });
  });

  it("carries saved orders in the snapshot and appends a change on every store path", async () => {
    await withTemporaryDirectory((directory) => {
      const database = open(directory);
      for (const id of ["a", "b", "c"]) task(database, id);
      const inbox = task(database, "inbox", { plannedDay: null });
      task(database, "x", { plannedDay: otherDay });
      task(database, "y", { plannedDay: otherDay });
      // No saved order yet: nothing in the snapshot or the feed.
      expect(database.fullSyncSnapshot(owner).dayOrders).toEqual([]);
      expect(dayOrderChanges(database)).toEqual([]);

      // The browser route and the assistant both call `reorder`.
      const write = (expectedRevision: number, taskIds: string[]) =>
        database.dayOrders.reorder({
          ownerId: owner,
          date: day,
          expectedRevision,
          taskIds,
          now,
        });
      expect(write(0, ["c", "b", "a"]).kind).toBe("applied");
      // A refused write and a resubmission of the saved order append nothing.
      expect(write(0, ["a", "b", "c"]).kind).toBe("conflict");
      expect(write(1, ["c", "b"]).kind).toBe("conflict");
      expect(write(1, ["c", "b", "a"]).kind).toBe("applied");
      expect(dayOrderChanges(database)).toEqual([
        { entityId: day, kind: "upsert", revision: 1 },
      ]);
      // Plan tasks for the date (plan tomorrow).
      expect(
        database.dayOrders.plan({
          ownerId: owner,
          date: day,
          expectedRevision: 1,
          tasks: [{ taskId: inbox.id, expectedRevision: inbox.revision }],
          now: later,
        }).kind,
      ).toBe("applied");
      // The importer saves an order only for a date that has none.
      expect(
        database.dayOrders.importOrders(
          owner,
          [
            { date: day, taskIds: ["a", "b", "c"] },
            { date: otherDay, taskIds: ["y", "x"] },
          ],
          later,
        ),
      ).toBe(1);
      expect(dayOrderChanges(database)).toEqual([
        { entityId: day, kind: "upsert", revision: 1 },
        { entityId: day, kind: "upsert", revision: 2 },
        { entityId: otherDay, kind: "upsert", revision: 1 },
      ]);
      expect(database.fullSyncSnapshot(owner).dayOrders).toEqual([
        {
          date: day,
          revision: 2,
          taskIds: ["c", "b", "a", "inbox"],
          updatedAt: later,
        },
        { date: otherDay, revision: 1, taskIds: ["y", "x"], updatedAt: later },
      ]);
      // The plan also announced the task whose planned day it set.
      expect(
        database
          .listSyncChanges(owner, database.getSyncState(owner).epoch, 0)
          .filter(
            ({ entityType, entityId }) =>
              entityType === "task" && entityId === inbox.id,
          ).length,
      ).toBeGreaterThan(1);
      database.close();
    });
  });

  it("keeps the saved ranks of a task that left the day until the next write", async () => {
    await withTemporaryDirectory((directory) => {
      const database = open(directory);
      for (const id of ["a", "b", "c"]) task(database, id);
      database.applyDayOrderSync(reorder("first", 0, ["c", "b", "a"]));
      leaveDay(database, "b");
      // The feed record is the saved ranks: "b" stays until the next write
      // and the client filters it by membership, exactly as a read does.
      expect(database.dayOrders.getSaved(owner, day)?.taskIds).toEqual([
        "c",
        "b",
        "a",
      ]);
      expect(database.dayOrders.get(owner, day).taskIds).toEqual(["c", "a"]);
      expect(dayOrderChanges(database)).toHaveLength(1);
      database.close();
    });
  });

  it("resets the sync epoch once so existing clients receive existing day orders", async () => {
    await withTemporaryDirectory((directory) => {
      const path = join(directory, "suite.sqlite");
      let database = open(directory);
      for (const id of ["a", "b"]) task(database, id);
      database.dayOrders.reorder({
        ownerId: owner,
        date: day,
        expectedRevision: 0,
        taskIds: ["b", "a"],
        now,
      });
      const before = database.getSyncState(owner);
      expect(before.cursor).toBeGreaterThan(0);
      database.close();
      // A database from before migration 0050: the saved order exists but
      // no feed change announces it, and the retained floor is above zero.
      const legacy = new DatabaseSync(path);
      legacy.exec(
        "DELETE FROM sync_changes WHERE entity_type='day_order'; UPDATE sync_owner_state SET retained_floor=1; DELETE FROM schema_migrations WHERE id='0050_sync_day_orders_time_entries_epoch_reset';",
      );
      legacy.close();

      database = open(directory);
      try {
        expect(database.state().appliedMigrationCount).toBe(
          database.state().expectedMigrationCount,
        );
        const after = database.getSyncState(owner);
        expect(after.epoch).not.toBe(before.epoch);
        expect(after.cursor).toBe(0);
        expect(database.getSyncRetention(owner).floor).toBe(0);
        // The old cursor cannot be served: the client takes a snapshot,
        // which carries the saved order.
        expect(
          database.pageSyncChanges(owner, before.epoch, before.cursor)
            .resetRequired,
        ).toBe(true);
        expect(database.fullSyncSnapshot(owner).dayOrders).toMatchObject([
          { date: day, revision: 1, taskIds: ["b", "a"] },
        ]);
      } finally {
        database.close();
      }
    });
  });
});
