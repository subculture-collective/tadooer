import { describe, expect, it } from "vitest";
import { prepareSuperProductivityImport } from "./super-productivity-apply.ts";

// Work history import (issue #41, ADR 0024). Fixtures are synthetic.
const state = (entities: Record<string, unknown>) => ({
  ids: Object.keys(entities),
  entities,
});
const done = { isDone: true, doneOn: 1700000060000, created: 1700000000000 };
const minutes = (value: number) => value * 60_000;
const prepare = (data: Record<string, unknown>) =>
  prepareSuperProductivityImport(JSON.stringify({ data }));

const fixture = () => ({
  project: state({ p: { id: "p", title: "Client work" } }),
  tag: state({
    TODAY: { id: "TODAY", title: "Today" },
    focus: { id: "focus", title: "Focus" },
  }),
  task: state({
    // Parent days are the sums of the children, except September 21, which
    // has 15 minutes more (tracked before the children existed).
    parent: {
      id: "parent",
      title: "Quarterly report",
      projectId: "p",
      subTaskIds: ["a", "b"],
      timeSpent: minutes(105),
      timeSpentOnDay: { "2026-09-20": minutes(60), "2026-09-21": minutes(45) },
    },
    a: {
      id: "a",
      title: "Collect numbers",
      parentId: "parent",
      projectId: "p",
      timeSpent: minutes(70),
      timeSpentOnDay: { "2026-09-20": minutes(40), "2026-09-21": minutes(30) },
    },
    b: {
      id: "b",
      title: "Draft",
      parentId: "parent",
      projectId: "p",
      timeSpent: minutes(20),
      timeSpentOnDay: { "2026-09-20": minutes(20), "2026-09-22": 0 },
    },
  }),
  archiveYoung: {
    task: state({
      // timeSpent lags its days: the dated entries win.
      young: {
        id: "young",
        title: "Young",
        timeSpent: 0,
        timeSpentOnDay: { "2026-09-18": 31_448_000 },
        ...done,
      },
    }),
    timeTracking: {
      project: { p: { "2026-09-18": { s: 1758186000000, e: 1758200000000 } } },
      tag: {},
    },
  },
  archiveOld: {
    task: state({
      // timeSpent has a minute without any day: reported, not imported.
      old: {
        id: "old",
        title: "Old",
        timeSpent: minutes(1),
        timeSpentOnDay: {},
        ...done,
      },
    }),
    timeTracking: {
      project: {
        p: { "2026-09-18": { s: 1758180000000, b: 1, bt: minutes(10) } },
      },
      tag: {
        TODAY: { "2026-09-17": { s: 1758090000000, e: 1758120000000 } },
        gone: { "2026-09-17": { s: 1758090000000 } },
      },
    },
  },
  timeTracking: {
    project: {},
    tag: { focus: { "2026-09-21": { s: 1758438000000, e: 1758459600000 } } },
  },
});

