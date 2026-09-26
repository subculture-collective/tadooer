import { describe, expect, it } from "vitest";
import {
  boardTemplate,
  groupTasksByView,
  planPanelMove,
  sortPanelTasks,
  sortTasksByView,
  taskMatchesPanel,
  taskMatchesView,
  type BoardPanelFilter,
  type BoardTaskFacts,
} from "./boards.ts";

const clock = { today: "2026-09-25", timeZone: "America/Chicago" };
const base: BoardPanelFilter = {
  includedTagIds: [],
  includedTagsMatch: "all",
  excludedTagIds: [],
  excludedTagsMatch: "any",
  includedMarkers: [],
  excludedMarkers: [],
  projectIds: [],
  doneState: "all",
  scheduledState: "all",
  backlogState: "all",
  parentsOnly: false,
  sortBy: null,
  sortDir: "asc",
};
const task = (overrides: Partial<BoardTaskFacts> = {}): BoardTaskFacts => ({
  id: "t",
  title: "Task",
  status: "open",
  projectId: null,
  tagIds: [],
  markers: [],
  plannedDay: null,
  plannedStart: null,
  deadlineDate: null,
  deadlineAt: null,
  createdAt: "2026-09-20T12:00:00.000Z",
  estimateMinutes: null,
  parentId: null,
  inBacklog: false,
  ...overrides,
});

describe("panel matching (Super Productivity doesTaskMatchPanel)", () => {
  it("combines tags and markers under the include and exclude match modes", () => {
    const filter = {
      ...base,
      includedTagIds: ["a"],
      includedMarkers: ["urgent" as const],
    };
    expect(taskMatchesPanel(task({ tagIds: ["a"] }), filter, clock)).toBe(
      false,
    );
    expect(
      taskMatchesPanel(
        task({ tagIds: ["a"], markers: ["urgent"] }),
        filter,
        clock,
      ),
    ).toBe(true);
    expect(
      taskMatchesPanel(
        task({ tagIds: ["a"] }),
        { ...filter, includedTagsMatch: "any" },
        clock,
      ),
    ).toBe(true);
    const excluding = {
      ...base,
      excludedTagIds: ["x"],
      excludedMarkers: ["important" as const],
    };
    expect(taskMatchesPanel(task({ tagIds: ["x"] }), excluding, clock)).toBe(
      false,
    );
    expect(
      taskMatchesPanel(
        task({ tagIds: ["x"] }),
        { ...excluding, excludedTagsMatch: "all" },
        clock,
      ),
    ).toBe(true);
    expect(
      taskMatchesPanel(
        task({ tagIds: ["x"], markers: ["important"] }),
        { ...excluding, excludedTagsMatch: "all" },
        clock,
      ),
    ).toBe(false);
  });

  it("derives the today marker from the planned day or start in the owner zone", () => {
    const filter = { ...base, includedMarkers: ["today" as const] };
    expect(
      taskMatchesPanel(task({ plannedDay: "2026-09-25" }), filter, clock),
    ).toBe(true);
    // 23:30 Chicago on the 25th is 04:30 UTC on the 26th.
    expect(
      taskMatchesPanel(
        task({ plannedStart: "2026-09-26T04:30:00.000Z" }),
        filter,
        clock,
      ),
    ).toBe(true);
    expect(
      taskMatchesPanel(task({ plannedDay: "2026-09-26" }), filter, clock),
    ).toBe(false);
  });

  it("applies done, project, scheduled, backlog and parent filters", () => {
    expect(
      taskMatchesPanel(task(), { ...base, doneState: "done" }, clock),
    ).toBe(false);
    expect(
      taskMatchesPanel(
        task({ status: "completed" }),
        { ...base, doneState: "open" },
        clock,
      ),
    ).toBe(false);
    expect(
      taskMatchesPanel(task(), { ...base, projectIds: ["p"] }, clock),
    ).toBe(false);
    expect(
      taskMatchesPanel(
        task({ projectId: "p" }),
        { ...base, projectIds: ["p"] },
        clock,
      ),
    ).toBe(true);
    expect(
      taskMatchesPanel(task(), { ...base, scheduledState: "scheduled" }, clock),
    ).toBe(false);
    expect(
      taskMatchesPanel(
        task({ plannedDay: "2026-10-01" }),
        { ...base, scheduledState: "unscheduled" },
        clock,
      ),
    ).toBe(false);
    expect(
      taskMatchesPanel(
        task(),
        { ...base, backlogState: "only_backlog" },
        clock,
      ),
    ).toBe(false);
    expect(
      taskMatchesPanel(
        task({ inBacklog: true }),
        { ...base, backlogState: "no_backlog" },
        clock,
      ),
    ).toBe(false);
    expect(
      taskMatchesPanel(
        task({ parentId: "parent" }),
        { ...base, parentsOnly: true },
        clock,
      ),
    ).toBe(false);
  });
});

