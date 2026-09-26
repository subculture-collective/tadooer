import { describe, expect, it } from "vitest";
import { prepareSuperProductivityImport } from "./super-productivity-apply.ts";

const state = (entities: Record<string, unknown>) => ({
  ids: Object.keys(entities),
  entities,
});
const created = 1758000000000;

const panel = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  title: id,
  includedTagIds: [],
  excludedTagIds: [],
  taskIds: [],
  taskDoneState: 1,
  scheduledState: 1,
  backlogState: 1,
  isParentTasksOnly: false,
  projectIds: [""],
  ...extra,
});

const exportWith = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    project: state({ p: { id: "p", title: "P", created } }),
    tag: state({
      x: { id: "x", title: "X", created },
      EM_URGENT: { id: "EM_URGENT", title: "urgent" },
      KANBAN_IN_PROGRESS: { id: "KANBAN_IN_PROGRESS", title: "in progress" },
    }),
    task: state({
      t1: {
        id: "t1",
        title: "One",
        projectId: "p",
        tagIds: ["x", "EM_URGENT"],
        created,
      },
      t2: {
        id: "t2",
        title: "Two",
        projectId: "p",
        tagIds: ["KANBAN_IN_PROGRESS"],
        created,
      },
    }),
    boards: {
      boardCfgs: [
        {
          id: "EISENHOWER",
          title: "Matrix",
          cols: 2,
          panels: [
            panel("urgent", {
              includedTagIds: ["EM_URGENT", "x", "ghost"],
              excludedTagIds: ["EM_IMPORTANT"],
              isParentTasksOnly: true,
              taskIds: ["t1", "missing"],
              sortByDue: "desc",
            }),
            panel("done", {
              taskDoneState: 2,
              backlogState: 2,
              projectIds: ["p", "nope"],
              projectId: "p",
              includedTagsMatch: "any",
              sortBy: "title",
              sortDir: "asc",
            }),
          ],
        },
      ],
    },
    section: state({
      s1: {
        id: "s1",
        contextId: "p",
        contextType: "PROJECT",
        title: "Now",
        taskIds: ["t2", "t1", "gone"],
      },
      s2: {
        id: "s2",
        contextId: "TODAY",
        contextType: "TAG",
        title: "Today",
        taskIds: [],
      },
    }),
    menuTree: {
      projectTree: [
        {
          k: "f",
          id: "f1",
          name: "Work",
          isExpanded: true,
          children: [
            { k: "p", id: "p" },
            { k: "f", id: "f2", name: "Inner", children: [] },
          ],
        },
      ],
      tagTree: [{ k: "t", id: "x" }],
    },
    ...extra,
  });

