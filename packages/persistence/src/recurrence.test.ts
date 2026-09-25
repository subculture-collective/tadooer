import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { zonedStartInstant } from "@suite/domain";
import { withTemporaryDirectory } from "@suite/test-support";
import {
  SuiteDatabase,
  type ImportedRecurringSeries,
  type RecurringSeriesFields,
  type TaskRecord,
} from "./index.ts";

const zone = "America/Chicago";
/** Noon in Chicago on a calendar date. */
const on = (date: string, time = "12:00") =>
  zonedStartInstant(date, time, zone);

const fields = (
  overrides: Partial<RecurringSeriesFields> = {},
): RecurringSeriesFields => ({
  title: "Water plants",
  notes: "",
  projectId: null,
  tagIds: [],
  estimateMinutes: null,
  rule: { cycle: "daily", interval: 1, weekdays: [], monthly: null },
  startDate: "2026-09-01",
  endDate: null,
  startTime: null,
  startReminder: { kind: "default" },
  anchor: "schedule",
  waitForCompletion: false,
  missedOccurrences: "latest",
  childTemplates: [],
  ...overrides,
});

const path = (directory: string) => join(directory, "suite.sqlite");
const open = (directory: string, owner = true) => {
  const db = SuiteDatabase.open(path(directory));
  if (owner)
    db.createOwner({
      id: "owner",
      username: "owner",
      displayName: "Owner",
      passwordHash: "hash",
      createdAt: on("2026-09-01"),
    });
  return db;
};

const createSeries = (
  db: SuiteDatabase,
  now: string,
  overrides: Partial<RecurringSeriesFields> = {},
  sourceTaskId?: string,
) => {
  const result = db.recurrence.create({
    ownerId: "owner",
    id: randomUUID(),
    idempotencyKey: randomUUID(),
    requestHash: "hash",
    fields: fields(overrides),
    sourceTaskId,
    timeZone: zone,
    now,
  });
  if (result.kind !== "created") throw new Error(`create: ${result.kind}`);
  return result;
};

const generate = (db: SuiteDatabase, date: string, time = "12:00") =>
  db.recurrence.generateDue({
    ownerId: "owner",
    timeZone: zone,
    now: on(date, time),
  });

const instances = (db: SuiteDatabase, seriesId: string): TaskRecord[] =>
  [...db.listTasks("owner"), ...db.listDeletedTasks("owner")]
    .filter((task) => task.recurrence?.seriesId === seriesId)
    .toSorted((left, right) =>
      (left.recurrence?.occurrenceDate ?? "").localeCompare(
        right.recurrence?.occurrenceDate ?? "",
      ),
    );

const complete = (db: SuiteDatabase, task: TaskRecord, at: string) => {
  const current = db.getTask("owner", task.id);
  if (current === undefined) throw new Error("missing task");
  const result = db.setTaskCompleted(
    "owner",
    task.id,
    current.revision,
    true,
    at,
  );
  if (result.kind !== "updated") throw new Error("complete failed");
};

