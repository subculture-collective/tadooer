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
      expect.arrayContaining([
        "hierarchy_parity_required",
        "recurrence_parity_required",
        "time_history_parity_required",
      ]),
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
        archiveOld: { task: state({ t: task }) },
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
