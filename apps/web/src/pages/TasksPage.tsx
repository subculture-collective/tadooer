import { DeadlineFields } from "../components/tasks/DeadlineFields.tsx";
import type { SyntheticEvent } from "react";
import type {
  BaikalStatusResponse,
  Project,
  Subtask,
  Tag,
  Task,
} from "@suite/contracts";
import { Field } from "../field.tsx";
import { TimeBlockForm } from "../time-block-form.tsx";

export interface TasksPageProps {
  readonly tasks: readonly Task[];
  readonly visibleTasks: readonly Task[];
  readonly recovery: readonly Task[];
  readonly projects: readonly Project[];
  readonly tags: readonly Tag[];
  readonly subtasks: Readonly<Record<string, readonly Subtask[]>>;
  readonly provenance: Readonly<Record<string, string>>;
  readonly baikalCalendars: BaikalStatusResponse["calendars"];
  readonly taskQuery: string;
  readonly taskStatusFilter: "all" | Task["status"];
  readonly taskProjectFilter: string;
  readonly taskTagFilter: string;
  readonly busy: boolean;
  readonly calendarActionsAvailable: boolean;
  readonly onTaskQueryChange: (query: string) => void;
  readonly onTaskStatusFilterChange: (filter: "all" | Task["status"]) => void;
  readonly onTaskProjectFilterChange: (projectId: string) => void;
  readonly onTaskTagFilterChange: (tagId: string) => void;
  readonly onSubmitOrganization: (
    event: SyntheticEvent<HTMLFormElement, SubmitEvent>,
    kind: "project" | "tag",
  ) => Promise<void>;
  readonly onSubmitTaskEdit: (
    event: SyntheticEvent<HTMLFormElement, SubmitEvent>,
    task: Task,
  ) => Promise<void>;
  readonly onSubmitTimeBlock: (
    event: SyntheticEvent<HTMLFormElement, SubmitEvent>,
    task: Task,
  ) => Promise<void>;
  readonly onRemoveTimeBlock: (task: Task) => Promise<void>;
  readonly onSubmitTaskOrganization: (
    event: SyntheticEvent<HTMLFormElement, SubmitEvent>,
    task: Task,
  ) => Promise<void>;
  readonly onSubmitSubtask: (
    event: SyntheticEvent<HTMLFormElement, SubmitEvent>,
    task: Task,
  ) => Promise<void>;
  readonly onChangeSubtask: (
    subtask: Subtask,
    action: "toggle" | "up" | "down" | "delete",
  ) => Promise<void>;
  readonly onSaveTaskAsTemplate: (task: Task) => Promise<void>;
  readonly onChangeTaskStatus: (
    task: Task,
    action: "complete" | "reopen",
  ) => Promise<boolean>;
  readonly onRemoveTask: (task: Task) => Promise<void>;
  readonly onRecoverTask: (task: Task) => Promise<void>;
}

