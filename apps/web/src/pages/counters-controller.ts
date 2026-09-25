import {
  ApiRequestError,
  type Counter,
  type CounterCreateRequest,
  type CounterDayWriteRequest,
  type CounterHistory,
  type CounterMutationResponse,
  type CounterPatchRequest,
  type DailyEvaluation,
  type EvaluationList,
  type EvaluationMutationResponse,
  type EvaluationWriteRequest,
} from "@suite/contracts";
import {
  addCalendarDays,
  formatClockDuration,
  weekStartOf,
} from "@suite/domain";

/** Counters and evaluations go straight to the server (ADR 0025). */
export interface CountersApi {
  readonly getCounterHistory: (
    from: string,
    to: string,
  ) => Promise<CounterHistory>;
  readonly createCounter: (
    counter: CounterCreateRequest,
    csrfToken: string,
  ) => Promise<CounterMutationResponse>;
  readonly updateCounter: (
    id: string,
    revision: number,
    patch: CounterPatchRequest,
    csrfToken: string,
  ) => Promise<CounterMutationResponse>;
  readonly deleteCounter: (
    id: string,
    revision: number,
    csrfToken: string,
  ) => Promise<CounterMutationResponse>;
  readonly recordCounterDay: (
    id: string,
    day: string,
    write: CounterDayWriteRequest,
    csrfToken: string,
  ) => Promise<CounterMutationResponse>;
  readonly controlCounterStopwatch: (
    id: string,
    revision: number,
    action: "start" | "stop",
    csrfToken: string,
  ) => Promise<CounterMutationResponse>;
  readonly getEvaluations: (
    from: string,
    to: string,
  ) => Promise<EvaluationList>;
  readonly saveEvaluation: (
    day: string,
    write: EvaluationWriteRequest,
    csrfToken: string,
  ) => Promise<EvaluationMutationResponse>;
}

export interface CountersState {
  /** Any date inside the shown Monday-to-Sunday week. */
  readonly anchor: string;
  readonly history: CounterHistory | null;
  readonly evaluations: EvaluationList | null;
  readonly error: string | null;
  readonly notice: string | null;
}

export const initialCounters = (anchor: string): CountersState => ({
  anchor,
  history: null,
  evaluations: null,
  error: null,
  notice: null,
});

export const weekRange = (
  anchor: string,
): { readonly from: string; readonly to: string } => {
  const from = weekStartOf(anchor);
  return { from, to: addCalendarDays(from, 6) };
};

export const weekDays = (anchor: string): string[] => {
  const { from } = weekRange(anchor);
  return [0, 1, 2, 3, 4, 5, 6].map((offset) => addCalendarDays(from, offset));
};

const failure = (error: unknown, fallback: string): string => {
  if (error instanceof ApiRequestError) {
    if (error.status === 412)
      return "This changed since the page loaded, for example on another device. It has been reloaded; check the value and try again.";
    if (error.status === 404)
      return "This counter no longer exists. The page has been reloaded.";
    return error.message;
  }
  return fallback;
};

export const loadCounters = async (
  api: CountersApi,
  anchor: string,
  notice: string | null = null,
): Promise<CountersState> => {
  const range = weekRange(anchor);
  try {
    const [history, evaluations] = await Promise.all([
      api.getCounterHistory(range.from, range.to),
      api.getEvaluations(range.from, range.to),
    ]);
    return { anchor, history, evaluations, error: null, notice };
  } catch (error) {
    return {
      ...initialCounters(anchor),
      error: failure(error, "Counters could not be loaded."),
    };
  }
};

/** A day's stored value and the revision a write must name (0 when empty). */
export const dayValue = (
  history: CounterHistory,
  counterId: string,
  day: string,
): { readonly value: number; readonly revision: number } => {
  const found = history.values.find(
    (value) => value.counterId === counterId && value.day === day,
  );
  return { value: found?.value ?? 0, revision: found?.revision ?? 0 };
};

/** Counts as numbers; stopwatch days as hours and minutes. */
export const formatCounterValue = (
  kind: Counter["kind"],
  value: number,
): string =>
  kind === "stopwatch"
    ? formatClockDuration(value)
    : value.toLocaleString("en-US");

