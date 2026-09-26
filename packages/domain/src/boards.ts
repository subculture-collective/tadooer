import { zonedCalendarDate } from "./date-only-planning.ts";

// Structural twins of the @suite/contracts board schemas; the domain package
// has no dependencies, so the contracts types are checked against these.
export type BoardMarker = "urgent" | "important" | "in_progress" | "today";
export type BoardTemplate = "eisenhower" | "kanban";
export interface BoardPanelFilter {
  readonly includedTagIds: readonly string[];
  readonly includedTagsMatch: "all" | "any";
  readonly excludedTagIds: readonly string[];
  readonly excludedTagsMatch: "any" | "all";
  readonly includedMarkers: readonly BoardMarker[];
  readonly excludedMarkers: readonly BoardMarker[];
  readonly projectIds: readonly string[];
  readonly doneState: "all" | "done" | "open";
  readonly scheduledState: "all" | "scheduled" | "unscheduled";
  readonly backlogState: "all" | "no_backlog" | "only_backlog";
  readonly parentsOnly: boolean;
  readonly sortBy: "dueDate" | "created" | "title" | "timeEstimate" | null;
  readonly sortDir: "asc" | "desc";
}
export type BoardMoveChange =
  | { readonly kind: "add_tag"; readonly tagId: string }
  | { readonly kind: "remove_tag"; readonly tagId: string }
  | { readonly kind: "add_marker"; readonly marker: BoardMarker }
  | { readonly kind: "remove_marker"; readonly marker: BoardMarker }
  | { readonly kind: "complete" }
  | { readonly kind: "reopen" }
  | { readonly kind: "assign_project"; readonly projectId: string }
  | { readonly kind: "plan_today"; readonly date: string }
  | { readonly kind: "clear_planned_day" }
  | { readonly kind: "add_to_backlog" }
  | { readonly kind: "remove_from_backlog" };
export type TaskViewDatePreset =
  | "today"
  | "tomorrow"
  | "thisWeek"
  | "nextWeek"
  | "thisMonth"
  | "nextMonth"
  | "unspecified";
export type TaskViewFilter =
  | { readonly kind: "tag"; readonly tagId: string }
  | { readonly kind: "project"; readonly projectId: string }
  | { readonly kind: "scheduledDate"; readonly preset: TaskViewDatePreset }
  | { readonly kind: "deadline"; readonly preset: TaskViewDatePreset }
  | {
      readonly kind: "estimatedTime";
      readonly preset: "10" | "30" | "60" | "120";
    }
  | { readonly kind: "timeSpent"; readonly preset: "10" | "30" | "60" | "120" }
  | null;
export interface TaskViewOptions {
  readonly sortBy:
    | "name"
    | "scheduledDate"
    | "deadline"
    | "creationDate"
    | "estimatedTime"
    | "timeSpent"
    | null;
  readonly sortDir: "asc" | "desc";
  readonly groupBy: "tag" | "project" | "scheduledDate" | "deadline" | null;
}

/**
 * Board panel matching, panel moves and saved task views (issue #63, ADR
 * 0028). The rules mirror Super Productivity 19.1.0 `boards.util.ts`
 * (`doesTaskMatchPanel`, `rewriteTagIdsForPanel`, `buildComparator`) and the
 * task-view customizer, with system tags replaced by board markers.
 */

/** The task facts a panel filter or a saved view reads. */
export interface BoardTaskFacts {
  readonly id: string;
  readonly title: string;
  readonly status: "open" | "completed";
  readonly projectId: string | null;
  readonly tagIds: readonly string[];
  /** Stored markers (urgent, important, in_progress); today is derived. */
  readonly markers: readonly Exclude<BoardMarker, "today">[];
  readonly plannedDay: string | null;
  readonly plannedStart: string | null;
  readonly deadlineDate: string | null;
  readonly deadlineAt: string | null;
  readonly createdAt: string;
  readonly estimateMinutes: number | null;
  readonly parentId: string | null;
  readonly inBacklog: boolean;
}

export interface BoardClock {
  /** The owner's current planning date (ADR 0027). */
  readonly today: string;
  readonly timeZone: string;
}

/** The owner-zone date a task is planned for, from its day or its start. */
export const plannedDateOf = (
  task: Pick<BoardTaskFacts, "plannedDay" | "plannedStart">,
  timeZone: string,
): string | null =>
  task.plannedStart !== null
    ? zonedCalendarDate(task.plannedStart, timeZone)
    : task.plannedDay;