export const TasksPage = ({
  visibleTasks,
  recovery,
  projects,
  tags,
  subtasks,
  provenance,
  baikalCalendars,
  taskQuery,
  taskStatusFilter,
  taskProjectFilter,
  taskTagFilter,
  busy,
  calendarActionsAvailable,
  onTaskQueryChange,
  onTaskStatusFilterChange,
  onTaskProjectFilterChange,
  onTaskTagFilterChange,
  onSubmitOrganization,
  onSubmitTaskEdit,
  onSubmitTimeBlock,
  onRemoveTimeBlock,
  onSubmitTaskOrganization,
  onSubmitSubtask,
  onChangeSubtask,
  onSaveTaskAsTemplate,
  onChangeTaskStatus,
  onRemoveTask,
  onRecoverTask,
}: TasksPageProps) => {
  return (
    <>
      <section aria-labelledby="organization-title">
        <h3 id="organization-title">Projects and tags</h3>
        <div className="task-actions">
          <form
            onSubmit={(event) => void onSubmitOrganization(event, "project")}
          >
            <Field label="New project" name="title" autoComplete="off" />
            <button disabled={busy}>Add project</button>
          </form>
          <form onSubmit={(event) => void onSubmitOrganization(event, "tag")}>
            <Field label="New tag" name="title" autoComplete="off" />
            <button disabled={busy}>Add tag</button>
          </form>
        </div>
      </section>
      <div className="task-filter-bar" role="search" aria-label="Filter tasks">
        <label>
          Search
          <input
            type="search"
            value={taskQuery}
            onChange={(event) => onTaskQueryChange(event.currentTarget.value)}
          />
        </label>
        <label>
          Status
          <select
            value={taskStatusFilter}
            onChange={(event) =>
              onTaskStatusFilterChange(
                event.currentTarget.value as "all" | Task["status"],
              )
            }
          >
            <option value="all">All</option>
            <option value="open">Open</option>
            <option value="completed">Completed</option>
          </select>
        </label>
        <label>
          Project
          <select
            value={taskProjectFilter}
            onChange={(event) =>
              onTaskProjectFilterChange(event.currentTarget.value)
            }
          >
            <option value="">All projects</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.title}
              </option>
            ))}
          </select>
        </label>
        <label>
          Tag
          <select
            value={taskTagFilter}
            onChange={(event) =>
              onTaskTagFilterChange(event.currentTarget.value)
            }
          >
            <option value="">All tags</option>
            {tags.map((tag) => (
              <option key={tag.id} value={tag.id}>
                {tag.displayName}
              </option>
            ))}
          </select>
        </label>
      </div>
      <h3>Captured tasks</h3>
      {visibleTasks.length === 0 ? (
        <p className="muted">No tasks match these filters.</p>
      ) : (
        <ul className="tasks">
          {visibleTasks.map((task) => (
            <li
              key={task.id}
              className={task.status === "completed" ? "task--completed" : ""}
            >
              <div className="task-heading">
                <strong>{task.title}</strong>
                <small>
                  {task.status === "completed" ? "Completed" : "Open"} ·
                  Revision {task.revision}
                </small>
              </div>
              {task.notes !== "" && <span>{task.notes}</span>}
              {provenance[task.id] !== undefined && (
                <p className="template-provenance">
                  Created from a reusable template.
                </p>
              )}
              {task.plannedStart != null && (
                <p className="planned-time">
                  Planned {new Date(task.plannedStart).toLocaleString()} ·{" "}
                  {task.estimateMinutes} minutes
                </p>
              )}
              <form
                className="task-edit"
                onSubmit={(event) => void onSubmitTaskEdit(event, task)}
              >
                <Field
                  label="Title"
                  name="title"
                  autoComplete="off"
                  defaultValue={task.title}
                />
                <Field
                  label="Notes"
                  name="notes"
                  autoComplete="off"
                  defaultValue={task.notes}
                  required={false}
                />
                <label className="field">
                  <span>Estimate minutes</span>
                  <input
                    name="estimateMinutes"
                    type="number"
                    min="1"
                    max="720"
                    defaultValue={task.estimateMinutes ?? ""}
                  />
                </label>
                <DeadlineFields
                  key={JSON.stringify(task.deadline)}
                  deadline={task.deadline}
                />
                <button disabled={busy}>Save task</button>
              </form>
              <TimeBlockForm
                task={task}
                calendars={baikalCalendars}
                busy={busy}
                available={calendarActionsAvailable}
                onSubmit={onSubmitTimeBlock}
                onRemove={onRemoveTimeBlock}
              />
              <form
                className="task-edit"
                onSubmit={(event) => void onSubmitTaskOrganization(event, task)}
              >
                <label className="field">
                  <span>Project</span>
                  <select name="projectId" defaultValue={task.projectId ?? ""}>
                    <option value="">No project</option>
                    {projects
                      .filter((project) => project.archivedAt === null)
                      .map((project) => (
                        <option key={project.id} value={project.id}>
                          {project.title}
                        </option>
                      ))}
                  </select>
                </label>
                <fieldset>
                  <legend>Tags</legend>
                  {tags
                    .filter((tag) => tag.archivedAt === null)
                    .map((tag) => (
                      <label key={tag.id}>
                        <input
                          type="checkbox"
                          name="tagIds"
                          value={tag.id}
                          defaultChecked={task.tagIds?.includes(tag.id)}
                        />
                        {tag.displayName}
                      </label>
                    ))}
                </fieldset>
                <button disabled={busy}>Save organization</button>
              </form>
              <div>
                <strong>Checklist</strong>
                <ul>
                  {(subtasks[task.id] ?? []).map((subtask, index, items) => (
                    <li key={subtask.id}>
                      {subtask.completed ? "✓" : "○"} {subtask.title}
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void onChangeSubtask(subtask, "toggle")}
                      >
                        {subtask.completed ? "Reopen" : "Complete"}
                      </button>
                      <button
                        type="button"
                        disabled={busy || index === 0}
                        onClick={() => void onChangeSubtask(subtask, "up")}
                      >
                        Move up
                      </button>
                      <button
                        type="button"
                        disabled={busy || index === items.length - 1}
                        onClick={() => void onChangeSubtask(subtask, "down")}
                      >
                        Move down
                      </button>
                      <button
                        type="button"
                        className="btn-danger"
                        disabled={busy}
                        onClick={() => void onChangeSubtask(subtask, "delete")}
                      >
                        Delete item
                      </button>
                    </li>
                  ))}
                </ul>
                <form onSubmit={(event) => void onSubmitSubtask(event, task)}>
                  <Field
                    label="New checklist item"
                    name="title"
                    autoComplete="off"
                  />
                  <button disabled={busy}>Add item</button>
                </form>
              </div>
              <div className="task-actions">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void onSaveTaskAsTemplate(task)}
                >
                  Save as template
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void onChangeTaskStatus(
                      task,
                      task.status === "completed" ? "reopen" : "complete",
                    )
                  }
                >
                  {task.status === "completed" ? "Reopen" : "Complete"}
                </button>
                <button
                  className="btn-danger"
                  type="button"
                  disabled={busy}
                  onClick={() => void onRemoveTask(task)}
                >
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <details className="recovery">
        <summary>Recently deleted tasks ({recovery.length})</summary>
        {recovery.length === 0 ? (
          <p className="muted">Nothing needs recovery.</p>
        ) : (
          <ul className="tasks">
            {recovery.map((task) => (
              <li key={task.id}>
                <strong>{task.title}</strong>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void onRecoverTask(task)}
                >
                  Restore task
                </button>
              </li>
            ))}
          </ul>
        )}
      </details>
    </>
  );
};
