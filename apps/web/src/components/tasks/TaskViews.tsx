import { useCallback, useEffect, useState, type SyntheticEvent } from "react";
import {
  ApiRequestError,
  type MenuFolder,
  type MenuFolderKind,
  type Project,
  type Section,
  type SectionContextKind,
  type Tag,
  type Task,
  type TaskView,
  type TaskViewFilter,
} from "@suite/contracts";
import {
  groupTasksByView,
  sortTasksByView,
  taskMatchesView,
  type BoardClock,
  type BoardTaskFacts,
  type TaskViewGroup,
} from "@suite/domain";
import {
  createMenuFolder,
  createSection,
  deleteMenuFolder,
  deleteSection,
  getMenuFolders,
  getSections,
  getTaskViews,
  getTimeReport,
  reorderMenuFolders,
  reorderSections,
  setTaskView,
  updateMenuFolder,
  updateSection,
} from "../../api.ts";
import { Button } from "../ui/button.tsx";
import { Card, CardContent, CardHeader } from "../ui/card.tsx";
import { Input } from "../ui/input.tsx";
import { NativeSelect } from "../ui/native-select.tsx";
import { SectionHeading } from "../ui/section-heading.tsx";

/**
 * Saved task views, sections and sidebar folders on the Tasks page (issue
 * #63, ADR 0028). Everything here is read and written over HTTP with
 * revisions; nothing is cached offline. A 412 reloads the record and asks
 * the owner to try again.
 */

/** A trimmed string field of a submitted form; empty when absent. */
const formString = (data: FormData, key: string): string => {
  const value = data.get(key);
  return typeof value === "string" ? value.trim() : "";
};

const failure = (error: unknown, fallback: string): string =>
  error instanceof ApiRequestError
    ? error.status === 412
      ? "This changed since it loaded. It was reloaded; try again."
      : error.message
    : fallback;

/** The facts a saved view reads from a cached task. Markers and backlog are server-side. */
export const taskFacts = (task: Task): BoardTaskFacts => ({
  id: task.id,
  title: task.title,
  status: task.status,
  projectId: task.projectId ?? null,
  tagIds: task.tagIds ?? [],
  markers: [],
  plannedDay: task.plannedDay ?? null,
  plannedStart: task.plannedStart ?? null,
  deadlineDate: task.deadline?.kind === "date" ? task.deadline.value : null,
  deadlineAt: task.deadline?.kind === "instant" ? task.deadline.value : null,
  createdAt: task.createdAt,
  estimateMinutes: task.estimateMinutes ?? null,
  parentId: task.parentId ?? null,
  inBacklog: false,
});

export interface ViewContext {
  readonly contextKind: TaskView["contextKind"];
  readonly contextId: string;
}

export const viewContextFor = (
  projectId: string,
  tagId: string,
): ViewContext =>
  projectId !== ""
    ? { contextKind: "project", contextId: projectId }
    : tagId !== ""
      ? { contextKind: "tag", contextId: tagId }
      : { contextKind: "all", contextId: "" };

const defaultView = (context: ViewContext): TaskView => ({
  ...context,
  sortBy: null,
  sortDir: "asc",
  groupBy: null,
  filter: null,
  collapsedGroups: [],
  revision: 0,
});

