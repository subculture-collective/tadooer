import { join } from "node:path";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { defaultApplicationPreferences } from "@suite/contracts";
import { withTemporaryDirectory } from "@suite/test-support";
import { SuiteDatabase } from "./index.ts";

const now = "2026-09-25T12:00:00.000Z";
const later = "2026-09-25T13:00:00.000Z";
const owner = (id: string) => ({
  id,
  username: id,
  displayName: id,
  passwordHash: "hash",
  createdAt: now,
});
const ids = {
  parent: "00000000-0000-4000-8000-000000000001",
  childA: "00000000-0000-4000-8000-000000000002",
  childB: "00000000-0000-4000-8000-000000000003",
  project: "00000000-0000-4000-8000-000000000010",
  archived: "00000000-0000-4000-8000-000000000011",
};

const create = (db: SuiteDatabase, id: string) => {
  const result = db.createTaskIdempotently("owner", `create-${id}`, id, {
    id,
    title: id,
    notes: "",
    status: "open",
    revision: 1,
    createdAt: now,
    updatedAt: now,
  });
  if (result.kind !== "created") throw new Error("Task was not created");
  return result.task;
};
const revision = (db: SuiteDatabase, id: string) =>
  db.getTask("owner", id, true)?.revision ?? 0;
const status = (db: SuiteDatabase, id: string) =>
  db.getTask("owner", id, true)?.status;
const family = (db: SuiteDatabase) => {
  create(db, ids.parent);
  for (const child of [ids.childA, ids.childB]) {
    create(db, child);
    db.taskHierarchy.move({
      ownerId: "owner",
      taskId: child,
      parentId: ids.parent,
      index: null,
      expectedRevision: revision(db, child),
      now,
    });
  }
};

it("stores one revisioned record per owner and rejects stale, invalid and failed writes", async () => {
  await withTemporaryDirectory((directory) => {
    const path = join(directory, "suite.sqlite");
    let db = SuiteDatabase.open(path);
    db.createOwner(owner("owner"));
    db.createProject({
      id: ids.project,
      ownerId: "owner",
      title: "Project",
      revision: 1,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    });
    db.createProject({
      id: ids.archived,
      ownerId: "owner",
      title: "Old",
      revision: 1,
      createdAt: now,
      updatedAt: now,
      archivedAt: now,
    });
    expect(db.applicationPreferences.get("owner")).toEqual({
      revision: 0,
      preferences: defaultApplicationPreferences,
    });
    const desired = {
      ...defaultApplicationPreferences,
      theme: "light" as const,
      defaultProjectId: ids.project,
      shortcuts: { "sync.now": "Ctrl+Shift+S" },
    };
    expect(
      db.applicationPreferences.mutate({
        ownerId: "owner",
        expectedRevision: 1,
        preferences: desired,
        now,
      }),
    ).toMatchObject({ kind: "conflict", record: { revision: 0 } });
    for (const invalid of [
      { ...desired, defaultProjectId: ids.archived },
      { ...desired, shortcuts: { "sync.now": "D" } },
      { ...desired, theme: "sepia" },
    ])
      expect(
        db.applicationPreferences.mutate({
          ownerId: "owner",
          expectedRevision: 0,
          preferences: invalid,
          now,
        }).kind,
      ).toBe("invalid");
    expect(
      db.applicationPreferences.mutate({
        ownerId: "owner",
        expectedRevision: 0,
        preferences: desired,
        now,
      }),
    ).toEqual({
      kind: "applied",
      record: { revision: 1, preferences: desired },
    });
    // A second owner is isolated at revision 0.
    const raw = new DatabaseSync(path);
    raw
      .prepare(
        "INSERT INTO owner_accounts (id, username, display_name, password_hash, created_at, disabled_at) VALUES (?,?,?,?,?,?)",
      )
      .run("other", "other", "Other", "hash", now, now);
    expect(db.applicationPreferences.get("other").revision).toBe(0);
    raw.exec(
      "CREATE TRIGGER fail_preferences BEFORE UPDATE ON owner_application_preferences BEGIN SELECT RAISE(ABORT,'injected preference failure'); END;",
    );
    expect(() =>
      db.applicationPreferences.mutate({
        ownerId: "owner",
        expectedRevision: 1,
        preferences: { ...desired, theme: "dark" },
        now: later,
      }),
    ).toThrow("injected preference failure");
    raw.exec("DROP TRIGGER fail_preferences;");
    raw.close();
    expect(db.applicationPreferences.get("owner")).toEqual({
      revision: 1,
      preferences: desired,
    });
    // Restart and backup keep the record.
    db.close();
    db = SuiteDatabase.open(path);
    expect(db.applicationPreferences.get("owner").revision).toBe(1);
    const backupPath = join(directory, "backup", "suite.sqlite");
    db.backup(backupPath);
    db.close();
    const restored = SuiteDatabase.open(backupPath);
    expect(restored.applicationPreferences.get("owner")).toEqual({
      revision: 1,
      preferences: desired,
    });
    restored.close();
  });
});

