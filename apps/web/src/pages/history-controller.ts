import {
  ApiRequestError,
  type TaskArchiveMutationResponse,
  type TaskHistoryEntry,
  type TaskHistoryResponse,
} from "@suite/contracts";

/** History reads and restores go straight to the server (ADR 0022). */
export interface HistoryApi {
  readonly getTaskHistory: (input: {
    readonly query?: string;
    readonly cursor?: string | null;
  }) => Promise<TaskHistoryResponse>;
  readonly unarchiveTask: (
    taskId: string,
    revision: number,
    csrfToken: string,
  ) => Promise<TaskArchiveMutationResponse>;
}

export interface HistoryState {
  readonly query: string;
  readonly entries: readonly TaskHistoryEntry[];
  readonly total: number;
  readonly nextCursor: string | null;
  readonly error: string | null;
  readonly notice: string | null;
}

export const emptyHistory: HistoryState = {
  query: "",
  entries: [],
  total: 0,
  nextCursor: null,
  error: null,
  notice: null,
};

const failure = (error: unknown, fallback: string): string => {
  if (error instanceof ApiRequestError) {
    if (error.status === 412)
      return "This task changed since the list loaded. Search again, then retry.";
    if (error.status === 404)
      return "This task is no longer in History. Search again to refresh the list.";
    return error.message;
  }
  return fallback;
};

export const searchHistory = async (
  api: HistoryApi,
  query: string,
): Promise<HistoryState> => {
  try {
    const page = await api.getTaskHistory({ query });
    return {
      query,
      entries: page.entries,
      total: page.total,
      nextCursor: page.nextCursor,
      error: null,
      notice: null,
    };
  } catch (error) {
    return {
      ...emptyHistory,
      query,
      error: failure(error, "History could not be loaded."),
    };
  }
};

export const loadMoreHistory = async (
  api: HistoryApi,
  state: HistoryState,
): Promise<HistoryState> => {
  if (state.nextCursor === null) return state;
  try {
    const page = await api.getTaskHistory({
      query: state.query,
      cursor: state.nextCursor,
    });
    const known = new Set(state.entries.map(({ task }) => task.id));
    return {
      ...state,
      entries: [
        ...state.entries,
        ...page.entries.filter(({ task }) => !known.has(task.id)),
      ],
      total: page.total,
      nextCursor: page.nextCursor,
      error: null,
    };
  } catch (error) {
    return {
      ...state,
      error: failure(error, "More history could not be loaded."),
    };
  }
};

/** Restores a family; the entry leaves the list only after the server agrees. */
export const restoreFromHistory = async (
  api: HistoryApi,
  state: HistoryState,
  entry: TaskHistoryEntry,
  csrfToken: string,
): Promise<{ readonly state: HistoryState; readonly restored: boolean }> => {
  try {
    const result = await api.unarchiveTask(
      entry.task.id,
      entry.task.revision,
      csrfToken,
    );
    const children = result.archive.children.length;
    return {
      restored: true,
      state: {
        ...state,
        entries: state.entries.filter(({ task }) => task.id !== entry.task.id),
        total: Math.max(0, state.total - 1),
        error: null,
        notice: `Restored "${result.archive.task.title}"${
          children === 0
            ? ""
            : ` with ${String(children)} child task${children === 1 ? "" : "s"}`
        } to Tasks.`,
      },
    };
  } catch (error) {
    return {
      restored: false,
      state: {
        ...state,
        notice: null,
        error: failure(error, "The task could not be restored."),
      },
    };
  }
};
