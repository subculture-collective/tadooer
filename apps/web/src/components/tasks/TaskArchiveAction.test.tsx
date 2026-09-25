import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import type { Task } from "@suite/contracts";
import { TasksPage, type TasksPageProps } from "../../pages/TasksPage.tsx";

const task = (id: string, extra: Partial<Task> = {}): Task => ({
  id,
  title: `Task ${id.slice(-1)}`,
  notes: "",
  status: "completed",
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
const parent = task("00000000-0000-4000-8000-000000000001");
const child = task("00000000-0000-4000-8000-000000000002", {
  parentId: parent.id,
  childPosition: 1024,
});

const props = (extra: Partial<TasksPageProps>): TasksPageProps => {
  const noop = vi.fn();
  return {
    tasks: [parent, child],
    visibleTasks: [parent, child],
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
    ...extra,
  };
};

it("offers Archive only on top-level tasks and only online", () => {
  const archive = 'title="Move this task and its children to History"';
  const online = renderToStaticMarkup(
    <TasksPage
      {...props({
        onArchiveTask: vi.fn(),
        organization: {
          csrfToken: "csrf",
          online: true,
          onProjectsChange: vi.fn(),
          onTagsChange: vi.fn(),
        },
      })}
    />,
  );
  expect(online.split(archive)).toHaveLength(2);
  const offline = renderToStaticMarkup(
    <TasksPage
      {...props({
        onArchiveTask: vi.fn(),
        organization: {
          csrfToken: "csrf",
          online: false,
          onProjectsChange: vi.fn(),
          onTagsChange: vi.fn(),
        },
      })}
    />,
  );
  expect(offline).toContain(`disabled="" ${archive}`);
  expect(renderToStaticMarkup(<TasksPage {...props({})} />)).not.toContain(
    archive,
  );
});
