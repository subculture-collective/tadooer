import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  dataExportDocumentSchema,
  type DataExportDocument,
} from "@suite/contracts";
import { withTemporaryDirectory } from "@suite/test-support";
import {
  DataRestoreError,
  SuiteDatabase,
  dataExportExcludedTables,
  dataExportInventory,
} from "./index.ts";

// Owner data export and restore (issue #93, ADR 0034).
const now = "2026-09-25T12:00:00.000Z";
const later = "2026-09-25T13:00:00.000Z";
const zone = "America/Chicago";
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ids = {
  project: id(1),
  tag: id(2),
  parent: id(3),
  child: id(4),
  completed: id(5),
  deleted: id(6),
  archived: id(7),
  subtask: id(8),
  note: id(9),
  entry: id(10),
  archivedEntry: id(11),
  counter: id(12),
  deletedCounter: id(13),
  board: id(14),
  habit: id(15),
  template: id(16),
  blueprint: id(17),
};
const source = { appVersion: "test", appRevision: "abc" };

const openWithOwner = (directory: string, ownerId: string, name: string) => {
  const db = SuiteDatabase.open(join(directory, `${name}.sqlite`));
  db.createOwner({
    id: ownerId,
    username: name,
    displayName: name,
    passwordHash: `$scrypt$secret-for-${name}`,
    createdAt: now,
  });
  return db;
};

const createTask = (
  db: SuiteDatabase,
  ownerId: string,
  taskId: string,
  title: string,
) => {
  const result = db.createTaskIdempotently(
    ownerId,
    `create-${taskId}`,
    taskId,
    {
      id: taskId,
      title,
      notes: `Notes for ${title}`,
      status: "open",
      revision: 1,
      createdAt: now,
      updatedAt: now,
    },
  );
  if (result.kind !== "created") throw new Error("Task was not created");
};
const revision = (db: SuiteDatabase, ownerId: string, taskId: string) =>
  db.getTask(ownerId, taskId, true)?.revision ?? 0;