describe("Super Productivity work history", () => {
  it("imports each tracked millisecond once and explains every mismatch", () => {
    const { report, records, workContexts } = prepare(fixture());
    expect(report.canApply).toBe(true);
    const entries = new Map(
      records
        .filter(({ kind }) => kind === "task")
        .map(({ sourceId, timeEntries }) => [sourceId, timeEntries ?? []]),
    );
    // Leaves import their days; zero days carry no time.
    expect(entries.get("a")).toEqual([
      {
        workDate: "2026-09-20",
        durationMs: minutes(40),
        kind: "task_day",
        sourceTaskId: "a",
        sourceStore: "task",
      },
      {
        workDate: "2026-09-21",
        durationMs: minutes(30),
        kind: "task_day",
        sourceTaskId: "a",
        sourceStore: "task",
      },
    ]);
    expect(entries.get("b")?.map(({ workDate }) => workDate)).toEqual([
      "2026-09-20",
    ]);
    // The parent keeps only the time its children do not explain.
    expect(entries.get("parent")).toEqual([
      {
        workDate: "2026-09-21",
        durationMs: minutes(15),
        kind: "parent_residual",
        sourceTaskId: "parent",
        sourceStore: "task",
      },
    ]);
    expect(entries.get("young")).toEqual([
      expect.objectContaining({
        durationMs: 31_448_000,
        sourceStore: "archiveYoung",
      }),
    ]);
    expect(entries.get("old")).toEqual([]);
    const total = [...entries.values()]
      .flat()
      .reduce((sum, entry) => sum + entry.durationMs, 0);
    expect(total).toBe(minutes(105) + 31_448_000);
    expect(report.totals.time).toEqual({
      sourceLeafMs: minutes(91),
      sourceLeafDailyMs: minutes(90) + 31_448_000,
      taskDayEntries: 4,
      taskDayMs: minutes(90) + 31_448_000,
      parentResidualEntries: 1,
      parentResidualMs: minutes(15),
      undatedMs: minutes(1),
      datedExcessMs: 31_448_000,
      workContextDays: 4,
    });
    const findings = (code: string) =>
      report.issues.filter((issue) => issue.code === code);
    expect(findings("time_total_mismatch")).toEqual([
      expect.objectContaining({
        sourceId: "young",
        blocking: false,
        detail: expect.stringContaining("timeSpent has no day") as unknown,
      }),
      expect.objectContaining({
        sourceId: "old",
        blocking: false,
        detail: expect.stringContaining(
          "60,000 ms (0.02 h) without a day stays only in import provenance",
        ) as unknown,
      }),
    ]);
    expect(findings("time_parent_residual")).toEqual([
      expect.objectContaining({ sourceId: "parent", blocking: false }),
    ]);
    expect(findings("time_reconciliation")).toHaveLength(1);
    expect(findings("time_reconciliation")[0]?.detail).toContain(
      "60,000 ms (0.02 h) of leaf timeSpent has no day and is not imported",
    );
    // Undated time stays in provenance; zero-time fields stay out of it.
    const old = records.find(({ sourceId }) => sourceId === "old");
    expect(JSON.parse(old?.sourceJson ?? "{}")).toMatchObject({
      timeSpent: minutes(1),
    });
    expect(JSON.parse(old?.sourceJson ?? "{}")).not.toHaveProperty(
      "timeSpentOnDay",
    );

    // Work start/end records: stores merge field by field, TODAY is the day
    // context, and a missing tag is kept by source ID.
    expect(workContexts).toEqual([
      expect.objectContaining({
        contextKind: "tag",
        sourceContextId: "gone",
        workDate: "2026-09-17",
      }),
      expect.objectContaining({
        contextKind: "today",
        sourceContextId: "TODAY",
        workDate: "2026-09-17",
        endedAt: new Date(1758120000000).toISOString(),
      }),
      {
        contextKind: "project",
        sourceContextId: "p",
        workDate: "2026-09-18",
        startedAt: new Date(1758186000000).toISOString(),
        endedAt: new Date(1758200000000).toISOString(),
        breakCount: 1,
        breakMs: minutes(10),
        sourceStore: "archiveYoung",
      },
      expect.objectContaining({
        contextKind: "tag",
        sourceContextId: "focus",
        sourceStore: "timeTracking",
      }),
    ]);
    expect(findings("work_context_merged")).toEqual([
      expect.objectContaining({ blocking: false }),
    ]);
    expect(findings("work_context_historical")).toEqual([
      expect.objectContaining({
        blocking: false,
        detail: expect.stringContaining("1 work-day record belongs") as unknown,
      }),
    ]);
  });

  it("reports a parent whose children exceed it and never subtracts child time", () => {
    const data = fixture();
    const { report, records } = prepare({
      ...data,
      task: state({
        parent: {
          id: "parent",
          title: "Parent",
          subTaskIds: ["a"],
          timeSpent: minutes(10),
          timeSpentOnDay: { "2026-09-20": minutes(10) },
        },
        a: {
          id: "a",
          title: "Child",
          parentId: "parent",
          timeSpent: minutes(25),
          timeSpentOnDay: { "2026-09-20": minutes(25) },
        },
      }),
    });
    expect(report.canApply).toBe(true);
    expect(
      records.find(({ sourceId }) => sourceId === "parent")?.timeEntries,
    ).toBeUndefined();
    expect(
      records.find(({ sourceId }) => sourceId === "a")?.timeEntries,
    ).toEqual([expect.objectContaining({ durationMs: minutes(25) })]);
    expect(report.issues).toContainEqual(
      expect.objectContaining({
        code: "time_parent_shortfall",
        sourceId: "parent",
        blocking: false,
      }),
    );
  });

  it("blocks malformed time tracking and impossible days", () => {
    for (const timeTracking of [
      { project: { p: { "2026-02-30": { s: 1 } } } },
      { project: { p: { "2026-09-20": { s: 1, x: 2 } } } },
      { project: { p: { "2026-09-20": { e: 1.5 } } } },
      { project: [] },
      { board: {} },
    ]) {
      const { report } = prepare({ ...fixture(), timeTracking });
      expect(report.canApply, JSON.stringify(timeTracking)).toBe(false);
    }
    const { report } = prepare({
      task: state({
        t: {
          id: "t",
          title: "Task",
          timeSpent: 86_400_001,
          timeSpentOnDay: { "2026-09-20": 86_400_001 },
        },
      }),
    });
    expect(report.issues).toContainEqual(
      expect.objectContaining({ code: "time_day_exceeds_day", blocking: true }),
    );
  });
});
