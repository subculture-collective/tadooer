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

it("keeps Today and board system tags out of ordinary tags", () => {
  const prepare = (extra: Record<string, unknown>, task = {}) =>
    prepareSuperProductivityImport(
      JSON.stringify({
        task: state({ t: { id: "t", title: "Task", ...task } }),
        ...extra,
      }),
    );
  // An empty Today view and unused markers are skipped with a notice.
  const skipped = prepare({
    tag: state({
      TODAY: { id: "TODAY", title: "Today", taskIds: [] },
      EM_URGENT: { id: "EM_URGENT", title: "urgent" },
    }),
  });
  expect(skipped.report.canApply).toBe(true);
  expect(skipped.records.filter(({ kind }) => kind === "tag")).toEqual([]);
  expect(skipped.report.issues.map(({ code }) => code)).toEqual([
    "configuration_not_imported",
    "configuration_not_imported",
  ]);
  // Today's order and used priority markers need #29 / #63 first.
  expect(
    prepare({
      tag: state({ TODAY: { id: "TODAY", title: "Today", taskIds: ["t"] } }),
    }).report.canApply,
  ).toBe(false);
  expect(
    prepare(
      { tag: state({ EM_URGENT: { id: "EM_URGENT", title: "urgent" } }) },
      { tagIds: ["EM_URGENT"] },
    ).report.canApply,
  ).toBe(false);
});

it("maps project lifecycle, appearance, backlog, menu order and notes", () => {
  const { report, records } = prepareSuperProductivityImport(
    JSON.stringify({
      task: state({
        t1: { id: "t1", title: "Active", projectId: "b" },
        t2: { id: "t2", title: "Later", projectId: "b" },
      }),
      project: state({
        a: {
          id: "a",
          title: "Done project",
          isDone: true,
          doneOn: 1700000000000,
          isArchived: true,
          icon: "work",
          theme: { primary: "#AABBCC", backgroundImageDark: "x.png" },
          noteIds: ["n2", "missing-note"],
        },
        b: {
          id: "b",
          title: "Backlog project",
          isEnableBacklog: true,
          backlogTaskIds: ["t2", "missing-task"],
          isHiddenFromMenu: true,
          noteIds: ["n1"],
        },
      }),
      tag: state({
        x: { id: "x", title: "X", color: "#abc", icon: "🏷️", isArchived: true },
        y: { id: "y", title: "Y" },
      }),
      menuTree: {
        projectTree: [
          {
            k: "f",
            id: "folder",
            name: "Work",
            children: [{ k: "p", id: "b" }],
          },
          { k: "p", id: "a" },
        ],
        tagTree: [
          { k: "t", id: "y" },
          { k: "t", id: "x" },
        ],
      },
      note: {
        ...state({
          n1: {
            id: "n1",
            projectId: "b",
            content: "# Plan\n- [ ] item",
            isPinnedToToday: true,
            created: 1700000000000,
            modified: 1700000000001,
          },
          n2: { id: "n2", projectId: "a", content: "Retro" },
          n3: { id: "n3", projectId: null, content: "Loose" },
        }),
        todayOrder: ["n1"],
      },
    }),
  );
  expect(report.canApply).toBe(true);
  expect(
    report.issues
      .map(({ code }) => code)
      .every((code) => code === "configuration_not_imported"),
  ).toBe(true);
  expect(report.issues.map(({ detail }) => detail).join("\n")).toMatch(
    /folders are not imported/,
  );
  expect(records.map(({ kind, sourceId }) => `${kind}:${sourceId}`)).toEqual([
    "project:b",
    "project:a",
    "tag:y",
    "tag:x",
    "task:t1",
    "task:t2",
    "note:n1",
    "note:n2",
    "note:n3",
  ]);
  expect(records[0]).toMatchObject({
    backlogEnabled: true,
    backlogTaskIds: ["t2"],
    hiddenFromMenu: true,
    archived: false,
    completedAt: null,
  });
  expect(records[1]).toMatchObject({
    completedAt: new Date(1700000000000).toISOString(),
    archived: true,
    icon: "work",
    color: "#aabbcc",
  });
  expect(records[3]).toMatchObject({
    color: "#aabbcc",
    icon: "🏷️",
    archived: true,
  });
  expect(records[6]).toMatchObject({
    notes: "# Plan\n- [ ] item",
    projectId: "b",
    pinnedToToday: true,
    createdAt: new Date(1700000000000).toISOString(),
  });
});

it("blocks inconsistent organization data instead of guessing", () => {
  const prepare = (extra: Record<string, unknown>) =>
    prepareSuperProductivityImport(
      JSON.stringify({
        task: state({ t: { id: "t", title: "Task" } }),
        ...extra,
      }),
    ).report.canApply;
  for (const extra of [
    // Backlog task outside the project, or a disabled backlog with tasks.
    {
      project: state({
        p: {
          id: "p",
          title: "P",
          isEnableBacklog: true,
          backlogTaskIds: ["t"],
        },
      }),
    },
    { project: state({ p: { id: "p", title: "P", backlogTaskIds: ["t"] } }) },
    // Completion without its time, invalid icon or colour.
    { project: state({ p: { id: "p", title: "P", isDone: true } }) },
    { project: state({ p: { id: "p", title: "P", icon: "<b>x</b>" } }) },
    { tag: state({ x: { id: "x", title: "X", color: "red" } }) },
    // Image notes, legacy notes text and dangling note projects.
    { note: state({ n: { id: "n", content: "Pic", imgUrl: "file:///x" } }) },
    { project: state({ p: { id: "p", title: "P", notes: "legacy" } }) },
    { note: state({ n: { id: "n", content: "Note", projectId: "gone" } }) },
    { note: state({ n: { id: "n", content: "Note", unknown: 1 } }) },
    { menuTree: { projectTree: [{ k: "x", id: "p" }], tagTree: [] } },
  ])
    expect(prepare(extra), JSON.stringify(extra)).toBe(false);
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
  ]);

  for (const extra of [
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

it("applies tag colour while retaining reviewed fields in provenance", () => {
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
  expect(records[0]).toMatchObject({ color: "#abcdef", icon: null });
});
