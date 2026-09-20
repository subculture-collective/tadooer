import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SuiteDatabase } from "@suite/persistence";
import { withTemporaryDirectory } from "@suite/test-support";
import { createCapturedTask } from "./task-capture.ts";

describe("atomic structured capture", () => {
  it("resolves assignments and times together, leaves no partial task on failure, and replays before resolving again", async () => {
    await withTemporaryDirectory((directory) => {
      const db = SuiteDatabase.open(join(directory, "suite.sqlite"));
      const ownerId = randomUUID();
      const projectId = randomUUID();
      const tagId = randomUUID();
      const now = "2026-09-19T12:00:00.000Z";
      db.createOwner({
        id: ownerId,
        username: "owner",
        displayName: "Owner",
        passwordHash: "test",
        createdAt: now,
      });
      const common = {
        ownerId,
        revision: 1,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
      };
      db.createProject({ ...common, id: projectId, title: "Work + Home" });
      db.createTag({
        ...common,
        id: tagId,
        title: "urgent",
        normalizedName: "urgent",
      });
      const input = {
        title: 'Review +"Work + Home" #urgent @tomorrow 09:00 !Friday',
        notes: "",
        structured: true,
        estimateMinutes: 25,
      };
      const cursor = db.getSyncState(ownerId);
      expect(() =>
        createCapturedTask(
          db,
          ownerId,
          "failed",
          "hash",
          { ...input, title: "Review +Missing #urgent" },
          now,
        ),
      ).toThrow("Project");
      expect(() =>
        createCapturedTask(
          db,
          ownerId,
          "failed-tag",
          "hash",
          { ...input, title: 'Review +"Work + Home" #missing' },
          now,
        ),
      ).toThrow("Tag");
      expect(db.listTasks(ownerId)).toEqual([]);
      expect(db.getSyncState(ownerId)).toEqual(cursor);
      const created = createCapturedTask(
        db,
        ownerId,
        "capture",
        "hash",
        input,
        now,
      );
      expect(created).toMatchObject({
        kind: "created",
        task: {
          title: "Review",
          projectId,
          tagIds: [tagId],
          estimateMinutes: 25,
          plannedStart: "2026-09-20T14:00:00.000Z",
          deadlineDate: "2026-09-25",
          deadlineAt: null,
        },
      });
      db.archiveProject(ownerId, projectId, 1, now);
      expect(
        createCapturedTask(
          db,
          ownerId,
          "capture",
          "hash",
          input,
          "2026-09-21T12:00:00Z",
        ),
      ).toMatchObject({ kind: "replayed" });
      expect(() =>
        createCapturedTask(db, ownerId, "new", "newhash", input, now),
      ).toThrow("archived");
      expect(() =>
        createCapturedTask(
          db,
          ownerId,
          "explicit",
          "hash",
          { title: "Explicit", notes: "", projectId, tagIds: [tagId] },
          now,
        ),
      ).toThrow("archived");
      expect(db.listTasks(ownerId)).toHaveLength(1);
      expect(db.listProjects(ownerId)).toHaveLength(1);
      expect(db.listTags(ownerId)).toHaveLength(1);
      db.close();
    });
  });
});
