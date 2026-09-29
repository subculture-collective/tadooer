import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { defaultFocusPreferences } from "@suite/contracts";
import { withTemporaryDirectory } from "@suite/test-support";
import { SuiteDatabase } from "./index.ts";

const now = "2026-09-24T15:00:00.000Z";
const minutes = (value: number) => value * 60_000;
const at = (offsetMinutes: number) =>
  new Date(Date.parse(now) + minutes(offsetMinutes)).toISOString();

// One active owner per database (ADR 0003); "other" only reads defaults.
const open = (path: string) => {
  const db = SuiteDatabase.open(path);
  for (const owner of ["owner"]) {
    if (db.findOwnerById(owner) !== undefined) continue;
    db.createOwner({
      id: owner,
      username: owner,
      displayName: owner,
      passwordHash: "hash",
      createdAt: now,
    });
    db.registerSyncClient({
      id: `${owner}-client`,
      ownerId: owner,
      label: "Laptop",
      credentialHash: `${owner}-credential`,
      createdAt: now,
      lastSeenAt: now,
      revokedAt: null,
    });
    const task = db.createTaskIdempotently(
      owner,
      `create-${owner}`,
      `${owner}-task`,
      {
        id: `${owner}-task`,
        title: "Write report",
        notes: "",
        status: "open",
        revision: 1,
        createdAt: now,
        updatedAt: now,
      },
    );
    if (task.kind !== "created") throw new Error("Task was not created");
  }
  return db;
};

const current = (db: SuiteDatabase, owner = "owner") => {
  const session = db.getActiveSession(owner);
  if (session === undefined) throw new Error("No session");
  return session;
};

const startSession = (db: SuiteDatabase, owner = "owner", startedAt = now) => {
  const result = db.applyActiveSessionTransition({
    session: {
      id: `${owner}-session`,
      ownerId: owner,
      taskId: `${owner}-task`,
      controllerClientId: `${owner}-client`,
      state: "running",
      phase: "focus",
      revision: 1,
      startedAt,
      leaseExpiresAt: new Date(Date.parse(startedAt) + 90_000).toISOString(),
      hardExpiresAt: new Date(Date.parse(startedAt) + 86_400_000).toISOString(),
      createdAt: startedAt,
      updatedAt: startedAt,
      endedAt: null,
    },
    expectedRevision: null,
    clientId: `${owner}-client`,
    idempotencyKey: `start-${owner}`,
    requestHash: "start",
    events: [
      {
        kind: "started",
        revision: 1,
        actorClientId: `${owner}-client`,
        createdAt: startedAt,
      },
    ],
    intervals: [
      {
        id: `${owner}-interval-1`,
        ordinal: 1,
        phase: "focus",
        taskId: `${owner}-task`,
        controllerClientId: `${owner}-client`,
        startedAt,
        endedAt: null,
        closedBy: null,
      },
    ],
    now: startedAt,
  });
  if (result.kind !== "applied") throw new Error(result.kind);
};

