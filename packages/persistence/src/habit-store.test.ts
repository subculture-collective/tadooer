import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { withTemporaryDirectory } from "@suite/test-support";
import type { HabitCommand } from "@suite/contracts";
import { SuiteDatabase } from "./index.ts";

describe("Habit mutations", () => {
  it("converges concurrent completions, preserves replay across restart, and enforces ownership/revisions", async () => {
    await withTemporaryDirectory((directory) => {
      const path = join(directory, "suite.sqlite");
      let db = SuiteDatabase.open(path);
      const ownerId = randomUUID();
      const otherOwner = randomUUID();
      const habitId = randomUUID();
      const now = "2026-09-20T01:00:00.000Z";
      db.createOwner({
        id: ownerId,
        username: "owner",
        displayName: "Owner",
        passwordHash: "hash",
        createdAt: now,
      });
      const fixture = new DatabaseSync(path);
      fixture
        .prepare(
          "INSERT INTO owner_accounts (id,username,display_name,password_hash,created_at,disabled_at) VALUES (?,?,?,?,?,?)",
        )
        .run(otherOwner, "other", "Other", "hash", now, now);
      fixture.close();
      const apply = (
        command: HabitCommand,
        operationId = randomUUID(),
        actorId = "client-a",
        owner = ownerId,
      ) =>
        db.habits.apply({ ownerId: owner, actorId, operationId, command, now });
      const created = apply({
        kind: "habit.create",
        habit: {
          id: habitId,
          title: "Walk",
          cadence: { kind: "daily" },
          startedOn: "2026-09-19",
          timeZone: "America/Chicago",
        },
      });
      expect(created).toMatchObject({
        kind: "applied",
        habit: { revision: 1 },
      });
      const command = {
        kind: "habit.complete" as const,
        habitId,
        baseRevision: 1,
        periodKey: "2026-09-19",
      };
      const operationId = randomUUID();
      const completed = apply(command, operationId);
      expect(completed).toMatchObject({
        kind: "applied",
        occurrence: { id: operationId },
      });
      const cursor = db.getSyncState(ownerId);
      expect(apply(command, randomUUID(), "client-b")).toEqual(completed);
      expect(db.getSyncState(ownerId)).toEqual(cursor);
      expect(db.habits.occurrences(ownerId)).toHaveLength(1);
      expect(apply(command, randomUUID(), "other", otherOwner)).toEqual({
        kind: "invalid",
      });
      expect(db.habits.occurrences(otherOwner)).toEqual([]);
      expect(apply({ ...command, periodKey: "2026-09-20" })).toEqual({
        kind: "invalid",
      }); // still Sep 19 locally
      expect(
        apply({
          kind: "habit.patch",
          habitId,
          baseRevision: 1,
          fields: { title: "Long walk" },
        }),
      ).toMatchObject({ kind: "applied", habit: { revision: 2 } });
      const staleId = randomUUID();
      expect(
        apply({ kind: "habit.archive", habitId, baseRevision: 1 }, staleId),
      ).toMatchObject({ kind: "conflict" });
      expect(
        apply({ kind: "habit.archive", habitId, baseRevision: 2 }),
      ).toMatchObject({
        kind: "applied",
        habit: { revision: 3, archivedAt: now },
      });
      expect(
        apply({ kind: "habit.restore", habitId, baseRevision: 3 }),
      ).toMatchObject({
        kind: "applied",
        habit: { revision: 4, archivedAt: null },
      });
      expect(
        apply({ ...command, periodKey: "2026-09-18" }, operationId),
      ).toEqual({ kind: "idempotency-conflict" });
      db.close();
      db = SuiteDatabase.open(path);
      expect(apply(command, operationId)).toEqual({
        ...completed,
        kind: "replayed",
      });
      expect(
        apply({ kind: "habit.archive", habitId, baseRevision: 1 }, staleId),
      ).toMatchObject({ kind: "conflict" });
      expect(db.habits.occurrences(ownerId)).toHaveLength(1);
      db.close();
    });
  });
});
