import { describe, expect, it } from "vitest";
import { prepareSuperProductivityImport } from "./super-productivity-apply.ts";
import { previewSuperProductivity } from "./super-productivity.ts";

// Repeat configuration import (issue #42, ADR 0023). Fixtures are synthetic.
const state = (entities: Record<string, unknown>) => ({
  ids: Object.keys(entities),
  entities,
});
const zone = "America/Chicago";
const prepare = (data: Record<string, unknown>) =>
  prepareSuperProductivityImport(JSON.stringify({ data }), { timeZone: zone });
const blocking = (report: {
  issues: readonly { code: string; blocking?: boolean; detail: string }[];
}) =>
  report.issues
    .filter((issue) => issue.blocking !== false)
    .map(({ code, detail }) => `${code}: ${detail}`);

/** A configuration as Super Productivity 19.1.0 writes it. */
const cfg = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  projectId: null,
  lastTaskCreation: Date.parse("2026-09-20T17:00:00.000Z"),
  lastTaskCreationDay: "2026-09-20",
  title: `Series ${id}`,
  tagIds: [],
  order: 0,
  isPaused: false,
  quickSetting: "CUSTOM",
  repeatCycle: "DAILY",
  startDate: "2026-01-01",
  repeatEvery: 1,
  monday: true,
  tuesday: true,
  wednesday: true,
  thursday: true,
  friday: true,
  saturday: false,
  sunday: false,
  notes: "",
  shouldInheritSubtasks: false,
  disableAutoUpdateSubtasks: false,
  skipOverdue: false,
  ...overrides,
});
// 17:00 in Chicago on a date, as an epoch.
const createdOn = (date: string) => Date.parse(`${date}T22:00:00.000Z`);

