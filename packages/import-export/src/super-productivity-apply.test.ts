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
