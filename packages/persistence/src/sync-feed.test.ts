import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { withTemporaryDirectory } from "@suite/test-support";
import {
  SuiteDatabase,
  syncChangePageSql,
  syncFeedMinimumRetainedChanges,
} from "./index.ts";

// Feed maintenance (issue #113, ADR 0045): bounded pages, retained floor,
// pruning.
const owner = "owner";
const day = 86_400_000;
const start = Date.parse("2026-09-01T00:00:00.000Z");
/** Change `sequence` is created `sequence` days after the start. */
const createdAt = (sequence: number): string =>
  new Date(start + sequence * day).toISOString();

const open = (directory: string): SuiteDatabase => {
  const database = SuiteDatabase.open(join(directory, "suite.sqlite"));
  if (database.getActiveOwnerId() === undefined)
    database.createOwner({
      id: owner,
      username: owner,
      displayName: "Owner",
      passwordHash: "hash",
      createdAt: createdAt(0),
    });
  return database;
};

const append = (
  database: SuiteDatabase,
  count: number,
  at: (sequence: number) => string = createdAt,
): string => {
  let epoch = database.getSyncState(owner).epoch;
  const head = database.getSyncState(owner).cursor;
  for (let index = 1; index <= count; index += 1)
    epoch = database.appendSyncChange(
      owner,
      "task",
      `task-${String(head + index)}`,
      "upsert",
      1,
      at(head + index),
    ).epoch;
  return epoch;
};

const sequences = (database: SuiteDatabase, epoch: string): number[] =>
  database.listSyncChanges(owner, epoch, 0).map(({ sequence }) => sequence);