describe("recurring series persistence", () => {
  it("creates today's instance once and replays across restarts", async () => {
    await withTemporaryDirectory(async (directory) => {
      const db = open(directory);
      const { series, generatedTaskIds } = createSeries(db, on("2026-09-24"));
      expect(generatedTaskIds).toHaveLength(1);
      const [first] = instances(db, series.id);
      expect(first).toMatchObject({
        title: "Water plants",
        plannedDay: "2026-09-24",
        plannedStart: null,
        recurrence: { seriesId: series.id, occurrenceDate: "2026-09-24" },
      });
      // The creation reached the sync change feed like any other task.
      const { epoch } = db.getSyncState("owner");
      expect(
        db
          .listSyncChanges("owner", epoch, 0)
          .some((change) => change.entityId === first?.id),
      ).toBe(true);
      expect(generate(db, "2026-09-24", "23:00")).toEqual([]);
      db.close();

      const reopened = open(directory, false);
      expect(generate(reopened, "2026-09-24", "23:30")).toEqual([]);
      expect(generate(reopened, "2026-09-25", "00:05")).toHaveLength(1);
      expect(generate(reopened, "2026-09-25")).toEqual([]);
      expect(
        instances(reopened, series.id).map(
          (task) => task.recurrence?.occurrenceDate,
        ),
      ).toEqual(["2026-09-24", "2026-09-25"]);
      reopened.close();
    });
  });

  it("rolls back a generation that fails midway and retries cleanly", async () => {
    await withTemporaryDirectory(async (directory) => {
      const db = open(directory);
      const { series } = createSeries(db, on("2026-09-24"), {
        childTemplates: [{ title: "Fill can", notes: "", estimateMinutes: 5 }],
      });
      const raw = new DatabaseSync(path(directory));
      raw.exec(`CREATE TRIGGER crash BEFORE INSERT ON recurring_task_links
        BEGIN SELECT RAISE(ABORT, 'simulated crash'); END;`);
      expect(() => generate(db, "2026-09-25")).toThrow("simulated crash");
      expect(instances(db, series.id)).toHaveLength(1);
      expect(
        db.listTasks("owner").filter(({ title }) => title === "Fill can"),
      ).toHaveLength(1);
      expect(db.recurrence.get("owner", series.id)?.cursorDate).toBe(
        "2026-09-24",
      );
      raw.exec("DROP TRIGGER crash;");
      raw.close();
      expect(generate(db, "2026-09-25")).toHaveLength(1);
      expect(
        db.listTasks("owner").filter(({ title }) => title === "Fill can"),
      ).toHaveLength(2);
      db.close();
    });
  });

  it("never duplicates an occurrence across two database handles", async () => {
    await withTemporaryDirectory(async (directory) => {
      const first = open(directory);
      const second = open(directory, false);
      const { series } = createSeries(first, on("2026-09-24"));
      expect(generate(first, "2026-09-25")).toHaveLength(1);
      expect(generate(second, "2026-09-25")).toEqual([]);
      // Even with a cursor that fell behind, the ledger holds the identity.
      const raw = new DatabaseSync(path(directory));
      raw
        .prepare("UPDATE recurring_series SET cursor_date=? WHERE id=?")
        .run("2026-09-24", series.id);
      raw.close();
      expect(generate(second, "2026-09-25")).toEqual([]);
      expect(instances(first, series.id)).toHaveLength(2);
      first.close();
      second.close();
    });
  });

  it("creates at most the newest missed occurrence after downtime", async () => {
    await withTemporaryDirectory(async (directory) => {
      const db = open(directory);
      const daily = createSeries(db, on("2026-09-01"));
      const mondays = createSeries(db, on("2026-09-01"), {
        title: "Weekly review",
        rule: { cycle: "weekly", interval: 1, weekdays: [1], monthly: null },
      });
      const skipped = createSeries(db, on("2026-09-01"), {
        title: "Stretch",
        rule: { cycle: "weekly", interval: 1, weekdays: [1], monthly: null },
        missedOccurrences: "skip",
      });
      // Down from September 1 until Thursday, September 24.
      expect(generate(db, "2026-09-24")).toHaveLength(2);
      expect(
        instances(db, daily.series.id).map((t) => t.recurrence?.occurrenceDate),
      ).toEqual(["2026-09-01", "2026-09-24"]);
      expect(
        instances(db, mondays.series.id).map(
          (t) => t.recurrence?.occurrenceDate,
        ),
      ).toEqual(["2026-09-21"]);
      expect(instances(db, skipped.series.id)).toEqual([]);
      expect(db.recurrence.get("owner", skipped.series.id)?.cursorDate).toBe(
        "2026-09-21",
      );
      db.close();
    });
  });

  it("plans timed instances at the same local time across DST", async () => {
    await withTemporaryDirectory(async (directory) => {
      const db = open(directory);
      const { series } = createSeries(db, on("2026-03-07", "06:00"), {
        startDate: "2026-03-07",
        startTime: "09:00",
        startReminder: { kind: "before_start", minutes: 15 },
      });
      generate(db, "2026-03-08", "06:00");
      generate(db, "2026-10-31", "06:00");
      generate(db, "2026-11-01", "06:00");
      expect(
        instances(db, series.id).map((task) => [
          task.plannedStart,
          task.plannedDay,
          task.startReminder,
        ]),
      ).toEqual([
        [
          "2026-03-07T15:00:00.000Z",
          null,
          { kind: "before_start", minutes: 15 },
        ],
        [
          "2026-03-08T14:00:00.000Z",
          null,
          { kind: "before_start", minutes: 15 },
        ],
        [
          "2026-10-31T14:00:00.000Z",
          null,
          { kind: "before_start", minutes: 15 },
        ],
        [
          "2026-11-01T15:00:00.000Z",
          null,
          { kind: "before_start", minutes: 15 },
        ],
      ]);
      db.close();
    });
  });

  it("waits for completion before creating the next instance", async () => {
    await withTemporaryDirectory(async (directory) => {
      const db = open(directory);
      const { series } = createSeries(db, on("2026-09-24"), {
        waitForCompletion: true,
      });
      expect(generate(db, "2026-09-26")).toEqual([]);
      expect(db.recurrence.get("owner", series.id)?.cursorDate).toBe(
        "2026-09-24",
      );
      const [pending] = instances(db, series.id);
      if (pending === undefined) throw new Error("missing instance");
      complete(db, pending, on("2026-09-26", "13:00"));
      expect(generate(db, "2026-09-26", "13:01")).toHaveLength(1);
      expect(
        instances(db, series.id).map((t) => t.recurrence?.occurrenceDate),
      ).toEqual(["2026-09-24", "2026-09-26"]);
      db.close();
    });
  });

  it("anchors a completion series on the latest completion date", async () => {
    await withTemporaryDirectory(async (directory) => {
      const db = open(directory);
      const { series } = createSeries(db, on("2026-09-01"), {
        rule: { cycle: "daily", interval: 3, weekdays: [], monthly: null },
        anchor: "completion",
      });
      const [first] = instances(db, series.id);
      if (first === undefined) throw new Error("missing instance");
      complete(db, first, on("2026-09-02", "18:00"));
      expect(generate(db, "2026-09-04")).toEqual([]);
      expect(db.recurrence.get("owner", series.id)).toMatchObject({
        anchorDate: "2026-09-02",
        cursorDate: "2026-09-02",
      });
      expect(generate(db, "2026-09-05")).toHaveLength(1);
      const second = instances(db, series.id)[1];
      if (second === undefined) throw new Error("missing instance");
      // Complete, reopen and complete again: the anchor follows the last
      // completion and a reopen does not move it back.
      complete(db, second, on("2026-09-06"));
      generate(db, "2026-09-06");
      const reopened = db.getTask("owner", second.id);
      if (reopened === undefined) throw new Error("missing instance");
      db.setTaskCompleted(
        "owner",
        second.id,
        reopened.revision,
        false,
        on("2026-09-06", "13:00"),
      );
      generate(db, "2026-09-06", "13:01");
      expect(db.recurrence.get("owner", series.id)?.anchorDate).toBe(
        "2026-09-06",
      );
      complete(db, second, on("2026-09-07"));
      expect(generate(db, "2026-09-09")).toEqual([]);
      expect(generate(db, "2026-09-10")).toHaveLength(1);
      expect(db.recurrence.get("owner", series.id)?.anchorDate).toBe(
        "2026-09-07",
      );
      db.close();
    });
  });

  it("keeps skipped and deleted occurrence exceptions", async () => {
    await withTemporaryDirectory(async (directory) => {
      const db = open(directory);
      const { series } = createSeries(db, on("2026-09-24"));
      const act = (
        date: string,
        action: "skip" | "unskip" | "delete_instance",
      ) => {
        const current = db.recurrence.get("owner", series.id);
        return db.recurrence.occurrence({
          ownerId: "owner",
          seriesId: series.id,
          expectedRevision: current?.revision ?? 0,
          date,
          action,
          now: on("2026-09-24", "13:00"),
        });
      };
      expect(act("2026-09-24", "skip")).toMatchObject({
        kind: "invalid",
        code: "occurrence_processed",
      });
      expect(act("2026-09-26", "unskip")).toMatchObject({
        kind: "invalid",
        code: "occurrence_not_skipped",
      });
      expect(act("2026-09-26", "skip")).toMatchObject({ kind: "updated" });
      expect(act("2026-09-27", "skip")).toMatchObject({ kind: "updated" });
      expect(act("2026-09-27", "unskip")).toMatchObject({ kind: "updated" });
      expect(act("2026-09-24", "delete_instance")).toMatchObject({
        kind: "updated",
      });
      expect(db.listTasks("owner")).toEqual([]);
      expect(generate(db, "2026-09-24", "20:00")).toEqual([]);
      expect(generate(db, "2026-09-26")).toEqual([]);
      expect(generate(db, "2026-09-27")).toHaveLength(1);
      expect(db.recurrence.exceptions("owner", series.id)).toEqual([
        { date: "2026-09-26", state: "skipped" },
        { date: "2026-09-24", state: "deleted" },
      ]);
      const stale = db.recurrence.occurrence({
        ownerId: "owner",
        seriesId: series.id,
        expectedRevision: 1,
        date: "2026-09-28",
        action: "skip",
        now: on("2026-09-27"),
      });
      expect(stale.kind).toBe("precondition-failed");
      db.close();
    });
  });

  it("does not backfill a pause and ends a series for good", async () => {
    await withTemporaryDirectory(async (directory) => {
      const db = open(directory);
      const { series } = createSeries(db, on("2026-09-21"), {
        startDate: "2026-09-21",
        rule: { cycle: "weekly", interval: 1, weekdays: [1], monthly: null },
      });
      const state = (action: "pause" | "resume" | "end", date: string) =>
        db.recurrence.setState({
          ownerId: "owner",
          seriesId: series.id,
          expectedRevision:
            db.recurrence.get("owner", series.id)?.revision ?? 0,
          action,
          timeZone: zone,
          now: on(date),
        });
      expect(state("pause", "2026-09-22")).toMatchObject({ kind: "updated" });
      expect(generate(db, "2026-09-28")).toEqual([]);
      // Resumed on Wednesday: Monday's occurrence fell in the pause.
      expect(state("resume", "2026-09-30")).toMatchObject({
        kind: "updated",
        generatedTaskIds: [],
      });
      expect(generate(db, "2026-10-05")).toHaveLength(1);
      expect(state("end", "2026-10-06")).toMatchObject({ kind: "updated" });
      expect(state("resume", "2026-10-07")).toMatchObject({
        kind: "invalid",
        code: "series_ended",
      });
      expect(generate(db, "2026-10-12")).toEqual([]);
      expect(
        instances(db, series.id).map((t) => t.recurrence?.occurrenceDate),
      ).toEqual(["2026-09-21", "2026-10-05"]);
      db.close();
    });
  });

  it("propagates template edits only to open instances on the old value", async () => {
    await withTemporaryDirectory(async (directory) => {
      const db = open(directory);
      const { series } = createSeries(db, on("2026-09-22"), {
        startDate: "2026-09-22",
        estimateMinutes: 10,
      });
      generate(db, "2026-09-23");
      generate(db, "2026-09-24");
      const [done, renamed, untouched] = instances(db, series.id);
      if (!done || !renamed || !untouched) throw new Error("missing instances");
      complete(db, done, on("2026-09-24"));
      db.patchTask(
        "owner",
        renamed.id,
        renamed.revision,
        { title: "Water the ferns" },
        on("2026-09-24"),
      );
      const result = db.recurrence.update({
        ownerId: "owner",
        seriesId: series.id,
        expectedRevision: series.revision,
        patch: {
          title: "Water all plants",
          estimateMinutes: 15,
          rule: { cycle: "daily", interval: 2, weekdays: [], monthly: null },
        },
        timeZone: zone,
        now: on("2026-09-24", "14:00"),
      });
      expect(result).toMatchObject({
        kind: "updated",
        updatedTaskIds: [renamed.id, untouched.id],
        generatedTaskIds: [],
      });
      const after = instances(db, series.id);
      expect(
        after.map(({ title, estimateMinutes }) => [title, estimateMinutes]),
      ).toEqual([
        ["Water plants", 10],
        ["Water the ferns", 15],
        ["Water all plants", 15],
      ]);
      // The schedule edit does not move existing instances.
      expect(after.map(({ plannedDay }) => plannedDay)).toEqual([
        "2026-09-22",
        "2026-09-23",
        "2026-09-24",
      ]);
      expect(db.recurrence.get("owner", series.id)).toMatchObject({
        floorDate: "2026-09-24",
        revision: 2,
      });
      db.close();
    });
  });

  it("creates child templates as child tasks and links a source task", async () => {
    await withTemporaryDirectory(async (directory) => {
      const db = open(directory);
      db.createTaskIdempotently("owner", "source", "source", {
        id: "00000000-0000-4000-8000-000000000001",
        title: "Weekly review",
        notes: "",
        status: "open",
        revision: 1,
        createdAt: on("2026-09-24"),
        updatedAt: on("2026-09-24"),
      });
      const { series, generatedTaskIds } = createSeries(
        db,
        on("2026-09-24"),
        {
          title: "Weekly review",
          rule: { cycle: "weekly", interval: 1, weekdays: [4], monthly: null },
          childTemplates: [
            { title: "Inbox zero", notes: "", estimateMinutes: 15 },
            {
              title: "Plan next week",
              notes: "Use the planner",
              estimateMinutes: null,
            },
          ],
        },
        "00000000-0000-4000-8000-000000000001",
      );
      expect(generatedTaskIds).toEqual([]);
      expect(
        db.getTask("owner", "00000000-0000-4000-8000-000000000001"),
      ).toMatchObject({
        recurrence: { seriesId: series.id, occurrenceDate: "2026-09-24" },
      });
      const [created] = generate(db, "2026-10-01");
      const children = db.taskHierarchy.listChildren("owner", created ?? "");
      expect(
        children.map(({ title, notes, estimateMinutes }) => [
          title,
          notes,
          estimateMinutes,
        ]),
      ).toEqual([
        ["Inbox zero", "", 15],
        ["Plan next week", "Use the planner", null],
      ]);
      expect(children.every((child) => child.recurrence === null)).toBe(true);
      db.close();
    });
  });

  it("imports series and instances without regenerating history", async () => {
    await withTemporaryDirectory(async (directory) => {
      const db = open(directory);
      const task = (sourceId: string) => ({
        kind: "task" as const,
        sourceId,
        sourceHash: sourceId,
        sourceJson: "{}",
        title: "Journal",
        notes: "",
        projectId: null,
        tagIds: [],
        plannedStart: null,
        plannedDay: null,
        deadlineDate: null,
        deadlineAt: null,
        estimateMinutes: null,
        completedAt: on("2026-09-20"),
        createdAt: on("2026-09-19"),
        parentSourceId: null,
        childIndex: null,
      });
      const imported: ImportedRecurringSeries = {
        ...fields({ title: "Journal", startDate: "2026-01-01" }),
        sourceId: "cfg",
        sourceHash: "cfg-hash",
        sourceJson: "{}",
        projectSourceId: null,
        tagSourceIds: [],
        paused: false,
        anchorDate: "2026-01-01",
        cursorDate: "2026-09-20",
        deletedDates: ["2026-09-22"],
        createdAt: null,
      };
      const recurrence = {
        series: [imported],
        links: [
          {
            taskSourceId: "a",
            seriesSourceId: "cfg",
            occurrenceDate: "2026-09-19",
          },
          {
            taskSourceId: "b",
            seriesSourceId: "cfg",
            occurrenceDate: "2026-09-20",
          },
          // A second copy of one day in the source history stays linked.
          {
            taskSourceId: "c",
            seriesSourceId: "cfg",
            occurrenceDate: "2026-09-20",
          },
        ],
      };
      const records = ["a", "b", "c"].map(task);
      expect(
        db.importTaskRecords("owner", records, on("2026-09-21"), recurrence),
      ).toEqual({
        created: 3,
        existing: 0,
        recurringSeries: { created: 1, existing: 0 },
      });
      const [series] = db.recurrence.list("owner");
      if (series === undefined) throw new Error("missing series");
      expect(series).toMatchObject({
        source: "super_productivity",
        cursorDate: "2026-09-20",
      });
      expect(db.recurrence.instanceCount("owner", series.id)).toBe(3);
      expect(generate(db, "2026-09-21")).toHaveLength(1);
      expect(generate(db, "2026-09-22")).toEqual([]);
      expect(generate(db, "2026-09-23")).toHaveLength(1);
      expect(
        db.importTaskRecords("owner", records, on("2026-09-23"), recurrence),
      ).toEqual({
        created: 0,
        existing: 3,
        recurringSeries: { created: 0, existing: 1 },
      });
      expect(db.recurrence.instanceCount("owner", series.id)).toBe(5);
      expect(() =>
        db.importTaskRecords("owner", records, on("2026-09-23"), {
          ...recurrence,
          series: [{ ...imported, sourceHash: "changed" }],
        }),
      ).toThrow("IMPORT_SOURCE_CHANGED");
      db.close();
    });
  });
});