describe("panel moves (rewriteTagIdsForPanel and _applyPanel)", () => {
  it("adds every included tag and marker and strips every excluded one by default", () => {
    const plan = planPanelMove(
      task({ tagIds: ["x", "keep"], markers: ["in_progress"] }),
      {
        ...base,
        includedTagIds: ["a"],
        includedMarkers: ["urgent"],
        excludedTagIds: ["x"],
        excludedMarkers: ["in_progress"],
        doneState: "done",
        projectIds: ["p"],
      },
      clock,
    );
    expect(plan).toEqual({
      ok: true,
      changes: [
        { kind: "add_tag", tagId: "a" },
        { kind: "add_marker", marker: "urgent" },
        { kind: "remove_tag", tagId: "x" },
        { kind: "remove_marker", marker: "in_progress" },
        { kind: "complete" },
        { kind: "assign_project", projectId: "p" },
      ],
    });
  });

  it("adds only the first included item for any-match and strips only the first excluded item for all-match", () => {
    expect(
      planPanelMove(
        task(),
        { ...base, includedTagIds: ["a", "b"], includedTagsMatch: "any" },
        clock,
      ),
    ).toEqual({ ok: true, changes: [{ kind: "add_tag", tagId: "a" }] });
    expect(
      planPanelMove(
        task({ tagIds: ["b"] }),
        { ...base, includedTagIds: ["a", "b"], includedTagsMatch: "any" },
        clock,
      ),
    ).toEqual({ ok: true, changes: [] });
    expect(
      planPanelMove(
        task({ tagIds: ["a"] }),
        { ...base, excludedTagIds: ["a", "b"], excludedTagsMatch: "all" },
        clock,
      ),
    ).toEqual({ ok: true, changes: [] });
    expect(
      planPanelMove(
        task({ tagIds: ["a", "b"] }),
        { ...base, excludedTagIds: ["a", "b"], excludedTagsMatch: "all" },
        clock,
      ),
    ).toEqual({ ok: true, changes: [{ kind: "remove_tag", tagId: "a" }] });
  });

  it("plans or clears today explicitly and refuses moves it cannot make true", () => {
    expect(
      planPanelMove(task(), { ...base, includedMarkers: ["today"] }, clock),
    ).toEqual({
      ok: true,
      changes: [{ kind: "plan_today", date: "2026-09-25" }],
    });
    expect(
      planPanelMove(
        task({ plannedDay: "2026-09-25" }),
        { ...base, excludedMarkers: ["today"] },
        clock,
      ),
    ).toEqual({ ok: true, changes: [{ kind: "clear_planned_day" }] });
    expect(
      planPanelMove(
        task({ plannedStart: "2026-09-25T15:00:00.000Z" }),
        { ...base, excludedMarkers: ["today"] },
        clock,
      ).ok,
    ).toBe(false);
    expect(
      planPanelMove(task(), { ...base, scheduledState: "scheduled" }, clock).ok,
    ).toBe(false);
    expect(
      planPanelMove(
        task({ parentId: "p" }),
        { ...base, parentsOnly: true },
        clock,
      ).ok,
    ).toBe(false);
    expect(
      planPanelMove(
        task({ inBacklog: true }),
        { ...base, backlogState: "no_backlog" },
        clock,
      ),
    ).toEqual({ ok: true, changes: [{ kind: "remove_from_backlog" }] });
  });
});

describe("panel and view ordering", () => {
  const tasks = [
    task({
      id: "b",
      title: "Bravo",
      createdAt: "2026-09-21T00:00:00.000Z",
      estimateMinutes: 30,
    }),
    task({
      id: "a",
      title: "Alpha",
      createdAt: "2026-09-22T00:00:00.000Z",
      plannedDay: "2026-09-30",
    }),
    task({
      id: "c",
      title: "Charlie",
      createdAt: "2026-09-20T00:00:00.000Z",
      plannedDay: "2026-09-26",
    }),
  ];
  it("keeps manual ranks first, then creation order, and sorts fields with nulls last", () => {
    expect(sortPanelTasks(tasks, base, ["c"]).map(({ id }) => id)).toEqual([
      "c",
      "b",
      "a",
    ]);
    expect(
      sortPanelTasks(tasks, { sortBy: "title", sortDir: "desc" }, []).map(
        ({ id }) => id,
      ),
    ).toEqual(["c", "b", "a"]);
    expect(
      sortPanelTasks(tasks, { sortBy: "dueDate", sortDir: "asc" }, []).map(
        ({ id }) => id,
      ),
    ).toEqual(["c", "a", "b"]);
  });

  it("filters, sorts and groups a saved view", () => {
    const spent = () => 0;
    expect(
      sortTasksByView(
        tasks,
        { sortBy: "estimatedTime", sortDir: "desc" },
        spent,
      ).map(({ id }) => id),
    ).toEqual(["b", "a", "c"]);
    expect(
      tasks
        .filter((item) =>
          taskMatchesView(
            item,
            { kind: "scheduledDate", preset: "nextWeek" },
            clock,
            spent,
          ),
        )
        .map(({ id }) => id),
    ).toEqual(["a"]);
    expect(
      tasks
        .filter((item) =>
          taskMatchesView(
            item,
            { kind: "scheduledDate", preset: "unspecified" },
            clock,
            spent,
          ),
        )
        .map(({ id }) => id),
    ).toEqual(["b"]);
    expect(
      groupTasksByView(tasks, { groupBy: "scheduledDate" }, clock, {
        tag: (id) => id,
        project: (id) => id,
      }).map(({ key, tasks: members }) => [key, members.map(({ id }) => id)]),
    ).toEqual([
      ["date:2026-09-26", ["c"]],
      ["date:2026-09-30", ["a"]],
      ["none", ["b"]],
    ]);
  });

  it("describes the default boards with markers instead of system tags", () => {
    const eisenhower = boardTemplate("eisenhower");
    expect(eisenhower.panels).toHaveLength(4);
    expect(eisenhower.panels[0]?.filter).toMatchObject({
      includedMarkers: ["important", "urgent"],
      parentsOnly: true,
    });
    const kanban = boardTemplate("kanban");
    expect(kanban.panels.map(({ filter }) => filter.doneState)).toEqual([
      "open",
      "open",
      "done",
    ]);
    expect(kanban.panels[1]?.filter.includedMarkers).toEqual(["in_progress"]);
  });
});
