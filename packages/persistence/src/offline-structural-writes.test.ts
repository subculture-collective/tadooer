import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { withTemporaryDirectory } from "@suite/test-support";
import { SuiteDatabase } from "./index.ts";

const owner = "owner-1";
const client = "client-1";
const now = "2026-09-25T12:00:00.000Z";

const open = (directory: string): SuiteDatabase => {
  const database = SuiteDatabase.open(join(directory, "suite.sqlite"));
  database.createOwner({
    id: owner,
    username: "owner",
    displayName: "Owner",
    passwordHash: "hash",
    createdAt: now,
  });
  database.registerSyncClient({
    id: client,
    ownerId: owner,
    label: "Laptop",
    credentialHash: "credential-hash",
    createdAt: now,
    lastSeenAt: now,
    revokedAt: null,
  });
  database.createTaskIdempotently(owner, "task-1", "hash", {
    id: "task-1",
    title: "Task",
    notes: "",
    status: "open",
    revision: 1,
    createdAt: now,
    updatedAt: now,
  });
  return database;
};

const envelope = (operationId: string) => ({
  ownerId: owner,
  clientId: client,
  operationId,
  requestHash: `${operationId}-hash`,
  now,
});

describe("ADR 0033 offline structural writes", () => {
  it("seeds the planning slot version and advances it for start, day and calendar changes", async () => {
    await withTemporaryDirectory((directory) => {
      const database = open(directory);
      expect(database.getTaskFieldVersions(owner, "task-1")).toMatchObject({
        plannedStart: 1,
      });
      expect(
        database.patchTask(
          owner,
          "task-1",
          1,
          { plannedDay: "2026-09-26" },
          now,
        ).kind,
      ).toBe("updated");
      expect(database.getTaskFieldVersions(owner, "task-1")).toMatchObject({
        plannedStart: 2,
        title: 1,
      });
      // A stale offline start edit conflicts with the online planned day.
      expect(
        database.applyTaskFieldSync({
          ...envelope("stale-start"),
          taskId: "task-1",
          baseVersions: { plannedStart: 1 },
          patch: { plannedStart: "2026-09-26T09:00:00.000Z" },
        }),
      ).toMatchObject({ kind: "conflict", fields: ["plannedStart"] });
      // A current one applies and clears the day (ADR 0020 exclusivity).
      const applied = database.applyTaskFieldSync({
        ...envelope("current-start"),
        taskId: "task-1",
        baseVersions: { plannedStart: 2 },
        patch: { plannedStart: "2026-09-26T09:00:00.000Z" },
      });
      expect(applied).toMatchObject({
        kind: "applied",
        task: {
          revision: 3,
          plannedStart: "2026-09-26T09:00:00.000Z",
          plannedDay: null,
        },
      });
      expect(
        database.applyTaskFieldSync({
          ...envelope("current-start"),
          taskId: "task-1",
          baseVersions: { plannedStart: 2 },
          patch: { plannedStart: "2026-09-26T09:00:00.000Z" },
        }).kind,
      ).toBe("replayed");
      // Planned day through the outbox clears the start.
      expect(
        database.applyTaskFieldSync({
          ...envelope("day"),
          taskId: "task-1",
          baseVersions: { plannedStart: 3 },
          patch: { plannedDay: "2026-09-27" },
        }),
      ).toMatchObject({
        kind: "applied",
        task: { revision: 4, plannedStart: null, plannedDay: "2026-09-27" },
      });
      // Disjoint fields still merge with a planning change.
      expect(
        database.applyTaskFieldSync({
          ...envelope("title"),
          taskId: "task-1",
          baseVersions: { title: 1 },
          patch: { title: "Renamed" },
        }),
      ).toMatchObject({ kind: "applied", task: { revision: 5 } });

      // A calendar block owns the planned start.
      const provider = database.ensureCalendarProvider(
        owner,
        "baikal",
        "connector-1",
        now,
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
        now,
      )[0];
      if (calendar === undefined) throw new Error("Calendar missing");
      database.reserveCalendarWrite({
        ownerId: owner,
        taskId: "task-1",
        expectedTaskRevision: 5,
        idempotencyKey: "planning-1",
        requestHash: "planning-hash",
        calendarId: calendar.id,
        reservedHref: "/dav.php/calendars/owner/default/suite-task.ics",
        reservedUid: "suite-task",
        now,
      });
      database.completeCalendarWrite({
        ownerId: owner,
        idempotencyKey: "planning-1",
        event: {
          id: "event-1",
          providerId: provider.id,
          calendarId: calendar.id,
          href: "/dav.php/calendars/owner/default/suite-task.ics",
          uid: "suite-task",
          etag: '"v1"',
          rawIcs: "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n",
          summary: "Task",
          startsAt: "2026-09-28T14:00:00.000Z",
          endsAt: "2026-09-28T14:45:00.000Z",
          allDay: false,
          freshness: "current",
          mutable: true,
          revision: 1,
          projectedAt: now,
        },
        plannedStart: "2026-09-28T14:00:00.000Z",
        estimateMinutes: 45,
        now,
      });
      const versions = database.getTaskFieldVersions(owner, "task-1");
      expect(versions).toMatchObject({ plannedStart: 6, estimateMinutes: 6 });
      for (let attempt = 0; attempt < 2; attempt += 1)
        expect(
          database.applyTaskFieldSync({
            ...envelope("blocked"),
            taskId: "task-1",
            baseVersions: { plannedStart: 6 },
            patch: { plannedStart: null },
          }),
        ).toMatchObject({ kind: "conflict", fields: ["calendarBlock"] });
      expect(database.getTask(owner, "task-1")?.plannedStart).toBe(
        "2026-09-28T14:00:00.000Z",
      );
      database.close();
    });
  });

  it("assigns projects and tags with field versions and rejects archived references", async () => {
    await withTemporaryDirectory((directory) => {
      const database = open(directory);
      const project = database.mutateOrganization(
        "project",
        owner,
        "project-1",
        null,
        { title: "Home", backlogEnabled: true },
        now,
      );
      database.mutateOrganization(
        "tag",
        owner,
        "tag-1",
        null,
        { title: "A" },
        now,
      );
      database.mutateOrganization(
        "tag",
        owner,
        "tag-2",
        null,
        { title: "B" },
        now,
      );
      if (project === undefined) throw new Error("Project missing");
      expect(
        database.applyTaskFieldSync({
          ...envelope("assign"),
          taskId: "task-1",
          baseVersions: { projectId: 1, tagIds: 1 },
          patch: { projectId: "project-1", tagIds: ["tag-2", "tag-1"] },
        }),
      ).toMatchObject({
        kind: "applied",
        task: { revision: 2, projectId: "project-1" },
      });
      expect(database.getTask(owner, "task-1")?.tagIds).toEqual([
        "tag-1",
        "tag-2",
      ]);
      expect(database.getTaskFieldVersions(owner, "task-1")).toMatchObject({
        projectId: 2,
        tagIds: 2,
        title: 1,
      });
      // Backlog membership follows the task out of the project.
      expect(
        database.setProjectBacklog(owner, "project-1", 1, "task-1", true, now)
          .kind,
      ).toBe("applied");
      expect(
        database.applyTaskFieldSync({
          ...envelope("leave"),
          taskId: "task-1",
          baseVersions: { projectId: 2 },
          patch: { projectId: null },
        }),
      ).toMatchObject({ kind: "applied", task: { projectId: null } });
      expect(
        database.listProjects(owner).find(({ id }) => id === "project-1")
          ?.backlogTaskIds,
      ).toEqual([]);
      // Archived or unknown references change nothing.
      database.mutateOrganization(
        "tag",
        owner,
        "tag-2",
        1,
        { archived: true },
        now,
      );
      const before = database.getTask(owner, "task-1");
      expect(
        database.applyTaskFieldSync({
          ...envelope("archived-tag"),
          taskId: "task-1",
          baseVersions: { tagIds: 2 },
          patch: { tagIds: ["tag-2"] },
        }),
      ).toMatchObject({ kind: "conflict", fields: ["tag"] });
      expect(
        database.applyTaskFieldSync({
          ...envelope("unknown-project"),
          taskId: "task-1",
          baseVersions: { projectId: 3 },
          patch: { projectId: "missing-project" },
        }),
      ).toMatchObject({ kind: "conflict", fields: ["project"] });
      expect(database.getTask(owner, "task-1")).toEqual(before);
      // A stale assignment is a field conflict like any other field.
      expect(
        database.applyTaskFieldSync({
          ...envelope("stale-project"),
          taskId: "task-1",
          baseVersions: { projectId: 1 },
          patch: { projectId: "project-1" },
        }),
      ).toMatchObject({ kind: "conflict", fields: ["projectId"] });
      database.close();
    });
  });

  it("creates and patches projects and tags idempotently with resource conflicts", async () => {
    await withTemporaryDirectory((directory) => {
      const database = open(directory);
      const create = {
        ...envelope("create-project"),
        kind: "project" as const,
        id: "project-1",
        baseRevision: null,
        fields: { title: "Home" },
      };
      expect(database.applyOrganizationSync(create)).toMatchObject({
        kind: "applied",
        record: { id: "project-1", title: "Home", revision: 1 },
      });
      expect(database.applyOrganizationSync(create).kind).toBe("replayed");
      expect(
        database.applyOrganizationSync({
          ...create,
          requestHash: "other-hash",
        }).kind,
      ).toBe("idempotency-conflict");
      // Another client reusing the ID conflicts and changes nothing.
      expect(
        database.applyOrganizationSync({
          ...create,
          operationId: "create-project-again",
          fields: { title: "Other" },
        }),
      ).toMatchObject({ kind: "conflict", fields: ["record"] });
      expect(database.listProjects(owner)[0]?.title).toBe("Home");
      expect(
        database.applyOrganizationSync({
          ...envelope("complete-project"),
          kind: "project",
          id: "project-1",
          baseRevision: 1,
          fields: { completed: true, title: "House" },
        }),
      ).toMatchObject({
        kind: "applied",
        record: { title: "House", revision: 2, completedAt: now },
      });
      expect(
        database.applyOrganizationSync({
          ...envelope("stale-project"),
          kind: "project",
          id: "project-1",
          baseRevision: 1,
          fields: { archived: false },
        }),
      ).toMatchObject({ kind: "conflict", fields: ["revision"] });
      const state = database.getSyncState(owner);
      expect(
        database
          .listSyncChanges(owner, state.epoch, 0)
          .filter(({ entityId }) => entityId === "project-1")
          .map(({ revision }) => revision),
      ).toEqual([1, 1, 2, 2]);

      expect(
        database.applyOrganizationSync({
          ...envelope("create-tag"),
          kind: "tag",
          id: "tag-1",
          baseRevision: null,
          fields: { title: "Errand" },
        }),
      ).toMatchObject({
        kind: "applied",
        record: { normalizedName: "errand" },
      });
      expect(
        database.applyOrganizationSync({
          ...envelope("duplicate-tag"),
          kind: "tag",
          id: "tag-2",
          baseRevision: null,
          fields: { title: "errand" },
        }),
      ).toMatchObject({ kind: "conflict", fields: ["name"] });
      expect(database.listTags(owner)).toHaveLength(1);
      expect(
        database.applyOrganizationSync({
          ...envelope("archive-tag"),
          kind: "tag",
          id: "tag-1",
          baseRevision: 1,
          fields: { archived: true },
        }),
      ).toMatchObject({ kind: "applied", record: { archivedAt: now } });
      database.close();
    });
  });

  it("creates, patches and deletes checklist items idempotently", async () => {
    await withTemporaryDirectory((directory) => {
      const database = open(directory);
      const parent = "8b4a1d5e-3c2f-4a6b-9d1e-2f3a4b5c6d7e";
      const item = "1f2e3d4c-5b6a-4978-8a9b-0c1d2e3f4a5b";
      database.createTaskIdempotently(owner, parent, "hash", {
        id: parent,
        title: "Parent",
        notes: "",
        status: "open",
        revision: 1,
        createdAt: now,
        updatedAt: now,
      });
      const create = {
        ...envelope("create-item"),
        command: {
          action: "create" as const,
          id: item,
          taskId: parent,
          title: "Step",
          position: 0,
        },
      };
      expect(database.applyChecklistSync(create)).toMatchObject({
        kind: "applied",
        record: { id: item, revision: 1, completed: false },
      });
      expect(database.applyChecklistSync(create).kind).toBe("replayed");
      expect(
        database.applyChecklistSync({
          ...envelope("orphan"),
          command: {
            action: "create",
            id: "2f2e3d4c-5b6a-4978-8a9b-0c1d2e3f4a5b",
            taskId: "3f2e3d4c-5b6a-4978-8a9b-0c1d2e3f4a5b",
            title: "Step",
            position: 0,
          },
        }),
      ).toMatchObject({ kind: "conflict", fields: ["task"] });
      expect(
        database.applyChecklistSync({
          ...envelope("complete-item"),
          command: {
            action: "update",
            id: item,
            baseRevision: 1,
            patch: { completed: true, position: 3 },
          },
        }),
      ).toMatchObject({
        kind: "applied",
        record: { revision: 2, completed: true, position: 3 },
      });
      for (let attempt = 0; attempt < 2; attempt += 1)
        expect(
          database.applyChecklistSync({
            ...envelope("stale-item"),
            command: {
              action: "update",
              id: item,
              baseRevision: 1,
              patch: { title: "Old" },
            },
          }),
        ).toMatchObject({ kind: "conflict", fields: ["revision"] });
      expect(database.listSubtasks(owner, parent)[0]?.title).toBe("Step");
      expect(
        database.applyChecklistSync({
          ...envelope("delete-item"),
          command: { action: "delete", id: item, baseRevision: 2 },
        }).kind,
      ).toBe("applied");
      expect(database.listSubtasks(owner, parent)).toEqual([]);
      expect(
        database.applyChecklistSync({
          ...envelope("delete-item"),
          command: { action: "delete", id: item, baseRevision: 2 },
        }).kind,
      ).toBe("replayed");
      expect(
        database.applyChecklistSync({
          ...envelope("delete-gone"),
          command: { action: "delete", id: item, baseRevision: 2 },
        }),
      ).toMatchObject({ kind: "conflict", fields: ["record"] });
      database.close();
    });
  });
});