export const isPlannedToday = (
  task: Pick<BoardTaskFacts, "plannedDay" | "plannedStart">,
  clock: BoardClock,
): boolean => plannedDateOf(task, clock.timeZone) === clock.today;

const hasMarker = (
  task: BoardTaskFacts,
  marker: BoardMarker,
  clock: BoardClock,
): boolean =>
  marker === "today"
    ? isPlannedToday(task, clock)
    : task.markers.includes(marker);

/** Membership predicate; `doesTaskMatchPanel` with markers beside tags. */
export const taskMatchesPanel = (
  task: BoardTaskFacts,
  filter: BoardPanelFilter,
  clock: BoardClock,
): boolean => {
  const included: boolean[] = [
    ...filter.includedTagIds.map((tagId) => task.tagIds.includes(tagId)),
    ...filter.includedMarkers.map((marker) => hasMarker(task, marker, clock)),
  ];
  if (included.length > 0) {
    const matches =
      filter.includedTagsMatch === "any"
        ? included.some(Boolean)
        : included.every(Boolean);
    if (!matches) return false;
  }
  const excluded: boolean[] = [
    ...filter.excludedTagIds.map((tagId) => task.tagIds.includes(tagId)),
    ...filter.excludedMarkers.map((marker) => hasMarker(task, marker, clock)),
  ];
  if (excluded.length > 0) {
    const hit =
      filter.excludedTagsMatch === "all"
        ? excluded.every(Boolean)
        : excluded.some(Boolean);
    if (hit) return false;
  }
  if (filter.parentsOnly && task.parentId !== null) return false;
  if (filter.doneState === "done" && task.status !== "completed") return false;
  if (filter.doneState === "open" && task.status === "completed") return false;
  if (
    filter.projectIds.length > 0 &&
    (task.projectId === null || !filter.projectIds.includes(task.projectId))
  )
    return false;
  const scheduled = task.plannedDay !== null || task.plannedStart !== null;
  if (filter.scheduledState === "scheduled" && !scheduled) return false;
  if (filter.scheduledState === "unscheduled" && scheduled) return false;
  if (filter.backlogState === "only_backlog" && !task.inBacklog) return false;
  if (filter.backlogState === "no_backlog" && task.inBacklog) return false;
  return true;
};

export type BoardMovePlan =
  | { readonly ok: true; readonly changes: readonly BoardMoveChange[] }
  | { readonly ok: false; readonly reason: string };

/**
 * The explicit changes that make a task match a panel after a move, in the
 * order they are applied. Mirrors `rewriteTagIdsForPanel` and `_applyPanel`:
 * included tags and markers are added (all of them, or the first one for
 * `any` when none is present), excluded ones are removed (all of them, or the
 * first one for `all` when the task carries every one), done state and the
 * first project are applied, and the backlog state is applied. A panel that
 * needs a specific date or a parent-only task cannot take a task that lacks
 * it, so the move is refused rather than guessed.
 */
