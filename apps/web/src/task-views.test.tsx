import { describe, expect, it } from "vitest";
import type { MenuFolder, Task, TaskView } from "@suite/contracts";
import {
  applyTaskView,
  groupByFolder,
  viewContextFor,
} from "./components/tasks/TaskViews.tsx";
import { describeBoardChange } from "./pages/BoardsPage.tsx";

const task = (id: string, fields: Partial<Task> = {}): Task => ({
  id,
  title: id.toUpperCase(),
  notes: "",
  status: "open",
  revision: 1,
  createdAt: "2026-09-20T12:00:00.000Z",
  updatedAt: "2026-09-20T12:00:00.000Z",
  completedAt: null,
  deletedAt: null,
  plannedStart: null,
  plannedDay: null,
  estimateMinutes: null,
  projectId: null,
  tagIds: [],
  ...fields,
});

const folder = (
  id: string,
  fields: Partial<MenuFolder> & Pick<MenuFolder, "itemIds">,
): MenuFolder => ({
  id,
  kind: "project",
  parentId: null,
  title: id,
  expanded: true,
  position: 0,
  revision: 1,
  createdAt: "2026-09-20T12:00:00.000Z",
  updatedAt: "2026-09-20T12:00:00.000Z",
  ...fields,
});

const clock = { today: "2026-09-25", timeZone: "UTC" };
const labels = {
  tag: (id: string) => `tag ${id}`,
  project: (id: string) => `project ${id}`,
};

describe("saved task views in the browser (ADR 0028)", () => {
  it("derives the view context from the active filters", () => {
    expect(viewContextFor("p1", "t1")).toEqual({
      contextKind: "project",
      contextId: "p1",
    });
    expect(viewContextFor("", "t1")).toEqual({
      contextKind: "tag",
      contextId: "t1",
    });
    expect(viewContextFor("", "")).toEqual({
      contextKind: "all",
      contextId: "",
    });
  });

  it("filters, sorts and groups the cached tasks by the saved view", () => {
    const tasks = [
      task("b", { projectId: "p1", tagIds: ["t1"] }),
      task("a", { projectId: "p2", tagIds: ["t1"] }),
      task("c", { projectId: "p1", tagIds: ["t1"] }),
      task("untagged", { projectId: "p1" }),
    ];
    const view: TaskView = {
      contextKind: "all",
      contextId: "",
      sortBy: "name",
      sortDir: "desc",
      groupBy: "project",
      filter: { kind: "tag", tagId: "t1" },
      collapsedGroups: [],
      revision: 1,
    };
    const groups = applyTaskView(tasks, view, clock, labels, () => 0);
    expect(
      groups.map((group) => [
        group.key,
        group.label,
        group.tasks.map(({ id }) => id),
      ]),
    ).toEqual([
      ["project:p1", "project p1", ["c", "b"]],
      ["project:p2", "project p2", ["a"]],
    ]);
  });

  it("keeps the whole list in one group without a saved view", () => {
    const tasks = [task("a"), task("b")];
    const view: TaskView = {
      contextKind: "all",
      contextId: "",
      sortBy: null,
      sortDir: "asc",
      groupBy: null,
      filter: null,
      collapsedGroups: [],
      revision: 0,
    };
    expect(applyTaskView(tasks, view, clock, labels, () => 0)).toEqual([
      { key: "all", label: "", tasks },
    ]);
  });
});

describe("sidebar folders in the browser (ADR 0028)", () => {
  it("flattens folders depth-first and leaves loose items last", () => {
    const projects = [{ id: "p1" }, { id: "p2" }, { id: "p3" }, { id: "p4" }];
    const folders = [
      folder("work", { itemIds: ["p2", "missing"] }),
      folder("client", { parentId: "work", itemIds: ["p3"] }),
      folder("home", { position: 1, itemIds: ["p1"] }),
      folder("tags", { kind: "tag", itemIds: ["p4"] }),
    ];
    expect(
      groupByFolder(projects, folders, "project").map(
        ({ folder: group, depth, items }) => [
          group?.id ?? null,
          depth,
          items.map(({ id }) => id),
        ],
      ),
    ).toEqual([
      ["work", 0, ["p2"]],
      ["client", 1, ["p3"]],
      ["home", 0, ["p1"]],
      [null, 0, ["p4"]],
    ]);
  });
});

describe("board move descriptions (ADR 0028)", () => {
  it("names every change a panel move applies", () => {
    const names = {
      tag: (id: string) => `tag ${id}`,
      project: (id: string) => `project ${id}`,
    };
    expect([
      describeBoardChange({ kind: "add_tag", tagId: "t1" }, names),
      describeBoardChange({ kind: "remove_tag", tagId: "t1" }, names),
      describeBoardChange({ kind: "add_marker", marker: "in_progress" }, names),
      describeBoardChange({ kind: "remove_marker", marker: "urgent" }, names),
      describeBoardChange({ kind: "complete" }, names),
      describeBoardChange({ kind: "reopen" }, names),
      describeBoardChange({ kind: "assign_project", projectId: "p1" }, names),
      describeBoardChange({ kind: "plan_today", date: "2026-09-25" }, names),
      describeBoardChange({ kind: "clear_planned_day" }, names),
      describeBoardChange({ kind: "add_to_backlog" }, names),
      describeBoardChange({ kind: "remove_from_backlog" }, names),
    ]).toEqual([
      'Add tag "tag t1"',
      'Remove tag "tag t1"',
      "Mark as in progress",
      "Unmark urgent",
      "Complete the task",
      "Reopen the task",
      'Move to project "project p1"',
      "Plan for 2026-09-25",
      "Clear the planned day",
      "Add to the project backlog",
      "Remove from the project backlog",
    ]);
  });
});