/** Loads every saved view once and exposes the one for the active context. */
export const useSavedTaskView = (
  csrfToken: string | undefined,
  online: boolean,
  context: ViewContext,
) => {
  const [views, setViews] = useState<readonly TaskView[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [timeSpent, setTimeSpent] = useState<Record<string, number>>({});
  const load = useCallback(async () => {
    try {
      setViews(await getTaskViews());
    } catch (error) {
      setMessage(failure(error, "Saved views could not be loaded."));
    }
  }, []);
  useEffect(() => {
    if (!online || csrfToken === undefined) return;
    void load();
  }, [online, csrfToken, load]);
  const view =
    views.find(
      (candidate) =>
        candidate.contextKind === context.contextKind &&
        candidate.contextId === context.contextId,
    ) ?? defaultView(context);
  const usesTimeSpent =
    view.sortBy === "timeSpent" || view.filter?.kind === "timeSpent";
  useEffect(() => {
    if (!usesTimeSpent || !online) return;
    const to = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - 365 * 86_400_000)
      .toISOString()
      .slice(0, 10);
    getTimeReport(from, to)
      .then((report) =>
        setTimeSpent(
          Object.fromEntries(
            report.tasks.map((task) => [
              task.taskId,
              Math.round(task.allTimeMs / 60_000),
            ]),
          ),
        ),
      )
      .catch(() => setTimeSpent({}));
  }, [usesTimeSpent, online]);
  const save = async (patch: Partial<Omit<TaskView, "revision">>) => {
    if (csrfToken === undefined) return;
    setMessage(null);
    try {
      const saved = await setTaskView(
        {
          contextKind: view.contextKind,
          contextId: view.contextId,
          expectedRevision: view.revision,
          sortBy: view.sortBy,
          sortDir: view.sortDir,
          groupBy: view.groupBy,
          filter: view.filter,
          collapsedGroups: view.collapsedGroups,
          ...patch,
        },
        csrfToken,
      );
      setViews((current) => [
        ...current.filter(
          (candidate) =>
            candidate.contextKind !== saved.contextKind ||
            candidate.contextId !== saved.contextId,
        ),
        saved,
      ]);
    } catch (error) {
      setMessage(failure(error, "The view could not be saved."));
      await load();
    }
  };
  return {
    view,
    save,
    message,
    timeSpentMinutes: (taskId: string) => timeSpent[taskId] ?? 0,
  };
};

/** Applies a saved view: filter, sort, then group. */
export const applyTaskView = <T extends Task>(
  tasks: readonly T[],
  view: TaskView,
  clock: BoardClock,
  labels: {
    readonly tag: (tagId: string) => string;
    readonly project: (projectId: string) => string;
  },
  timeSpentMinutes: (taskId: string) => number,
): TaskViewGroup<T>[] => {
  const facts = new Map(tasks.map((task) => [task.id, taskFacts(task)]));
  const fact = (task: T): BoardTaskFacts =>
    facts.get(task.id) ?? taskFacts(task);
  const filtered = tasks.filter((task) =>
    taskMatchesView(fact(task), view.filter, clock, timeSpentMinutes),
  );
  const sorted = sortTasksByView(
    filtered.map((task) => ({ ...fact(task), task })),
    view,
    timeSpentMinutes,
  );
  return groupTasksByView(sorted, view, clock, labels).map((group) => ({
    ...group,
    tasks: group.tasks.map(({ task }) => task),
  }));
};

const presetOptions = [
  ["today", "Today"],
  ["tomorrow", "Tomorrow"],
  ["thisWeek", "This week"],
  ["nextWeek", "Next week"],
  ["thisMonth", "This month"],
  ["nextMonth", "Next month"],
  ["unspecified", "Not set"],
] as const;
const timeOptions = [
  ["10", "10 minutes or more"],
  ["30", "30 minutes or more"],
  ["60", "1 hour or more"],
  ["120", "2 hours or more"],
] as const;