export const planPanelMove = (
  task: BoardTaskFacts,
  filter: BoardPanelFilter,
  clock: BoardClock,
): BoardMovePlan => {
  const changes: BoardMoveChange[] = [];
  const nextTags = new Set(task.tagIds);
  const nextMarkers = new Set<BoardMarker>(task.markers);
  let plannedToday = isPlannedToday(task, clock);
  const includes = [
    ...filter.includedTagIds.map((tagId) => ({ kind: "tag" as const, tagId })),
    ...filter.includedMarkers.map((marker) => ({
      kind: "marker" as const,
      marker,
    })),
  ];
  const present = (item: (typeof includes)[number]): boolean =>
    item.kind === "tag"
      ? nextTags.has(item.tagId)
      : item.marker === "today"
        ? plannedToday
        : nextMarkers.has(item.marker);
  const add = (item: (typeof includes)[number]): void => {
    if (item.kind === "tag") {
      nextTags.add(item.tagId);
      changes.push({ kind: "add_tag", tagId: item.tagId });
    } else if (item.marker === "today") {
      plannedToday = true;
      changes.push({ kind: "plan_today", date: clock.today });
    } else {
      nextMarkers.add(item.marker);
      changes.push({ kind: "add_marker", marker: item.marker });
    }
  };
  if (includes.length > 0) {
    if (filter.includedTagsMatch === "any") {
      const first = includes[0];
      if (first !== undefined && !includes.some(present)) add(first);
    } else for (const item of includes) if (!present(item)) add(item);
  }
  const excludes = [
    ...filter.excludedTagIds.map((tagId) => ({ kind: "tag" as const, tagId })),
    ...filter.excludedMarkers.map((marker) => ({
      kind: "marker" as const,
      marker,
    })),
  ];
  const remove = (item: (typeof excludes)[number]): boolean => {
    if (item.kind === "tag") {
      nextTags.delete(item.tagId);
      changes.push({ kind: "remove_tag", tagId: item.tagId });
    } else if (item.marker === "today") {
      if (task.plannedStart !== null) return false;
      plannedToday = false;
      changes.push({ kind: "clear_planned_day" });
    } else {
      nextMarkers.delete(item.marker);
      changes.push({ kind: "remove_marker", marker: item.marker });
    }
    return true;
  };
  if (excludes.length > 0) {
    const carried = excludes.filter(present);
    const toRemove =
      filter.excludedTagsMatch === "all"
        ? carried.length === excludes.length
          ? excludes.slice(0, 1)
          : []
        : carried;
    for (const item of toRemove)
      if (!remove(item))
        return {
          ok: false,
          reason:
            "The task has a planned start today; remove its time block or start before moving it out of a today panel",
        };
  }
  if (filter.doneState === "done" && task.status !== "completed")
    changes.push({ kind: "complete" });
  else if (filter.doneState === "open" && task.status === "completed")
    changes.push({ kind: "reopen" });
  const firstProject = filter.projectIds[0];
  if (
    firstProject !== undefined &&
    (task.projectId === null || !filter.projectIds.includes(task.projectId))
  )
    changes.push({ kind: "assign_project", projectId: firstProject });
  if (filter.parentsOnly && task.parentId !== null)
    return {
      ok: false,
      reason:
        "This panel shows only top-level tasks; move the child to the top level first",
    };
  const scheduled =
    plannedToday || task.plannedDay !== null || task.plannedStart !== null;
  if (filter.scheduledState === "scheduled" && !scheduled)
    return {
      ok: false,
      reason:
        "This panel shows only scheduled tasks; plan the task for a day first",
    };
  if (filter.scheduledState === "unscheduled" && scheduled) {
    if (task.plannedStart !== null)
      return {
        ok: false,
        reason:
          "This panel shows only unscheduled tasks; remove the task's time block or start first",
      };
    if (!changes.some((change) => change.kind === "clear_planned_day"))
      changes.push({ kind: "clear_planned_day" });
  }
  if (filter.backlogState === "only_backlog" && !task.inBacklog)
    changes.push({ kind: "add_to_backlog" });
  if (filter.backlogState === "no_backlog" && task.inBacklog)
    changes.push({ kind: "remove_from_backlog" });
  return { ok: true, changes };
};

const dueInstant = (task: BoardTaskFacts): number | null =>
  task.plannedStart !== null
    ? Date.parse(task.plannedStart)
    : task.plannedDay !== null
      ? Date.parse(`${task.plannedDay}T00:00:00.000Z`)
      : null;

const compareNullable = (a: number | null, b: number | null): number =>
  a === null && b === null ? 0 : a === null ? 1 : b === null ? -1 : a - b;

/**
 * Orders a panel's members: the saved manual ranks first (then creation
 * order) when `sortBy` is null, or the sort field with nulls last. Descending
 * sorts reverse the comparison, as the source does.
 */
export const sortPanelTasks = <T extends BoardTaskFacts>(
  tasks: readonly T[],
  filter: Pick<BoardPanelFilter, "sortBy" | "sortDir">,
  manualOrder: readonly string[],
): T[] => {
  if (filter.sortBy === null) {
    const rank = new Map(manualOrder.map((id, index) => [id, index]));
    return tasks.toSorted((a, b) => {
      const ra = rank.get(a.id);
      const rb = rank.get(b.id);
      if (ra !== undefined && rb !== undefined) return ra - rb;
      if (ra !== undefined) return -1;
      if (rb !== undefined) return 1;
      return a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
    });
  }
  const field = filter.sortBy;
  const compare = (a: T, b: T): number => {
    switch (field) {
      case "title":
        return a.title.localeCompare(b.title);
      case "created":
        return a.createdAt.localeCompare(b.createdAt);
      case "timeEstimate":
        return (a.estimateMinutes ?? 0) - (b.estimateMinutes ?? 0);
      case "dueDate":
        return compareNullable(dueInstant(a), dueInstant(b));
    }
  };
  const direction = filter.sortDir === "desc" ? -1 : 1;
  return tasks.toSorted(
    (a, b) => direction * compare(a, b) || a.id.localeCompare(b.id),
  );
};