/** The typed amount as a stored value: whole minutes for a stopwatch. */
export const parseCounterInput = (
  kind: Counter["kind"],
  text: string,
): number | null => {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const amount = Number(trimmed);
  const value = kind === "stopwatch" ? amount * 60_000 : amount;
  return Number.isSafeInteger(value) &&
    value <= (kind === "stopwatch" ? 90_000_000 : 1_000_000)
    ? value
    : null;
};

export const evaluationFor = (
  evaluations: EvaluationList | null,
  day: string,
): DailyEvaluation | undefined =>
  evaluations?.evaluations.find((evaluation) => evaluation.day === day);

const mutate = async (
  api: CountersApi,
  state: CountersState,
  action: () => Promise<unknown>,
  success: string,
  fallback: string,
): Promise<{ readonly state: CountersState; readonly saved: boolean }> => {
  try {
    await action();
    return {
      saved: true,
      state: await loadCounters(api, state.anchor, success),
    };
  } catch (error) {
    const message = failure(error, fallback);
    const reload =
      error instanceof ApiRequestError &&
      (error.status === 412 || error.status === 404);
    const next = reload ? await loadCounters(api, state.anchor) : state;
    return { saved: false, state: { ...next, notice: null, error: message } };
  }
};

/** Raises or lowers a day by one step: one count, or one minute for a stopwatch. */
export const stepCounter = (
  api: CountersApi,
  state: CountersState,
  counter: Counter,
  day: string,
  direction: 1 | -1,
  csrfToken: string,
) => {
  const history = state.history;
  const { revision } =
    history === null ? { revision: 0 } : dayValue(history, counter.id, day);
  return mutate(
    api,
    state,
    () =>
      api.recordCounterDay(
        counter.id,
        day,
        {
          action: "increment",
          delta: direction * (counter.kind === "stopwatch" ? 60_000 : 1),
          expectedRevision: revision,
        },
        csrfToken,
      ),
    `${counter.title} ${direction === 1 ? "increased" : "decreased"}.`,
    "The counter could not be changed.",
  );
};

export const setCounterDay = (
  api: CountersApi,
  state: CountersState,
  counter: Counter,
  day: string,
  value: number,
  csrfToken: string,
) => {
  const { revision } =
    state.history === null
      ? { revision: 0 }
      : dayValue(state.history, counter.id, day);
  return mutate(
    api,
    state,
    () =>
      api.recordCounterDay(
        counter.id,
        day,
        { action: "set", value, expectedRevision: revision },
        csrfToken,
      ),
    `${counter.title} on ${day} set to ${formatCounterValue(counter.kind, value)}.`,
    "The value could not be saved.",
  );
};

export const toggleStopwatch = (
  api: CountersApi,
  state: CountersState,
  counter: Counter,
  csrfToken: string,
) => {
  const action = counter.runningSince === null ? "start" : "stop";
  return mutate(
    api,
    state,
    () =>
      api.controlCounterStopwatch(
        counter.id,
        counter.revision,
        action,
        csrfToken,
      ),
    action === "start"
      ? `${counter.title} started.`
      : `${counter.title} stopped; the time was added to the days it ran.`,
    "The stopwatch could not be changed.",
  );
};

export const addCounter = (
  api: CountersApi,
  state: CountersState,
  counter: CounterCreateRequest,
  csrfToken: string,
) =>
  mutate(
    api,
    state,
    () => api.createCounter(counter, csrfToken),
    `${counter.title} added.`,
    "The counter could not be added.",
  );

export const editCounter = (
  api: CountersApi,
  state: CountersState,
  counter: Counter,
  patch: CounterPatchRequest,
  csrfToken: string,
) =>
  mutate(
    api,
    state,
    () => api.updateCounter(counter.id, counter.revision, patch, csrfToken),
    `${counter.title} updated.`,
    "The counter could not be updated.",
  );

export const removeCounter = (
  api: CountersApi,
  state: CountersState,
  counter: Counter,
  csrfToken: string,
) =>
  mutate(
    api,
    state,
    () => api.deleteCounter(counter.id, counter.revision, csrfToken),
    `${counter.title} and its recorded days were deleted.`,
    "The counter could not be deleted.",
  );

export const writeEvaluation = (
  api: CountersApi,
  state: CountersState,
  day: string,
  write: EvaluationWriteRequest,
  csrfToken: string,
) =>
  mutate(
    api,
    state,
    () => api.saveEvaluation(day, write, csrfToken),
    `Evaluation for ${day} saved.`,
    "The evaluation could not be saved.",
  );