describe("Super Productivity repeat configurations", () => {
  it("maps every supported option to a recurring series", () => {
    const { report, recurrence } = prepare({
      task: state({}),
      project: state({ p: { id: "p", title: "Home" } }),
      tag: state({ t: { id: "t", title: "Chores" } }),
      taskRepeatCfg: state({
        daily: cfg("daily", {
          projectId: "p",
          tagIds: ["TODAY", "t"],
          defaultEstimate: 900000,
          notes: "Use the green can",
          startTime: "9:30",
          remindAt: "m15",
          skipOverdue: true,
          deletedInstanceDates: ["2026-09-12", "2026-09-10"],
        }),
        weekly: cfg("weekly", {
          repeatCycle: "WEEKLY",
          repeatEvery: 2,
          waitForCompletion: true,
          shouldInheritSubtasks: true,
          subTaskTemplates: [
            { title: "Sweep", timeEstimate: 600000 },
            { title: "Mop", notes: "Kitchen only" },
          ],
        }),
        nth: cfg("nth", {
          repeatCycle: "MONTHLY",
          monthlyWeekOfMonth: -1,
          monthlyWeekday: 5,
          monthlyLastDay: true,
        }),
        monthEnd: cfg("monthEnd", {
          repeatCycle: "MONTHLY",
          monthlyWeekday: 2,
          monthlyLastDay: true,
          isPaused: true,
        }),
        yearly: cfg("yearly", {
          repeatCycle: "YEARLY",
          startDate: "2024-02-29",
          repeatFromCompletionDate: true,
          startTime: "07:00",
          remindAt: "DoNotRemind",
          lastTaskCreationDay: undefined,
        }),
      }),
    });
    expect(blocking(report)).toEqual([]);
    expect(report.canApply).toBe(true);
    const series = new Map(recurrence.series.map((s) => [s.sourceId, s]));
    expect(series.get("daily")).toMatchObject({
      title: "Series daily",
      notes: "Use the green can",
      projectSourceId: "p",
      tagSourceIds: ["t"],
      estimateMinutes: 15,
      rule: { cycle: "daily", interval: 1, weekdays: [], monthly: null },
      startDate: "2026-01-01",
      startTime: "09:30",
      startReminder: { kind: "before_start", minutes: 15 },
      missedOccurrences: "skip",
      anchor: "schedule",
      cursorDate: "2026-09-20",
      deletedDates: ["2026-09-10", "2026-09-12"],
      paused: false,
    });
    expect(series.get("weekly")).toMatchObject({
      rule: { cycle: "weekly", interval: 2, weekdays: [1, 2, 3, 4, 5] },
      waitForCompletion: true,
      missedOccurrences: "latest",
      childTemplates: [
        { title: "Sweep", notes: "", estimateMinutes: 10 },
        { title: "Mop", notes: "Kitchen only", estimateMinutes: null },
      ],
    });
    // The Nth-weekday anchor wins over monthlyLastDay, as in the source.
    expect(series.get("nth")?.rule.monthly).toEqual({
      kind: "nth_weekday",
      week: -1,
      weekday: 5,
    });
    // A weekday without a week of month falls back to the source's anchor.
    expect(series.get("monthEnd")).toMatchObject({
      rule: { monthly: { kind: "last_day" } },
      paused: true,
    });
    // lastTaskCreation is the fallback cursor, read in the owner's zone.
    expect(series.get("yearly")).toMatchObject({
      anchor: "completion",
      anchorDate: "2026-09-20",
      cursorDate: "2026-09-20",
      startTime: "07:00",
      startReminder: { kind: "none" },
    });
    expect(
      JSON.parse(series.get("daily")?.sourceJson ?? "{}"),
    ).not.toHaveProperty("quickSetting");
  });

  it("links live and archived instances by occurrence date without new work", () => {
    const { report, records, recurrence } = prepare({
      task: state({
        "rpt_daily_2026-09-21": {
          id: "rpt_daily_2026-09-21",
          title: "Water plants",
          repeatCfgId: "daily",
          created: createdOn("2026-09-21"),
          dueDay: "2026-09-21",
        },
        legacy: {
          id: "legacy",
          title: "Water plants",
          repeatCfgId: "daily",
          // 22:00 on the 20th in Chicago is already the 21st in UTC.
          created: Date.parse("2026-09-21T03:00:00.000Z"),
        },
      }),
      archiveYoung: {
        task: state({
          old: {
            id: "old",
            title: "Water plants",
            repeatCfgId: "daily",
            isDone: true,
            doneOn: createdOn("2026-09-18"),
            created: createdOn("2026-09-18"),
          },
          gone: {
            id: "gone",
            title: "Retired routine",
            repeatCfgId: "deleted-config",
            isDone: true,
            doneOn: createdOn("2026-01-02"),
            created: createdOn("2026-01-02"),
          },
        }),
      },
      taskRepeatCfg: state({
        daily: cfg("daily", { lastTaskCreationDay: "2026-09-21" }),
      }),
    });
    expect(blocking(report)).toEqual([]);
    expect(recurrence.links).toEqual([
      {
        taskSourceId: "rpt_daily_2026-09-21",
        seriesSourceId: "daily",
        occurrenceDate: "2026-09-21",
      },
      {
        taskSourceId: "legacy",
        seriesSourceId: "daily",
        occurrenceDate: "2026-09-20",
      },
      {
        taskSourceId: "old",
        seriesSourceId: "daily",
        occurrenceDate: "2026-09-18",
      },
    ]);
    const task = (sourceId: string) =>
      records.find((record) => record.sourceId === sourceId);
    expect(
      report.tasks.find((t) => t.sourceId === "legacy")?.occurrenceDate,
    ).toBe("2026-09-20");
    // A missing configuration stays a historical reference, and out of the
    // provenance hash, exactly as before #42.
    expect(task("gone")?.historicalReferences).toEqual([
      {
        kind: "repeat_config",
        sourceId: "deleted-config",
        reason: "missing_from_export",
      },
    ]);
    expect(JSON.parse(task("gone")?.sourceJson ?? "{}")).not.toHaveProperty(
      "repeatCfgId",
    );
    expect(task("old")?.historicalReferences).toEqual([]);
    expect(JSON.parse(task("old")?.sourceJson ?? "{}")).toMatchObject({
      repeatCfgId: "daily",
    });
    expect(
      report.issues.filter(({ code }) => code === "historical_reference"),
    ).toHaveLength(1);
  });

  it("reports a second instance of one occurrence without blocking", () => {
    const { report, recurrence } = prepare({
      task: state({
        a: {
          id: "a",
          title: "Journal",
          repeatCfgId: "daily",
          created: createdOn("2026-09-20"),
        },
        b: {
          id: "b",
          title: "Journal",
          repeatCfgId: "daily",
          created: createdOn("2026-09-20") + 60000,
        },
      }),
      taskRepeatCfg: state({ daily: cfg("daily") }),
    });
    expect(blocking(report)).toEqual([]);
    expect(
      report.issues.find(
        ({ code }) => code === "recurrence_duplicate_occurrence",
      ),
    ).toMatchObject({ sourceId: "b", blocking: false });
    expect(recurrence.links).toHaveLength(2);
  });

  it("blocks options that cannot be represented, with a finding each", () => {
    const report = previewSuperProductivity(
      JSON.stringify({
        data: {
          task: state({
            parent: { id: "parent", title: "Parent", subTaskIds: ["child"] },
            child: {
              id: "child",
              title: "Child",
              parentId: "parent",
              repeatCfgId: "ok",
              created: createdOn("2026-09-20"),
            },
          }),
          tag: state({}),
          taskRepeatCfg: state({
            ok: cfg("ok"),
            noStart: cfg("noStart", { startDate: undefined }),
            noDays: cfg("noDays", {
              repeatCycle: "WEEKLY",
              monday: false,
              tuesday: false,
              wednesday: false,
              thursday: false,
              friday: false,
            }),
            reminder: cfg("reminder", { startTime: "08:00", remindAt: "m7" }),
            estimate: cfg("estimate", { defaultEstimate: 90500 }),
            priority: cfg("priority", { tagIds: ["EM_URGENT"] }),
            unknown: cfg("unknown", { futureOption: true }),
            every: cfg("every", { repeatEvery: 0 }),
          }),
        },
      }),
      { timeZone: zone },
    );
    const findings = report.issues
      .filter(({ code }) => code === "recurrence_unmappable")
      .map(({ sourceId }) => sourceId);
    expect(findings.toSorted()).toEqual(
      [
        "child",
        "estimate",
        "every",
        "noDays",
        "noStart",
        "priority",
        "reminder",
        "unknown",
      ].toSorted(),
    );
    expect(report.issues.map(({ code }) => code)).not.toContain(
      "recurrence_parity_required",
    );
  });

  it("keeps a start time without a reminder option as a date-only series", () => {
    const { report, recurrence } = prepare({
      task: state({}),
      taskRepeatCfg: state({
        daily: cfg("daily", {
          startTime: "18:00",
          subTaskTemplates: [{ title: "Not inherited" }],
        }),
      }),
    });
    expect(blocking(report)).toEqual([]);
    expect(
      report.issues
        .filter(({ code }) => code === "recurrence_notice")
        .map(({ blocking: blocks }) => blocks),
    ).toEqual([false, false]);
    expect(recurrence.series[0]).toMatchObject({
      startTime: null,
      startReminder: { kind: "default" },
      childTemplates: [],
    });
  });
});
