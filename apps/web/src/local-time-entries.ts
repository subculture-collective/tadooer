import {
  syncTimeEntryWindowDays,
  syncTimeEntryWindowStart,
  timeEntrySchema,
  type SyncOperation,
  type Task,
  type TimeEntry,
  type TimeReport,
} from "@suite/contracts";
import { weekStartOf } from "@suite/domain";

/**
 * Stored time entries in the offline cache (ADR 0050). One pure function
 * says what a queued operation does to a cached entry; the local store uses
 * it for the optimistic write, for the replay of the outbox over a fresh
 * snapshot and for the rebase after a sync round. The cached report is what
 * the Worklog shows without a connection.
 */
export type TimeEntryOperation = Extract<
  SyncOperation,
  {
    readonly kind:
      "time_entry.create" | "time_entry.patch" | "time_entry.delete";
  }
>;

export const isTimeEntryOperation = (
  operation: SyncOperation,
): operation is TimeEntryOperation =>
  operation.kind === "time_entry.create" ||
  operation.kind === "time_entry.patch" ||
  operation.kind === "time_entry.delete";

export const timeEntryIdForOperation = (
  operation: TimeEntryOperation,
): string =>
  operation.kind === "time_entry.create"
    ? operation.timeEntry.id
    : operation.timeEntryId;

/**
 * The oldest work date the cache keeps at `now`. The server bounds its
 * snapshot by the owner-zone date; the cache measures from the UTC date and
 * keeps one more day, which covers the difference between the two.
 */
export const cachedTimeEntryWindowStart = (now: string): string =>
  syncTimeEntryWindowStart(now.slice(0, 10), syncTimeEntryWindowDays + 1);

/** Whether an entry of this work date belongs in the cache at `now`. */
export const inCachedTimeEntryWindow = (
  workDate: string,
  now: string,
): boolean => workDate >= cachedTimeEntryWindowStart(now);

/**
 * The cached entry after one queued operation: the new value, `null` when
 * the operation deletes it, or `undefined` when there is nothing to change.
 * A patched entry takes the revision the server will give it, so a second
 * offline edit does not conflict with the first. The server may still
 * refuse the operation by a day rule (ADR 0024); the canonical entry then
 * replaces this one.
 */
export const applyTimeEntryOperation = (
  current: TimeEntry | undefined,
  operation: TimeEntryOperation,
): TimeEntry | null | undefined => {
  if (operation.kind === "time_entry.create")
    return (
      current ??
      timeEntrySchema.parse({
        ...operation.timeEntry,
        source: "manual",
        revision: 1,
        startedAt: null,
        endedAt: null,
        running: false,
        provenance: null,
        createdAt: operation.createdAt,
        updatedAt: operation.createdAt,
      })
    );
  if (current === undefined) return undefined;
  if (operation.kind === "time_entry.delete") return null;
  const { fields } = operation;
  return {
    ...current,
    workDate: fields.workDate ?? current.workDate,
    durationMs: fields.durationMs ?? current.durationMs,
    note: fields.note ?? current.note,
    revision: operation.baseRevision + 1,
    updatedAt: operation.createdAt,
  };
};

/** By work date, then creation time, then ID: the order of the report. */
export const compareTimeEntries = (left: TimeEntry, right: TimeEntry): number =>
  left.workDate.localeCompare(right.workDate) ||
  left.taskId.localeCompare(right.taskId) ||
  left.id.localeCompare(right.id);

type ReportTask = Pick<
  Task,
  | "id"
  | "title"
  | "parentId"
  | "projectId"
  | "status"
  | "deletedAt"
  | "archivedAt"
  | "estimateMinutes"
>;

/**
 * The Worklog report for [from, to] computed from the cache alone (ADR
 * 0050): the manual and imported entries of the cached window, with tasks
 * and projects from the cached records. It has no focus time, no imported
 * work start or end, and no all-time totals, since those need the server;
 * `allTimeMs` repeats the time in the range. Entries of tasks that are not
 * cached or are soft-deleted are left out, as the server report does.
 */