export const TaskViewControls = ({
  view,
  online,
  tags,
  projects,
  message,
  onSave,
}: {
  readonly view: TaskView;
  readonly online: boolean;
  readonly tags: readonly Tag[];
  readonly projects: readonly Project[];
  readonly message: string | null;
  readonly onSave: (
    patch: Partial<Omit<TaskView, "revision">>,
  ) => Promise<void>;
}) => {
  const filterKind = view.filter?.kind ?? "";
  const filterValue =
    view.filter === null
      ? ""
      : view.filter.kind === "tag"
        ? view.filter.tagId
        : view.filter.kind === "project"
          ? view.filter.projectId
          : view.filter.preset;
  const changeFilter = (kind: string, value: string) => {
    let filter: TaskViewFilter = null;
    if (kind === "tag" && value !== "") filter = { kind, tagId: value };
    else if (kind === "project" && value !== "")
      filter = { kind, projectId: value };
    else if ((kind === "scheduledDate" || kind === "deadline") && value !== "")
      filter = { kind, preset: value as (typeof presetOptions)[number][0] };
    else if ((kind === "estimatedTime" || kind === "timeSpent") && value !== "")
      filter = { kind, preset: value as (typeof timeOptions)[number][0] };
    void onSave({ filter });
  };
  const contextLabel =
    view.contextKind === "all"
      ? "all tasks"
      : view.contextKind === "project"
        ? `project ${projects.find(({ id }) => id === view.contextId)?.title ?? ""}`
        : `tag ${tags.find(({ id }) => id === view.contextId)?.displayName ?? ""}`;
  return (
    <Card className="task-view-controls" aria-label="Saved view">
      <CardContent className="flex flex-wrap items-end gap-2 pt-4">
        <p className="w-full">
          <small>
            Saved view for {contextLabel}
            {!online && " (needs a connection to change)"}
          </small>
        </p>
        <label>
          Sort
          <NativeSelect
            value={view.sortBy ?? ""}
            disabled={!online}
            onChange={(event) =>
              void onSave({
                sortBy:
                  event.currentTarget.value === ""
                    ? null
                    : (event.currentTarget.value as TaskView["sortBy"]),
              })
            }
          >
            <option value="">Default</option>
            <option value="name">Name</option>
            <option value="scheduledDate">Scheduled date</option>
            <option value="deadline">Deadline</option>
            <option value="creationDate">Creation date</option>
            <option value="estimatedTime">Estimated time</option>
            <option value="timeSpent">Time spent</option>
          </NativeSelect>
        </label>
        <label>
          Direction
          <NativeSelect
            value={view.sortDir}
            disabled={!online}
            onChange={(event) =>
              void onSave({
                sortDir: event.currentTarget.value as "asc" | "desc",
              })
            }
          >
            <option value="asc">Ascending</option>
            <option value="desc">Descending</option>
          </NativeSelect>
        </label>
        <label>
          Group
          <NativeSelect
            value={view.groupBy ?? ""}
            disabled={!online}
            onChange={(event) =>
              void onSave({
                groupBy:
                  event.currentTarget.value === ""
                    ? null
                    : (event.currentTarget.value as TaskView["groupBy"]),
              })
            }
          >
            <option value="">None</option>
            <option value="tag">Tag</option>
            <option value="project">Project</option>
            <option value="scheduledDate">Scheduled date</option>
            <option value="deadline">Deadline</option>
          </NativeSelect>
        </label>
        <label>
          Filter
          <NativeSelect
            value={filterKind}
            disabled={!online}
            onChange={(event) => changeFilter(event.currentTarget.value, "")}
          >
            <option value="">None</option>
            <option value="tag">Tag</option>
            <option value="project">Project</option>
            <option value="scheduledDate">Scheduled date</option>
            <option value="deadline">Deadline</option>
            <option value="estimatedTime">Estimated time</option>
            <option value="timeSpent">Time spent</option>
          </NativeSelect>
        </label>
        {filterKind !== "" && (
          <label>
            Filter value
            <NativeSelect
              value={filterValue}
              disabled={!online}
              onChange={(event) =>
                changeFilter(filterKind, event.currentTarget.value)
              }
            >
              <option value="">Choose</option>
              {filterKind === "tag" &&
                tags.map((tag) => (
                  <option key={tag.id} value={tag.id}>
                    {tag.displayName}
                  </option>
                ))}
              {filterKind === "project" &&
                projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.title}
                  </option>
                ))}
              {(filterKind === "scheduledDate" || filterKind === "deadline") &&
                presetOptions.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              {(filterKind === "estimatedTime" || filterKind === "timeSpent") &&
                timeOptions.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
            </NativeSelect>
          </label>
        )}
        {message !== null && (
          <p role="status" className="w-full">
            {message}
          </p>
        )}
      </CardContent>
    </Card>
  );
};

// ---------------------------------------------------------------- sections