it("completes a parent with its last open child only when autoMarkParentDone is on", async () => {
  await withTemporaryDirectory((directory) => {
    const db = SuiteDatabase.open(join(directory, "suite.sqlite"));
    db.createOwner(owner("owner"));
    family(db);
    // Off by default (ADR 0018): no propagation.
    for (const child of [ids.childA, ids.childB])
      expect(
        db.setTaskCompleted("owner", child, revision(db, child), true, now)
          .kind,
      ).toBe("updated");
    expect(status(db, ids.parent)).toBe("open");
    db.setTaskCompleted(
      "owner",
      ids.childB,
      revision(db, ids.childB),
      false,
      now,
    );
    db.applicationPreferences.mutate({
      ownerId: "owner",
      expectedRevision: 0,
      preferences: {
        ...defaultApplicationPreferences,
        autoMarkParentDone: true,
      },
      now,
    });
    const parentRevision = revision(db, ids.parent);
    // One child still open: nothing happens.
    db.setTaskCompleted(
      "owner",
      ids.childA,
      revision(db, ids.childA),
      false,
      now,
    );
    db.setTaskCompleted(
      "owner",
      ids.childA,
      revision(db, ids.childA),
      true,
      now,
    );
    expect(status(db, ids.parent)).toBe("open");
    // Last child through the sync path completes the parent with a new
    // revision, a status version and a sync change.
    db.registerSyncClient({
      id: "client",
      ownerId: "owner",
      label: "Browser",
      credentialHash: "digest",
      createdAt: now,
      lastSeenAt: now,
      revokedAt: null,
    });
    const versions = new DatabaseSync(join(directory, "suite.sqlite"));
    const statusVersion =
      (
        versions
          .prepare(
            "SELECT version FROM task_field_versions WHERE task_id=? AND field='status'",
          )
          .get(ids.childB) as { version: number } | undefined
      )?.version ?? revision(db, ids.childB);
    versions.close();
    expect(
      db.applyTaskCompletionSync({
        ownerId: "owner",
        clientId: "client",
        operationId: "op-1",
        requestHash: "hash",
        taskId: ids.childB,
        baseStatusVersion: statusVersion,
        completed: true,
        now: later,
      }).kind,
    ).toBe("applied");
    const parent = db.getTask("owner", ids.parent, true);
    expect(parent).toMatchObject({
      status: "completed",
      completedAt: later,
      revision: parentRevision + 1,
    });
    // Reopening a child never reopens the parent; completing a parent never
    // touches its children.
    db.setTaskCompleted(
      "owner",
      ids.childA,
      revision(db, ids.childA),
      false,
      now,
    );
    expect(status(db, ids.parent)).toBe("completed");
    db.close();
  });
});

it("applies imported settings once and honours the owner default reminder", async () => {
  await withTemporaryDirectory((directory) => {
    const db = SuiteDatabase.open(join(directory, "suite.sqlite"));
    db.createOwner(owner("owner"));
    const imported = () =>
      db.importTaskRecords(
        "owner",
        [
          {
            kind: "project",
            sourceId: "p",
            title: "Project",
            sourceHash: "h",
            sourceJson: "{}",
            notes: "",
            projectId: null,
            tagIds: [],
            plannedStart: null,
            deadlineDate: null,
            deadlineAt: null,
            estimateMinutes: null,
            completedAt: null,
            createdAt: now,
            plannedDay: null,
            startReminder: { kind: "default" },
            deadlineReminderMinutes: null,
          },
        ],
        now,
        undefined,
        {
          applicationPreferences: {
            preferences: {
              theme: "light",
              firstDayOfWeek: 0,
              defaultProjectSourceId: "p",
              defaultTaskReminder: { kind: "none" },
              shortcuts: { "sync.now": "Ctrl+Shift+S" },
            },
            planning: { dayStartsAt: "03:00", workdayStart: "08:00" },
          },
        },
      );
    expect(imported()).toMatchObject({ applicationPreferences: 7 });
    const record = db.applicationPreferences.get("owner");
    expect(record.revision).toBe(1);
    expect(record.preferences).toMatchObject({
      theme: "light",
      firstDayOfWeek: 0,
      defaultTaskReminder: { kind: "none" },
      shortcuts: { "sync.now": "Ctrl+Shift+S" },
    });
    expect(record.preferences.defaultProjectId).toBe(
      db.listProjects("owner")[0]?.id,
    );
    expect(db.getPlanningPreferences("owner")).toMatchObject({
      dayStartsAt: "03:00",
      workdayStart: "08:00",
    });
    // Saved preferences are never overwritten by a repeat import.
    expect(imported()).toMatchObject({ applicationPreferences: 0 });
    // The owner default reminder replaces the ADR 0016 default for tasks
    // that keep `default`; explicit per-task settings still win.
    const task = create(db, ids.parent);
    db.patchTask(
      "owner",
      task.id,
      task.revision,
      { plannedStart: "2026-09-26T09:00:00.000Z" },
      now,
    );
    const preferences = {
      ...db.getNotificationPreferences("owner"),
      enabled: true,
    };
    const deliveries = () =>
      new DatabaseSync(join(directory, "suite.sqlite"))
        .prepare(
          "SELECT reminder_kind FROM notification_deliveries WHERE owner_id='owner' AND state='pending' ORDER BY reminder_kind",
        )
        .all() as { reminder_kind: string }[];
    db.reconcileNotificationDeliveries({
      ownerId: "owner",
      tasks: [db.getTask("owner", task.id) ?? task],
      preferences,
      now,
    });
    expect(deliveries()).toEqual([]);
    db.patchTask(
      "owner",
      task.id,
      revision(db, task.id),
      {
        startReminder: { kind: "before_start", minutes: 15 },
      },
      now,
    );
    db.reconcileNotificationDeliveries({
      ownerId: "owner",
      tasks: [db.getTask("owner", task.id) ?? task],
      preferences,
      now,
    });
    expect(deliveries()).toEqual([{ reminder_kind: "lead" }]);
    db.close();
    // The stored file holds the reviewed record (after the WAL is folded in).
    const checkpoint = new DatabaseSync(join(directory, "suite.sqlite"));
    checkpoint.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    checkpoint.close();
    expect(readFileSync(join(directory, "suite.sqlite"), "latin1")).toContain(
      '"theme":"light"',
    );
  });
});