describe("focus preferences persistence (ADR 0029)", () => {
  it("starts at the defaults with revision 0, versions saves, rejects stale writes and isolates owners", async () => {
    await withTemporaryDirectory((directory) => {
      const db = open(join(directory, "suite.sqlite"));
      try {
        expect(db.focus.getPreferences("owner")).toEqual({
          preferences: defaultFocusPreferences,
          revision: 0,
          imported: null,
        });
        const edited = {
          ...defaultFocusPreferences,
          pomodoro: { ...defaultFocusPreferences.pomodoro, workMinutes: 50 },
        };
        expect(
          db.focus.putPreferences("owner", 1, edited, now),
        ).toBeUndefined();
        expect(db.focus.putPreferences("owner", 0, edited, now)).toMatchObject({
          revision: 1,
          preferences: { pomodoro: { workMinutes: 50 } },
        });
        expect(
          db.focus.putPreferences("owner", 0, edited, now),
        ).toBeUndefined();
        expect(
          db.focus.putPreferences(
            "owner",
            1,
            { ...edited, pomodoro: { ...edited.pomodoro, workMinutes: 0 } },
            now,
          ),
        ).toBeUndefined();
        expect(db.focus.getRevision("owner")).toBe(1);
        expect(db.focus.getPreferences("other")).toMatchObject({ revision: 0 });
        expect(
          db.focus.getPreferences("other").preferences.pomodoro.workMinutes,
        ).toBe(25);
      } finally {
        db.close();
      }
    });
  });

  it("applies an import once, never over an owner edit, and survives reopening the file", async () => {
    await withTemporaryDirectory((directory) => {
      const path = join(directory, "suite.sqlite");
      let db = open(path);
      const provenance = {
        source: "super_productivity" as const,
        inputHash: "a".repeat(64),
        importedAt: now,
        fields: ["pomodoro.duration"],
      };
      const imported = {
        ...defaultFocusPreferences,
        pomodoro: { ...defaultFocusPreferences.pomodoro, workMinutes: 45 },
      };
      expect(
        db.focus.importInTransaction("owner", imported, provenance, now),
      ).toBe("applied");
      expect(db.focus.getPreferences("owner")).toEqual({
        preferences: imported,
        revision: 1,
        imported: provenance,
      });
      expect(
        db.focus.importInTransaction(
          "owner",
          { ...imported, countdownMinutes: 10 },
          provenance,
          now,
        ),
      ).toBe("skipped");
      db.focus.putPreferences(
        "owner",
        1,
        { ...imported, countdownMinutes: 30 },
        now,
      );
      db.close();
      db = SuiteDatabase.open(path);
      try {
        expect(db.focus.getPreferences("owner")).toMatchObject({
          revision: 2,
          preferences: { countdownMinutes: 30, pomodoro: { workMinutes: 45 } },
          imported: provenance,
        });
      } finally {
        db.close();
      }
    });
  });

  it("keeps a session plan, records idle provenance in the session transaction and dedupes ledger rows", async () => {
    await withTemporaryDirectory((directory) => {
      const db = open(join(directory, "suite.sqlite"));
      try {
        startSession(db);
        expect(db.focus.getPlan("owner", "owner-session")).toBeUndefined();
        const plan = {
          mode: "pomodoro" as const,
          workMs: minutes(25),
          shortBreakMs: minutes(5),
          longBreakMs: minutes(15),
          cyclesBeforeLongBreak: 4,
          flowtime: {
            breakEnabled: false,
            breakMode: "ratio" as const,
            breakPercentage: 20,
            breakRules: [],
          },
        };
        db.focus.putPlan("owner", "owner-session", plan, now);
        expect(db.focus.getPlan("owner", "owner-session")).toEqual(plan);
        expect(db.focus.getPlan("other", "owner-session")).toBeUndefined();
        db.focus.putPlan("owner", "owner-session", null, now);
        expect(db.focus.getPlan("owner", "owner-session")).toBeUndefined();

        // A failing hook rolls the whole transition back.
        expect(() =>
          db.applyActiveSessionTransition({
            session: { ...current(db), revision: 2, updatedAt: at(10) },
            expectedRevision: 1,
            clientId: "owner-client",
            idempotencyKey: "idle-1",
            requestHash: "idle",
            events: [],
            intervals: [],
            now: at(10),
            inTransaction: () => {
              throw new Error("boom");
            },
          }),
        ).toThrow("boom");
        expect(db.getActiveSession("owner")?.revision).toBe(1);
        db.applyActiveSessionTransition({
          session: { ...current(db), revision: 2, updatedAt: at(10) },
          expectedRevision: 1,
          clientId: "owner-client",
          idempotencyKey: "idle-1",
          requestHash: "idle",
          events: [],
          intervals: [],
          now: at(10),
          inTransaction: () =>
            db.focus.recordIdleDisposition({
              id: "disposition-1",
              sessionId: "owner-session",
              ownerId: "owner",
              revision: 2,
              disposition: "break",
              idleStartedAt: at(5),
              idleEndedAt: at(10),
              trimmedMs: minutes(5),
              actorClientId: "owner-client",
              createdAt: at(10),
            }),
        });
        expect(db.focus.listIdleDispositions("owner", "owner-session")).toEqual(
          [
            expect.objectContaining({
              revision: 2,
              disposition: "break",
              trimmedMs: minutes(5),
            }),
          ],
        );
        expect(db.focus.listIdleDispositions("other", "owner-session")).toEqual(
          [],
        );

        expect(
          db.focus.queueReminder("owner", "focus_countdown", at(25), at(25)),
        ).toBe(true);
        expect(
          db.focus.queueReminder("owner", "focus_countdown", at(25), at(26)),
        ).toBe(false);
        expect(
          db.focus.queueReminder("owner", "focus_break_end", at(25), at(26)),
        ).toBe(true);
        const due = db.listDueNotificationDeliveries(at(30));
        expect(
          due
            .map(({ kind, taskId }) => ({ kind, taskId }))
            .toSorted((left, right) => left.kind.localeCompare(right.kind)),
        ).toEqual([
          { kind: "focus_break_end", taskId: null },
          { kind: "focus_countdown", taskId: null },
        ]);
        // Task-reminder reconciliation leaves focus rows alone.
        db.reconcileNotificationDeliveries({
          ownerId: "owner",
          tasks: db.listTasks("owner"),
          preferences: db.getNotificationPreferences("owner"),
          now: at(30),
        });
        expect(db.listDueNotificationDeliveries(at(30))).toHaveLength(2);
        db.focus.snoozeBreakReminder("owner", at(45), at(30));
        expect(db.focus.getBreakSnoozedUntil("owner")).toBe(at(45));
        expect(db.focus.getBreakSnoozedUntil("other")).toBeNull();
      } finally {
        db.close();
      }
    });
  });

  it("bounds a running interval by its lease when listing owner intervals", async () => {
    await withTemporaryDirectory((directory) => {
      const db = open(join(directory, "suite.sqlite"));
      try {
        startSession(db);
        const listed = db.focus.listOwnerIntervals("owner", at(-60), at(60));
        expect(listed).toEqual([
          {
            sessionId: "owner-session",
            kind: "focus",
            startedAt: now,
            endedAt: new Date(Date.parse(now) + 90_000).toISOString(),
          },
        ]);
        expect(
          db.focus.listOwnerIntervals("owner", at(-60), at(1))[0]?.endedAt,
        ).toBeNull();
        expect(db.focus.lastFocusEnd("owner")).toBeNull();
      } finally {
        db.close();
      }
    });
  });

  it("rebuilds the notification ledger without losing existing rows", async () => {
    await withTemporaryDirectory((directory) => {
      const path = join(directory, "suite.sqlite");
      let db = open(path);
      db.queueNotificationTest("owner", "legacy-test", now);
      db.close();
      // Undo only this migration's ledger rebuild to check the copy path.
      const legacy = new DatabaseSync(path);
      legacy.exec(
        "DROP TABLE owner_focus_preferences; DROP TABLE active_session_focus_plans; DROP TABLE active_session_idle_dispositions; DROP TABLE owner_focus_reminder_state; DROP INDEX notification_delivery_focus_occurrence; DELETE FROM schema_migrations WHERE id='0033_focus_preferences_idle';",
      );
      legacy.close();
      db = SuiteDatabase.open(path);
      try {
        expect(db.getNotificationDelivery("legacy-test")).toMatchObject({
          kind: "test",
          state: "pending",
        });
        expect(db.state().appliedMigrationCount).toBe(40);
        expect(
          db.focus.queueReminder("owner", "focus_tracking_reminder", now, now),
        ).toBe(true);
      } finally {
        db.close();
      }
    });
  });
});
