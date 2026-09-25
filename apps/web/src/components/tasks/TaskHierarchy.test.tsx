import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Task } from "@suite/contracts";
import type { LocalStore } from "../../local-store.ts";
import {
  TaskChildrenSection,
  TaskPlacementControls,
  siblingMoveIndex,
} from "./TaskHierarchy.tsx";
import { createTaskHierarchyActions } from "./task-hierarchy-actions.ts";
import { TasksPage, type TasksPageProps } from "../../pages/TasksPage.tsx";

const task = (id: string, extra: Partial<Task> = {}): Task => ({
  id,
  title: `Task ${id.slice(-1)}`,
  notes: "",
  status: "open",
  revision: 1,
  createdAt: "2026-09-24T00:00:00.000Z",
  updatedAt: "2026-09-24T00:00:00.000Z",
  completedAt: null,
  deletedAt: null,
  plannedStart: null,
  estimateMinutes: null,
  projectId: null,
  tagIds: [],
  parentId: null,
  childPosition: null,
  ...extra,
});
const parent = task("00000000-0000-4000-8000-000000000001", {
  title: "Plan trip",
});
const other = task("00000000-0000-4000-8000-000000000002", {
  title: "Pack",
});
const first = task("00000000-0000-4000-8000-000000000003", {
  title: "Book train",
  parentId: parent.id,
  childPosition: 1024,
  status: "completed",
  estimateMinutes: 20,
});
const second = task("00000000-0000-4000-8000-000000000004", {
  title: "Book hotel",
  parentId: parent.id,
  childPosition: 2048,
  estimateMinutes: 45,
});

describe("task hierarchy controls", () => {
  it("computes one-step sibling moves in server index terms", () => {
    const siblings = [first, second];
    expect(siblingMoveIndex(siblings, first.id, "up")).toBeNull();
    expect(siblingMoveIndex(siblings, first.id, "down")).toBe(1);
    expect(siblingMoveIndex(siblings, second.id, "up")).toBe(0);
    expect(siblingMoveIndex(siblings, second.id, "down")).toBeNull();
    expect(siblingMoveIndex(siblings, "missing", "up")).toBeNull();
  });

  it("labels child sections with progress and an add form", () => {
    const html = renderToStaticMarkup(
      <TaskChildrenSection
        parent={parent}
        items={[first, second]}
        busy={false}
        renderChild={(child) => <li key={child.id}>{child.title}</li>}
        onCreateChildTask={vi.fn()}
      />,
    );
    expect(html).toContain(`aria-labelledby="child-tasks-${parent.id}"`);
    expect(html).toContain("1 of 2 done");
    expect(html).toContain("45 min estimated for open children");
    expect(html).toContain('aria-label="Add a child task to Plan trip"');
    expect(html).toContain("New child task");
  });

  it("offers accessible reorder, promote and reparent controls for a child", () => {
    const html = renderToStaticMarkup(
      <TaskPlacementControls
        task={first}
        siblings={[first, second]}
        parents={[parent, other]}
        parentTitle="Plan trip"
        hasChildren={false}
        busy={false}
        onMoveTask={vi.fn()}
      />,
    );
    expect(html).toContain("Child of &quot;Plan trip&quot;");
    expect(html).toContain(
      'aria-label="Move &quot;Book train&quot; up among child tasks"',
    );
    expect(html).toMatch(
      /<button[^>]*disabled=""[^>]*aria-label="Move &quot;Book train&quot; up/,
    );
    expect(html).toContain("Make top-level task");
    // The current parent and the task itself are not offered as targets.
    expect(html).toContain(`value="${other.id}"`);
    expect(html).not.toContain(`value="${parent.id}"`);
  });

  it("keeps a parent with children top-level", () => {
    const html = renderToStaticMarkup(
      <TaskPlacementControls
        task={parent}
        siblings={[]}
        parents={[parent, other]}
        parentTitle={null}
        hasChildren
        busy={false}
        onMoveTask={vi.fn()}
      />,
    );
    expect(html).toContain("stays top-level");
    expect(html).not.toContain("Make child of");
  });
});

it("queues a new child as a create followed by a move", async () => {
  const calls: string[] = [];
  const store = {
    queueTaskCreate: vi.fn((input: { title: string }) => {
      calls.push(`create:${input.title}`);
      return Promise.resolve({
        kind: "task.create",
        task: { id: "new-child" },
      } as never);
    }),
    queueTaskMove: vi.fn(
      (taskId: string, parentId: string | null, index: number | null) => {
        calls.push(`move:${taskId}:${String(parentId)}:${String(index)}`);
        return Promise.resolve({} as never);
      },
    ),
  } satisfies Pick<LocalStore, "queueTaskCreate" | "queueTaskMove">;
  const commit = vi.fn(async (queue: () => Promise<void>) => {
    await queue();
    calls.push("sync");
  });
  const actions = createTaskHierarchyActions(store, commit);
  await actions.onCreateChildTask(parent, "Book taxi");
  await actions.onMoveTask(second, parent.id, 0);
  expect(calls).toEqual([
    "create:Book taxi",
    `move:new-child:${parent.id}:null`,
    "sync",
    `move:${second.id}:${parent.id}:0`,
    "sync",
  ]);
});

it("nests children under their parent and keeps filtered-out parents' children visible", () => {
  const noop = vi.fn();
  const props = {
    tasks: [parent, other, first, second],
    visibleTasks: [parent, other, first, second],
    recovery: [],
    projects: [],
    tags: [],
    subtasks: {},
    provenance: {},
    baikalCalendars: [],
    taskQuery: "",
    taskStatusFilter: "all",
    taskProjectFilter: "",
    taskTagFilter: "",
    busy: false,
    calendarActionsAvailable: false,
    onTaskQueryChange: noop,
    onTaskStatusFilterChange: noop,
    onTaskProjectFilterChange: noop,
    onTaskTagFilterChange: noop,
    onSubmitOrganization: noop,
    onSubmitTaskEdit: noop,
    onSubmitTimeBlock: noop,
    onRemoveTimeBlock: noop,
    onSubmitTaskOrganization: noop,
    onSubmitSubtask: noop,
    onChangeSubtask: noop,
    onSaveTaskAsTemplate: noop,
    onChangeTaskStatus: noop,
    onRemoveTask: noop,
    onRecoverTask: noop,
    onCreateChildTask: noop,
    onMoveTask: noop,
  } satisfies TasksPageProps;
  const nested = renderToStaticMarkup(<TasksPage {...props} />);
  const list = nested.slice(nested.indexOf("Plan trip"));
  expect(list.indexOf("Book train")).toBeLessThan(list.indexOf("Book hotel"));
  expect(nested).toContain('class="task--child"');
  // Filtering out the parent leaves its matching child at top level.
  const filtered = renderToStaticMarkup(
    <TasksPage {...props} visibleTasks={[second]} />,
  );
  expect(filtered).toContain("Book hotel");
  expect(filtered).toContain("Child of &quot;Plan trip&quot;");
});
