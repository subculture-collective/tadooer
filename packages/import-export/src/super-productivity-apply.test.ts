import { expect, it } from "vitest";
import { prepareSuperProductivityImport } from "./super-productivity-apply.ts";
const state = (entities: Record<string, unknown>) => ({
  ids: Object.keys(entities),
  entities,
});
it("prepares exact core fields without retaining integration secrets", () => {
  const result = prepareSuperProductivityImport(
    JSON.stringify({
      task: state({
        t: {
          id: "t",
          title: "Task",
          notes: "Keep notes",
          isDone: true,
          created: 1700000000000,
          doneOn: 1700000060000,
          timeEstimate: 120000,
          projectId: "p",
          tagIds: ["tag"],
          dueWithTime: 1700000100000,
          deadlineDay: "2026-10-01",
        },
      }),
      project: state({
        p: {
          id: "p",
          title: "Project",
          issueIntegrationCfgs: { secret: "do-not-persist" },
        },
      }),
      tag: state({ tag: { id: "tag", title: "Tag" } }),
      globalConfig: { secret: "do-not-persist" },
    }),
  );
  expect(result.report.canApply).toBe(true);
  expect(result.records.map(({ kind }) => kind)).toEqual([
    "project",
    "tag",
    "task",
  ]);
  expect(result.records[2]).toMatchObject({
    notes: "Keep notes",
    estimateMinutes: 2,
    completedAt: new Date(1700000060000).toISOString(),
    projectId: "p",
    tagIds: ["tag"],
  });
  expect(JSON.stringify(result.records)).not.toContain("do-not-persist");
});
it("blocks unsupported workflows without rounding estimates or inventing dates", () => {
  for (const extra of [
    { timeEstimate: 1 },
    { dueDay: "2026-09-20" },
    { isDone: true },
    { attachments: [{ path: "file" }] },
    { remindAt: 1700000000000 },
    { notes: "x".repeat(20001) },
    { timeSpent: 60000 },
  ]) {
    const result = prepareSuperProductivityImport(
      JSON.stringify({
        task: state({ t: { id: "t", title: "Task", ...extra } }),
      }),
    );
    expect(result.report.canApply).toBe(false);
    expect(result.report.issues.length).toBeGreaterThan(0);
  }
});

it("does not reinterpret virtual Today views, project backlogs, or completed projects", () => {
  for (const extra of [
    { tag: state({ TODAY: { id: "TODAY", title: "Today" } }) },
    {
      project: state({
        p: { id: "p", title: "Project", backlogTaskIds: ["t"] },
      }),
    },
    {
      project: state({
        p: { id: "p", title: "Project", isDone: true, doneOn: 1700000000000 },
      }),
    },
  ]) {
    expect(
      prepareSuperProductivityImport(
        JSON.stringify({
          task: state({ t: { id: "t", title: "Task" } }),
          ...extra,
        }),
      ).report.canApply,
    ).toBe(false);
  }
});

it("reports every export section and blocks unreviewed or unsupported data", () => {
  const prepare = (extra: Record<string, unknown>, task = {}) =>
    prepareSuperProductivityImport(
      JSON.stringify({
        task: state({ t: { id: "t", title: "Task", ...task } }),
        ...extra,
      }),
    ).report;
  const codes = (report: ReturnType<typeof prepare>) =>
    report.issues.map(({ code }) => code);

  // Configuration is reported without blocking; default counters are setup.
  const configured = prepare({
    boards: { boardCfgs: [{ id: "kanban" }] },
    menuTree: { projectTree: [], tagTree: [] },
    simpleCounter: state({ c: { id: "c", countOnDay: {} } }),
    note: { ...state({}), todayOrder: [] },
    timeTracking: { project: {}, tag: {} },
  });
  expect(configured.canApply).toBe(true);
  expect(codes(configured)).toEqual([
    "configuration_not_imported",
    "configuration_not_imported",
    "configuration_not_imported",
  ]);

  for (const extra of [
    { note: state({ n: { id: "n", content: "Note" } }) },
    { metric: state({ "2026-09-24": { id: "2026-09-24" } }) },
    { reminders: [{ id: "r" }] },
    { pluginUserData: [{ id: "plugin", data: "{}" }] },
    { timeTracking: { project: { p: { "2026-09-24": { s: 1 } } }, tag: {} } },
    { simpleCounter: state({ c: { id: "c", countOnDay: { d: 2 } } }) },
  ]) {
    const report = prepare(extra);
    expect(report.canApply).toBe(false);
    expect(codes(report)).toContain("unsupported_section");
  }
  expect(codes(prepare({ futureSection: {} }))).toContain("unknown_section");
  expect(codes(prepare({}, { futureField: 1 }))).toContain(
    "unknown_task_field",
  );
  for (const task of [
    { deadlineRemindAt: 1700000000000 },
    { issueProviderId: "provider" },
    { plannedAt: 1700000000000 },
  ])
    expect(prepare({}, task).canApply).toBe(false);
  expect(
    prepare({ tag: state({ x: { id: "x", title: "X", isDone: true } }) })
      .canApply,
  ).toBe(false);
  // Derived view state is not user data and does not block.
  expect(
    prepare({}, { subTasks: [], modified: 1, _hideSubTasksMode: 1 }).canApply,
  ).toBe(true);
});

it("retains reviewed presentation fields in provenance without applying them", () => {
  const { records } = prepareSuperProductivityImport(
    JSON.stringify({
      task: state({ t: { id: "t", title: "Task", tagIds: ["x"] } }),
      tag: state({ x: { id: "x", title: "X", color: "#abcdef" } }),
    }),
  );
  expect(JSON.parse(records[0]?.sourceJson ?? "{}")).toEqual({
    id: "x",
    title: "X",
    color: "#abcdef",
  });
});
