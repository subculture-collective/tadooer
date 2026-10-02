import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { withTemporaryDirectory } from "@suite/test-support";
import { SuiteDatabase } from "./index.ts";

describe("SuiteDatabase", () => {
  it("repairs missing deadline versions without changing existing versions, tasks, or sync state", async () => {
    await withTemporaryDirectory((directory) => {
      const path = join(directory, "suite.sqlite");
      let database = SuiteDatabase.open(path);
      const now = "2026-09-19T12:00:00.000Z";
      database.createOwner({
        id: "owner",
        username: "owner",
        displayName: "Owner",
        passwordHash: "hash",
        createdAt: now,
      });
      for (const id of ["missing", "existing"]) {
        database.createTaskIdempotently("owner", id, id, {
          id,
          title: id,
          notes: "",
          status: "open",
          revision: 1,
          createdAt: now,
          updatedAt: now,
        });
        database.patchTask("owner", id, 1, { title: `${id} updated` }, now);
      }
      const tasks = database.listTasks("owner");
      const sync = database.getSyncState("owner");
      database.close();
      const legacy = new DatabaseSync(path);
      legacy.exec(
        "DELETE FROM schema_migrations WHERE id='0018_missing_deadline_field_versions'; DELETE FROM task_field_versions WHERE task_id='missing' AND field='deadline';",
      );
      legacy.close();
      database = SuiteDatabase.open(path);
      expect(database.getTaskFieldVersions("owner", "missing").deadline).toBe(
        2,
      );
      expect(database.getTaskFieldVersions("owner", "existing").deadline).toBe(
        1,
      );
      expect(database.listTasks("owner")).toEqual(tasks);
      expect(database.getSyncState("owner")).toEqual(sync);
      database.close();
      database = SuiteDatabase.open(path);
      expect(database.getTaskFieldVersions("owner", "missing").deadline).toBe(
        2,
      );
      database.close();
    });
  });

  it("syncs a deadline as one field across date, instant, clear, replay, and disjoint edits", async () => {
    await withTemporaryDirectory((directory) => {
      const database = SuiteDatabase.open(join(directory, "suite.sqlite"));
      const now = "2026-09-19T12:00:00.000Z";
      database.createOwner({
        id: "deadline-owner",
        username: "deadline-owner",
        displayName: "Owner",
        passwordHash: "hash",
        createdAt: now,
      });
      const base = {
        ownerId: "deadline-owner",
        clientId: "deadline-client",
        now,
      };
      database.registerSyncClient({
        id: base.clientId,
        ownerId: base.ownerId,
        label: "Browser",
        credentialHash: "hash",
        createdAt: now,
        lastSeenAt: now,
        revokedAt: null,
      });
      const created = database.applyTaskCreateSync({
        ...base,
        operationId: "create",
        requestHash: "create-hash",
        task: {
          id: "deadline-task",
          title: "Task",
          notes: "",
          status: "open",
          revision: 1,
          createdAt: now,
          updatedAt: now,
          estimateMinutes: null,
          deadline: { kind: "date", value: "2026-09-20" },
        },
      });
      expect(created).toMatchObject({
        kind: "applied",
        task: { deadlineDate: "2026-09-20", deadlineAt: null },
      });
      database.patchTask(
        base.ownerId,
        "deadline-task",
        1,
        { title: "Renamed" },
        now,
      );
      const patch = {
        ...base,
        operationId: "instant",
        requestHash: "instant-hash",
        taskId: "deadline-task",
        baseVersions: { deadline: 1 },
        patch: { deadline: { kind: "instant" as const, value: now } },
      };
      expect(database.applyTaskFieldSync(patch)).toMatchObject({
        kind: "applied",
        task: {
          title: "Renamed",
          revision: 3,
          deadlineDate: null,
          deadlineAt: now,
        },
      });
      const cursor = database.getSyncState(base.ownerId);
      expect(database.applyTaskFieldSync(patch)).toMatchObject({
        kind: "replayed",
        task: { deadlineAt: now },
      });
      expect(database.getSyncState(base.ownerId)).toEqual(cursor);
      expect(
        database.applyTaskFieldSync({
          ...patch,
          operationId: "stale",
          patch: { deadline: null },
        }),
      ).toMatchObject({ kind: "conflict", fields: ["deadline"] });
      expect(
        database.applyTaskFieldSync({
          ...patch,
          operationId: "clear",
          baseVersions: { deadline: 3 },
          patch: { deadline: null },
        }),
      ).toMatchObject({
        kind: "applied",
        task: { deadlineDate: null, deadlineAt: null, revision: 4 },
      });
      database.patchTask(
        base.ownerId,
        "deadline-task",
        4,
        { deadlineDate: "2026-09-21", deadlineAt: null },
        now,
      );
      expect(
        database.getTaskFieldVersions(base.ownerId, "deadline-task").deadline,
      ).toBe(5);
      expect(
        database.applyTaskFieldSync({
          ...patch,
          operationId: "online-conflict",
          baseVersions: { deadline: 4 },
        }),
      ).toMatchObject({ kind: "conflict", fields: ["deadline"] });
      expect(
        database.applyTaskFieldSync({
          ...patch,
          ownerId: "other-owner",
          operationId: "other",
        }),
      ).toMatchObject({ kind: "conflict" });
      expect(database.fullSyncSnapshot(base.ownerId).tasks[0]).toMatchObject({
        deadlineDate: "2026-09-21",
        deadlineAt: null,
      });
      database.close();
    });
  });

  it("stores one immutable completion per habit period", async () => {
    await withTemporaryDirectory((directory) => {
      const database = SuiteDatabase.open(join(directory, "suite.sqlite"));
      database.createOwner({
        id: "habit-owner",
        username: "habit-owner",
        displayName: "Habit owner",
        passwordHash: "hash",
        createdAt: "2026-08-21T00:00:00.000Z",
      });
      database.createHabit({
        id: "habit-1",
        ownerId: "habit-owner",
        title: "Walk",
        cadence: { kind: "daily" },
        startedOn: "2026-08-21",
        timeZone: "UTC",
        revision: 1,
        createdAt: "2026-08-21T00:00:00.000Z",
        updatedAt: "2026-08-21T00:00:00.000Z",
        archivedAt: null,
      });
      expect(
        database.recordHabitOccurrence({
          id: "occurrence-1",
          habitId: "habit-1",
          periodKey: "2026-08-21",
          completedAt: "2026-08-21T12:00:00.000Z",
          createdAt: "2026-08-21T12:00:00.000Z",
        }),
      ).toBe(true);
      expect(
        database.recordHabitOccurrence({
          id: "occurrence-2",
          habitId: "habit-1",
          periodKey: "2026-08-21",
          completedAt: "2026-08-21T13:00:00.000Z",
          createdAt: "2026-08-21T13:00:00.000Z",
        }),
      ).toBe(false);
      expect(database.listHabitOccurrences("habit-1")).toHaveLength(1);
      database.close();
    });
  });

  it("upgrades a Phase 0A database without changing its installation identity", async () => {
    await withTemporaryDirectory((directory) => {
      const path = join(directory, "suite.sqlite");
      const legacy = new DatabaseSync(path);
      const migrationSql = `
      CREATE TABLE install_metadata (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        instance_id TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      ) STRICT;
    `;
      legacy.exec(`
        CREATE TABLE schema_migrations (
          id TEXT PRIMARY KEY,
          checksum TEXT NOT NULL,
          applied_at TEXT NOT NULL
        ) STRICT;
        ${migrationSql}
      `);
      legacy
        .prepare(
          "INSERT INTO schema_migrations (id, checksum, applied_at) VALUES (?, ?, ?)",
        )
        .run(
          "0001_install_metadata",
          createHash("sha256").update(migrationSql).digest("hex"),
          "2026-08-05T00:00:00.000Z",
        );
      legacy
        .prepare(
          "INSERT INTO install_metadata (singleton, instance_id, created_at) VALUES (1, ?, ?)",
        )
        .run(
          "d1054acd-c04d-4bd8-a814-254b007154ba",
          "2026-08-05T00:00:00.000Z",
        );
      legacy.close();

      const upgraded = SuiteDatabase.open(path);
      expect(upgraded.state()).toMatchObject({
        install: { instanceId: "d1054acd-c04d-4bd8-a814-254b007154ba" },
        appliedMigrationCount: 43,
        expectedMigrationCount: 43,
      });
      expect(upgraded.setupRequired()).toBe(true);
      upgraded.close();
    });
  });

  it("preserves installation identity and migration state across restart", async () => {
    await withTemporaryDirectory((directory) => {
      const path = join(directory, "suite.sqlite");
      const first = SuiteDatabase.open(path);
      const firstState = first.state();
      first.close();

      const reopened = SuiteDatabase.open(path);
      const reopenedState = reopened.state();
      reopened.close();

      expect(reopenedState).toEqual(firstState);
      expect(reopenedState.appliedMigrationCount).toBe(43);
      expect(reopenedState.expectedMigrationCount).toBe(43);
    });
  });

  it("keeps templates inert and instantiates an idempotent independent task tree", async () => {
    await withTemporaryDirectory((directory) => {
      const database = SuiteDatabase.open(join(directory, "suite.sqlite"));
      const now = "2026-08-06T00:00:00.000Z";
      database.createOwner({
        id: "template-owner",
        username: "template-owner",
        displayName: "Template owner",
        passwordHash: "hash",
        createdAt: now,
      });
      database.createProject({
        id: "template-project",
        ownerId: "template-owner",
        title: "Fitness",
        revision: 1,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
      });
      database.createTag({
        id: "template-tag",
        ownerId: "template-owner",
        title: "Fitness",
        normalizedName: "fitness",
        revision: 1,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
      });
      database.createTaskTemplate({
        id: "template-1",
        ownerId: "template-owner",
        title: "Leg day",
        notes: "",
        estimateMinutes: 60,
        suggestedProjectId: "template-project",
        tagIds: ["template-tag"],
        revision: 1,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        blueprints: [
          {
            id: "blueprint-1",
            title: "Warm up",
            position: 0,
            revision: 1,
            createdAt: now,
            updatedAt: now,
          },
        ],
      });
      expect(database.listTasks("template-owner")).toHaveLength(0);
      const first = database.instantiateTemplateIdempotently({
        ownerId: "template-owner",
        templateId: "template-1",
        destinationProjectId: "template-project",
        idempotencyKey: "template-instantiate-0001",
        requestHash: "template-hash",
        now,
      });
      expect(first).toMatchObject({
        kind: "created",
        tasks: [
          {
            task: {
              title: "Leg day",
              projectId: "template-project",
              tagIds: ["template-tag"],
            },
            subtasks: [{ title: "Warm up" }],
            provenance: { templateId: "template-1", templateRevision: 1 },
          },
        ],
      });
      const replay = database.instantiateTemplateIdempotently({
        ownerId: "template-owner",
        templateId: "template-1",
        destinationProjectId: "template-project",
        idempotencyKey: "template-instantiate-0001",
        requestHash: "template-hash",
        now,
      });
      expect(replay).toMatchObject({ kind: "replayed" });
      expect(database.listTasks("template-owner")).toHaveLength(1);
      database.close();
    });
  });

  it("resolves a planning placeholder atomically and replays it across restart", async () => {
    await withTemporaryDirectory((directory) => {
      const path = join(directory, "suite.sqlite");
      let database = SuiteDatabase.open(path);
      const now = "2026-08-07T12:00:00.000Z";
      database.createOwner({
        id: "pool-owner",
        username: "pool-owner",
        displayName: "Pool owner",
        passwordHash: "hash",
        createdAt: now,
      });
      const task = database.createTaskIdempotently(
        "pool-owner",
        "pool-parent-create",
        "pool-parent-hash",
        {
          id: "pool-parent",
          title: "Leg day",
          notes: "",
          status: "open",
          revision: 1,
          createdAt: now,
          updatedAt: now,
        },
      );
      expect(task.kind).toBe("created");
      database.createChoicePool(
        {
          id: "leg-pool",
          ownerId: "pool-owner",
          title: "Leg exercises",
          policy: "cycle",
          pickCount: 2,
          cooldownSeconds: null,
          revision: 1,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
        },
        ["Squat", "Lunge", "Calf raise"].map((title, position) => ({
          id: `leg-item-${String(position)}`,
          poolId: "leg-pool",
          title,
          position,
          revision: 1,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
        })),
      );
      expect(database.listTasks("pool-owner")).toHaveLength(1);
      expect(
        database.createPlanningPlaceholder({
          id: "leg-placeholder",
          ownerId: "pool-owner",
          taskId: "pool-parent",
          poolId: "leg-pool",
          pickCount: 2,
          position: 0,
          state: "unresolved",
          revision: 1,
          createdAt: now,
          updatedAt: now,
          resolvedAt: null,
        }),
      ).toMatchObject({ state: "unresolved", revision: 1 });
      const first = database.resolvePlanningPlaceholderIdempotently({
        ownerId: "pool-owner",
        placeholderId: "leg-placeholder",
        expectedRevision: 1,
        selectedItemIds: ["leg-item-0", "leg-item-1"],
        logicalTime: now,
        cycle: 1,
        overridden: false,
        idempotencyKey: "pool-resolution-001",
        requestHash: "pool-resolution-hash",
        now,
      });
      expect(first).toMatchObject({
        kind: "created",
        placeholder: { state: "resolved", revision: 2 },
        subtasks: [
          { title: "Squat", position: 0 },
          { title: "Lunge", position: 1 },
        ],
        history: [
          { itemId: "leg-item-0", kind: "selected", cycle: 1 },
          { itemId: "leg-item-1", kind: "selected", cycle: 1 },
        ],
      });
      const identities = {
        resolution: first.resolution?.id,
        subtasks: first.subtasks?.map(({ id }) => id),
        history: first.history?.map(({ id }) => id),
      };
      database.close();
      database = SuiteDatabase.open(path);
      const replay = database.resolvePlanningPlaceholderIdempotently({
        ownerId: "pool-owner",
        placeholderId: "leg-placeholder",
        expectedRevision: 1,
        selectedItemIds: ["leg-item-0", "leg-item-1"],
        logicalTime: now,
        cycle: 1,
        overridden: false,
        idempotencyKey: "pool-resolution-001",
        requestHash: "pool-resolution-hash",
        now,
      });
      expect(replay.kind).toBe("replayed");
      expect({
        resolution: replay.resolution?.id,
        subtasks: replay.subtasks?.map(({ id }) => id),
        history: replay.history?.map(({ id }) => id),
      }).toEqual(identities);
      expect(
        database.resolvePlanningPlaceholderIdempotently({
          ownerId: "pool-owner",
          placeholderId: "leg-placeholder",
          expectedRevision: 1,
          selectedItemIds: ["leg-item-1", "leg-item-2"],
          logicalTime: now,
          cycle: 1,
          overridden: false,
          idempotencyKey: "pool-resolution-001",
          requestHash: "changed-hash",
          now,
        }).kind,
      ).toBe("conflict");
      expect(database.listSubtasks("pool-owner", "pool-parent")).toHaveLength(
        2,
      );
      expect(database.listChoicePoolHistory("leg-pool")).toHaveLength(2);
      database.close();
    });
  });

  it("creates exactly one active owner and revokes persisted sessions", async () => {
    await withTemporaryDirectory((directory) => {
      const database = SuiteDatabase.open(join(directory, "suite.sqlite"));
      const owner = {
        id: "owner-1",
        username: "owner",
        displayName: "Owner",
        passwordHash: "not-a-real-hash",
        createdAt: "2026-08-05T00:00:00.000Z",
      };

      expect(database.createOwner(owner)).toBe(true);
      expect(database.createOwner({ ...owner, id: "owner-2" })).toBe(false);
      expect(database.findOwnerByUsername("OWNER")).toEqual(owner);

      database.createSession({
        tokenHash: "token-hash",
        ownerId: owner.id,
        csrfHash: "csrf-hash",
        issuedAt: owner.createdAt,
        idleExpiresAt: "2026-08-05T00:30:00.000Z",
        absoluteExpiresAt: "2026-08-05T12:00:00.000Z",
        revokedAt: null,
      });
      expect(database.findSession("token-hash")?.ownerId).toBe(owner.id);
      expect(
        database.revokeSession("token-hash", "2026-08-05T00:01:00.000Z"),
      ).toBe(true);
      expect(database.findSession("token-hash")?.revokedAt).toBe(
        "2026-08-05T00:01:00.000Z",
      );
      database.close();
    });
  });

  it("persists scoped automation tokens, confirmations, outcomes, and safe audit metadata", async () => {
    await withTemporaryDirectory((directory) => {
      const path = join(directory, "suite.sqlite");
      const database = SuiteDatabase.open(path);
      database.createOwner({
        id: "owner-automation",
        username: "automation-owner",
        displayName: "Automation Owner",
        passwordHash: "not-a-real-hash",
        createdAt: "2026-08-06T00:00:00.000Z",
      });
      database.createAutomationToken({
        id: "automation-token-active",
        ownerId: "owner-automation",
        label: "Quick add",
        secretHash: "secret-digest-active",
        confirmationPolicy: "confirm_all",
        scopes: ["tasks.write", "tasks.read"],
        createdAt: "2026-08-06T00:00:00.000Z",
        lastUsedAt: null,
        expiresAt: "2026-08-07T00:00:00.000Z",
        revokedAt: null,
      });
      database.createAutomationToken({
        id: "automation-token-expired",
        ownerId: "owner-automation",
        label: "Expired",
        secretHash: "secret-digest-expired",
        confirmationPolicy: "confirm_all",
        scopes: ["tasks.read"],
        createdAt: "2026-08-06T00:00:00.000Z",
        lastUsedAt: null,
        expiresAt: "2026-08-06T00:00:00.000Z",
        revokedAt: null,
      });
      expect(database.listAutomationTokens("owner-automation")).toEqual([
        expect.objectContaining({
          id: "automation-token-active",
          scopes: ["tasks.read", "tasks.write"],
          lastUsedAt: null,
        }),
        expect.objectContaining({ id: "automation-token-expired" }),
      ]);
      expect(
        database.authenticateAutomationToken(
          "automation-token-active",
          "secret-digest-active",
          "2026-08-06T00:01:00.000Z",
        ),
      ).toMatchObject({
        id: "automation-token-active",
        lastUsedAt: "2026-08-06T00:01:00.000Z",
      });
      expect(
        database.authenticateAutomationToken(
          "automation-token-expired",
          "secret-digest-expired",
          "2026-08-06T00:01:00.000Z",
        ),
      ).toBeUndefined();
      expect(
        database.authenticateAutomationToken(
          "automation-token-active",
          "wrong-secret-digest",
          "2026-08-06T00:01:00.000Z",
        ),
      ).toBeUndefined();

      database.createAutomationPreview({
        id: "preview-current",
        ownerId: "owner-automation",
        tokenId: "automation-token-active",
        operation: "task.create",
        inputHash: "request-hash",
        input: { title: "Private task content" },
        summary: "Create one task",
        affectedIds: ["task-1"],
        baseRevisions: { "task-1": 3 },
        expiresAt: "2026-08-06T00:05:00.000Z",
        consumedAt: null,
        createdAt: "2026-08-06T00:01:00.000Z",
      });
      database.createAutomationPreview({
        id: "preview-expired",
        ownerId: "owner-automation",
        tokenId: "automation-token-active",
        operation: "task.create",
        inputHash: "expired-request-hash",
        input: {},
        summary: "Expired preview",
        affectedIds: [],
        baseRevisions: {},
        expiresAt: "2026-08-06T00:01:00.000Z",
        consumedAt: null,
        createdAt: "2026-08-06T00:00:00.000Z",
      });
      expect(
        database.consumeAutomationPreview(
          "preview-current",
          "2026-08-06T00:02:00.000Z",
        ),
      ).toBe(true);
      expect(
        database.consumeAutomationPreview(
          "preview-current",
          "2026-08-06T00:02:01.000Z",
        ),
      ).toBe(false);
      expect(
        database.consumeAutomationPreview(
          "preview-expired",
          "2026-08-06T00:02:00.000Z",
        ),
      ).toBe(false);
      expect(database.getAutomationPreview("preview-current")).toMatchObject({
        input: { title: "Private task content" },
        consumedAt: "2026-08-06T00:02:00.000Z",
      });

      database.putAutomationOutcome({
        ownerId: "owner-automation",
        tokenId: "automation-token-active",
        operation: "task.create",
        idempotencyKey: "automation-operation-001",
        requestHash: "request-hash",
        previewId: "preview-current",
        response: { taskId: "task-1", replayed: false },
        createdAt: "2026-08-06T00:02:00.000Z",
      });
      database.appendAutomationAudit({
        id: "audit-1",
        ownerId: "owner-automation",
        tokenId: "automation-token-active",
        operation: "task.create",
        phase: "execute",
        outcome: "succeeded",
        errorCode: null,
        previewId: "preview-current",
        affectedIds: ["task-1"],
        requestHash: "request-hash",
        createdAt: "2026-08-06T00:02:00.000Z",
      });
      database.close();

      const reopened = SuiteDatabase.open(path);
      expect(
        reopened.getAutomationOutcome(
          "owner-automation",
          "automation-token-active",
          "task.create",
          "automation-operation-001",
        ),
      ).toEqual({
        ownerId: "owner-automation",
        tokenId: "automation-token-active",
        operation: "task.create",
        idempotencyKey: "automation-operation-001",
        requestHash: "request-hash",
        previewId: "preview-current",
        response: { taskId: "task-1", replayed: false },
        createdAt: "2026-08-06T00:02:00.000Z",
      });
      const audit = reopened.listAutomationAudit("owner-automation");
      expect(audit).toEqual([
        {
          id: "audit-1",
          ownerId: "owner-automation",
          tokenId: "automation-token-active",
          operation: "task.create",
          phase: "execute",
          outcome: "succeeded",
          errorCode: null,
          previewId: "preview-current",
          affectedIds: ["task-1"],
          requestHash: "request-hash",
          createdAt: "2026-08-06T00:02:00.000Z",
        },
      ]);
      expect(JSON.stringify(audit)).not.toContain("Private task content");
      expect(JSON.stringify(audit)).not.toContain("secret-digest-active");
      expect(reopened.listAutomationAudit("owner-other")).toEqual([]);
      expect(
        reopened.revokeAutomationToken(
          "owner-other",
          "automation-token-active",
          "2026-08-06T00:03:00.000Z",
        ),
      ).toBe(false);
      expect(
        reopened.revokeAutomationToken(
          "owner-automation",
          "automation-token-active",
          "2026-08-06T00:03:00.000Z",
        ),
      ).toBe(true);
      expect(
        reopened.authenticateAutomationToken(
          "automation-token-active",
          "secret-digest-active",
          "2026-08-06T00:03:01.000Z",
        ),
      ).toBeUndefined();
      expect(
        reopened.revokeAutomationToken(
          "owner-automation",
          "automation-token-active",
          "2026-08-06T00:03:01.000Z",
        ),
      ).toBe(false);
      reopened.close();
    });
  });

  it("creates a portable SQLite backup with the same installation identity", async () => {
    await withTemporaryDirectory((directory) => {
      const sourcePath = join(directory, "suite.sqlite");
      const backupPath = join(directory, "backup", "suite.sqlite");
      const source = SuiteDatabase.open(sourcePath);
      const sourceState = source.state();
      source.backup(backupPath);
      source.close();

      expect(existsSync(backupPath)).toBe(true);

      const restored = SuiteDatabase.open(backupPath);
      expect(restored.state()).toEqual(sourceState);
      restored.close();
    });
  });

  it("keeps provider and calendar identities stable across discovery", async () => {
    await withTemporaryDirectory((directory) => {
      const database = SuiteDatabase.open(join(directory, "suite.sqlite"));
      expect(
        database.createOwner({
          id: "owner-1",
          username: "owner",
          displayName: "Owner",
          passwordHash: "not-a-real-hash",
          createdAt: "2026-08-05T00:00:00.000Z",
        }),
      ).toBe(true);
      const firstProvider = database.ensureCalendarProvider(
        "owner-1",
        "baikal",
        "connector-1",
        "2026-08-05T00:00:00.000Z",
      );
      const secondProvider = database.ensureCalendarProvider(
        "owner-1",
        "baikal",
        "connector-1",
        "2026-08-05T01:00:00.000Z",
      );
      expect(secondProvider.id).toBe(firstProvider.id);

      const workCalendar = {
        href: "/calendars/owner/work/",
        displayName: "Work",
        supportsEvents: true,
        supportsTodos: false,
      };
      const input = [workCalendar];
      const first = database.putCalendarCollections(
        firstProvider.id,
        input,
        "2026-08-05T00:00:00.000Z",
      );
      const second = database.putCalendarCollections(
        firstProvider.id,
        [{ ...workCalendar, displayName: "Work renamed" }],
        "2026-08-05T01:00:00.000Z",
      );
      expect(second[0]?.id).toBe(first[0]?.id);
      expect(second[0]?.displayName).toBe("Work renamed");
      database.close();
    });
  });

  it("creates a task once for an idempotency key and rejects key reuse", async () => {
    await withTemporaryDirectory((directory) => {
      const database = SuiteDatabase.open(join(directory, "suite.sqlite"));
      database.createOwner({
        id: "owner-1",
        username: "owner",
        displayName: "Owner",
        passwordHash: "not-a-real-hash",
        createdAt: "2026-08-05T00:00:00.000Z",
      });
      const task = {
        id: "task-1",
        title: "First task",
        notes: "Captured safely",
        status: "open" as const,
        revision: 1,
        createdAt: "2026-08-05T00:00:00.000Z",
        updatedAt: "2026-08-05T00:00:00.000Z",
      };
      expect(
        database.createTaskIdempotently(
          "owner-1",
          "request-0001",
          "hash-1",
          task,
        ).kind,
      ).toBe("created");
      expect(
        database.createTaskIdempotently("owner-1", "request-0001", "hash-1", {
          ...task,
          id: "task-2",
        }),
      ).toMatchObject({ kind: "replayed", task: { id: "task-1" } });
      expect(
        database.createTaskIdempotently(
          "owner-1",
          "request-0001",
          "different-hash",
          { ...task, id: "task-3" },
        ),
      ).toEqual({ kind: "conflict" });
      expect(database.listTasks("owner-1")).toHaveLength(1);
      database.close();
    });
  });

  it("conditionally updates, completes, deletes, and restores a task", async () => {
    await withTemporaryDirectory((directory) => {
      const database = SuiteDatabase.open(join(directory, "suite.sqlite"));
      database.createOwner({
        id: "owner-1",
        username: "owner",
        displayName: "Owner",
        passwordHash: "hash",
        createdAt: "2026-08-06T00:00:00.000Z",
      });
      database.createTaskIdempotently("owner-1", "request-001", "hash", {
        id: "task-1",
        title: "Draft",
        notes: "",
        status: "open",
        revision: 1,
        createdAt: "2026-08-06T00:00:00.000Z",
        updatedAt: "2026-08-06T00:00:00.000Z",
      });
      const patched = database.patchTask(
        "owner-1",
        "task-1",
        1,
        {
          title: "Plan Phase 1",
          plannedStart: "2026-08-06T14:00:00.000Z",
          estimateMinutes: 45,
          deadlineDate: "2026-08-07",
          deadlineAt: null,
        },
        "2026-08-06T00:01:00.000Z",
      );
      expect(patched).toMatchObject({
        kind: "updated",
        task: {
          title: "Plan Phase 1",
          revision: 2,
          estimateMinutes: 45,
          deadlineDate: "2026-08-07",
          deadlineAt: null,
        },
      });
      expect(
        database.patchTask(
          "owner-1",
          "task-1",
          1,
          { title: "Stale overwrite" },
          "2026-08-06T00:02:00.000Z",
        ),
      ).toMatchObject({
        kind: "precondition-failed",
        task: { title: "Plan Phase 1", revision: 2 },
      });
      expect(
        database.setTaskCompleted(
          "owner-1",
          "task-1",
          2,
          true,
          "2026-08-06T00:03:00.000Z",
        ),
      ).toMatchObject({
        kind: "updated",
        task: { status: "completed", revision: 3 },
      });
      expect(
        database.deleteTask("owner-1", "task-1", 3, "2026-08-06T00:04:00.000Z"),
      ).toMatchObject({ kind: "updated", task: { revision: 4 } });
      expect(database.listTasks("owner-1")).toEqual([]);
      expect(database.listDeletedTasks("owner-1")).toHaveLength(1);
      expect(
        database.restoreTask(
          "owner-1",
          "task-1",
          4,
          "2026-08-06T00:05:00.000Z",
        ),
      ).toMatchObject({
        kind: "updated",
        task: { deletedAt: null, revision: 5 },
      });
      database.close();
    });
  });

  it("reserves and completes one retry-safe task calendar block", async () => {
    await withTemporaryDirectory((directory) => {
      const database = SuiteDatabase.open(join(directory, "suite.sqlite"));
      database.createOwner({
        id: "owner-1",
        username: "owner",
        displayName: "Owner",
        passwordHash: "hash",
        createdAt: "2026-08-06T00:00:00.000Z",
      });
      database.createTaskIdempotently("owner-1", "request-001", "hash", {
        id: "task-1",
        title: "Calendar task",
        notes: "",
        status: "open",
        revision: 1,
        createdAt: "2026-08-06T00:00:00.000Z",
        updatedAt: "2026-08-06T00:00:00.000Z",
      });
      const provider = database.ensureCalendarProvider(
        "owner-1",
        "baikal",
        "connector-1",
        "2026-08-06T00:00:00.000Z",
      );
      const calendar = database.putCalendarCollections(
        provider.id,
        [
          {
            href: "/dav.php/calendars/owner/default/",
            displayName: "Default",
            supportsEvents: true,
            supportsTodos: false,
          },
        ],
        "2026-08-06T00:00:00.000Z",
      )[0];
      if (calendar === undefined) throw new Error("Calendar was not persisted");
      const reservation = database.reserveCalendarWrite({
        ownerId: "owner-1",
        taskId: "task-1",
        expectedTaskRevision: 1,
        idempotencyKey: "planning-request-001",
        requestHash: "planning-hash",
        calendarId: calendar.id,
        reservedHref: "/dav.php/calendars/owner/default/suite-task.ics",
        reservedUid: "suite-task",
        now: "2026-08-06T00:01:00.000Z",
      });
      expect(reservation).toMatchObject({ kind: "reserved" });
      expect(
        database.reserveCalendarWrite({
          ownerId: "owner-1",
          taskId: "task-1",
          expectedTaskRevision: 1,
          idempotencyKey: "planning-request-001",
          requestHash: "planning-hash",
          calendarId: calendar.id,
          reservedHref: "ignored-on-replay.ics",
          reservedUid: "ignored-on-replay",
          now: "2026-08-06T00:02:00.000Z",
        }),
      ).toMatchObject({
        kind: "replayed",
        operation: { reservedUid: "suite-task" },
      });
      const completed = database.completeCalendarWrite({
        ownerId: "owner-1",
        idempotencyKey: "planning-request-001",
        event: {
          id: "event-projection-1",
          providerId: provider.id,
          calendarId: calendar.id,
          href: "/dav.php/calendars/owner/default/suite-task.ics",
          uid: "suite-task",
          etag: '"v1"',
          rawIcs: "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n",
          summary: "Calendar task",
          startsAt: "2026-08-06T14:00:00.000Z",
          endsAt: "2026-08-06T14:45:00.000Z",
          allDay: false,
          freshness: "current",
          mutable: true,
          revision: 1,
          projectedAt: "2026-08-06T00:03:00.000Z",
        },
        plannedStart: "2026-08-06T14:00:00.000Z",
        estimateMinutes: 45,
        now: "2026-08-06T00:03:00.000Z",
      });
      expect(completed).toMatchObject({
        task: { revision: 2, estimateMinutes: 45 },
        block: { eventUid: "suite-task", state: "active" },
      });
      expect(
        database.listCalendarEvents(
          "owner-1",
          "2026-08-06T00:00:00.000Z",
          "2026-08-07T00:00:00.000Z",
        ),
      ).toHaveLength(1);
      const released = database.releaseTaskCalendarBlock({
        ownerId: "owner-1",
        taskId: "task-1",
        expectedTaskRevision: 2,
        expectedBlockRevision: 1,
        now: "2026-08-06T00:04:00.000Z",
      });
      expect(released).toMatchObject({
        plannedStart: null,
        estimateMinutes: null,
        revision: 3,
      });
      expect(
        database.getTaskCalendarBlock("owner-1", "task-1"),
      ).toBeUndefined();
      expect(
        database.listCalendarEvents(
          "owner-1",
          "2026-08-06T00:00:00.000Z",
          "2026-08-07T00:00:00.000Z",
        ),
      ).toHaveLength(0);
      database.close();
    });
  });

  it("persists Phase 2 clients, ordered changes, field merges, organization, and sessions", async () => {
    await withTemporaryDirectory((directory) => {
      const database = SuiteDatabase.open(join(directory, "suite.sqlite"));
      const now = "2026-08-06T00:00:00.000Z";
      database.createOwner({
        id: "owner-2",
        username: "sync-owner",
        displayName: "Sync Owner",
        passwordHash: "hash",
        createdAt: now,
      });
      expect(
        database.registerSyncClient({
          id: "client-1",
          ownerId: "owner-2",
          label: "Laptop",
          credentialHash: "credential-hash",
          createdAt: now,
          lastSeenAt: now,
          revokedAt: null,
        }),
      ).toBe("registered");
      expect(
        database.authenticateSyncClient(
          "owner-2",
          "client-1",
          "credential-hash",
          now,
        )?.label,
      ).toBe("Laptop");
      const acceptedAt = "2026-08-06T00:05:00.000Z";
      const offlineCreated = database.applyTaskCreateSync({
        ownerId: "owner-2",
        clientId: "client-1",
        operationId: "offline-create-1",
        requestHash: "offline-create-hash",
        now: acceptedAt,
        task: {
          id: "offline-created-task",
          title: "Offline task",
          notes: "",
          status: "open",
          revision: 1,
          createdAt: "2099-01-01T00:00:00.000Z",
          updatedAt: "2099-01-01T00:00:00.000Z",
          estimateMinutes: 25,
        },
      });
      expect(offlineCreated).toMatchObject({
        kind: "applied",
        task: { createdAt: acceptedAt, updatedAt: acceptedAt },
      });
      expect(
        database.patchTask(
          "owner-2",
          "offline-created-task",
          1,
          { title: "Online rename" },
          "2026-08-06T00:06:00.000Z",
        ),
      ).toMatchObject({ kind: "updated", task: { revision: 2 } });
      expect(
        database.applyTaskFieldSync({
          ownerId: "owner-2",
          clientId: "client-1",
          operationId: "offline-stale-patch",
          requestHash: "offline-stale-hash",
          taskId: "offline-created-task",
          baseVersions: { title: 1 },
          patch: { title: "Stale offline rename" },
          now: "2026-08-06T00:07:00.000Z",
        }),
      ).toMatchObject({ kind: "conflict", fields: ["title"] });
      const syncState = database.getSyncState("owner-2");
      expect(
        database
          .listSyncChanges("owner-2", syncState.epoch, 0)
          .filter(({ entityId }) => entityId === "offline-created-task")
          .map(({ kind, revision }) => ({ kind, revision })),
      ).toEqual([
        { kind: "upsert", revision: 1 },
        { kind: "upsert", revision: 2 },
      ]);
      const task = {
        id: "sync-task",
        title: "Initial",
        notes: "Notes",
        status: "open" as const,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      database.createTaskIdempotently(
        "owner-2",
        "task-request",
        "task-hash",
        task,
      );
      const merged = database.applyTaskFieldSync({
        ownerId: "owner-2",
        clientId: "client-1",
        operationId: "op-1",
        requestHash: "hash-1",
        taskId: task.id,
        baseVersions: { title: 1, notes: 1, status: 1, estimateMinutes: 1 },
        patch: { title: "Renamed" },
        now,
      });
      expect(merged).toMatchObject({
        kind: "applied",
        task: { title: "Renamed", revision: 2 },
      });
      const disjoint = database.applyTaskFieldSync({
        ownerId: "owner-2",
        clientId: "client-1",
        operationId: "op-2",
        requestHash: "hash-2",
        taskId: task.id,
        baseVersions: { title: 1, notes: 1, status: 1, estimateMinutes: 1 },
        patch: { notes: "Merged note" },
        now,
      });
      expect(disjoint).toMatchObject({
        kind: "applied",
        task: { title: "Renamed", notes: "Merged note" },
      });
      expect(
        database.applyTaskFieldSync({
          ownerId: "owner-2",
          clientId: "client-1",
          operationId: "op-3",
          requestHash: "hash-3",
          taskId: task.id,
          baseVersions: { title: 1, notes: 1, status: 1, estimateMinutes: 1 },
          patch: { title: "Stale" },
          now,
        }),
      ).toMatchObject({ kind: "conflict", fields: ["title"] });
      expect(
        database.listSyncChanges(
          "owner-2",
          database.appendSyncChange(
            "owner-2",
            "project",
            "project-1",
            "project.create",
            1,
            now,
          ).epoch,
          0,
        ).length,
      ).toBeGreaterThan(0);
      database.createProject({
        id: "project-1",
        ownerId: "owner-2",
        title: "Home",
        revision: 1,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
      });
      database.createTag({
        id: "tag-1",
        ownerId: "owner-2",
        title: "Today",
        normalizedName: "today",
        revision: 1,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
      });
      expect(database.setTaskTags("owner-2", task.id, ["tag-1"])).toBe(true);
      database.createSubtask({
        id: "sub-1",
        ownerId: "owner-2",
        taskId: task.id,
        title: "First",
        completed: false,
        position: 1,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      });
      expect(database.listSubtasks("owner-2", task.id)).toHaveLength(1);
      database.putActiveSession({
        id: "session-1",
        ownerId: "owner-2",
        taskId: task.id,
        controllerClientId: "client-1",
        state: "running",
        phase: "focus",
        revision: 1,
        startedAt: now,
        leaseExpiresAt: "2026-08-06T00:01:30.000Z",
        hardExpiresAt: "2026-08-07T00:00:00.000Z",
        createdAt: now,
        updatedAt: now,
        endedAt: null,
      });
      expect(database.getActiveSession("owner-2")).toMatchObject({
        state: "running",
        controllerClientId: "client-1",
      });
      database.putActiveSession({
        id: "session-1",
        ownerId: "owner-2",
        taskId: task.id,
        controllerClientId: "client-1",
        state: "completed",
        phase: "focus",
        revision: 2,
        startedAt: now,
        leaseExpiresAt: null,
        hardExpiresAt: "2026-08-07T00:00:00.000Z",
        createdAt: now,
        updatedAt: "2026-08-06T00:10:00.000Z",
        endedAt: "2026-08-06T00:10:00.000Z",
      });
      expect(
        database.applyActiveSessionTransition({
          session: {
            id: "session-2",
            ownerId: "owner-2",
            taskId: task.id,
            controllerClientId: "client-1",
            state: "running",
            phase: "focus",
            revision: 1,
            startedAt: "2026-08-06T00:10:00.000Z",
            leaseExpiresAt: "2026-08-06T00:12:00.000Z",
            hardExpiresAt: "2026-08-07T00:00:00.000Z",
            createdAt: "2026-08-06T00:10:00.000Z",
            updatedAt: "2026-08-06T00:10:00.000Z",
            endedAt: null,
          },
          clientId: "client-1",
          idempotencyKey: "session-start-2",
          requestHash: "session-hash-2",
          expectedRevision: null,
          events: [
            {
              kind: "started",
              revision: 1,
              actorClientId: "client-1",
              createdAt: "2026-08-06T00:10:00.000Z",
            },
          ],
          intervals: [
            {
              id: "interval-2",
              ordinal: 1,
              phase: "focus",
              taskId: task.id,
              controllerClientId: "client-1",
              startedAt: "2026-08-06T00:10:00.000Z",
              endedAt: null,
              closedBy: null,
            },
          ],
          now: "2026-08-06T00:10:00.000Z",
        }),
      ).toMatchObject({ kind: "applied", session: { id: "session-2" } });
      expect(database.getActiveSession("owner-2")?.id).toBe("session-2");
      expect(database.listActiveSessionIntervals("session-2")).toHaveLength(1);
      expect(database.listActiveSessionEvents("session-2")).toHaveLength(1);
      const breakTransition = {
        session: {
          id: "session-2",
          ownerId: "owner-2",
          taskId: task.id,
          controllerClientId: "client-1",
          state: "running" as const,
          phase: "break" as const,
          revision: 2,
          startedAt: "2026-08-06T00:10:00.000Z",
          leaseExpiresAt: "2026-08-06T00:12:30.000Z",
          hardExpiresAt: "2026-08-07T00:00:00.000Z",
          createdAt: "2026-08-06T00:10:00.000Z",
          updatedAt: "2026-08-06T00:11:00.000Z",
          endedAt: null,
        },
        expectedRevision: 1,
        clientId: "client-1",
        idempotencyKey: "session-break-2",
        requestHash: "session-break-hash-2",
        events: [
          {
            kind: "started",
            revision: 1,
            actorClientId: "client-1",
            createdAt: "2026-08-06T00:10:00.000Z",
          },
          {
            kind: "break-started",
            revision: 2,
            actorClientId: "client-1",
            createdAt: "2026-08-06T00:11:00.000Z",
          },
        ],
        intervals: [
          {
            id: "interval-2",
            ordinal: 1,
            phase: "focus" as const,
            taskId: task.id,
            controllerClientId: "client-1",
            startedAt: "2026-08-06T00:10:00.000Z",
            endedAt: "2026-08-06T00:11:00.000Z",
            closedBy: "break",
          },
          {
            id: "interval-3",
            ordinal: 2,
            phase: "break" as const,
            taskId: task.id,
            controllerClientId: "client-1",
            startedAt: "2026-08-06T00:11:00.000Z",
            endedAt: null,
            closedBy: null,
          },
        ],
        now: "2026-08-06T00:11:00.000Z",
      };
      expect(
        database.applyActiveSessionTransition(breakTransition),
      ).toMatchObject({
        kind: "applied",
        session: { revision: 2, phase: "break" },
      });
      expect(database.listActiveSessionIntervals("session-2")).toEqual([
        expect.objectContaining({ ordinal: 1, closedBy: "break" }),
        expect.objectContaining({ ordinal: 2, endedAt: null }),
      ]);
      expect(database.listActiveSessionEvents("session-2")).toHaveLength(2);
      expect(
        database.applyActiveSessionTransition(breakTransition),
      ).toMatchObject({
        kind: "replayed",
        session: { revision: 2, phase: "break" },
      });
      expect(database.revokeSyncClient("owner-2", "client-1", now)).toBe(true);
      expect(
        database.authenticateSyncClient(
          "owner-2",
          "client-1",
          "credential-hash",
          now,
        ),
      ).toBeUndefined();
      database.close();
    });
  });

  it("replays calendar import previews and revokes read-only feed capabilities", async () => {
    await withTemporaryDirectory((directory) => {
      const database = SuiteDatabase.open(join(directory, "suite.sqlite"));
      const now = "2026-08-07T12:00:00.000Z";
      database.createOwner({
        id: "import-owner",
        username: "import-owner",
        displayName: "Import owner",
        passwordHash: "hash",
        createdAt: now,
      });
      database.putBaikalConnector({
        id: "connector-1",
        ownerId: "import-owner",
        endpoint: "http://baikal.test/",
        username: "owner",
        credentialKeyId: "key",
        credentialNonce: new Uint8Array([1]),
        credentialCiphertext: new Uint8Array([2]),
        credentialTag: new Uint8Array([3]),
        verifiedAt: now,
        updatedAt: now,
      });
      const provider = database.ensureCalendarProvider(
        "import-owner",
        "baikal",
        "connector-1",
        now,
      );
      const calendar = database.putCalendarCollections(
        provider.id,
        [
          {
            href: "/cal/",
            displayName: "Calendar",
            supportsEvents: true,
            supportsTodos: false,
          },
        ],
        now,
      )[0];
      if (calendar === undefined) throw new Error("Calendar fixture missing");
      const input = {
        id: "00000000-0000-4000-8000-000000000071",
        ownerId: "import-owner",
        calendarId: calendar.id,
        source: "ics" as const,
        inputHash: "a".repeat(64),
        report: { source: "ics" },
        candidates: [
          {
            externalId: "event-1",
            uid: "uid-1",
            rawIcs:
              "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:uid-1\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n",
            href: "event-1.ics",
          },
        ],
        createdAt: now,
      };
      expect(database.createCalendarImportPreview(input)).toMatchObject({
        replayed: false,
        job: { state: "previewed", items: [{ state: "pending" }] },
      });
      expect(
        database.createCalendarImportPreview({
          ...input,
          id: "00000000-0000-4000-8000-000000000072",
        }),
      ).toMatchObject({ replayed: true, job: { id: input.id } });
      database.markCalendarImportItem(
        "import-owner",
        input.id,
        "event-1",
        "applied",
        now,
      );
      expect(
        database.finishCalendarImport("import-owner", input.id, now),
      ).toMatchObject({ state: "applied" });
      database.createCalendarFeedCapability({
        id: "00000000-0000-4000-8000-000000000073",
        ownerId: "import-owner",
        calendarId: calendar.id,
        label: "Phone",
        secretHash: "digest",
        createdAt: now,
        revokedAt: null,
      });
      expect(
        database.listCalendarFeedCapabilities("import-owner"),
      ).toHaveLength(1);
      expect(
        database.revokeCalendarFeedCapability(
          "import-owner",
          "00000000-0000-4000-8000-000000000073",
          now,
        ),
      ).toBe(true);
      expect(
        database.getCalendarFeedCapability(
          "00000000-0000-4000-8000-000000000073",
        )?.revokedAt,
      ).toBe(now);
      database.close();
    });
  });

  it("persists Google state, incremental projections, and preferences without exposing grants", async () => {
    await withTemporaryDirectory((directory) => {
      const path = join(directory, "suite.sqlite");
      const database = SuiteDatabase.open(path);
      const now = "2026-08-07T12:00:00.000Z";
      database.createOwner({
        id: "google-owner",
        username: "google-owner",
        displayName: "Google owner",
        passwordHash: "hash",
        createdAt: now,
      });
      database.createGoogleOAuthState({
        stateHash: "state-digest",
        ownerId: "google-owner",
        expiresAt: "2026-08-07T12:10:00.000Z",
        createdAt: now,
      });
      expect(
        database.consumeGoogleOAuthState(
          "state-digest",
          "2026-08-07T12:01:00.000Z",
        ),
      ).toBe("google-owner");
      expect(
        database.consumeGoogleOAuthState(
          "state-digest",
          "2026-08-07T12:02:00.000Z",
        ),
      ).toBeUndefined();
      database.createGoogleOAuthState({
        stateHash: "expired-digest",
        ownerId: "google-owner",
        expiresAt: "2026-08-07T12:03:00.000Z",
        createdAt: "2026-08-07T12:02:00.000Z",
      });
      expect(
        database.consumeGoogleOAuthState(
          "expired-digest",
          "2026-08-07T12:04:00.000Z",
        ),
      ).toBeUndefined();

      database.putGoogleConnector({
        id: "google-connector",
        ownerId: "google-owner",
        credentialKeyId: "key-id",
        credentialNonce: new Uint8Array([1, 2, 3]),
        credentialCiphertext: new Uint8Array([4, 5, 6]),
        credentialTag: new Uint8Array([7, 8, 9]),
        grantedScopes: ["scope-b", "scope-a"],
        accountLabel: "owner@example.test",
        state: "connected",
        createdAt: now,
        updatedAt: now,
        revokedAt: null,
      });
      expect(database.getGoogleConnector("google-owner")).toMatchObject({
        accountLabel: "owner@example.test",
        grantedScopes: ["scope-a", "scope-b"],
      });
      const provider = database.ensureCalendarProvider(
        "google-owner",
        "google",
        "google-connector",
        now,
      );
      const calendar = database.putCalendarCollections(
        provider.id,
        [
          {
            href: "primary@example.test",
            displayName: "Primary",
            supportsEvents: true,
            supportsTodos: false,
          },
        ],
        now,
      )[0];
      if (calendar === undefined) throw new Error("Calendar fixture missing");
      database.applyGoogleEventSync({
        ownerId: "google-owner",
        calendarId: calendar.id,
        externalCalendarId: "primary@example.test",
        providerId: provider.id,
        syncToken: "sync-1",
        reset: true,
        events: [
          {
            id: "event-1",
            uid: "event-1@example.test",
            etag: '"event-1"',
            summary: "Recurring instance",
            startsAt: "2026-08-07T13:00:00.000Z",
            endsAt: "2026-08-07T14:00:00.000Z",
            allDay: false,
            recurrence: "instance",
            deleted: false,
            rawIcs: "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n",
          },
        ],
        now,
      });
      expect(
        database.listCalendarEvents(
          "google-owner",
          "2026-08-07T00:00:00.000Z",
          "2026-08-08T00:00:00.000Z",
        ),
      ).toMatchObject([
        {
          href: "event-1",
          recurrence: "instance",
          mutable: false,
          providerKind: "google",
          providerDisplayLabel: "Google Calendar",
          calendarName: "Primary",
        },
      ]);
      expect(database.listGoogleCalendarSync("google-owner")).toMatchObject([
        { syncToken: "sync-1", state: "fresh" },
      ]);
      database.applyGoogleEventSync({
        ownerId: "google-owner",
        calendarId: calendar.id,
        externalCalendarId: "primary@example.test",
        providerId: provider.id,
        syncToken: "sync-2",
        reset: false,
        events: [
          {
            id: "event-1",
            uid: "event-1@example.test",
            etag: '"event-2"',
            summary: "",
            startsAt: "1970-01-01T00:00:00.000Z",
            endsAt: "1970-01-01T00:00:00.001Z",
            allDay: false,
            recurrence: "none",
            deleted: true,
            rawIcs: "",
          },
        ],
        now: "2026-08-07T12:05:00.000Z",
      });
      expect(
        database.listCalendarEvents(
          "google-owner",
          "2026-08-07T00:00:00.000Z",
          "2026-08-08T00:00:00.000Z",
        ),
      ).toEqual([]);
      expect(database.getPlanningPreferences("google-owner")).toMatchObject({
        workingDays: [1, 2, 3, 4, 5],
        timeZone: "America/Chicago",
      });
      expect(
        database.putPlanningPreferences(
          "google-owner",
          {
            workingDays: [1, 3, 5],
            workdayStart: "08:00",
            workdayEnd: "16:00",
            breakStart: null,
            breakEnd: null,
            timeZone: "UTC",
          },
          now,
        ),
      ).toMatchObject({ workingDays: [1, 3, 5], breakStart: null });
      database.pruneGoogleCalendars("google-owner", provider.id, []);
      expect(database.listOwnedCalendars("google-owner", "google")).toEqual([]);
      expect(database.disconnectGoogle("google-owner")).toBe(true);
      expect(database.getGoogleConnector("google-owner")).toBeUndefined();
      expect(database.listOwnedCalendars("google-owner", "google")).toEqual([]);
      database.close();

      const raw = new DatabaseSync(path, { readOnly: true });
      const connectorRows = raw
        .prepare("SELECT COUNT(*) AS count FROM google_connectors")
        .get() as unknown as { readonly count: number };
      expect(connectorRows.count).toBe(0);
      raw.close();
    });
  });

  it("binds Google write consent to its OAuth request and keeps calendar roles with the calendar list", async () => {
    await withTemporaryDirectory((directory) => {
      const path = join(directory, "suite.sqlite");
      const database = SuiteDatabase.open(path);
      const now = "2026-09-29T12:00:00.000Z";
      database.createOwner({
        id: "write-owner",
        username: "write-owner",
        displayName: "Write owner",
        passwordHash: "hash",
        createdAt: now,
      });
      database.createGoogleOAuthState({
        stateHash: "read-digest",
        ownerId: "write-owner",
        expiresAt: "2026-09-29T12:10:00.000Z",
        createdAt: now,
      });
      expect(
        database.consumeGoogleOAuthRequest(
          "read-digest",
          "2026-09-29T12:01:00.000Z",
        ),
      ).toEqual({ ownerId: "write-owner", requestedAccess: "read" });
      database.createGoogleOAuthState({
        stateHash: "write-digest",
        ownerId: "write-owner",
        expiresAt: "2026-09-29T12:10:00.000Z",
        createdAt: now,
        requestedAccess: "write",
      });
      expect(
        database.consumeGoogleOAuthRequest(
          "write-digest",
          "2026-09-29T12:01:00.000Z",
        ),
      ).toEqual({ ownerId: "write-owner", requestedAccess: "write" });
      expect(
        database.consumeGoogleOAuthRequest(
          "write-digest",
          "2026-09-29T12:02:00.000Z",
        ),
      ).toBeUndefined();

      const connector = {
        id: "write-connector",
        ownerId: "write-owner",
        credentialKeyId: "key-id",
        credentialNonce: new Uint8Array([1]),
        credentialCiphertext: new Uint8Array([2]),
        credentialTag: new Uint8Array([3]),
        grantedScopes: ["read"],
        accountLabel: null,
        state: "connected" as const,
        createdAt: now,
        updatedAt: now,
        revokedAt: null,
      };
      database.putGoogleConnector(connector);
      expect(database.getGoogleConnector("write-owner")?.writeConsentAt).toBe(
        null,
      );
      database.putGoogleConnector({ ...connector, writeConsentAt: now });
      expect(database.getGoogleConnector("write-owner")?.writeConsentAt).toBe(
        now,
      );
      expect(database.setGoogleWriteConsent("write-owner", null, now)).toBe(
        true,
      );
      expect(database.getGoogleConnector("write-owner")?.writeConsentAt).toBe(
        null,
      );

      const provider = database.ensureCalendarProvider(
        "write-owner",
        "google",
        "write-connector",
        now,
      );
      const [owned, shared] = database.putCalendarCollections(
        provider.id,
        [
          {
            href: "owned@example.test",
            displayName: "Owned",
            supportsEvents: true,
            supportsTodos: false,
          },
          {
            href: "shared@example.test",
            displayName: "Shared",
            supportsEvents: true,
            supportsTodos: false,
          },
        ],
        now,
      );
      if (owned === undefined || shared === undefined)
        throw new Error("Calendar fixtures missing");
      database.putGoogleCalendarCapabilities(
        "write-owner",
        [
          { calendarId: owned.id, accessRole: "owner" },
          { calendarId: shared.id, accessRole: "writer" },
        ],
        now,
      );
      const later = "2026-09-29T13:00:00.000Z";
      database.putGoogleCalendarCapabilities(
        "write-owner",
        [{ calendarId: shared.id, accessRole: "reader" }],
        later,
      );
      expect(
        Object.fromEntries(
          database
            .listGoogleCalendarCapabilities("write-owner")
            .map(({ calendarId, accessRole, observedAt }) => [
              calendarId,
              [accessRole, observedAt],
            ]),
        ),
      ).toEqual({
        [owned.id]: ["owner", now],
        [shared.id]: ["reader", later],
      });
      database.pruneGoogleCalendars("write-owner", provider.id, [
        "owned@example.test",
      ]);
      expect(
        database
          .listGoogleCalendarCapabilities("write-owner")
          .map(({ calendarId }) => calendarId),
      ).toEqual([owned.id]);
      expect(database.disconnectGoogle("write-owner")).toBe(true);
      expect(database.listGoogleCalendarCapabilities("write-owner")).toEqual(
        [],
      );
      database.close();
    });
  });

  it("keeps notification occurrences durable, unique, cancellable, and content-free", async () => {
    await withTemporaryDirectory((directory) => {
      const path = join(directory, "suite.sqlite");
      let database = SuiteDatabase.open(path);
      const now = "2026-08-10T15:40:00.000Z";
      database.createOwner({
        id: "notification-owner",
        username: "notification-owner",
        displayName: "Notification owner",
        passwordHash: "hash",
        createdAt: now,
      });
      database.createTaskIdempotently(
        "notification-owner",
        "notification-task-create",
        "notification-task-hash",
        {
          id: "notification-task",
          title: "Private title sentinel",
          notes: "secret notes sentinel",
          status: "open",
          revision: 1,
          createdAt: now,
          updatedAt: now,
        },
      );
      database.patchTask(
        "notification-owner",
        "notification-task",
        1,
        {
          plannedStart: "2026-08-10T16:00:00.000Z",
          estimateMinutes: 30,
        },
        now,
      );
      expect(
        database.getNotificationPreferences("notification-owner"),
      ).toMatchObject({ enabled: false, leadReminderEnabled: true });
      const preferences = database.putNotificationPreferences(
        "notification-owner",
        {
          enabled: true,
          leadReminderEnabled: true,
          atStartReminderEnabled: true,
          detailedContentEnabled: true,
        },
        now,
      );
      const reconcile = (): void =>
        database.reconcileNotificationDeliveries({
          ownerId: "notification-owner",
          tasks: database.listTasks("notification-owner"),
          preferences,
          now,
        });
      reconcile();
      reconcile();
      const due = database.listDueNotificationDeliveries(
        "2026-08-10T15:45:00.000Z",
      );
      expect(due).toHaveLength(1);
      expect(due[0]).toMatchObject({ kind: "lead", attemptCount: 0 });
      const claimed = database.claimNotificationDelivery(
        due[0]?.id ?? "",
        "2026-08-10T15:45:00.000Z",
      );
      expect(claimed).toMatchObject({ state: "sending", attemptCount: 1 });
      database.finishNotificationDelivery(
        due[0]?.id ?? "",
        "delivered",
        null,
        "2026-08-10T15:45:01.000Z",
      );
      const current = database.getTask(
        "notification-owner",
        "notification-task",
      );
      database.patchTask(
        "notification-owner",
        "notification-task",
        current?.revision ?? 0,
        { plannedStart: "2026-08-10T17:00:00.000Z" },
        "2026-08-10T15:46:00.000Z",
      );
      database.reconcileNotificationDeliveries({
        ownerId: "notification-owner",
        tasks: database.listTasks("notification-owner"),
        preferences,
        now: "2026-08-10T15:46:00.000Z",
      });
      expect(
        database.getNotificationDeliveryStatus("notification-owner"),
      ).toMatchObject({ pendingCount: 2, failedCount: 0 });
      const raw = new DatabaseSync(path, { readOnly: true });
      const serialized = JSON.stringify(
        raw.prepare("SELECT * FROM notification_deliveries").all(),
      );
      expect(serialized).not.toContain("Private title sentinel");
      expect(serialized).not.toContain("secret notes sentinel");
      raw.close();
      database.close();
      database = SuiteDatabase.open(path);
      expect(
        database.getNotificationDeliveryStatus("notification-owner"),
      ).toMatchObject({ pendingCount: 2, failedCount: 0 });
      database.close();
    });
  });
});

it("persists the ADR 0035 token confirmation policy and rejects unknown values", async () => {
  await withTemporaryDirectory((directory) => {
    const path = join(directory, "suite.sqlite");
    const database = SuiteDatabase.open(path);
    database.createOwner({
      id: "owner-policy",
      username: "policy-owner",
      displayName: "Policy Owner",
      passwordHash: "not-a-real-hash",
      createdAt: "2026-09-25T00:00:00.000Z",
    });
    const token = {
      id: "automation-token-policy",
      ownerId: "owner-policy",
      label: "Execute ordinary",
      secretHash: "secret-digest-policy",
      confirmationPolicy: "execute_ordinary",
      scopes: ["tasks:write"],
      createdAt: "2026-09-25T00:00:00.000Z",
      lastUsedAt: null,
      expiresAt: "2026-09-26T00:00:00.000Z",
      revokedAt: null,
    };
    database.createAutomationToken(token);
    expect(() =>
      database.createAutomationToken({
        ...token,
        id: "automation-token-invalid",
        secretHash: "secret-digest-invalid",
        confirmationPolicy: "auto",
      }),
    ).toThrow();
    database.close();
    const reopened = SuiteDatabase.open(path);
    expect(reopened.listAutomationTokens("owner-policy")).toEqual([
      expect.objectContaining({
        id: "automation-token-policy",
        confirmationPolicy: "execute_ordinary",
      }),
    ]);
    expect(
      reopened.authenticateAutomationToken(
        "automation-token-policy",
        "secret-digest-policy",
        "2026-09-25T00:01:00.000Z",
      )?.confirmationPolicy,
    ).toBe("execute_ordinary");
    reopened.close();
  });
});