export const SectionsPanel = ({
  csrfToken,
  online,
  contextKind,
  contextId,
  contextTitle,
  tasks,
  busy,
}: {
  readonly csrfToken: string;
  readonly online: boolean;
  readonly contextKind: SectionContextKind;
  readonly contextId: string;
  readonly contextTitle: string;
  /** Active tasks of the context, for placement. */
  readonly tasks: readonly Task[];
  readonly busy: boolean;
}) => {
  const [sections, setSections] = useState<readonly Section[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [placement, setPlacement] = useState<Record<string, string>>({});
  const load = useCallback(async () => {
    try {
      setSections(await getSections(contextKind, contextId));
    } catch (error) {
      setMessage(failure(error, "Sections could not be loaded."));
    }
  }, [contextKind, contextId]);
  useEffect(() => {
    if (!online) return;
    void load();
  }, [online, load, tasks]);
  const run = async (
    action: () => Promise<readonly Section[]>,
    fallback: string,
  ) => {
    setMessage(null);
    try {
      setSections(await action());
    } catch (error) {
      setMessage(failure(error, fallback));
      await load();
    }
  };
  const submitNew = (event: SyntheticEvent<HTMLFormElement, SubmitEvent>) => {
    event.preventDefault();
    const title = formString(new FormData(event.currentTarget), "title");
    if (title === "") return;
    event.currentTarget.reset();
    void run(
      () => createSection({ contextKind, contextId, title }, csrfToken),
      "The section could not be created.",
    );
  };
  const titleOf = (taskId: string) =>
    tasks.find((task) => task.id === taskId)?.title ?? "Task not loaded";
  const placed = new Set(sections.flatMap((section) => section.taskIds));
  const disabled = busy || !online;
  return (
    <Card aria-labelledby="sections-title">
      <CardHeader>
        <SectionHeading
          id="sections-title"
          as="h2"
          title={`Sections in ${contextTitle}`}
        >
          <p>
            <small>
              Named groups of this {contextKind}'s tasks with their own order.
              Tasks outside every section stay in the list below.
            </small>
          </p>
        </SectionHeading>
      </CardHeader>
      <CardContent>
        {message !== null && <p role="status">{message}</p>}
        {sections.length === 0 && (
          <p>
            <small>No sections yet.</small>
          </p>
        )}
        <ul className="sections">
          {sections.map((section, index) => (
            <li key={section.id}>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  const title = formString(
                    new FormData(event.currentTarget),
                    "title",
                  );
                  if (title === "" || title === section.title) return;
                  void run(
                    () =>
                      updateSection(
                        section.id,
                        { expectedRevision: section.revision, title },
                        csrfToken,
                      ),
                    "The section could not be renamed.",
                  );
                }}
              >
                <label className="field">
                  <span>Section title</span>
                  <Input
                    name="title"
                    key={section.revision}
                    defaultValue={section.title}
                    maxLength={200}
                  />
                </label>
                <Button variant="outline" disabled={disabled}>
                  Rename
                </Button>
              </form>
              <div className="task-actions">
                <Button
                  type="button"
                  variant="outline"
                  disabled={disabled}
                  aria-expanded={section.expanded}
                  onClick={() =>
                    void run(
                      () =>
                        updateSection(
                          section.id,
                          {
                            expectedRevision: section.revision,
                            expanded: !section.expanded,
                          },
                          csrfToken,
                        ),
                      "The section could not be changed.",
                    )
                  }
                >
                  {section.expanded ? "Collapse" : "Expand"} {section.title}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={disabled || index === 0}
                  onClick={() => {
                    const items = sections.map(({ id, revision }) => ({
                      id,
                      revision,
                    }));
                    items.splice(index, 0, ...items.splice(index - 1, 1));
                    void run(
                      () =>
                        reorderSections(
                          { contextKind, contextId, items },
                          csrfToken,
                        ),
                      "The section order could not be saved.",
                    );
                  }}
                >
                  Move {section.title} up
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={disabled || index === sections.length - 1}
                  onClick={() => {
                    const items = sections.map(({ id, revision }) => ({
                      id,
                      revision,
                    }));
                    items.splice(index + 1, 0, ...items.splice(index, 1));
                    void run(
                      () =>
                        reorderSections(
                          { contextKind, contextId, items },
                          csrfToken,
                        ),
                      "The section order could not be saved.",
                    );
                  }}
                >
                  Move {section.title} down
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  disabled={disabled}
                  onClick={() =>
                    void run(
                      () =>
                        deleteSection(section.id, section.revision, csrfToken),
                      "The section could not be deleted.",
                    )
                  }
                >
                  Delete {section.title}
                </Button>
              </div>
              {section.expanded && (
                <ol>
                  {section.taskIds.map((taskId, position) => (
                    <li key={taskId}>
                      {titleOf(taskId)}
                      <div className="task-actions">
                        <Button
                          type="button"
                          variant="outline"
                          disabled={disabled || position === 0}
                          aria-label={`Move ${titleOf(taskId)} up in ${section.title}`}
                          onClick={() => {
                            const taskIds = [...section.taskIds];
                            taskIds.splice(
                              position,
                              0,
                              ...taskIds.splice(position - 1, 1),
                            );
                            void run(
                              () =>
                                updateSection(
                                  section.id,
                                  {
                                    expectedRevision: section.revision,
                                    taskIds,
                                  },
                                  csrfToken,
                                ),
                              "The task order could not be saved.",
                            );
                          }}
                        >
                          Up
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          disabled={
                            disabled || position === section.taskIds.length - 1
                          }
                          aria-label={`Move ${titleOf(taskId)} down in ${section.title}`}
                          onClick={() => {
                            const taskIds = [...section.taskIds];
                            taskIds.splice(
                              position + 1,
                              0,
                              ...taskIds.splice(position, 1),
                            );
                            void run(
                              () =>
                                updateSection(
                                  section.id,
                                  {
                                    expectedRevision: section.revision,
                                    taskIds,
                                  },
                                  csrfToken,
                                ),
                              "The task order could not be saved.",
                            );
                          }}
                        >
                          Down
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          disabled={disabled}
                          aria-label={`Remove ${titleOf(taskId)} from ${section.title}`}
                          onClick={() =>
                            void run(
                              () =>
                                updateSection(
                                  section.id,
                                  {
                                    expectedRevision: section.revision,
                                    taskIds: section.taskIds.filter(
                                      (id) => id !== taskId,
                                    ),
                                  },
                                  csrfToken,
                                ),
                              "The task could not be removed.",
                            )
                          }
                        >
                          Remove
                        </Button>
                      </div>
                    </li>
                  ))}
                </ol>
              )}
              <div className="task-actions">
                <NativeSelect
                  aria-label={`Task to add to ${section.title}`}
                  value={placement[section.id] ?? ""}
                  disabled={disabled}
                  onChange={(event) =>
                    setPlacement({
                      ...placement,
                      [section.id]: event.currentTarget.value,
                    })
                  }
                >
                  <option value="">Choose a task</option>
                  {tasks
                    .filter((task) => !section.taskIds.includes(task.id))
                    .map((task) => (
                      <option key={task.id} value={task.id}>
                        {task.title}
                        {placed.has(task.id) ? " (in another section)" : ""}
                      </option>
                    ))}
                </NativeSelect>
                <Button
                  type="button"
                  disabled={disabled || (placement[section.id] ?? "") === ""}
                  onClick={() => {
                    const taskId = placement[section.id];
                    if (taskId === undefined || taskId === "") return;
                    setPlacement({ ...placement, [section.id]: "" });
                    void run(
                      () =>
                        updateSection(
                          section.id,
                          {
                            expectedRevision: section.revision,
                            taskIds: [...section.taskIds, taskId],
                          },
                          csrfToken,
                        ),
                      "The task could not be added.",
                    );
                  }}
                >
                  Add to {section.title}
                </Button>
              </div>
            </li>
          ))}
        </ul>
        <form onSubmit={submitNew}>
          <label className="field">
            <span>New section</span>
            <Input name="title" autoComplete="off" required maxLength={200} />
          </label>
          <Button disabled={disabled}>Add section</Button>
        </form>
      </CardContent>
    </Card>
  );
};

