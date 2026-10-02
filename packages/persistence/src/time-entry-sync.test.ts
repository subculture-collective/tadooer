import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  syncTimeEntryWindowDays,
  syncTimeEntryWindowStart,
} from "@suite/contracts";
import { withTemporaryDirectory } from "@suite/test-support";
import { SuiteDatabase } from "./index.ts";

/** Stored time entries in the sync feed (ADR 0050, issue #114). */

const owner = "owner-1";
const client = "client-1";
const now = "2026-10-02T12:00:00.000Z";
const later = "2026-10-02T13:00:00.000Z";
const day = "2026-10-02";
const taskId = "00000000-0000-4000-8000-000000000001";
const entryId = "10000000-0000-4000-8000-000000000001";
const second = "10000000-0000-4000-8000-000000000002";
const minutes = (value: number) => value * 60_000;

const open = (directory: string): SuiteDatabase => {
  const database = SuiteDatabase.open(join(directory, "suite.sqlite"));
  // A reopened database already has its owner, client and task.
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
  const created = database.createTaskIdempotently(owner, taskId, taskId, {
    id: taskId,
    title: "Write report",
    notes: "",
    status: "open",
    revision: 1,
    createdAt: now,
    updatedAt: now,
  });
  if (created.kind !== "created") throw new Error("task was not created");
  return database;
};

const envelope = (operationId: string, at = now) => ({
  ownerId: owner,
  clientId: client,
  operationId,
  requestHash: `${operationId}-hash`,
  now: at,
});

const create = (id = entryId, durationMs = minutes(30), workDate = day) => ({
  action: "create" as const,
  id,
  taskId,
  workDate,
  durationMs,
  note: "",
});

const entryChanges = (database: SuiteDatabase) =>
  database
    .listSyncChanges(owner, database.getSyncState(owner).epoch, 0)
    .filter(({ entityType }) => entityType === "time_entry")
    .map(({ entityId, kind, revision }) => ({ entityId, kind, revision }));

/** A finished focus interval on the task, in UTC. */
const focus = (database: SuiteDatabase, startedAt: string, endedAt: string) => {
  const result = database.applyActiveSessionTransition({
    session: {
      id: "20000000-0000-4000-8000-000000000001",
      ownerId: owner,
      taskId,
      controllerClientId: client,
      state: "completed",
      phase: "focus",
      revision: 1,
      startedAt,
      leaseExpiresAt: null,
      hardExpiresAt: "2026-10-04T00:00:00.000Z",
      createdAt: startedAt,
      updatedAt: startedAt,
      endedAt,
    },
    expectedRevision: null,
    clientId: client,
    idempotencyKey: "start-focus",
    requestHash: "hash-focus",
    events: [],
    intervals: [
      {
        id: "20000000-0000-4000-8000-000000000002",
        ordinal: 1,
        phase: "focus",
        taskId,
        controllerClientId: client,
        startedAt,
        endedAt,
        closedBy: "complete",
      },
    ],
    now: startedAt,
  });
  if (result.kind !== "applied") throw new Error("session was not stored");
};

