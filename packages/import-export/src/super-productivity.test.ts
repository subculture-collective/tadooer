import { describe, expect, it } from "vitest";
import { previewSuperProductivity } from "./super-productivity.ts";

const state = (entities: Record<string, unknown>) => ({
  ids: Object.keys(entities),
  entities,
});
describe("Super Productivity migration preview", () => {
  it("inventories live and archived tasks without double-counting parent time", () => {
    const raw = JSON.stringify({
      data: {
        task: state({
          parent: { id: "parent", title: "Parent", timeSpent: 60000 },
          child: {
            id: "child",
            title: "Child",
            parentId: "parent",
            projectId: "p",
            timeSpent: 60000,
            timeSpentOnDay: { "2026-09-20": 60000 },
            dueWithTime: 1789909200000,
            dueDay: "2026-09-19",
            deadlineDay: "2026-09-21",
            repeatCfgId: "r",
          },
        }),
        archiveYoung: {
          task: state({
            done: { id: "done", title: "Done", isDone: true, timeSpent: 30000 },
          }),
        },
        archiveOld: {
          task: state({ older: { id: "older", title: "Older", isDone: true } }),
        },
        project: state({ p: { id: "p", title: "Project" } }),
        tag: state({}),
        taskRepeatCfg: state({ r: { id: "r", repeatCycle: "DAILY" } }),
        globalConfig: { secret: "must-not-appear" },
      },
    });
    const report = previewSuperProductivity(raw);
    expect(report.canApply).toBe(false);
    expect(report.totals).toEqual({
      tasks: 4,
      completed: 2,
      archived: 2,
      childTasks: 1,
      projects: 1,
      tags: 0,
      repeatConfigurations: 1,
      trackedMilliseconds: 90000,
      // Only dated daily values import; 30 s of leaf timeSpent has no day.
      time: {
        sourceLeafMs: 90000,
        sourceLeafDailyMs: 60000,
        taskDayEntries: 1,
        taskDayMs: 60000,
        parentResidualEntries: 0,
        parentResidualMs: 0,
        undatedMs: 30000,
        datedExcessMs: 0,
        workContextDays: 0,
      },
      // No counters or metric days in this export (ADR 0025).
      counters: {
        definitions: 0,
        dayValues: 0,
        clickCount: 0,
        stopwatchMs: 0,
        evaluations: 0,
        focusSessions: 0,
        focusSessionMs: 0,
      },
    });
    expect(
      report.tasks.find((task) => task.sourceId === "child"),
    ).toMatchObject({
      scheduledDay: null,
      scheduledAt: new Date(1789909200000).toISOString(),
      deadlineDay: "2026-09-21",
    });
    expect(JSON.stringify(report)).not.toContain("must-not-appear");
    expect(report.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(["recurrence_unmappable", "time_reconciliation"]),
    );
    // Work history applies since #41 (ADR 0024).
    expect(report.issues.map((issue) => issue.code)).not.toContain(
      "time_history_parity_required",
    );
    // Children map to full child tasks (ADR 0018); hierarchy no longer blocks.
    expect(report.issues.map((issue) => issue.code)).not.toContain(
      "hierarchy_parity_required",
    );
  });
  it("reports duplicate IDs, broken references, invalid dates, and time mismatches", () => {
    const task = {
      id: "t",
      title: "Task",
      projectId: "missing",
      parentId: "missing",
      timeSpent: 12,
      timeSpentOnDay: { today: 10 },
      dueDay: "2026-99-99",
      deadlineDay: "2026-02-30",
    };
    const report = previewSuperProductivity(
      JSON.stringify({
        task: state({ t: task }),
        // Divergent copies block; identical copies would collapse (ADR 0022).
        archiveOld: { task: state({ t: { ...task, isDone: true } }) },
      }),
    );
    expect(report.totals.tasks).toBe(1);
    expect(report.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        "duplicate_task",
        "missing_parent",
        "missing_project",
        "invalid_date",
        "time_total_mismatch",
      ]),
    );
  });
  it("rejects unrelated JSON and reports malformed entity stores", () => {
    expect(() => previewSuperProductivity("[]")).toThrow();
    expect(() => previewSuperProductivity("not json")).toThrow();
    expect(
      previewSuperProductivity(JSON.stringify({ task: {} })).issues[0]?.code,
    ).toBe("invalid_entity_store");
  });
});

it("reports malformed archives rather than silently treating them as empty", () => {
  for (const archive of [null, [], "encrypted", {}, { task: null }]) {
    const report = previewSuperProductivity(
      JSON.stringify({ task: state({}), archiveOld: archive }),
    );
    expect(
      report.issues.some(
        ({ code }) =>
          code === "invalid_archive" || code === "invalid_entity_store",
      ),
    ).toBe(true);
  }
});

it("detects cycles, inconsistent child lists, missing tags, and malformed time history", () => {
  const report = previewSuperProductivity(
    JSON.stringify({
      task: state({
        a: {
          id: "a",
          title: "A",
          parentId: "b",
          subTaskIds: ["b", "missing", "b"],
          tagIds: ["missing"],
        },
        b: { id: "b", title: "B", parentId: "a", subTaskIds: [] },
        self: {
          id: "self",
          title: "Self",
          parentId: "self",
          timeSpentOnDay: [],
        },
        invalid: {
          id: "invalid",
          title: "Invalid",
          parentId: 3,
          subTaskIds: [3],
          timeSpentOnDay: { "2026-02-30": 1 },
        },
      }),
    }),
  );
  expect(report.issues.map(({ code }) => code)).toEqual(
    expect.arrayContaining([
      "hierarchy_cycle",
      "hierarchy_mismatch",
      "missing_child",
      "missing_tag",
      "duplicate_child_reference",
      "invalid_time_history",
      "invalid_reference",
      "invalid_reference_list",
      "invalid_date",
    ]),
  );
  expect(
    report.issues.filter(({ code }) => code === "hierarchy_cycle"),
  ).toHaveLength(2);
});

it("walks deep parent chains without recursion and reports unsafe time totals", () => {
  const tasks: Record<string, unknown> = {};
  for (let i = 0; i < 10000; i++)
    tasks[String(i)] = {
      id: String(i),
      title: "Task",
      parentId: i === 9999 ? null : String(i + 1),
    };
  tasks.time = {
    id: "time",
    title: "Time",
    timeSpent: Number.MAX_SAFE_INTEGER,
    timeSpentOnDay: { "2026-09-19": Number.MAX_SAFE_INTEGER, "2026-09-20": 1 },
  };
  const report = previewSuperProductivity(
    JSON.stringify({ task: state(tasks) }),
  );
  expect(report.totals.tasks).toBe(10001);
  expect(report.issues.some(({ code }) => code === "hierarchy_cycle")).toBe(
    false,
  );
  expect(report.issues.some(({ code }) => code === "time_total_overflow")).toBe(
    true,
  );
});