describe("Super Productivity boards, sections and menu folders (ADR 0028)", () => {
  it("maps boards with marker filters, sections and nested folders", () => {
    const { report, boards, records } =
      prepareSuperProductivityImport(exportWith());
    expect(report.canApply).toBe(true);
    expect(boards.boards).toHaveLength(1);
    const [board] = boards.boards;
    expect(board?.columns).toBe(2);
    expect(
      board?.panels.map(({ filter, sourceTaskIds }) => ({
        filter,
        sourceTaskIds,
      })),
    ).toMatchObject([
      {
        filter: {
          includedTagIds: ["x"],
          includedMarkers: ["urgent"],
          excludedMarkers: ["important"],
          parentsOnly: true,
          sortBy: "dueDate",
          sortDir: "desc",
          projectIds: [],
        },
        sourceTaskIds: ["t1"],
      },
      {
        filter: {
          doneState: "done",
          backlogState: "no_backlog",
          projectIds: ["p"],
          includedTagsMatch: "any",
          sortBy: "title",
        },
        sourceTaskIds: [],
      },
    ]);
    expect(boards.sections).toEqual([
      expect.objectContaining({
        sourceId: "s1",
        contextKind: "project",
        sourceContextId: "p",
        title: "Now",
        expanded: true,
        sourceTaskIds: ["t2", "t1"],
      }),
    ]);
    expect(
      boards.folders.map(
        ({ sourceId, sourceParentId, kind, sourceItemIds, expanded }) => ({
          sourceId,
          sourceParentId,
          kind,
          sourceItemIds,
          expanded,
        }),
      ),
    ).toEqual([
      {
        sourceId: "f1",
        sourceParentId: null,
        kind: "project",
        sourceItemIds: ["p"],
        expanded: true,
      },
      {
        sourceId: "f2",
        sourceParentId: "f1",
        kind: "project",
        sourceItemIds: [],
        expanded: false,
      },
    ]);
    expect(boards.taskMarkers).toEqual([
      { sourceTaskId: "t1", markers: ["urgent"] },
      { sourceTaskId: "t2", markers: ["in_progress"] },
    ]);
    // Marker tags never become ordinary tags on the task.
    expect(records.find(({ sourceId }) => sourceId === "t1")?.tagIds).toEqual([
      "x",
    ]);
    const notices = report.issues.filter(({ code }) => code === "board_notice");
    expect(notices.every(({ blocking }) => !blocking)).toBe(true);
    expect(
      notices.map(({ sourceId, detail }) => `${sourceId ?? ""}: ${detail}`),
    ).toEqual([
      "urgent: 1 included tag in panel urgent has no mapping and is not imported",
      "urgent: 1 task reference in panel urgent has no mapping and is not imported",
      "done: 1 project in panel done has no mapping and is not imported",
      "s1: 1 task reference in section s1 has no mapping and is not imported",
      "s2: A section of the Today view has no Tadooer context and is not imported",
    ]);
  });

  it("blocks unreviewed board, panel and section fields", () => {
    for (const extra of [
      {
        boards: {
          boardCfgs: [{ id: "b", title: "B", cols: 1, panels: [], extra: 1 }],
        },
      },
      {
        boards: {
          boardCfgs: [
            {
              id: "b",
              title: "B",
              cols: 1,
              panels: [panel("x", { unknown: true })],
            },
          ],
        },
      },
      { boards: { boardCfgs: [{ id: "b", title: "", cols: 1, panels: [] }] } },
      { boards: { other: [] } },
      {
        section: state({
          s: {
            id: "s",
            contextId: "p",
            contextType: "LIST",
            title: "S",
            taskIds: [],
          },
        }),
      },
      {
        section: state({
          s: {
            id: "s",
            contextId: "p",
            contextType: "PROJECT",
            title: "S",
            taskIds: [],
            extra: 1,
          },
        }),
      },
      {
        menuTree: {
          projectTree: [
            { k: "f", id: "f", name: "F", children: [], color: "red" },
          ],
          tagTree: [],
        },
      },
    ]) {
      const { report } = prepareSuperProductivityImport(exportWith(extra));
      expect(report.canApply, JSON.stringify(extra)).toBe(false);
    }
  });

  it("reports state codes and sort fields without a mapping and keeps the panel", () => {
    const { report, boards } = prepareSuperProductivityImport(
      exportWith({
        boards: {
          boardCfgs: [
            {
              id: "b",
              title: "B",
              cols: 9,
              panels: [panel("odd", { taskDoneState: 7, sortBy: "priority" })],
            },
          ],
        },
      }),
    );
    expect(report.canApply).toBe(true);
    expect(boards.boards[0]?.columns).toBe(1);
    expect(boards.boards[0]?.panels[0]?.filter).toEqual(
      expect.objectContaining({ doneState: "all", sortBy: null }),
    );
    expect(
      report.issues
        .filter(
          ({ code, sourceId }) =>
            code === "board_notice" && (sourceId === "b" || sourceId === "odd"),
        )
        .map(({ detail }) => detail),
    ).toEqual([
      "Board columns are not between 1 and 6; one column is used",
      'sortBy "priority" has no mapping; the panel keeps its manual order',
      "taskDoneState 7 has no mapping; the panel shows all tasks for it",
    ]);
  });
});