export const cachedTimeReport = (input: {
  readonly entries: readonly TimeEntry[];
  readonly tasks: readonly ReportTask[];
  readonly projects: readonly { readonly id: string; readonly title: string }[];
  readonly from: string;
  readonly to: string;
  readonly timeZone: string;
  readonly generatedAt: string;
}): TimeReport => {
  const tasks = new Map(
    input.tasks
      .filter((task) => task.deletedAt == null)
      .map((task) => [task.id, task]),
  );
  const entries = input.entries
    .filter(
      (entry) =>
        entry.source !== "focus" &&
        entry.workDate >= input.from &&
        entry.workDate <= input.to &&
        tasks.has(entry.taskId),
    )
    .toSorted(compareTimeEntries);
  const sources = () => ({ focus: 0, import: 0, manual: 0 });
  const bySource = sources();
  const own = new Map<string, ReturnType<typeof sources>>();
  const byDay = new Map<string, Map<string, ReturnType<typeof sources>>>();
  for (const entry of entries) {
    bySource[entry.source] += entry.durationMs;
    const taskSources = own.get(entry.taskId) ?? sources();
    taskSources[entry.source] += entry.durationMs;
    own.set(entry.taskId, taskSources);
    const day = byDay.get(entry.workDate) ?? new Map<string, typeof bySource>();
    const daySources = day.get(entry.taskId) ?? sources();
    daySources[entry.source] += entry.durationMs;
    day.set(entry.taskId, daySources);
    byDay.set(entry.workDate, day);
  }
  const total = (value: ReturnType<typeof sources>) =>
    value.focus + value.import + value.manual;
  const ownMs = (taskId: string) => total(own.get(taskId) ?? sources());
  // Tasks with time, and their parents so child time can be shown.
  const listed = new Set(own.keys());
  for (const taskId of own.keys()) {
    const parentId = tasks.get(taskId)?.parentId;
    if (parentId != null && tasks.has(parentId)) listed.add(parentId);
  }
  const childrenOf = (taskId: string) =>
    [...tasks.values()].filter((task) => task.parentId === taskId);
  const reportTasks = [...listed]
    .flatMap((taskId) => {
      const task = tasks.get(taskId);
      if (task === undefined) return [];
      const children = childrenOf(taskId);
      const estimate = task.estimateMinutes ?? null;
      const childEstimates = children.flatMap((child) =>
        child.estimateMinutes == null ? [] : [child.estimateMinutes],
      );
      const childrenMs = children.reduce(
        (sum, child) => sum + ownMs(child.id),
        0,
      );
      return [
        {
          taskId,
          title: task.title,
          parentId: task.parentId ?? null,
          projectId: task.projectId ?? null,
          status: task.status,
          archived: task.archivedAt != null,
          estimateMinutes: estimate,
          rollupEstimateMinutes:
            children.length === 0 ||
            (estimate === null && childEstimates.length === 0)
              ? estimate
              : (estimate ?? 0) +
                childEstimates.reduce((sum, value) => sum + value, 0),
          ownMs: ownMs(taskId),
          childrenMs,
          allTimeMs: ownMs(taskId) + childrenMs,
          bySource: own.get(taskId) ?? sources(),
        },
      ];
    })
    .toSorted(
      (left, right) =>
        right.ownMs + right.childrenMs - (left.ownMs + left.childrenMs) ||
        left.title.localeCompare(right.title) ||
        left.taskId.localeCompare(right.taskId),
    );
  const projectTime = new Map<string, number>();
  const projectEstimate = new Map<string, number>();
  for (const task of reportTasks) {
    if (task.ownMs === 0) continue;
    const key = task.projectId ?? "";
    projectTime.set(key, (projectTime.get(key) ?? 0) + task.ownMs);
    if (task.estimateMinutes !== null)
      projectEstimate.set(
        key,
        (projectEstimate.get(key) ?? 0) + task.estimateMinutes,
      );
  }
  const projectTitles = new Map(
    input.projects.map((project) => [project.id, project.title]),
  );
  const days = [...byDay.entries()]
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([date, perTask]) => {
      const dayTasks = [...perTask.entries()]
        .map(([taskId, value]) => ({
          taskId,
          totalMs: total(value),
          bySource: value,
        }))
        .toSorted(
          (left, right) =>
            right.totalMs - left.totalMs ||
            left.taskId.localeCompare(right.taskId),
        );
      return {
        date,
        totalMs: dayTasks.reduce((sum, task) => sum + task.totalMs, 0),
        workStart: null,
        workEnd: null,
        breakCount: null,
        breakMs: null,
        tasks: dayTasks,
      };
    });
  const weeks = new Map<string, { totalMs: number; daysWorked: number }>();
  for (const day of days) {
    const week = weekStartOf(day.date);
    const current = weeks.get(week) ?? { totalMs: 0, daysWorked: 0 };
    weeks.set(week, {
      totalMs: current.totalMs + day.totalMs,
      daysWorked: current.daysWorked + (day.totalMs > 0 ? 1 : 0),
    });
  }
  return {
    from: input.from,
    to: input.to,
    timeZone: input.timeZone,
    generatedAt: input.generatedAt,
    totalMs: total(bySource),
    bySource,
    days,
    weeks: [...weeks.entries()]
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([weekStart, week]) => ({ weekStart, ...week })),
    tasks: reportTasks,
    projects: [...projectTime.entries()]
      .map(([key, totalMs]) => ({
        projectId: key === "" ? null : key,
        title: key === "" ? "No project" : (projectTitles.get(key) ?? key),
        totalMs,
        estimateMinutes: projectEstimate.get(key) ?? null,
      }))
      .toSorted(
        (left, right) =>
          right.totalMs - left.totalMs || left.title.localeCompare(right.title),
      ),
    entries,
  };
};