// ------------------------------------------------------------ menu folders

/** Loads the owner's sidebar folders once; returns them with a reload. */
export const useMenuFolders = (
  csrfToken: string | undefined,
  online: boolean,
) => {
  const [folders, setFolders] = useState<readonly MenuFolder[]>([]);
  const load = useCallback(async () => {
    try {
      setFolders(await getMenuFolders());
    } catch {
      setFolders([]);
    }
  }, []);
  useEffect(() => {
    if (!online || csrfToken === undefined) return;
    void load();
  }, [online, csrfToken, load]);
  return { folders, setFolders, reload: load };
};

export interface FolderGroup<T> {
  readonly folder: MenuFolder | null;
  readonly depth: number;
  readonly items: readonly T[];
}

/**
 * Flattens folders depth-first for a select: each folder (with its depth) and
 * the items it holds, then the loose items under a null folder.
 */
export const groupByFolder = <T extends { readonly id: string }>(
  items: readonly T[],
  folders: readonly MenuFolder[],
  kind: MenuFolderKind,
): FolderGroup<T>[] => {
  const byId = new Map(items.map((item) => [item.id, item]));
  const placed = new Set<string>();
  const groups: FolderGroup<T>[] = [];
  const visit = (parentId: string | null, depth: number) => {
    for (const folder of folders.filter(
      (candidate) => candidate.kind === kind && candidate.parentId === parentId,
    )) {
      const held = folder.itemIds.flatMap((id) => {
        const item = byId.get(id);
        if (item === undefined) return [];
        placed.add(id);
        return [item];
      });
      groups.push({ folder, depth, items: held });
      visit(folder.id, depth + 1);
    }
  };
  visit(null, 0);
  return [
    ...groups,
    {
      folder: null,
      depth: 0,
      items: items.filter(({ id }) => !placed.has(id)),
    },
  ];
};