/** Default boards of Super Productivity 19.1.0, expressed with markers. */
export const boardTemplate = (
  template: BoardTemplate,
): {
  readonly title: string;
  readonly columns: number;
  readonly panels: readonly {
    readonly title: string;
    readonly filter: BoardPanelFilter;
  }[];
} => {
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
  if (template === "eisenhower") {
    const quadrant = (
      title: string,
      includedMarkers: BoardMarker[],
      excludedMarkers: BoardMarker[],
    ) => ({
      title,
      filter: { ...base, includedMarkers, excludedMarkers, parentsOnly: true },
    });
    return {
      title: "Eisenhower matrix",
      columns: 2,
      panels: [
        quadrant("Urgent and important", ["important", "urgent"], []),
        quadrant("Not urgent and important", ["important"], ["urgent"]),
        quadrant("Urgent and not important", ["urgent"], ["important"]),
        quadrant("Not urgent and not important", [], ["important", "urgent"]),
      ],
    };
  }
  const column = (
    title: string,
    filter: Partial<BoardPanelFilter>,
  ): { title: string; filter: BoardPanelFilter } => ({
    title,
    filter: { ...base, backlogState: "no_backlog", ...filter },
  });
  return {
    title: "Kanban",
    columns: 3,
    panels: [
      column("To do", { doneState: "open", excludedMarkers: ["in_progress"] }),
      column("In progress", {
        doneState: "open",
        includedMarkers: ["in_progress"],
      }),
      column("Done", { doneState: "done" }),
    ],
  };
};

// ------------------------------------------------------------ task views

/** Owner-zone calendar arithmetic for the date presets. */
const addDays = (date: string, days: number): string =>
  new Date(Date.parse(`${date}T00:00:00.000Z`) + days * 86_400_000)
    .toISOString()
    .slice(0, 10);
const weekday = (date: string): number =>
  new Date(`${date}T00:00:00.000Z`).getUTCDay();
/** Monday-based week window [start, end]. */
const weekOf = (date: string, offsetWeeks: number): [string, string] => {
  const monday = addDays(date, -((weekday(date) + 6) % 7) + offsetWeeks * 7);
  return [monday, addDays(monday, 6)];
};
const monthOf = (date: string, offsetMonths: number): [string, string] => {
  const [year, month] = date.split("-").map(Number) as [number, number, number];
  const start = new Date(Date.UTC(year, month - 1 + offsetMonths, 1));
  const end = new Date(Date.UTC(year, month + offsetMonths, 0));
  return [start.toISOString().slice(0, 10), end.toISOString().slice(0, 10)];
};

const presetWindow = (
  preset: Exclude<TaskViewDatePreset, "unspecified">,
  today: string,
): [string, string] => {
  switch (preset) {
    case "today":
      return [today, today];
    case "tomorrow":
      return [addDays(today, 1), addDays(today, 1)];
    case "thisWeek":
      return weekOf(today, 0);
    case "nextWeek":
      return weekOf(today, 1);
    case "thisMonth":
      return monthOf(today, 0);
    case "nextMonth":
      return monthOf(today, 1);
  }
};

const deadlineDateOf = (
  task: BoardTaskFacts,
  timeZone: string,
): string | null =>
  task.deadlineAt !== null
    ? zonedCalendarDate(task.deadlineAt, timeZone)
    : task.deadlineDate;

/** Applies a saved view's single filter; `timeSpent` uses the supplied minutes. */
export const taskMatchesView = (
  task: BoardTaskFacts,
  filter: TaskViewFilter,
  clock: BoardClock,
  timeSpentMinutes: (taskId: string) => number,
): boolean => {
  if (filter === null) return true;
  switch (filter.kind) {
    case "tag":
      return task.tagIds.includes(filter.tagId);
    case "project":
      return task.projectId === filter.projectId;
    case "scheduledDate":
    case "deadline": {
      const date =
        filter.kind === "scheduledDate"
          ? plannedDateOf(task, clock.timeZone)
          : deadlineDateOf(task, clock.timeZone);
      if (filter.preset === "unspecified") return date === null;
      if (date === null) return false;
      const [from, to] = presetWindow(filter.preset, clock.today);
      return date >= from && date <= to;
    }
    case "estimatedTime":
      return (task.estimateMinutes ?? 0) >= Number(filter.preset);
    case "timeSpent":
      return timeSpentMinutes(task.id) >= Number(filter.preset);
  }
};