/** Seeds one owner with rows across most included tables. */
const seed = (db: SuiteDatabase, ownerId: string) => {
  db.putPlanningPreferences(
    ownerId,
    {
      workingDays: [1, 2, 3, 4],
      workdayStart: "08:30",
      workdayEnd: "16:00",
      breakStart: null,
      breakEnd: null,
      timeZone: zone,
    },
    now,
  );
  db.putNotificationPreferences(
    ownerId,
    {
      enabled: true,
      leadReminderEnabled: false,
      atStartReminderEnabled: true,
      detailedContentEnabled: false,
    },
    now,
  );
  db.createProject({
    id: ids.project,
    ownerId,
    title: "Garden",
    revision: 1,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
  });
  db.createTag({
    id: ids.tag,
    ownerId,
    title: "Outside",
    normalizedName: "outside",
    revision: 1,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
  });
  for (const [taskId, title] of [
    [ids.parent, "Plant beds"],
    [ids.child, "Buy seeds"],
    [ids.completed, "Order soil"],
    [ids.deleted, "Old idea"],
    [ids.archived, "Last year's harvest"],
  ] as const)
    createTask(db, ownerId, taskId, title);
  db.taskHierarchy.move({
    ownerId,
    taskId: ids.child,
    parentId: ids.parent,
    expectedRevision: revision(db, ownerId, ids.child),
    now,
  });
  db.setTaskTags(
    ownerId,
    ids.parent,
    [ids.tag],
    revision(db, ownerId, ids.parent),
    now,
  );
  db.assignTaskProject(
    ownerId,
    ids.parent,
    ids.project,
    revision(db, ownerId, ids.parent),
    now,
  );
  db.setTaskCompleted(
    ownerId,
    ids.completed,
    revision(db, ownerId, ids.completed),
    true,
    now,
  );
  db.deleteTask(ownerId, ids.deleted, revision(db, ownerId, ids.deleted), now);
  db.createSubtask({
    id: ids.subtask,
    ownerId,
    taskId: ids.parent,
    title: "Measure the plot",
    completed: false,
    position: 0,
    revision: 1,
    createdAt: now,
    updatedAt: now,
  });
  db.notes.create(
    ownerId,
    {
      id: ids.note,
      content: "Rotate the crops",
      projectId: ids.project,
      tagId: null,
      pinnedToToday: true,
    },
    now,
  );
  for (const [entryId, taskId] of [
    [ids.entry, ids.parent],
    [ids.archivedEntry, ids.archived],
  ] as const)
    db.timeEntries.create({
      ownerId,
      id: entryId,
      taskId,
      workDate: "2026-09-24",
      durationMs: 25 * 60_000,
      note: "",
      timeZone: zone,
      now,
    });
  const archived = db.taskArchive.archive({
    ownerId,
    taskId: ids.archived,
    expectedRevision: revision(db, ownerId, ids.archived),
    now: later,
  });
  if (archived.kind !== "archived") throw new Error(archived.kind);
  for (const counterId of [ids.counter, ids.deletedCounter]) {
    const created = db.counters.create({
      ownerId,
      id: counterId,
      counter: {
        title: counterId === ids.counter ? "Water" : "Retired",
        kind: "click",
        icon: "local_drink",
        enabled: true,
        hidden: false,
        streak: {
          enabled: true,
          minValue: 1,
          mode: "weekdays",
          weekdays: [1, 2, 3, 4, 5],
          weeklyFrequency: 3,
        },
        countdownMs: null,
      },
      now,
    });
    if (created.kind !== "applied") throw new Error(created.kind);
    const recorded = db.counters.recordDay({
      ownerId,
      counterId,
      day: "2026-09-24",
      action: "set",
      amount: 3,
      expectedRevision: 0,
      timeZone: zone,
      now,
    });
    if (recorded.kind !== "applied") throw new Error(recorded.kind);
  }
  const retired = db.counters.get(ownerId, ids.deletedCounter);
  if (retired === undefined) throw new Error("counter missing");
  const removed = db.counters.delete({
    ownerId,
    id: ids.deletedCounter,
    expectedRevision: retired.revision,
    now: later,
  });
  if (removed.kind !== "applied") throw new Error(removed.kind);
  let boardIds = 0;
  db.boards.createBoard(
    ownerId,
    { template: "kanban" },
    () => id(200 + boardIds++),
    now,
  );
  const habit = db.habits.apply({
    ownerId,
    actorId: "seed",
    operationId: `habit-${ids.habit}`,
    command: {
      kind: "habit.create",
      habit: {
        id: ids.habit,
        title: "Water the garden",
        cadence: { kind: "daily" },
        startedOn: "2026-09-01",
        timeZone: zone,
      },
    },
    now,
  });
  if (habit.kind !== "applied") throw new Error(habit.kind);
  db.createTaskTemplate({
    id: ids.template,
    ownerId,
    title: "Weekly weeding",
    notes: "",
    estimateMinutes: 30,
    suggestedProjectId: ids.project,
    tagIds: [ids.tag],
    revision: 1,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    blueprints: [
      {
        id: ids.blueprint,
        title: "North bed",
        position: 0,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      },
    ],
  });
};

/** Strips the fields ADR 0034 documents as differing between instances. */
const comparable = (document: DataExportDocument, ownerId: string) =>
  Object.fromEntries(
    Object.entries(document.tables).map(([table, rows]) => [
      table,
      rows.map((row) =>
        Object.fromEntries(
          Object.entries(row).map(([column, value]) => [
            column,
            column === "owner_id" && value === ownerId ? "<owner>" : value,
          ]),
        ),
      ),
    ]),
  );

const raw = (directory: string, name: string) =>
  new DatabaseSync(join(directory, `${name}.sqlite`));

describe("data export inventory", () => {
  it("classifies every table as included or excluded", async () => {
    await withTemporaryDirectory((directory) => {
      const db = openWithOwner(directory, "owner-a", "a");
      try {
        const included = dataExportInventory.map(({ table }) => table);
        expect(new Set(included).size).toBe(included.length);
        expect(
          included.filter((t) => dataExportExcludedTables.includes(t)),
        ).toEqual([]);
        expect([...included, ...dataExportExcludedTables].toSorted()).toEqual(
          db.dataExport.tableNames(),
        );
      } finally {
        db.close();
      }
    });
  });
});

