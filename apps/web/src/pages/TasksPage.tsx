import { PageHeader } from "../components/ui/page-header.tsx";
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
import { Button } from "../components/ui/button.tsx";
import { Card, CardContent, CardHeader } from "../components/ui/card.tsx";
import { Checkbox } from "../components/ui/checkbox.tsx";
import { EmptyState } from "../components/ui/empty-state.tsx";
import { Input } from "../components/ui/input.tsx";
import { NativeSelect } from "../components/ui/native-select.tsx";
import { SectionHeading } from "../components/ui/section-heading.tsx";
import { OrganizationPanel } from "../components/organization/OrganizationPanel.tsx";

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
  /** Enables project/tag/note management when a session is available. */
  readonly organization?: {
    readonly csrfToken: string;
    readonly online: boolean;
    readonly onProjectsChange: (projects: readonly Project[]) => void;
    readonly onTagsChange: (tags: readonly Tag[]) => void;
  };
}

export const TasksPage = ({
  tasks,
  organization,
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
      <PageHeader
        title="Tasks"
        description="Organize, edit, and schedule your tasks."
      />
      <Card aria-labelledby="organization-title">
        <CardHeader>
          <SectionHeading
            id="organization-title"
            as="h2"
            title="Projects and tags"
          />
        </CardHeader>
        <CardContent>
          <div className="task-actions">
            <form
              onSubmit={(event) => void onSubmitOrganization(event, "project")}
            >
              <Field label="New project" name="title" autoComplete="off" />
              <Button disabled={busy}>Add project</Button>
            </form>
            <form onSubmit={(event) => void onSubmitOrganization(event, "tag")}>
              <Field label="New tag" name="title" autoComplete="off" />
              <Button disabled={busy}>Add tag</Button>
            </form>
          </div>
        </CardContent>
      </Card>
      {organization !== undefined && (
        <OrganizationPanel
          projects={projects}
          tags={tags}
          tasks={tasks}
          {...organization}
        />
      )}
      <Card className="task-filter-bar" role="search" aria-label="Filter tasks">
        <CardContent className="flex flex-wrap items-end gap-2 pt-4">
          <label>
            Search
            <Input
              type="search"
              value={taskQuery}
              onChange={(event) => onTaskQueryChange(event.currentTarget.value)}
            />
          </label>
          <label>
            Status
            <NativeSelect
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
            </NativeSelect>
          </label>
          <label>
            Project
            <NativeSelect
              value={taskProjectFilter}
              onChange={(event) =>
                onTaskProjectFilterChange(event.currentTarget.value)
              }
            >
              <option value="">All projects</option>
              {projects
                .filter(
                  (project) =>
                    !project.hiddenFromMenu || project.id === taskProjectFilter,
                )
                .map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.title}
                  </option>
                ))}
            </NativeSelect>
          </label>
          <label>
            Tag
            <NativeSelect
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
            </NativeSelect>
          </label>
        </CardContent>
      </Card>
      <SectionHeading as="h2" title="Captured tasks" />
      {visibleTasks.length === 0 ? (
        <EmptyState title="No tasks match these filters." />
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
                  <Input
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
                <Button disabled={busy}>Save task</Button>
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
                  <NativeSelect
                    name="projectId"
                    defaultValue={task.projectId ?? ""}
                  >
                    <option value="">No project</option>
                    {projects
                      .filter((project) => project.archivedAt === null)
                      .map((project) => (
                        <option key={project.id} value={project.id}>
                          {project.title}
                        </option>
                      ))}
                  </NativeSelect>
                </label>
                <fieldset>
                  <legend>Tags</legend>
                  {tags
                    .filter((tag) => tag.archivedAt === null)
                    .map((tag) => (
                      <label key={tag.id}>
                        <Checkbox
                          name="tagIds"
                          value={tag.id}
                          defaultChecked={
                            task.tagIds?.includes(tag.id) === true
                          }
                        />
                        {tag.displayName}
                      </label>
                    ))}
                </fieldset>
                <Button disabled={busy}>Save organization</Button>
              </form>
              <div>
                <strong>Checklist</strong>
                <ul>
                  {(subtasks[task.id] ?? []).map((subtask, index, items) => (
                    <li key={subtask.id}>
                      {subtask.completed ? "✓" : "○"} {subtask.title}
                      <Button
                        type="button"
                        disabled={busy}
                        onClick={() => void onChangeSubtask(subtask, "toggle")}
                      >
                        {subtask.completed ? "Reopen" : "Complete"}
                      </Button>
                      <Button
                        type="button"
                        disabled={busy || index === 0}
                        onClick={() => void onChangeSubtask(subtask, "up")}
                      >
                        Move up
                      </Button>
                      <Button
                        type="button"
                        disabled={busy || index === items.length - 1}
                        onClick={() => void onChangeSubtask(subtask, "down")}
                      >
                        Move down
                      </Button>
                      <Button
                        type="button"
                        variant="destructive"
                        disabled={busy}
                        onClick={() => void onChangeSubtask(subtask, "delete")}
                      >
                        Delete item
                      </Button>
                    </li>
                  ))}
                </ul>
                <form onSubmit={(event) => void onSubmitSubtask(event, task)}>
                  <Field
                    label="New checklist item"
                    name="title"
                    autoComplete="off"
                  />
                  <Button disabled={busy}>Add item</Button>
                </form>
              </div>
              <div className="task-actions">
                <Button
                  type="button"
                  disabled={busy}
                  onClick={() => void onSaveTaskAsTemplate(task)}
                >
                  Save as template
                </Button>
                <Button
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
                </Button>
                <Button
                  variant="destructive"
                  type="button"
                  disabled={busy}
                  onClick={() => void onRemoveTask(task)}
                >
                  Delete
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <Card className="recovery">
        <CardHeader>
          <SectionHeading
            as="h2"
            title={`Recently deleted tasks (${String(recovery.length)})`}
          />
        </CardHeader>
        <CardContent>
          {recovery.length === 0 ? (
            <p className="muted">Nothing needs recovery.</p>
          ) : (
            <ul className="tasks">
              {recovery.map((task) => (
                <li key={task.id}>
                  <strong>{task.title}</strong>
                  <Button
                    type="button"
                    disabled={busy}
                    onClick={() => void onRecoverTask(task)}
                  >
                    Restore task
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </>
  );
};