describe("sync feed maintenance", () => {
  it("pages with a SQL limit and returns what the in-memory slice returned", async () => {
    await withTemporaryDirectory((directory) => {
      const database = open(directory);
      try {
        const epoch = append(database, 257);
        const all = database.listSyncChanges(owner, epoch, 0);
        expect(all).toHaveLength(257);

        // The previous implementation: the whole tail, sliced in memory.
        const previous = (after: number, limit?: number) => {
          const changes = database
            .listSyncChanges(owner, epoch, after)
            .slice(0, Math.max(1, Math.min(limit ?? 100, 500)));
          return {
            resetRequired: false,
            changes,
            cursor: changes.at(-1)?.sequence ?? after,
          };
        };
        for (const limit of [undefined, 0, 1, 7, 100, 256, 257, 258, 500, 900])
          for (const after of [0, 1, 99, 100, 101, 200, 256, 257])
            expect(
              database.pageSyncChanges(owner, epoch, after, limit),
            ).toEqual(previous(after, limit));

        // Walking pages reproduces the feed, and a full page is the route's
        // signal for `hasMore`.
        for (const limit of [1, 50, 100, 257]) {
          const walked: number[] = [];
          const pageSizes: number[] = [];
          let cursor = 0;
          for (;;) {
            const page = database.pageSyncChanges(owner, epoch, cursor, limit);
            expect(page.resetRequired).toBe(false);
            pageSizes.push(page.changes.length);
            walked.push(...page.changes.map(({ sequence }) => sequence));
            cursor = page.cursor;
            if (page.changes.length < limit) break;
          }
          expect(walked).toEqual(all.map(({ sequence }) => sequence));
          expect(cursor).toBe(257);
          // Every page but the last is full; the last is short (or empty
          // when the feed length is a multiple of the limit).
          expect(pageSizes.slice(0, -1).every((size) => size === limit)).toBe(
            true,
          );
          expect(pageSizes.at(-1)).toBe(257 % limit);
        }

        // Unchanged rejections: another epoch, past the head, negative.
        for (const [pageEpoch, after] of [
          ["other-epoch", 0],
          [epoch, 258],
          [epoch, -1],
        ] as const)
          expect(database.pageSyncChanges(owner, pageEpoch, after)).toEqual({
            resetRequired: true,
            changes: [],
            cursor: 257,
          });
      } finally {
        database.close();
      }
    });
  });

  it("reads a page through the primary key without sorting", async () => {
    await withTemporaryDirectory((directory) => {
      const database = open(directory);
      append(database, 3);
      database.close();
      const sqlite = new DatabaseSync(join(directory, "suite.sqlite"));
      try {
        const plan = (
          sqlite
            .prepare(`EXPLAIN QUERY PLAN ${syncChangePageSql}`)
            .all(owner, "epoch", 0, 100) as unknown as { detail: string }[]
        ).map(({ detail }) => detail);
        expect(plan).toEqual([
          "SEARCH sync_changes USING INDEX sqlite_autoindex_sync_changes_1 (owner_id=? AND epoch=? AND sequence>?)",
        ]);
      } finally {
        sqlite.close();
      }
    });
  });

  it("prunes only changes outside the window and serves cursors at or above the floor", async () => {
    await withTemporaryDirectory((directory) => {
      const database = open(directory);
      try {
        const epoch = append(database, 20);
        expect(database.getSyncRetention(owner)).toEqual({
          floor: 0,
          oldestRetainedAt: createdAt(1),
        });

        // Changes 1 to 8 were created before the cutoff; 9 is at it.
        expect(
          database.pruneSyncChanges(owner, createdAt(9), createdAt(21), 5),
        ).toEqual({ deleted: 8, floor: 8 });
        expect(sequences(database, epoch)).toEqual([
          9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
        ]);
        expect(database.getSyncState(owner)).toEqual({ epoch, cursor: 20 });
        expect(database.getSyncRetention(owner)).toEqual({
          floor: 8,
          oldestRetainedAt: createdAt(9),
        });

        // Below the floor: the changes after the cursor are partly gone.
        for (const below of [0, 1, 7])
          expect(database.pageSyncChanges(owner, epoch, below)).toEqual({
            resetRequired: true,
            changes: [],
            cursor: 20,
          });
        // At the floor: everything after it is retained.
        const atFloor = database.pageSyncChanges(owner, epoch, 8, 5);
        expect(atFloor.resetRequired).toBe(false);
        expect(atFloor.changes.map(({ sequence }) => sequence)).toEqual([
          9, 10, 11, 12, 13,
        ]);
        expect(atFloor.cursor).toBe(13);
        // Above the floor, and at the head.
        expect(
          database
            .pageSyncChanges(owner, epoch, 15)
            .changes.map(({ sequence }) => sequence),
        ).toEqual([16, 17, 18, 19, 20]);
        expect(database.pageSyncChanges(owner, epoch, 20)).toEqual({
          resetRequired: false,
          changes: [],
          cursor: 20,
        });

        // Repeating the same prune changes nothing.
        expect(
          database.pruneSyncChanges(owner, createdAt(9), createdAt(21), 5),
        ).toEqual({ deleted: 0, floor: 8 });

        // New changes continue the sequence above the floor.
        append(database, 1);
        expect(database.getSyncState(owner).cursor).toBe(21);
        expect(
          database
            .pageSyncChanges(owner, epoch, 20)
            .changes.map(({ sequence }) => sequence),
        ).toEqual([21]);
      } finally {
        database.close();
      }
    });
  });

  it("never prunes the newest changes, whatever the window", async () => {
    await withTemporaryDirectory((directory) => {
      const database = open(directory);
      try {
        const epoch = append(database, 20);
        // Every change is older than the cutoff; the newest five stay.
        expect(
          database.pruneSyncChanges(owner, createdAt(100), createdAt(100), 5),
        ).toEqual({ deleted: 15, floor: 15 });
        expect(sequences(database, epoch)).toEqual([16, 17, 18, 19, 20]);
        // Fewer changes than the guard: nothing to prune.
        expect(
          database.pruneSyncChanges(owner, createdAt(100), createdAt(100), 5),
        ).toEqual({ deleted: 0, floor: 15 });
        expect(
          database.pruneSyncChanges(owner, createdAt(100), createdAt(100), 50),
        ).toEqual({ deleted: 0, floor: 15 });
        expect(sequences(database, epoch)).toEqual([16, 17, 18, 19, 20]);
      } finally {
        database.close();
      }
    });
  });

  // Seeds over a thousand committed changes; slow on a loaded or containerised host.
  it(
    "keeps at least 1000 changes by default",
    { timeout: 120_000 },
    async () => {
      await withTemporaryDirectory((directory) => {
        const database = open(directory);
        try {
          expect(syncFeedMinimumRetainedChanges).toBe(1000);
          const epoch = append(database, 1003, () => createdAt(1));
          expect(
            database.pruneSyncChanges(owner, createdAt(2), createdAt(2)),
          ).toEqual({ deleted: 3, floor: 3 });
          const retained = sequences(database, epoch);
          expect(retained).toHaveLength(1000);
          expect(retained[0]).toBe(4);
          expect(retained.at(-1)).toBe(1003);
        } finally {
          database.close();
        }
      });
    },
  );

  it("prunes a contiguous prefix when timestamps are out of order", async () => {
    await withTemporaryDirectory((directory) => {
      const database = open(directory);
      try {
        // Change 4 carries a recent timestamp (a clock correction); changes
        // 5 and 6 are old again. Nothing after change 4 may be removed,
        // or a cursor above the floor would miss changes.
        const epoch = append(database, 10, (sequence) =>
          sequence === 4 ? createdAt(50) : createdAt(sequence),
        );
        expect(
          database.pruneSyncChanges(owner, createdAt(8), createdAt(60), 0),
        ).toEqual({ deleted: 3, floor: 3 });
        expect(sequences(database, epoch)).toEqual([4, 5, 6, 7, 8, 9, 10]);
      } finally {
        database.close();
      }
    });
  });

  it("does nothing for an owner without a feed and rejects an invalid cutoff", async () => {
    await withTemporaryDirectory((directory) => {
      const database = open(directory);
      try {
        expect(database.getSyncRetention(owner)).toEqual({
          floor: 0,
          oldestRetainedAt: null,
        });
        expect(
          database.pruneSyncChanges(owner, createdAt(1), createdAt(1), 0),
        ).toEqual({ deleted: 0, floor: 0 });
        expect(() =>
          database.pruneSyncChanges(owner, "not a date", createdAt(1)),
        ).toThrow();
        expect(() =>
          database.pruneSyncChanges(owner, createdAt(1), createdAt(1), -1),
        ).toThrow();
      } finally {
        database.close();
      }
    });
  });

  it("keeps the floor across a restart", async () => {
    await withTemporaryDirectory((directory) => {
      let database = open(directory);
      const epoch = append(database, 12);
      database.pruneSyncChanges(owner, createdAt(7), createdAt(13), 2);
      database.close();

      database = open(directory);
      try {
        expect(database.getSyncState(owner)).toEqual({ epoch, cursor: 12 });
        expect(database.getSyncRetention(owner).floor).toBe(6);
        expect(database.pageSyncChanges(owner, epoch, 5).resetRequired).toBe(
          true,
        );
        expect(
          database
            .pageSyncChanges(owner, epoch, 6)
            .changes.map(({ sequence }) => sequence),
        ).toEqual([7, 8, 9, 10, 11, 12]);
      } finally {
        database.close();
      }
    });
  });

  it("resets the floor when a restore starts a new epoch", async () => {
    await withTemporaryDirectory((directory) => {
      const database = open(directory);
      try {
        const epoch = append(database, 12);
        database.pruneSyncChanges(owner, createdAt(7), createdAt(13), 2);
        expect(database.getSyncRetention(owner).floor).toBe(6);

        const document = database.dataExport.export(owner, createdAt(13), {
          appVersion: "test",
          appRevision: "test",
        });
        database.dataExport.restore(owner, document, "replace", createdAt(14));

        const state = database.getSyncState(owner);
        expect(state.epoch).not.toBe(epoch);
        expect(state.cursor).toBe(0);
        expect(database.getSyncRetention(owner)).toEqual({
          floor: 0,
          oldestRetainedAt: null,
        });
        // The old cursor is rejected for its epoch; the new epoch serves
        // from its start.
        expect(database.pageSyncChanges(owner, epoch, 8).resetRequired).toBe(
          true,
        );
        expect(database.pageSyncChanges(owner, state.epoch, 0)).toEqual({
          resetRequired: false,
          changes: [],
          cursor: 0,
        });
        append(database, 2);
        expect(
          database
            .pageSyncChanges(owner, state.epoch, 0)
            .changes.map(({ sequence }) => sequence),
        ).toEqual([1, 2]);
      } finally {
        database.close();
      }
    });
  });

  it("adds the floor to sync state written before migration 0048", async () => {
    await withTemporaryDirectory((directory) => {
      const path = join(directory, "suite.sqlite");
      let database = open(directory);
      const epoch = append(database, 3);
      database.close();
      // Back to the 0047 schema: no floor column, migration not recorded.
      const legacy = new DatabaseSync(path);
      legacy.exec(
        "PRAGMA foreign_keys = OFF; ALTER TABLE sync_owner_state DROP COLUMN retained_floor; DELETE FROM schema_migrations WHERE id='0048_sync_retained_floor';",
      );
      legacy.close();

      database = open(directory);
      try {
        expect(database.state().appliedMigrationCount).toBe(
          database.state().expectedMigrationCount,
        );
        expect(database.getSyncState(owner)).toEqual({ epoch, cursor: 3 });
        expect(database.getSyncRetention(owner).floor).toBe(0);
        expect(database.pageSyncChanges(owner, epoch, 0).changes).toHaveLength(
          3,
        );
      } finally {
        database.close();
      }
    });
  });
});