describe("data export", () => {
  it("exports the owner's rows without secrets, sessions or connector state", async () => {
    await withTemporaryDirectory((directory) => {
      const db = openWithOwner(directory, "owner-a", "a");
      try {
        seed(db, "owner-a");
        db.createSession({
          tokenHash: "session-digest",
          ownerId: "owner-a",
          csrfHash: "csrf-digest",
          issuedAt: now,
          idleExpiresAt: later,
          absoluteExpiresAt: later,
          revokedAt: null,
        });
        const document = db.dataExport.export("owner-a", now, source);
        expect(dataExportDocumentSchema.parse(document)).toEqual(document);
        expect(document.owner).toEqual({
          id: "owner-a",
          username: "a",
          displayName: "a",
          createdAt: now,
        });
        expect(document.source.migrationCount).toBe(
          db.state().appliedMigrationCount,
        );
        const text = JSON.stringify(document);
        expect(text).not.toContain("secret-for-a");
        expect(text).not.toContain("session-digest");
        expect(text).not.toContain("csrf-digest");
        for (const column of [
          "password_hash",
          "secret_hash",
          "token_hash",
          "csrf_hash",
          "credential_hash",
          "credential_ciphertext",
          "url_ciphertext",
          "sync_token",
        ])
          expect(text, column).not.toContain(`"${column}"`);
        for (const table of dataExportExcludedTables)
          expect(document.tables, table).not.toHaveProperty(table);
        expect(document.excludedTables).toEqual(dataExportExcludedTables);
        const count = (table: string) => document.tables[table]?.length ?? 0;
        expect(count("tasks")).toBe(5);
        expect(count("time_entries")).toBe(2);
        expect(count("counters")).toBe(2);
        expect(count("counter_day_values")).toBe(1);
        expect(count("board_panels")).toBe(3);
        expect(count("habits")).toBe(1);
        expect(count("template_subtask_blueprints")).toBe(1);
        expect(count("owner_preference_revisions")).toBe(2);
        // Deterministic order: two exports of the same data are identical.
        expect(db.dataExport.export("owner-a", now, source)).toEqual(document);
      } finally {
        db.close();
      }
    });
  });

  it("round-trips through a fresh database with another owner id", async () => {
    await withTemporaryDirectory((directory) => {
      const a = openWithOwner(directory, "owner-a", "a");
      const b = openWithOwner(directory, "owner-b", "b");
      try {
        seed(a, "owner-a");
        const exported = a.dataExport.export("owner-a", now, source);
        const preview = b.dataExport.preview("owner-b", exported);
        expect(preview).toMatchObject({
          sameOwner: false,
          sameInstance: false,
          issues: [],
          canApply: true,
          target: { counts: [], totalRows: 0, empty: true },
        });
        expect(preview.totalRows).toBe(
          Object.values(exported.tables).reduce(
            (sum, rows) => sum + rows.length,
            0,
          ),
        );

        const outcome = b.dataExport.restore(
          "owner-b",
          exported,
          "empty-only",
          later,
        );
        expect(outcome).toMatchObject({
          mode: "empty-only",
          deletedRows: 0,
          totalRows: preview.totalRows,
          restoredAt: later,
        });
        const restored = b.dataExport.export("owner-b", now, source);
        expect(comparable(restored, "owner-b")).toEqual(
          comparable(exported, "owner-a"),
        );
        expect(restored.owner.id).toBe("owner-b");
        expect(restored.source.instanceId).not.toBe(exported.source.instanceId);

        // Trigger-guarded columns landed and the archive rules still hold.
        const archived = b.getTask("owner-b", ids.archived, true);
        expect(archived?.archivedAt).toBe(later);
        expect(b.counters.get("owner-b", ids.deletedCounter)?.deletedAt).toBe(
          later,
        );
        expect(b.getTask("owner-b", ids.child, true)?.parentId).toBe(
          ids.parent,
        );
        expect(b.getPlanningPreferences("owner-b").workdayStart).toBe("08:30");
        // A new sync epoch: clients of the target resynchronize.
        const sqlite = raw(directory, "b");
        expect(
          sqlite
            .prepare(
              "SELECT COUNT(*) AS n FROM sync_changes WHERE owner_id='owner-b'",
            )
            .get(),
        ).toEqual({ n: 0 });
        expect(
          sqlite
            .prepare(
              "SELECT next_sequence FROM sync_owner_state WHERE owner_id='owner-b'",
            )
            .get(),
        ).toEqual({ next_sequence: 1 });
        expect(
          sqlite
            .prepare(
              "SELECT password_hash FROM owner_accounts WHERE id='owner-b'",
            )
            .get(),
        ).toEqual({ password_hash: "$scrypt$secret-for-b" });
        sqlite.close();
        // The target is usable: the restored owner keeps editing.
        expect(a.dataExport.preview("owner-a", restored).target.empty).toBe(
          false,
        );
      } finally {
        a.close();
        b.close();
      }
    });
  });

  it("refuses to fill a non-empty owner unless replace is chosen", async () => {
    await withTemporaryDirectory((directory) => {
      const a = openWithOwner(directory, "owner-a", "a");
      try {
        seed(a, "owner-a");
        const exported = a.dataExport.export("owner-a", now, source);
        createTask(a, "owner-a", id(99), "Added after the export");
        a.appendSyncChange("owner-a", "task", id(99), "created", 1, later);
        expect(a.dataExport.preview("owner-a", exported)).toMatchObject({
          sameOwner: true,
          sameInstance: true,
          canApply: true,
          target: { empty: false },
        });
        expect(() =>
          a.dataExport.restore("owner-a", exported, "empty-only", later),
        ).toThrow(DataRestoreError);
        expect(a.getTask("owner-a", id(99), true)).toBeDefined();

        const outcome = a.dataExport.restore(
          "owner-a",
          exported,
          "replace",
          later,
        );
        expect(outcome.mode).toBe("replace");
        expect(outcome.deletedRows).toBeGreaterThan(0);
        expect(a.getTask("owner-a", id(99), true)).toBeUndefined();
        const again = a.dataExport.export("owner-a", now, source);
        expect(again.tables).toEqual(exported.tables);
        expect(again.tables.time_entries).toHaveLength(2);
        expect(a.getTask("owner-a", ids.archived, true)?.archivedAt).toBe(
          later,
        );
        const sqlite = raw(directory, "a");
        expect(
          sqlite.prepare("SELECT COUNT(*) AS n FROM sync_changes").get(),
        ).toEqual({ n: 0 });
        sqlite.close();
      } finally {
        a.close();
      }
    });
  });

  it("blocks newer schemas, unknown tables and columns, and excluded tables", async () => {
    await withTemporaryDirectory((directory) => {
      const a = openWithOwner(directory, "owner-a", "a");
      try {
        seed(a, "owner-a");
        const exported = a.dataExport.export("owner-a", now, source);
        const broken: DataExportDocument = {
          ...exported,
          source: {
            ...exported.source,
            migrationCount: exported.source.migrationCount + 1,
          },
          tables: {
            ...exported.tables,
            web_sessions: [{ token_hash: "x" }],
            future_table: [{ id: "1" }],
            projects: [
              { ...(exported.tables.projects?.[0] ?? {}), emoji: "🌱" },
            ],
          },
        };
        const preview = a.dataExport.preview("owner-a", broken);
        expect(preview.canApply).toBe(false);
        expect(preview.issues.map(({ code }) => code).toSorted()).toEqual([
          "EXCLUDED_TABLE",
          "NEWER_SCHEMA",
          "UNKNOWN_COLUMN",
          "UNKNOWN_TABLE",
        ]);
        let error: unknown;
        try {
          a.dataExport.restore("owner-a", broken, "replace", later);
        } catch (caught: unknown) {
          error = caught;
        }
        expect(error).toBeInstanceOf(DataRestoreError);
        expect((error as DataRestoreError).code).toBe("RESTORE_NOT_READY");
        // Nothing changed.
        expect(a.dataExport.export("owner-a", now, source)).toEqual(exported);
      } finally {
        a.close();
      }
    });
  });

  it("rolls back a restore whose rows violate the schema", async () => {
    await withTemporaryDirectory((directory) => {
      const a = openWithOwner(directory, "owner-a", "a");
      const b = openWithOwner(directory, "owner-b", "b");
      try {
        seed(a, "owner-a");
        const exported = a.dataExport.export("owner-a", now, source);
        const corrupt: DataExportDocument = {
          ...exported,
          tables: {
            ...exported.tables,
            subtasks: [
              ...(exported.tables.subtasks ?? []),
              {
                ...(exported.tables.subtasks?.[0] ?? {}),
                id: id(98),
                task_id: id(97),
              },
            ],
          },
        };
        expect(() =>
          b.dataExport.restore("owner-b", corrupt, "empty-only", later),
        ).toThrow();
        expect(b.dataExport.preview("owner-b", exported).target).toEqual({
          counts: [],
          totalRows: 0,
          empty: true,
        });
        expect(b.listTasks("owner-b")).toEqual([]);
      } finally {
        a.close();
        b.close();
      }
    });
  });
});
