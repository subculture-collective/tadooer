import { PageHeader } from "../components/ui/page-header.tsx";
import { DeadlineFields } from "../components/tasks/DeadlineFields.tsx";
import type { ReactElement, SyntheticEvent } from "react";
import { groupTaskHierarchy, zonedCalendarDate } from "@suite/domain";
import {
  TaskChildrenSection,
  TaskPlacementControls,
  type TaskHierarchyActions,
} from "../components/tasks/TaskHierarchy.tsx";
import type {
  BaikalStatusResponse,
  Note,
  Project,
  Subtask,
  Tag,
  Task,
  TaskPatchRequest,
} from "@suite/contracts";
import { TaskPlanningForm } from "../components/tasks/TaskPlanningForm.tsx";
import { Field } from "../field.tsx";
import { TimeBlockForm } from "../time-block-form.tsx";
import { Button } from "../components/ui/button.tsx";
import { Card, CardContent, CardHeader } from "../components/ui/card.tsx";
import { Checkbox } from "../components/ui/checkbox.tsx";
import { EmptyState } from "../components/ui/empty-state.tsx";
import { Input } from "../components/ui/input.tsx";
import { NativeSelect } from "../components/ui/native-select.tsx";
import { SectionHeading } from "../components/ui/section-heading.tsx";
import {
  OrganizationPanel,
  type NoteQueue,
  type OrganizationQueue,
} from "../components/organization/OrganizationPanel.tsx";
import { TaskLinksPanel } from "../components/tasks/TaskLinksPanel.tsx";
import { NoteMarkdown } from "../components/notes/NoteMarkdown.tsx";
import { useApplicationPreferences } from "../application-preferences.tsx";
import {
  RecurringSeriesManager,
  TaskRecurrencePanel,
} from "../components/tasks/TaskRecurrence.tsx";
import {
  MenuFolderManager,
  SectionsPanel,
  TaskViewControls,
  applyTaskView,
  groupByFolder,
  useMenuFolders,
  useSavedTaskView,
  viewContextFor,
} from "../components/tasks/TaskViews.tsx";