describe("ADR 0050 time entries in the sync feed", () => {
  it("creates, patches and deletes an entry from the outbox idempotently and across a restart", async () => {
    await withTemporaryDirectory((directory) => {
      let database = open(directory);
      const created = { ...envelope("create"), command: create() };
      expect(database.applyTimeEntrySync(created)).toMatchObject({
        kind: "applied",
        revision: 1,
        record: {
          id: entryId,
          source: "manual",
          durationMs: minutes(30),
          workDate: day,
        },
      });
      expect(database.applyTimeEntrySync(created)).toMatchObject({
        kind: "replayed",
        revision: 1,
      });
      expect(
        database.applyTimeEntrySync({ ...created, requestHash: "other" }).kind,
      ).toBe("idempotency-conflict");
      expect(
        database.applyTimeEntrySync({
          ...envelope("patch", later),
          command: {
            action: "update",
            id: entryId,
            baseRevision: 1,
            patch: { durationMs: minutes(45), note: "Longer" },
          },
        }),
      ).toMatchObject({
        kind: "applied",
        revision: 2,
        record: { durationMs: minutes(45), note: "Longer", updatedAt: later },
      });
      const remove = {
        ...envelope("delete", later),
        command: { action: "delete" as const, id: entryId, baseRevision: 2 },
      };
      // A deletion leaves no record; the outcome still carries a revision.
      expect(database.applyTimeEntrySync(remove)).toEqual({
        kind: "applied",
        revision: 3,
      });
      database.close();

      database = open(directory);
      expect(database.applyTimeEntrySync(remove)).toEqual({
        kind: "replayed",
        revision: 3,
      });
      expect(database.timeEntries.get(owner, entryId)).toBeUndefined();
      expect(entryChanges(database)).toEqual([
        { entityId: entryId, kind: "upsert", revision: 1 },
        { entityId: entryId, kind: "upsert", revision: 2 },
        { entityId: entryId, kind: "deleted", revision: 3 },
      ]);
      database.close();
    });
  });

  it("turns a stale, missing or rule-breaking write into a conflict that changes nothing", async () => {
    await withTemporaryDirectory((directory) => {
      let database = open(directory);
      // Days are owner-zone dates; UTC keeps the focus interval below on
      // one day.
      const timeZone = "UTC";
      database.putPlanningPreferences(
        owner,
        { ...database.getPlanningPreferences(owner), timeZone },
        now,
      );
      database.applyTimeEntrySync({ ...envelope("create"), command: create() });
      // Another device edits the entry first.
      database.timeEntries.update({
        ownerId: owner,
        id: entryId,
        expectedRevision: 1,
        patch: { durationMs: minutes(40) },
        timeZone,
        now: later,
      });
      const stale = {
        ...envelope("stale", later),
        command: {
          action: "update" as const,
          id: entryId,
          baseRevision: 1,
          patch: { durationMs: minutes(10) },
        },
      };
      expect(database.applyTimeEntrySync(stale)).toMatchObject({
        kind: "conflict",
        fields: ["revision"],
        revision: 2,
        record: { durationMs: minutes(40), revision: 2 },
      });
      // Nothing was overwritten and the canonical entry is re-sent.
      expect(database.timeEntries.get(owner, entryId)?.durationMs).toBe(
        minutes(40),
      );
      expect(entryChanges(database)).toEqual([
        { entityId: entryId, kind: "upsert", revision: 1 },
        { entityId: entryId, kind: "upsert", revision: 2 },
        { entityId: entryId, kind: "upsert", revision: 2 },
      ]);
      expect(
        database.applyTimeEntrySync({
          ...envelope("stale-delete", later),
          command: { action: "delete", id: entryId, baseRevision: 1 },
        }),
      ).toMatchObject({ kind: "conflict", fields: ["revision"] });
      // An ID that is taken, and an entry that does not exist.
      expect(
        database.applyTimeEntrySync({
          ...envelope("duplicate"),
          command: create(entryId, minutes(5)),
        }),
      ).toMatchObject({ kind: "conflict", fields: ["record"] });
      expect(
        database.applyTimeEntrySync({
          ...envelope("gone", later),
          command: {
            action: "update",
            id: second,
            baseRevision: 1,
            patch: { note: "Lost" },
          },
        }),
      ).toEqual({ kind: "conflict", fields: ["record"] });

      // The day rules need focus time, which only the server holds: 23
      // hours of focus that day leave room for 20 more minutes, not 30.
      focus(database, "2026-10-01T00:00:00.000Z", "2026-10-01T23:00:00.000Z");
      const full = {
        ...envelope("full", later),
        command: create(second, minutes(61), "2026-10-01"),
      };
      expect(database.applyTimeEntrySync(full)).toEqual({
        kind: "conflict",
        fields: ["day_total_exceeds_day"],
      });
      // A correction below zero on a day without that much time.
      expect(
        database.applyTimeEntrySync({
          ...envelope("negative", later),
          command: create(second, -minutes(90), day),
        }),
      ).toEqual({ kind: "conflict", fields: ["day_total_negative"] });
      // A task that does not exist, and a focus interval used as an entry.
      expect(
        database.applyTimeEntrySync({
          ...envelope("no-task", later),
          command: {
            ...create(second),
            taskId: "00000000-0000-4000-8000-000000000009",
          },
        }),
      ).toEqual({ kind: "conflict", fields: ["task_unavailable"] });
      expect(
        database.applyTimeEntrySync({
          ...envelope("focus", later),
          command: {
            action: "delete",
            id: "20000000-0000-4000-8000-000000000002",
            baseRevision: 1,
          },
        }),
      ).toEqual({ kind: "conflict", fields: ["entry_read_only"] });
      expect(database.timeEntries.get(owner, second)).toBeUndefined();
      const changes = entryChanges(database).length;

      // A stored conflict replays as the same conflict after a restart.
      database.close();
      database = open(directory);
      expect(database.applyTimeEntrySync(full)).toEqual({
        kind: "conflict",
        fields: ["day_total_exceeds_day"],
      });
      expect(database.applyTimeEntrySync(stale)).toMatchObject({
        kind: "conflict",
        fields: ["revision"],
        record: { durationMs: minutes(40) },
      });
      expect(entryChanges(database)).toHaveLength(changes);
      database.close();
    });
  });

  it("appends a change on every store path and none for a refused or replayed write", async () => {
    await withTemporaryDirectory((directory) => {
      const database = open(directory);
      const timeZone = database.getPlanningPreferences(owner).timeZone;
      // The browser route and the assistant both call the store.
      const add = (id: string, durationMs: number) =>
        database.timeEntries.create({
          ownerId: owner,
          id,
          taskId,
          workDate: day,
          durationMs,
          note: "",
          timeZone,
          now,
        });
      expect(add(entryId, minutes(30)).kind).toBe("applied");
      // A retried POST with the same content replays; another is refused.
      expect(add(entryId, minutes(30)).kind).toBe("replayed");
      expect(add(entryId, minutes(31)).kind).toBe("exists");
      expect(add(second, 0).kind).toBe("invalid");
      expect(
        database.timeEntries.update({
          ownerId: owner,
          id: entryId,
          expectedRevision: 1,
          patch: { note: "Edited" },
          timeZone,
          now: later,
        }).kind,
      ).toBe("applied");
      expect(
        database.timeEntries.update({
          ownerId: owner,
          id: entryId,
          expectedRevision: 1,
          patch: { note: "Stale" },
          timeZone,
          now: later,
        }).kind,
      ).toBe("precondition-failed");
      // The importer writes entries inside its transaction.
      const imported = "30000000-0000-4000-8000-000000000001";
      database.timeEntries.insertImported(
        owner,
        taskId,
        [
          {
            workDate: "2026-09-30",
            durationMs: minutes(50),
            kind: "task_day",
            sourceTaskId: "source-task",
            sourceStore: "task",
          },
        ],
        () => imported,
        later,
      );
      expect(
        database.timeEntries.delete({
          ownerId: owner,
          id: entryId,
          expectedRevision: 1,
          timeZone,
          now: later,
        }).kind,
      ).toBe("precondition-failed");
      expect(
        database.timeEntries.delete({
          ownerId: owner,
          id: entryId,
          expectedRevision: 2,
          timeZone,
          now: later,
        }).kind,
      ).toBe("applied");
      expect(entryChanges(database)).toEqual([
        { entityId: entryId, kind: "upsert", revision: 1 },
        { entityId: entryId, kind: "upsert", revision: 2 },
        { entityId: imported, kind: "upsert", revision: 1 },
        { entityId: entryId, kind: "deleted", revision: 3 },
      ]);
      expect(database.listSyncTimeEntries(owner, later)).toMatchObject([
        { id: imported, source: "import", revision: 1 },
      ]);
      database.close();
    });
  });

  it("bounds the snapshot to the rolling window and keeps older history for the report", async () => {
    await withTemporaryDirectory((directory) => {
      const database = open(directory);
      const timeZone = database.getPlanningPreferences(owner).timeZone;
      const first = syncTimeEntryWindowStart(day);
      const before = syncTimeEntryWindowStart(day, syncTimeEntryWindowDays + 1);
      const dates = {
        "10000000-0000-4000-8000-0000000000a1": before,
        "10000000-0000-4000-8000-0000000000a2": first,
        "10000000-0000-4000-8000-0000000000a3": day,
        "10000000-0000-4000-8000-0000000000a4": "2026-10-20",
      };
      for (const [id, workDate] of Object.entries(dates))
        expect(
          database.timeEntries.create({
            ownerId: owner,
            id,
            taskId,
            workDate,
            durationMs: minutes(10),
            note: "",
            timeZone,
            now,
          }).kind,
        ).toBe("applied");
      // The first day of the window is in; the day before it is not.
      // A future date is in.
      expect(
        database
          .listSyncTimeEntries(owner, now)
          .map(({ workDate }) => workDate),
      ).toEqual([first, day, "2026-10-20"]);
      // The window moves with the owner's date: a day later, its first
      // day has left.
      expect(
        database
          .listSyncTimeEntries(owner, "2026-10-03T12:00:00.000Z")
          .map(({ workDate }) => workDate),
      ).toEqual([day, "2026-10-20"]);
      // The feed still announces every entry, and the report reads them all.
      expect(entryChanges(database)).toHaveLength(4);
      expect(
        database.timeEntries.report({
          ownerId: owner,
          from: before,
          to: day,
          timeZone,
          now,
        }).totalMs,
      ).toBe(minutes(30));
      database.close();
    });
  });

  it("uses the owner's time zone for the window", async () => {
    await withTemporaryDirectory((directory) => {
      const database = open(directory);
      database.putPlanningPreferences(
        owner,
        {
          ...database.getPlanningPreferences(owner),
          timeZone: "Pacific/Kiritimati",
        },
        now,
      );
      const timeZone = "Pacific/Kiritimati";
      // 12:00 UTC on October 2 is already October 3 in UTC+14.
      const first = syncTimeEntryWindowStart("2026-10-03");
      const edge = syncTimeEntryWindowStart(day);
      for (const [id, workDate] of [
        [entryId, edge],
        [second, first],
      ] as const)
        database.timeEntries.create({
          ownerId: owner,
          id,
          taskId,
          workDate,
          durationMs: minutes(10),
          note: "",
          timeZone,
          now,
        });
      expect(
        database.listSyncTimeEntries(owner, now).map(({ id }) => id),
      ).toEqual([second]);
      database.close();
    });
  });
});