export const sortTasksByView = <T extends BoardTaskFacts>(
  tasks: readonly T[],
  view: Pick<TaskViewOptions, "sortBy" | "sortDir">,
  timeSpentMinutes: (taskId: string) => number,
): T[] => {
  if (view.sortBy === null) return [...tasks];
  const field = view.sortBy;
  const compare = (a: T, b: T): number => {
    switch (field) {
      case "name":
        return a.title.localeCompare(b.title);
      case "creationDate":
        return a.createdAt.localeCompare(b.createdAt);
      case "estimatedTime":
        return (a.estimateMinutes ?? 0) - (b.estimateMinutes ?? 0);
      case "timeSpent":
        return timeSpentMinutes(a.id) - timeSpentMinutes(b.id);
      case "scheduledDate":
        return compareNullable(dueInstant(a), dueInstant(b));
      case "deadline":
        return compareNullable(
          a.deadlineAt !== null
            ? Date.parse(a.deadlineAt)
            : a.deadlineDate !== null
              ? Date.parse(`${a.deadlineDate}T00:00:00.000Z`)
              : null,
          b.deadlineAt !== null
            ? Date.parse(b.deadlineAt)
            : b.deadlineDate !== null
              ? Date.parse(`${b.deadlineDate}T00:00:00.000Z`)
              : null,
        );
    }
  };
  const direction = view.sortDir === "desc" ? -1 : 1;
  return tasks.toSorted((a, b) => direction * compare(a, b));
};

export interface TaskViewGroup<T> {
  /** Stable key, also used in `collapsedGroups`. */
  readonly key: string;
  readonly label: string;
  readonly tasks: readonly T[];
}

/**
 * Groups tasks by the view's group option, keeping the incoming order inside
 * each group. A task with several tags appears under each of them, as in the
 * source; tasks without a value form a trailing "None" group.
 */
export const groupTasksByView = <T extends BoardTaskFacts>(
  tasks: readonly T[],
  view: Pick<TaskViewOptions, "groupBy">,
  clock: BoardClock,
  labels: {
    readonly tag: (tagId: string) => string;
    readonly project: (projectId: string) => string;
  },
): TaskViewGroup<T>[] => {
  if (view.groupBy === null) return [{ key: "all", label: "", tasks }];
  const groups = new Map<string, { label: string; tasks: T[] }>();
  const put = (key: string, label: string, task: T): void => {
    const group = groups.get(key) ?? { label, tasks: [] };
    group.tasks.push(task);
    groups.set(key, group);
  };
  for (const task of tasks) {
    switch (view.groupBy) {
      case "tag":
        if (task.tagIds.length === 0) put("none", "No tag", task);
        for (const tagId of task.tagIds)
          put(`tag:${tagId}`, labels.tag(tagId), task);
        break;
      case "project":
        if (task.projectId === null) put("none", "No project", task);
        else
          put(
            `project:${task.projectId}`,
            labels.project(task.projectId),
            task,
          );
        break;
      case "scheduledDate": {
        const date = plannedDateOf(task, clock.timeZone);
        if (date === null) put("none", "Not scheduled", task);
        else put(`date:${date}`, date, task);
        break;
      }
      case "deadline": {
        const date = deadlineDateOf(task, clock.timeZone);
        if (date === null) put("none", "No deadline", task);
        else put(`date:${date}`, date, task);
        break;
      }
    }
  }
  const none = groups.get("none");
  groups.delete("none");
  const ordered = [...groups.entries()].toSorted(([a, ga], [b, gb]) =>
    view.groupBy === "tag" || view.groupBy === "project"
      ? ga.label.localeCompare(gb.label)
      : a.localeCompare(b),
  );
  return [
    ...ordered.map(([key, group]) => ({ key, ...group })),
    ...(none === undefined ? [] : [{ key: "none", ...none }]),
  ];
};
