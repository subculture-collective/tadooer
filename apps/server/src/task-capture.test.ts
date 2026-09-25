import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SuiteDatabase } from "@suite/persistence";
import { withTemporaryDirectory } from "@suite/test-support";
import {
  createCapturedTask,
  createCapturedTaskBatch,
  resolveTaskCapture,
} from "./task-capture.ts";

const now = "2026-09-19T12:00:00.000Z";

const openOwner = (directory: string) => {
  const db = SuiteDatabase.open(join(directory, "suite.sqlite"));
  const ownerId = randomUUID();
  db.createOwner({
    id: ownerId,
    username: "owner",
    displayName: "Owner",
    passwordHash: "test",
    createdAt: now,
  });
  return { db, ownerId };
};

const tagTitles = (db: SuiteDatabase, ownerId: string) =>
  db.listTags(ownerId).map((tag) => tag.title);

describe("atomic structured capture", () => {
  it("resolves assignments and times together, leaves no partial task on failure, and replays before resolving again", async () => {
    await withTemporaryDirectory((directory) => {
      const { db, ownerId } = openOwner(directory);
      const projectId = randomUUID();
      const tagId = randomUUID();
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
      ).toThrow("confirm tag creation");
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

  it("applies estimate words with the editor bounds and rejects a double estimate", async () => {
    await withTemporaryDirectory((directory) => {
      const { db, ownerId } = openOwner(directory);
      const created = createCapturedTask(
        db,
        ownerId,
        "estimate",
        "h",
        { title: "Write report 1h30m", notes: "", structured: true },
        now,
      );
      expect(created).toMatchObject({
        kind: "created",
        task: { title: "Write report", estimateMinutes: 90 },
      });
      expect(() =>
        createCapturedTask(
          db,
          ownerId,
          "both",
          "h",
          {
            title: "Write report 30m",
            notes: "",
            structured: true,
            estimateMinutes: 45,
          },
          now,
        ),
      ).toThrow("either capture markers or explicit fields");
      // The web form sends null for a blank field; that is not a conflict.
      expect(
        resolveTaskCapture(
          db,
          ownerId,
          {
            title: "Write report 30m",
            notes: "",
            structured: true,
            estimateMinutes: null,
          },
          now,
        ).estimateMinutes,
      ).toBe(30);
      expect(() =>
        createCapturedTask(
          db,
          ownerId,
          "big",
          "h",
          { title: "Write report 13h", notes: "", structured: true },
          now,
        ),
      ).toThrow("outside 1–720");
      expect(db.listTasks(ownerId)).toHaveLength(1);
      db.close();
    });
  });

  it("creates confirmed new tags with the task in one transaction, case-folded and reused", async () => {
    await withTemporaryDirectory((directory) => {
      const { db, ownerId } = openOwner(directory);
      const input = {
        title: "Ship #Release #release #Später",
        notes: "",
        structured: true,
      };
      expect(() =>
        createCapturedTask(db, ownerId, "no-consent", "h", input, now),
      ).toThrow("confirm tag creation");
      expect(tagTitles(db, ownerId)).toEqual([]);

      const resolved = resolveTaskCapture(db, ownerId, input, now, {
        allowNewTags: true,
      });
      expect(resolved.newTags?.map((tag) => tag.title)).toEqual([
        "Release",
        "Später",
      ]);

      const created = createCapturedTask(
        db,
        ownerId,
        "consent",
        "h",
        { ...input, createTags: true },
        now,
      );
      expect(created.kind).toBe("created");
      expect(tagTitles(db, ownerId)).toEqual(["Release", "Später"]);
      expect(
        created.kind === "created" ? created.task.tagIds : [],
      ).toHaveLength(2);
      // An existing tag with another case is reused, not duplicated.
      const reused = createCapturedTask(
        db,
        ownerId,
        "reuse",
        "h",
        {
          title: "Again #RELEASE #new",
          notes: "",
          structured: true,
          createTags: true,
        },
        now,
      );
      expect(reused.kind).toBe("created");
      expect(tagTitles(db, ownerId)).toEqual(["Release", "Später", "new"]);

      // A failure after the tags are created rolls the tags back too:
      // 25 new tags pass the request limit; with an existing one it is 26.
      const tooMany = Array.from(
        { length: 25 },
        (_, index) => `#t${String(index)}`,
      )
        .concat("#new")
        .join(" ");
      expect(() =>
        createCapturedTask(
          db,
          ownerId,
          "many",
          "h",
          {
            title: `Overflow ${tooMany}`,
            notes: "",
            structured: true,
            createTags: true,
          },
          now,
        ),
      ).toThrow("limited to 25");
      expect(tagTitles(db, ownerId)).toEqual(["Release", "Später", "new"]);
      expect(db.listTasks(ownerId)).toHaveLength(2);
      db.close();
    });
  });

  it("attaches safe links per the URL preference and never stores credentials", async () => {
    await withTemporaryDirectory((directory) => {
      const { db, ownerId } = openOwner(directory);
      const title = "Read https://example.com/spec and www.example.org/x";
      const attached = createCapturedTask(
        db,
        ownerId,
        "attach",
        "h",
        { title, notes: "", structured: true },
        now,
      );
      if (attached.kind !== "created") throw new Error("expected creation");
      expect(attached.task.title).toBe(title);
      expect(
        db.taskLinks
          .get(ownerId, attached.task.id)
          ?.attachments.map((a) => a.url),
      ).toEqual(["https://example.com/spec", "https://www.example.org/x"]);

      expect(
        db.capture.updatePreferences(
          ownerId,
          0,
          { urlBehavior: "extract" },
          now,
        ),
      ).toEqual({ urlBehavior: "extract", revision: 1 });
      expect(
        db.capture.updatePreferences(ownerId, 0, { urlBehavior: "keep" }, now),
      ).toBeUndefined();
      const extracted = createCapturedTask(
        db,
        ownerId,
        "extract",
        "h",
        { title: "Read https://example.com/spec", notes: "", structured: true },
        now,
      );
      expect(extracted).toMatchObject({
        kind: "created",
        task: { title: "Read" },
      });

      db.capture.updatePreferences(ownerId, 1, { urlBehavior: "keep" }, now);
      const kept = createCapturedTask(
        db,
        ownerId,
        "keep",
        "h",
        {
          title: "Read https://user:pw@example.com/spec",
          notes: "",
          structured: true,
        },
        now,
      );
      if (kept.kind !== "created") throw new Error("expected creation");
      expect(db.taskLinks.get(ownerId, kept.task.id)?.attachments).toEqual([]);

      db.capture.updatePreferences(
        ownerId,
        2,
        { urlBehavior: "keep_and_attach" },
        now,
      );
      expect(() =>
        createCapturedTask(
          db,
          ownerId,
          "unsafe",
          "h",
          {
            title: "Read https://user:pw@example.com/spec",
            notes: "",
            structured: true,
          },
          now,
        ),
      ).toThrow("user name or password");
      expect(db.listTasks(ownerId)).toHaveLength(3);
      db.close();
    });
  });

  it("plans a day for @date and starts a recurring series for @every with the task as first instance", async () => {
    await withTemporaryDirectory((directory) => {
      const { db, ownerId } = openOwner(directory);
      const planned = createCapturedTask(
        db,
        ownerId,
        "day",
        "h",
        { title: "Plan @tomorrow", notes: "", structured: true },
        now,
      );
      expect(planned).toMatchObject({
        kind: "created",
        task: { plannedDay: "2026-09-20", plannedStart: null },
      });

      // 2026-09-19 is a Saturday in America/Chicago (the default zone).
      const repeating = createCapturedTask(
        db,
        ownerId,
        "series",
        "h",
        {
          title: "Standup #team @every monday 09:00",
          notes: "",
          structured: true,
          createTags: true,
        },
        now,
      );
      if (repeating.kind !== "created") throw new Error("expected creation");
      expect(repeating.task).toMatchObject({
        title: "Standup",
        plannedStart: "2026-09-21T14:00:00.000Z",
        recurrence: { occurrenceDate: "2026-09-21" },
      });
      const series = db.recurrence.list(ownerId);
      expect(series).toHaveLength(1);
      expect(series[0]).toMatchObject({
        title: "Standup",
        rule: { cycle: "weekly", interval: 1, weekdays: [1] },
        startDate: "2026-09-21",
        startTime: "09:00",
        tagIds: repeating.task.tagIds,
      });
      expect(db.recurrence.instanceCount(ownerId, series[0]?.id ?? "")).toBe(1);
      expect(db.listTasks(ownerId)).toHaveLength(2);

      // Replay creates no second series.
      expect(
        createCapturedTask(
          db,
          ownerId,
          "series",
          "h",
          {
            title: "Standup #team @every monday 09:00",
            notes: "",
            structured: true,
            createTags: true,
          },
          now,
        ).kind,
      ).toBe("replayed");
      expect(db.recurrence.list(ownerId)).toHaveLength(1);

      expect(() =>
        createCapturedTask(
          db,
          ownerId,
          "bad",
          "h",
          { title: "Odd @every other day", notes: "", structured: true },
          now,
        ),
      ).toThrow("Unsupported repeat");
      db.close();
    });
  });

  it("creates a pasted batch atomically with children, replays it, and rolls back on a bad item", async () => {
    await withTemporaryDirectory((directory) => {
      const { db, ownerId } = openOwner(directory);
      const items = [
        {
          title: "Plan sprint #sprint 30m",
          notes: "",
          structured: true,
          children: [
            { title: "Draft agenda #sprint", notes: "", structured: true },
            { title: "Book room", notes: "", structured: false },
          ],
        },
        { title: "Second", notes: "n", structured: false, children: [] },
      ];
      const created = createCapturedTaskBatch(
        db,
        ownerId,
        "batch",
        "h",
        { items, createTags: true },
        now,
      );
      expect(created.kind).toBe("created");
      expect(created.tasks.map((task) => task.title)).toEqual([
        "Plan sprint",
        "Draft agenda",
        "Book room",
        "Second",
      ]);
      expect(tagTitles(db, ownerId)).toEqual(["sprint"]);
      const parent = created.tasks[0];
      expect(
        db.taskHierarchy
          .listChildren(ownerId, parent?.id ?? "")
          .map((task) => task.title),
      ).toEqual(["Draft agenda", "Book room"]);
      expect(created.tasks[1]?.tagIds).toEqual(parent?.tagIds);

      const replayed = createCapturedTaskBatch(
        db,
        ownerId,
        "batch",
        "h",
        { items, createTags: true },
        now,
      );
      expect(replayed.kind).toBe("replayed");
      expect(replayed.tasks).toHaveLength(4);
      expect(
        createCapturedTaskBatch(db, ownerId, "batch", "other", { items }, now)
          .kind,
      ).toBe("conflict");

      expect(() =>
        createCapturedTaskBatch(
          db,
          ownerId,
          "broken",
          "h",
          {
            items: [
              {
                title: "Fine #newtag",
                notes: "",
                structured: true,
                children: [],
              },
              {
                title: "Broken +Nope",
                notes: "",
                structured: true,
                children: [],
              },
            ],
            createTags: true,
          },
          now,
        ),
      ).toThrow("Project");
      expect(db.listTasks(ownerId)).toHaveLength(4);
      expect(tagTitles(db, ownerId)).toEqual(["sprint"]);
      db.close();
    });
  });
});
