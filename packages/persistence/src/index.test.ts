import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { withTemporaryDirectory } from "@suite/test-support";
import { SuiteDatabase } from "./index.ts";

describe("SuiteDatabase", () => {
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
        appliedMigrationCount: 7,
        expectedMigrationCount: 7,
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
      expect(reopenedState.appliedMigrationCount).toBe(7);
      expect(reopenedState.expectedMigrationCount).toBe(7);
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
        },
        "2026-08-06T00:01:00.000Z",
      );
      expect(patched).toMatchObject({
        kind: "updated",
        task: { title: "Plan Phase 1", revision: 2, estimateMinutes: 45 },
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
});