export interface TasksPageProps extends TaskHierarchyActions {
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
  /** Moves a top-level task and its children to History (ADR 0022); online only. */
  readonly onArchiveTask?: (task: Task) => Promise<void>;
  /** Enables project/tag/note management when a session is available. */
  readonly organization?: {
    readonly csrfToken: string;
    readonly online: boolean;
    readonly onProjectsChange: (projects: readonly Project[]) => void;
    readonly onTagsChange: (tags: readonly Tag[]) => void;
    /** ADR 0033: lifecycle and appearance edits through the offline outbox. */
    readonly queue?: OrganizationQueue;
    /** ADR 0046: notes from the offline cache and their outbox writes. */
    readonly notes?: readonly Note[];
    readonly noteQueue?: NoteQueue;
  };
  /** Owner planning zone for date-only plans (ADR 0020). */
  readonly timeZone?: string;
  readonly onSubmitTaskPlanning?: (
    task: Task,
    patch: TaskPatchRequest,
  ) => Promise<void>;
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
  onArchiveTask,
  timeZone = "UTC",
  onSubmitTaskPlanning,
  onCreateChildTask,
  onMoveTask,
}: TasksPageProps) => {
  // ADR 0030: task notes use the same safe Markdown subset as notes.
  const { markdownInNotes } = useApplicationPreferences().snapshot.preferences;
  const visibleIds = new Set(visibleTasks.map(({ id }) => id));
  const today = zonedCalendarDate(new Date(), timeZone);
  // Saved view, sections and sidebar folders (ADR 0028): online HTTP records.
  const viewContext = viewContextFor(taskProjectFilter, taskTagFilter);
  const savedView = useSavedTaskView(
    organization?.csrfToken,
    organization?.online === true,
    viewContext,
  );
  const { folders, setFolders } = useMenuFolders(
    organization?.csrfToken,
    organization?.online === true,
  );
  const viewLabels = {
    tag: (tagId: string) =>
      tags.find(({ id }) => id === tagId)?.displayName ?? "Unknown tag",
    project: (projectId: string) =>
      projects.find(({ id }) => id === projectId)?.title ?? "Unknown project",
  };
  // Children render under a visible parent; a child whose parent is filtered
  // out stays visible at top level with its placement shown.
  const topLevel = visibleTasks.filter(
    (task) => task.parentId == null || !visibleIds.has(task.parentId),
  );
  const viewGroups = applyTaskView(
    topLevel,
    savedView.view,
    { today, timeZone },
    viewLabels,
    savedView.timeSpentMinutes,
  );
  const { childrenByParent } = groupTaskHierarchy(visibleTasks);
  const allChildren = groupTaskHierarchy(tasks).childrenByParent;
  const titleById = new Map(tasks.map(({ id, title }) => [id, title]));
  const parentCandidates = tasks.filter(
    (task) => task.parentId == null && task.deletedAt == null,
  );
  const renderTask = (task: Task, siblings: readonly Task[]): ReactElement => (
    <li
      key={task.id}
      className={[
        task.status === "completed" ? "task--completed" : "",
        task.parentId == null ? "" : "task--child",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <div className="task-heading">
        <strong>{task.title}</strong>
        <small>
          {task.status === "completed" ? "Completed" : "Open"} · Revision{" "}
          {task.revision}
        </small>
      </div>
      {task.notes !== "" &&
        (markdownInNotes ? (
          <NoteMarkdown content={task.notes} />
        ) : (
          <span>{task.notes}</span>
        ))}
      {provenance[task.id] !== undefined && (
        <p className="template-provenance">Created from a reusable template.</p>
      )}
      {task.plannedStart != null && (
        <p className="planned-time">
          Planned {new Date(task.plannedStart).toLocaleString()} ·{" "}
          {task.estimateMinutes} minutes
        </p>
      )}
      {task.plannedStart == null && task.plannedDay != null && (
        <p className="planned-time">
          Planned for {task.plannedDay} · no time set
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
      <TaskPlacementControls
        task={task}
        siblings={siblings}
        parents={parentCandidates}
        parentTitle={
          task.parentId == null ? null : (titleById.get(task.parentId) ?? null)
        }
        hasChildren={(allChildren.get(task.id)?.length ?? 0) > 0}
        busy={busy}
        onMoveTask={onMoveTask}
      />
      <TimeBlockForm
        task={task}
        calendars={baikalCalendars}
        busy={busy}
        available={calendarActionsAvailable}
        onSubmit={onSubmitTimeBlock}
        onRemove={onRemoveTimeBlock}
      />
      {onSubmitTaskPlanning !== undefined && (
        <TaskPlanningForm
          key={`${task.id}:${String(task.revision)}`}
          task={task}
          timeZone={timeZone}
          busy={busy}
          available={true}
          remindersAvailable={calendarActionsAvailable}
          onSubmit={onSubmitTaskPlanning}
        />
      )}
      <form
        className="task-edit"
        onSubmit={(event) => void onSubmitTaskOrganization(event, task)}
      >
        <label className="field">
          <span>Project</span>
          <NativeSelect name="projectId" defaultValue={task.projectId ?? ""}>
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
                  defaultChecked={task.tagIds?.includes(tag.id) === true}
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
          <Field label="New checklist item" name="title" autoComplete="off" />
          <Button disabled={busy}>Add item</Button>
        </form>
      </div>
      {task.parentId == null && (
        <TaskChildrenSection
          parent={task}
          items={childrenByParent.get(task.id) ?? []}
          allItems={allChildren.get(task.id) ?? []}
          busy={busy}
          renderChild={(child) =>
            renderTask(child, allChildren.get(task.id) ?? [])
          }
          onCreateChildTask={onCreateChildTask}
        />
      )}
      {organization !== undefined && (
        <TaskLinksPanel
          taskId={task.id}
          csrfToken={organization.csrfToken}
          online={organization.online}
        />
      )}
      {organization !== undefined && (
        <TaskRecurrencePanel
          task={task}
          csrfToken={organization.csrfToken}
          online={organization.online}
          today={today}
          tags={tags}
        />
      )}
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
        {onArchiveTask !== undefined && task.parentId == null && (
          <Button
            type="button"
            variant="outline"
            disabled={busy || organization?.online === false}
            title="Move this task and its children to History"
            onClick={() => void onArchiveTask(task)}
          >
            Archive
          </Button>
        )}
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
  );
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
      {organization !== undefined && (
        <MenuFolderManager
          csrfToken={organization.csrfToken}
          online={organization.online}
          folders={folders}
          onFoldersChange={setFolders}
          projects={projects}
          tags={tags}
          busy={busy}
        />
      )}
      {organization !== undefined && (
        <RecurringSeriesManager
          csrfToken={organization.csrfToken}
          online={organization.online}
          projects={projects}
          today={today}
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
              {groupByFolder(
                projects.filter(
                  (project) =>
                    !project.hiddenFromMenu || project.id === taskProjectFilter,
                ),
                folders,
                "project",
              ).map((group) =>
                group.folder === null ? (
                  group.items.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.title}
                    </option>
                  ))
                ) : (
                  <optgroup
                    key={group.folder.id}
                    label={`${"· ".repeat(group.depth)}${group.folder.title}`}
                  >
                    {group.items.map((project) => (
                      <option key={project.id} value={project.id}>
                        {project.title}
                      </option>
                    ))}
                  </optgroup>
                ),
              )}
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
              {groupByFolder(tags, folders, "tag").map((group) =>
                group.folder === null ? (
                  group.items.map((tag) => (
                    <option key={tag.id} value={tag.id}>
                      {tag.displayName}
                    </option>
                  ))
                ) : (
                  <optgroup
                    key={group.folder.id}
                    label={`${"· ".repeat(group.depth)}${group.folder.title}`}
                  >
                    {group.items.map((tag) => (
                      <option key={tag.id} value={tag.id}>
                        {tag.displayName}
                      </option>
                    ))}
                  </optgroup>
                ),
              )}
            </NativeSelect>
          </label>
        </CardContent>
      </Card>
      {organization !== undefined && (
        <TaskViewControls
          view={savedView.view}
          online={organization.online}
          tags={tags}
          projects={projects}
          message={savedView.message}
          onSave={savedView.save}
        />
      )}
      {organization !== undefined &&
        viewContext.contextKind !== "all" &&
        viewContext.contextKind !== "today" && (
          <SectionsPanel
            csrfToken={organization.csrfToken}
            online={organization.online}
            contextKind={viewContext.contextKind}
            contextId={viewContext.contextId}
            contextTitle={
              viewContext.contextKind === "project"
                ? viewLabels.project(viewContext.contextId)
                : viewLabels.tag(viewContext.contextId)
            }
            tasks={tasks.filter(
              (task) =>
                task.deletedAt == null &&
                (viewContext.contextKind === "project"
                  ? task.projectId === viewContext.contextId
                  : task.tagIds?.includes(viewContext.contextId) === true),
            )}
            busy={busy}
          />
        )}
      <SectionHeading as="h2" title="Captured tasks" />
      {visibleTasks.length === 0 ||
      viewGroups.every((group) => group.tasks.length === 0) ? (
        <EmptyState title="No tasks match these filters." />
      ) : (
        viewGroups.map((group) => (
          <div key={group.key} className="task-view-group">
            {group.label !== "" && (
              <SectionHeading
                as="h3"
                title={`${group.label} (${String(group.tasks.length)})`}
              />
            )}
            <ul className="tasks">
              {group.tasks.map((task) =>
                renderTask(
                  task,
                  task.parentId == null
                    ? []
                    : (allChildren.get(task.parentId) ?? []),
                ),
              )}
            </ul>
          </div>
        ))
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
                  {task.parentId != null && (
                    <small>
                      Child of{" "}
                      {titleById.get(task.parentId) ?? "a deleted task"};
                      restoring it alone makes it top-level if its parent is
                      still deleted
                    </small>
                  )}
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
