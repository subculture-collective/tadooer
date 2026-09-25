import {
  ApiRequestError,
  type TimeEntry,
  type TimeEntryCreateRequest,
  type TimeEntryMutationResponse,
  type TimeEntryPatchRequest,
  type TimeReport,
} from "@suite/contracts";
import {
  addCalendarDays,
  weekStartOf,
  type TimeEntrySource,
  type WorklogCsvRow,
} from "@suite/domain";

/** Worklog reads and corrections go straight to the server (ADR 0024). */
export interface WorklogApi {
  readonly getTimeReport: (from: string, to: string) => Promise<TimeReport>;
  readonly createTimeEntry: (
    entry: TimeEntryCreateRequest,
    csrfToken: string,
  ) => Promise<TimeEntryMutationResponse>;
  readonly updateTimeEntry: (
    id: string,
    revision: number,
    patch: TimeEntryPatchRequest,
    csrfToken: string,
  ) => Promise<TimeEntryMutationResponse>;
  readonly deleteTimeEntry: (
    id: string,
    revision: number,
    csrfToken: string,
  ) => Promise<TimeEntryMutationResponse>;
}

export type WorklogPeriod = "week" | "month";

export interface WorklogState {
  readonly period: WorklogPeriod;
  /** Any date inside the shown period. */
  readonly anchor: string;
  readonly report: TimeReport | null;
  readonly error: string | null;
  readonly notice: string | null;
}

export const initialWorklog = (
  anchor: string,
  period: WorklogPeriod = "week",
): WorklogState => ({
  period,
  anchor,
  report: null,
  error: null,
  notice: null,
});

/** Monday-to-Sunday week, or the calendar month, containing the anchor. */
export const periodRange = (
  anchor: string,
  period: WorklogPeriod,
): { readonly from: string; readonly to: string } => {
  if (period === "week") {
    const from = weekStartOf(anchor);
    return { from, to: addCalendarDays(from, 6) };
  }
  const from = `${anchor.slice(0, 7)}-01`;
  const nextMonth = addCalendarDays(from, 32).slice(0, 7);
  return { from, to: addCalendarDays(`${nextMonth}-01`, -1) };
};

export const shiftPeriod = (
  anchor: string,
  period: WorklogPeriod,
  direction: 1 | -1,
): string => {
  const { from, to } = periodRange(anchor, period);
  return direction === 1 ? addCalendarDays(to, 1) : addCalendarDays(from, -1);
};

const failure = (error: unknown, fallback: string): string => {
  if (error instanceof ApiRequestError) {
    if (error.status === 412)
      return "This entry changed since the worklog loaded. It has been reloaded; check it and try again.";
    if (error.status === 404)
      return "This entry no longer exists. The worklog has been reloaded.";
    return error.message;
  }
  return fallback;
};

export const loadWorklog = async (
  api: WorklogApi,
  period: WorklogPeriod,
  anchor: string,
  notice: string | null = null,
): Promise<WorklogState> => {
  const range = periodRange(anchor, period);
  try {
    return {
      period,
      anchor,
      report: await api.getTimeReport(range.from, range.to),
      error: null,
      notice,
    };
  } catch (error) {
    return {
      period,
      anchor,
      report: null,
      error: failure(error, "The worklog could not be loaded."),
      notice: null,
    };
  }
};

/** Whole minutes typed by the owner; negative minutes are a correction. */
export const minutesToMilliseconds = (value: string): number | null => {
  const minutes = Number(value.trim());
  if (value.trim() === "" || !Number.isFinite(minutes)) return null;
  const milliseconds = Math.round(minutes * 60_000);
  return milliseconds === 0 || Math.abs(milliseconds) > 86_400_000
    ? null
    : milliseconds;
};

const mutate = async (
  api: WorklogApi,
  state: WorklogState,
  action: () => Promise<TimeEntryMutationResponse>,
  success: string,
  fallback: string,
): Promise<{ readonly state: WorklogState; readonly saved: boolean }> => {
  try {
    await action();
    return {
      saved: true,
      state: await loadWorklog(api, state.period, state.anchor, success),
    };
  } catch (error) {
    const message = failure(error, fallback);
    const reload =
      error instanceof ApiRequestError &&
      (error.status === 412 || error.status === 404);
    const next = reload
      ? await loadWorklog(api, state.period, state.anchor)
      : state;
    return { saved: false, state: { ...next, notice: null, error: message } };
  }
};

export const addTimeEntry = (
  api: WorklogApi,
  state: WorklogState,
  entry: TimeEntryCreateRequest,
  csrfToken: string,
) =>
  mutate(
    api,
    state,
    () => api.createTimeEntry(entry, csrfToken),
    entry.durationMs < 0 ? "Correction recorded." : "Time added.",
    "The time could not be recorded.",
  );

export const editTimeEntry = (
  api: WorklogApi,
  state: WorklogState,
  entry: TimeEntry,
  patch: TimeEntryPatchRequest,
  csrfToken: string,
) =>
  mutate(
    api,
    state,
    () => api.updateTimeEntry(entry.id, entry.revision ?? 0, patch, csrfToken),
    "Entry updated.",
    "The entry could not be updated.",
  );

export const removeTimeEntry = (
  api: WorklogApi,
  state: WorklogState,
  entry: TimeEntry,
  csrfToken: string,
) =>
  mutate(
    api,
    state,
    () => api.deleteTimeEntry(entry.id, entry.revision ?? 0, csrfToken),
    "Entry deleted.",
    "The entry could not be deleted.",
  );

/** Focus entries belong to their session; archived history is read-only. */
export const canEditEntry = (report: TimeReport, entry: TimeEntry): boolean =>
  entry.source !== "focus" &&
  entry.revision !== null &&
  report.tasks.find(({ taskId }) => taskId === entry.taskId)?.archived !== true;

/** One CSV row per task and day, in date then time order. */
export const worklogRows = (
  report: TimeReport,
  projects: readonly { readonly id: string; readonly title: string }[] = [],
): WorklogCsvRow[] => {
  const tasks = new Map(report.tasks.map((task) => [task.taskId, task]));
  const projectTitle = (id: string | null) =>
    id === null
      ? ""
      : (report.projects.find(({ projectId }) => projectId === id)?.title ??
        projects.find((project) => project.id === id)?.title ??
        "");
  return report.days.flatMap((day) =>
    day.tasks.map((row) => {
      const task = tasks.get(row.taskId);
      const parent =
        task?.parentId == null ? undefined : tasks.get(task.parentId);
      return {
        date: day.date,
        task: task?.title ?? row.taskId,
        parentTask: parent?.title ?? "",
        project: projectTitle(task?.projectId ?? null),
        durationMs: row.totalMs,
        estimateMinutes: task?.estimateMinutes ?? null,
        sources: (["focus", "import", "manual"] as const).filter(
          (source): source is TimeEntrySource => row.bySource[source] !== 0,
        ),
      };
    }),
  );
};

export const worklogFileName = (report: TimeReport): string =>
  `worklog-${report.from}-to-${report.to}.csv`;