export const MenuFolderManager = ({
  csrfToken,
  online,
  folders,
  onFoldersChange,
  projects,
  tags,
  busy,
}: {
  readonly csrfToken: string;
  readonly online: boolean;
  readonly folders: readonly MenuFolder[];
  readonly onFoldersChange: (folders: readonly MenuFolder[]) => void;
  readonly projects: readonly Project[];
  readonly tags: readonly Tag[];
  readonly busy: boolean;
}) => {
  const [message, setMessage] = useState<string | null>(null);
  const [kind, setKind] = useState<MenuFolderKind>("project");
  const [assignment, setAssignment] = useState<Record<string, string>>({});
  const run = async (
    action: () => Promise<readonly MenuFolder[]>,
    fallback: string,
  ) => {
    setMessage(null);
    try {
      const changed = await action();
      // The server returns one kind; keep the other kind's folders.
      onFoldersChange([
        ...folders.filter((folder) => folder.kind !== kind),
        ...changed,
      ]);
    } catch (error) {
      setMessage(failure(error, fallback));
      try {
        onFoldersChange(await getMenuFolders());
      } catch {
        /* keep the last list */
      }
    }
  };
  const items: readonly { id: string; title: string }[] =
    kind === "project"
      ? projects.map(({ id, title }) => ({ id, title }))
      : tags.map(({ id, displayName }) => ({ id, title: displayName }));
  const itemTitle = (id: string) =>
    items.find((item) => item.id === id)?.title ?? id;
  const ofKind = folders.filter((folder) => folder.kind === kind);
  const disabled = busy || !online;
  const siblings = (parentId: string | null) =>
    ofKind.filter((folder) => folder.parentId === parentId);
  const depthOf = (folder: MenuFolder): number => {
    let depth = 0;
    let current = folder.parentId;
    while (current !== null && depth < 8) {
      current = ofKind.find(({ id }) => id === current)?.parentId ?? null;
      depth++;
    }
    return depth;
  };
  return (
    <Card aria-labelledby="menu-folders-title">
      <CardHeader>
        <SectionHeading id="menu-folders-title" as="h2" title="Sidebar folders">
          <p>
            <small>
              Group projects and tags in the filters. An item sits in one
              folder; folders nest up to eight levels.
            </small>
          </p>
        </SectionHeading>
      </CardHeader>
      <CardContent>
        {message !== null && <p role="status">{message}</p>}
        <label className="field">
          <span>Folder kind</span>
          <NativeSelect
            value={kind}
            onChange={(event) =>
              setKind(event.currentTarget.value as MenuFolderKind)
            }
          >
            <option value="project">Projects</option>
            <option value="tag">Tags</option>
          </NativeSelect>
        </label>
        <ul className="menu-folders">
          {ofKind.map((folder) => {
            const peers = siblings(folder.parentId);
            const index = peers.findIndex(({ id }) => id === folder.id);
            const reorder = (direction: -1 | 1) => {
              const items = peers.map(({ id, revision }) => ({ id, revision }));
              const target = index + direction;
              if (target < 0 || target >= items.length) return;
              items.splice(target, 0, ...items.splice(index, 1));
              void run(
                () =>
                  reorderMenuFolders(
                    { kind, parentId: folder.parentId, items },
                    csrfToken,
                  ),
                "The folder order could not be saved.",
              );
            };
            return (
              <li
                key={folder.id}
                style={{ marginLeft: `${String(depthOf(folder))}rem` }}
              >
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    const title = formString(
                      new FormData(event.currentTarget),
                      "title",
                    );
                    if (title === "" || title === folder.title) return;
                    void run(
                      () =>
                        updateMenuFolder(
                          folder.id,
                          { expectedRevision: folder.revision, title },
                          csrfToken,
                        ),
                      "The folder could not be renamed.",
                    );
                  }}
                >
                  <label className="field">
                    <span>Folder title</span>
                    <Input
                      name="title"
                      key={folder.revision}
                      defaultValue={folder.title}
                      maxLength={100}
                    />
                  </label>
                  <Button variant="outline" disabled={disabled}>
                    Rename
                  </Button>
                </form>
                <p>
                  <small>
                    {folder.itemIds.length === 0
                      ? "Empty"
                      : folder.itemIds.map(itemTitle).join(", ")}
                  </small>
                </p>
                <div className="task-actions">
                  <Button
                    type="button"
                    variant="outline"
                    disabled={disabled}
                    aria-expanded={folder.expanded}
                    onClick={() =>
                      void run(
                        () =>
                          updateMenuFolder(
                            folder.id,
                            {
                              expectedRevision: folder.revision,
                              expanded: !folder.expanded,
                            },
                            csrfToken,
                          ),
                        "The folder could not be changed.",
                      )
                    }
                  >
                    {folder.expanded ? "Collapse" : "Expand"} {folder.title}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={disabled || index <= 0}
                    onClick={() => reorder(-1)}
                  >
                    Move {folder.title} up
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={disabled || index === peers.length - 1}
                    onClick={() => reorder(1)}
                  >
                    Move {folder.title} down
                  </Button>
                  <Button
                    type="button"
                    variant="destructive"
                    disabled={disabled}
                    onClick={() =>
                      void run(
                        () =>
                          deleteMenuFolder(
                            folder.id,
                            folder.revision,
                            csrfToken,
                          ),
                        "The folder could not be deleted.",
                      )
                    }
                  >
                    Delete {folder.title}
                  </Button>
                </div>
                <div className="task-actions">
                  <NativeSelect
                    aria-label={`Item to add to ${folder.title}`}
                    value={assignment[folder.id] ?? ""}
                    disabled={disabled}
                    onChange={(event) =>
                      setAssignment({
                        ...assignment,
                        [folder.id]: event.currentTarget.value,
                      })
                    }
                  >
                    <option value="">Choose a {kind}</option>
                    {items
                      .filter(({ id }) => !folder.itemIds.includes(id))
                      .map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.title}
                        </option>
                      ))}
                  </NativeSelect>
                  <Button
                    type="button"
                    disabled={disabled || (assignment[folder.id] ?? "") === ""}
                    onClick={() => {
                      const itemId = assignment[folder.id];
                      if (itemId === undefined || itemId === "") return;
                      setAssignment({ ...assignment, [folder.id]: "" });
                      void run(
                        () =>
                          updateMenuFolder(
                            folder.id,
                            {
                              expectedRevision: folder.revision,
                              itemIds: [...folder.itemIds, itemId],
                            },
                            csrfToken,
                          ),
                        "The item could not be added.",
                      );
                    }}
                  >
                    Add to {folder.title}
                  </Button>
                  {folder.itemIds.length > 0 && (
                    <Button
                      type="button"
                      variant="outline"
                      disabled={disabled}
                      onClick={() =>
                        void run(
                          () =>
                            updateMenuFolder(
                              folder.id,
                              {
                                expectedRevision: folder.revision,
                                itemIds: folder.itemIds.slice(0, -1),
                              },
                              csrfToken,
                            ),
                          "The item could not be removed.",
                        )
                      }
                    >
                      Remove last item from {folder.title}
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            const title = formString(data, "title");
            const parent = formString(data, "parentId");
            if (title === "") return;
            event.currentTarget.reset();
            void run(
              () =>
                createMenuFolder(
                  { kind, title, parentId: parent === "" ? null : parent },
                  csrfToken,
                ),
              "The folder could not be created.",
            );
          }}
        >
          <label className="field">
            <span>New {kind} folder</span>
            <Input name="title" autoComplete="off" required maxLength={100} />
          </label>
          <label className="field">
            <span>Inside</span>
            <NativeSelect name="parentId" defaultValue="">
              <option value="">Top level</option>
              {ofKind.map((folder) => (
                <option key={folder.id} value={folder.id}>
                  {folder.title}
                </option>
              ))}
            </NativeSelect>
          </label>
          <Button disabled={disabled}>Add folder</Button>
        </form>
      </CardContent>
    </Card>
  );
};
