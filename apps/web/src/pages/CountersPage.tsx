import { useEffect, useState, type SyntheticEvent } from "react";
import type {
  Counter,
  CounterHistory,
  CounterKind,
  EvaluationList,
} from "@suite/contracts";
import {
  addCalendarDays,
  formatClockDuration,
  zonedCalendarDate,
} from "@suite/domain";
import {
  controlCounterStopwatch,
  createCounter,
  deleteCounter,
  getCounterHistory,
  getEvaluations,
  recordCounterDay,
  saveEvaluation,
  updateCounter,
} from "../api.ts";
import { Alert, AlertDescription } from "../components/ui/alert.tsx";
import { Badge } from "../components/ui/badge.tsx";
import { Button } from "../components/ui/button.tsx";
import { Card, CardContent, CardHeader } from "../components/ui/card.tsx";
import { EmptyState } from "../components/ui/empty-state.tsx";
import { Input } from "../components/ui/input.tsx";
import {
  NativeSelect,
  NativeSelectOption,
} from "../components/ui/native-select.tsx";
import { PageHeader } from "../components/ui/page-header.tsx";
import { Textarea } from "../components/ui/textarea.tsx";
import {
  addCounter,
  dayValue,
  editCounter,
  evaluationFor,
  formatCounterValue,
  initialCounters,
  loadCounters,
  parseCounterInput,
  removeCounter,
  setCounterDay,
  stepCounter,
  toggleStopwatch,
  weekDays,
  weekRange,
  writeEvaluation,
  type CountersApi,
  type CountersState,
} from "./counters-controller.ts";

const defaultApi: CountersApi = {
  getCounterHistory,
  createCounter,
  updateCounter,
  deleteCounter,
  recordCounterDay,
  controlCounterStopwatch,
  getEvaluations,
  saveEvaluation,
};

const kindLabel: Readonly<Record<CounterKind, string>> = {
  click: "Click counter",
  stopwatch: "Stopwatch",
  repeated_countdown: "Repeated countdown",
};

const weekdayNames = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

const dayLabel = (date: string) =>
  new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${date}T00:00:00.000Z`));

const clockTime = (value: string, timeZone: string) =>
  new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone,
  }).format(new Date(value));

const text = (data: FormData, name: string): string => {
  const value = data.get(name);
  return typeof value === "string" ? value : "";
};

const unit = (kind: CounterKind) =>
  kind === "stopwatch" ? "minutes" : "count";

const streakText = (counter: Counter): string | null => {
  if (counter.currentStreak === null) return null;
  const minimum = formatCounterValue(counter.kind, counter.streak.minValue);
  return counter.streak.mode === "weekly_frequency"
    ? `Streak: ${String(counter.currentStreak)} qualifying day${counter.currentStreak === 1 ? "" : "s"} (at least ${minimum} on ${String(counter.streak.weeklyFrequency)} days a week)`
    : `Streak: ${String(counter.currentStreak)} day${counter.currentStreak === 1 ? "" : "s"} (at least ${minimum} on selected weekdays)`;
};

export interface CounterTodayProps {
  readonly history: CounterHistory;
  readonly online: boolean;
  readonly busy: boolean;
  readonly onStep: (counter: Counter, direction: 1 | -1) => void;
  readonly onSet: (counter: Counter, day: string, value: number) => void;
  readonly onToggle: (counter: Counter) => void;
  readonly onInvalid: (message: string) => void;
}

/** Today's controls for enabled counters that are not hidden. */
export const CounterToday = ({
  history,
  online,
  busy,
  onStep,
  onSet,
  onToggle,
  onInvalid,
}: CounterTodayProps) => {
  const shown = history.counters.filter(
    (counter) => counter.enabled && !counter.hidden,
  );
  if (shown.length === 0)
    return (
      <EmptyState
        title="No counters to record today."
        description="Add a counter below, or enable or show one you already have."
      />
    );
  const disabled = busy || !online;
  return (
    <ul className="counter-list" aria-label={`Counters on ${history.today}`}>
      {shown.map((counter) => {
        const { value } = dayValue(history, counter.id, history.today);
        const streak = streakText(counter);
        const submit = (event: SyntheticEvent<HTMLFormElement>) => {
          event.preventDefault();
          const typed = parseCounterInput(
            counter.kind,
            text(new FormData(event.currentTarget), "value"),
          );
          if (typed === null)
            onInvalid(
              counter.kind === "stopwatch"
                ? "Enter whole minutes, up to one day."
                : "Enter a whole number from 0 to 1,000,000.",
            );
          else onSet(counter, history.today, typed);
        };
        return (
          <li key={counter.id}>
            <Card>
              <CardContent className="counter-row">
                <div>
                  <h3>
                    {counter.icon === null ? "" : `${counter.icon} `}
                    {counter.title}
                  </h3>
                  <p aria-live="polite">
                    Today:{" "}
                    <strong>{formatCounterValue(counter.kind, value)}</strong>
                    {counter.runningSince !== null && (
                      <>
                        {" "}
                        <Badge variant="success">
                          Running since{" "}
                          {clockTime(counter.runningSince, history.timeZone)}
                        </Badge>
                      </>
                    )}
                  </p>
                  {streak !== null && <p className="hint">{streak}</p>}
                  {counter.countdownMs !== null && (
                    <p className="hint">
                      Countdown length{" "}
                      {formatClockDuration(counter.countdownMs)}; record each
                      completed countdown.
                    </p>
                  )}
                </div>
                <div className="counter-actions">
                  {counter.kind === "stopwatch" ? (
                    <Button
                      type="button"
                      disabled={disabled}
                      onClick={() => onToggle(counter)}
                    >
                      {counter.runningSince === null ? "Start" : "Stop"}{" "}
                      <span className="sr-only">{counter.title}</span>
                    </Button>
                  ) : (
                    <>
                      <Button
                        type="button"
                        variant="outline"
                        aria-label={`Decrease ${counter.title}`}
                        disabled={disabled || value === 0}
                        onClick={() => onStep(counter, -1)}
                      >
                        −
                      </Button>
                      <Button
                        type="button"
                        aria-label={`Increase ${counter.title}`}
                        disabled={disabled}
                        onClick={() => onStep(counter, 1)}
                      >
                        +
                      </Button>
                    </>
                  )}
                  <form
                    className="counter-set"
                    aria-label={`Set today's value for ${counter.title}`}
                    onSubmit={submit}
                  >
                    <label className="field">
                      Today ({unit(counter.kind)})
                      <Input
                        name="value"
                        inputMode="numeric"
                        disabled={disabled}
                        defaultValue=""
                      />
                    </label>
                    <Button type="submit" variant="outline" disabled={disabled}>
                      Set
                    </Button>
                  </form>
                </div>
              </CardContent>
            </Card>
          </li>
        );
      })}
    </ul>
  );
};

export interface CounterWeekProps {
  readonly history: CounterHistory;
  readonly evaluations: EvaluationList | null;
  readonly anchor: string;
}

/** Monday-to-Sunday grid of day values, with streaks and evaluation scores. */
export const CounterWeek = ({
  history,
  evaluations,
  anchor,
}: CounterWeekProps) => {
  const days = weekDays(anchor);
  const counters = history.counters;
  if (counters.length === 0 && (evaluations?.evaluations.length ?? 0) === 0)
    return (
      <p className="hint">No counters or evaluations recorded this week.</p>
    );
  const maxima = new Map(
    counters.map((counter) => [
      counter.id,
      Math.max(
        1,
        ...days.map((day) => dayValue(history, counter.id, day).value),
      ),
    ]),
  );
  return (
    <table className="counter-week">
      <caption className="sr-only">
        Counter values from {days[0]} to {days[6]}
      </caption>
      <thead>
        <tr>
          <th scope="col">Counter</th>
          {days.map((day) => (
            <th scope="col" key={day}>
              {dayLabel(day)}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {counters.map((counter) => (
          <tr key={counter.id}>
            <th scope="row">
              {counter.title}
              {!counter.enabled && (
                <>
                  {" "}
                  <Badge variant="secondary">Disabled</Badge>
                </>
              )}
            </th>
            {days.map((day) => {
              const { value } = dayValue(history, counter.id, day);
              const share = value / (maxima.get(counter.id) ?? 1);
              return (
                <td key={day}>
                  <span
                    className="counter-bar"
                    aria-hidden="true"
                    style={{
                      inlineSize: `${String(Math.round(share * 100))}%`,
                    }}
                  />
                  {value === 0 ? "–" : formatCounterValue(counter.kind, value)}
                </td>
              );
            })}
          </tr>
        ))}
        <tr>
          <th scope="row">Impact / energy</th>
          {days.map((day) => {
            const evaluation = evaluationFor(evaluations, day);
            return (
              <td key={day}>
                {evaluation === undefined
                  ? "–"
                  : `${evaluation.impact === null ? "–" : `${String(evaluation.impact)}/4`} · ${evaluation.energy === null ? "–" : `${String(evaluation.energy)}/3`}`}
              </td>
            );
          })}
        </tr>
        <tr>
          <th scope="row">Focus in Tadooer</th>
          {days.map((day) => {
            const focus = evaluations?.focus.find((item) => item.day === day);
            return (
              <td key={day}>
                {focus === undefined ? "–" : formatClockDuration(focus.ms)}
              </td>
            );
          })}
        </tr>
      </tbody>
    </table>
  );
};

export interface CountersPageProps {
  readonly csrfToken: string;
  readonly online: boolean;
  readonly timeZone?: string;
  readonly api?: CountersApi;
  readonly initialState?: CountersState;
  readonly newId?: () => string;
}

export const CountersPage = ({
  csrfToken,
  online,
  timeZone = "UTC",
  api = defaultApi,
  initialState,
  newId = () => crypto.randomUUID(),
}: CountersPageProps) => {
  const today = zonedCalendarDate(new Date(), timeZone);
  const [state, setState] = useState<CountersState>(
    initialState ?? initialCounters(today),
  );
  const [busy, setBusy] = useState(false);
  const [kind, setKind] = useState<CounterKind>("click");
  const [editing, setEditing] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [evaluationDay, setEvaluationDay] = useState(
    state.history?.today ?? today,
  );
  const run = async (
    next: () => Promise<{ readonly state: CountersState } | CountersState>,
  ) => {
    setBusy(true);
    try {
      const result = await next();
      setState("state" in result ? result.state : result);
    } finally {
      setBusy(false);
    }
  };
  const load = (anchor: string) => void run(() => loadCounters(api, anchor));
  useEffect(() => {
    if (!online || initialState !== undefined) return;
    load(state.anchor);
    // Load once per connection; later loads are explicit.
  }, [online]);
  const invalid = (message: string) =>
    setState({ ...state, notice: null, error: message });
  const disabled = busy || !online;
  const range = weekRange(state.anchor);
  const days = weekDays(state.anchor);
  const history = state.history;
  // The evaluation form edits a day of the shown week.
  const shownDay = days.includes(evaluationDay)
    ? evaluationDay
    : days.includes(today)
      ? today
      : (days[0] ?? today);
  const evaluation = evaluationFor(state.evaluations, shownDay);
  const focus = state.evaluations?.focus.find((item) => item.day === shownDay);

  const create = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const title = text(data, "title").trim();
    const minimum = parseCounterInput(kind, text(data, "streakMin") || "1");
    const countdown = parseCounterInput("stopwatch", text(data, "countdown"));
    const weekdays = [0, 1, 2, 3, 4, 5, 6].filter(
      (weekday) => data.get(`weekday-${String(weekday)}`) === "on",
    );
    const frequency = Number(text(data, "frequency") || "3");
    if (
      title === "" ||
      minimum === null ||
      minimum === 0 ||
      (kind === "repeated_countdown" && (countdown === null || countdown === 0))
    ) {
      invalid(
        "Give the counter a title, a streak minimum above zero and, for a countdown, a length in minutes.",
      );
      return;
    }
    void run(async () => {
      const result = await addCounter(
        api,
        state,
        {
          id: newId(),
          title,
          kind,
          streak: {
            enabled: data.get("streak") === "on",
            minValue: minimum,
            mode:
              text(data, "mode") === "weekly_frequency"
                ? "weekly_frequency"
                : "weekdays",
            weekdays,
            weeklyFrequency: Math.min(7, Math.max(1, frequency)),
          },
          countdownMs: kind === "repeated_countdown" ? countdown : null,
        },
        csrfToken,
      );
      if (result.saved) form.reset();
      return result;
    });
  };

  const recordPast = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (history === null) return;
    const data = new FormData(event.currentTarget);
    const counter = history.counters.find(
      ({ id }) => id === text(data, "counter"),
    );
    const day = text(data, "day");
    if (counter === undefined) {
      invalid("Choose a counter.");
      return;
    }
    const value = parseCounterInput(counter.kind, text(data, "value"));
    if (value === null) {
      invalid(
        counter.kind === "stopwatch"
          ? "Enter whole minutes, up to one day."
          : "Enter a whole number from 0 to 1,000,000.",
      );
      return;
    }
    void run(() => setCounterDay(api, state, counter, day, value, csrfToken));
  };

  const saveDay = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const scale = (name: string) => {
      const value = text(data, name);
      return value === "" ? null : Number(value);
    };
    void run(() =>
      writeEvaluation(
        api,
        state,
        shownDay,
        {
          expectedRevision: evaluation?.revision ?? 0,
          impact: scale("impact"),
          energy: scale("energy"),
          reflection: text(data, "reflection").trim(),
          notes: text(data, "notes").trim(),
          remindTomorrow: data.get("remindTomorrow") === "on",
        },
        csrfToken,
      ),
    );
  };

  return (
    <section
      className="mx-auto flex w-full max-w-5xl flex-col gap-6"
      aria-labelledby="counters-heading"
    >
      <PageHeader
        id="counters-heading"
        title="Counters"
        description="Daily counts, stopwatch time and a short evaluation of each day. Days follow your planning time zone; streaks are worked out from the recorded days."
      />
      {!online && (
        <Alert variant="warning" role="status">
          <AlertDescription>
            Counters need a connection. Their values are not kept offline.
          </AlertDescription>
        </Alert>
      )}
      {state.error !== null && (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      )}
      {state.notice !== null && (
        <Alert variant="info" role="status">
          <AlertDescription>{state.notice}</AlertDescription>
        </Alert>
      )}
      <section aria-labelledby="counters-today">
        <h2 id="counters-today">Today</h2>
        {history !== null && (
          <CounterToday
            history={history}
            online={online}
            busy={busy}
            onInvalid={invalid}
            onStep={(counter, direction) =>
              void run(() =>
                stepCounter(
                  api,
                  state,
                  counter,
                  history.today,
                  direction,
                  csrfToken,
                ),
              )
            }
            onSet={(counter, day, value) =>
              void run(() =>
                setCounterDay(api, state, counter, day, value, csrfToken),
              )
            }
            onToggle={(counter) =>
              void run(() => toggleStopwatch(api, state, counter, csrfToken))
            }
          />
        )}
      </section>
      <Card>
        <CardHeader>
          <h2 id="counters-week">Week</h2>
          <div className="worklog-controls">
            <Button
              type="button"
              variant="outline"
              disabled={disabled}
              onClick={() => load(addCalendarDays(range.from, -7))}
            >
              Previous week
            </Button>
            <span>
              {range.from} to {range.to}
            </span>
            <Button
              type="button"
              variant="outline"
              disabled={disabled}
              onClick={() => load(addCalendarDays(range.from, 7))}
            >
              Next week
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {history !== null && (
            <CounterWeek
              history={history}
              evaluations={state.evaluations}
              anchor={state.anchor}
            />
          )}
          {history !== null && history.counters.length > 0 && (
            <form
              className="worklog-add"
              aria-label="Correct a day"
              onSubmit={recordPast}
            >
              <label className="field">
                Counter
                <NativeSelect name="counter" disabled={disabled}>
                  {history.counters.map((counter) => (
                    <NativeSelectOption key={counter.id} value={counter.id}>
                      {counter.title}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </label>
              <label className="field">
                Day
                <NativeSelect name="day" disabled={disabled}>
                  {days.map((day) => (
                    <NativeSelectOption key={day} value={day}>
                      {dayLabel(day)}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </label>
              <label className="field">
                Value (count, or minutes for a stopwatch)
                <Input name="value" inputMode="numeric" disabled={disabled} />
              </label>
              <Button type="submit" variant="outline" disabled={disabled}>
                Save day
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <h2 id="counters-evaluation">Daily evaluation</h2>
        </CardHeader>
        <CardContent>
          <label className="field">
            Day
            <NativeSelect
              value={shownDay}
              disabled={disabled}
              onChange={(event) => setEvaluationDay(event.target.value)}
            >
              {days.map((day) => (
                <NativeSelectOption key={day} value={day}>
                  {dayLabel(day)}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </label>
          <form
            key={`${shownDay}:${String(evaluation?.revision ?? 0)}`}
            className="counter-evaluation"
            aria-label={`Evaluation for ${shownDay}`}
            onSubmit={saveDay}
          >
            <fieldset disabled={disabled}>
              <legend>Impact of the day&apos;s work</legend>
              {[1, 2, 3, 4].map((value) => (
                <label key={value} className="counter-choice">
                  <input
                    type="radio"
                    name="impact"
                    value={value}
                    defaultChecked={evaluation?.impact === value}
                  />
                  {value}
                </label>
              ))}
              <label className="counter-choice">
                <input
                  type="radio"
                  name="impact"
                  value=""
                  defaultChecked={(evaluation?.impact ?? null) === null}
                />
                Not rated
              </label>
            </fieldset>
            <fieldset disabled={disabled}>
              <legend>Energy</legend>
              {(
                [
                  [1, "Exhausted"],
                  [2, "OK"],
                  [3, "Good"],
                ] as const
              ).map(([value, label]) => (
                <label key={value} className="counter-choice">
                  <input
                    type="radio"
                    name="energy"
                    value={value}
                    defaultChecked={evaluation?.energy === value}
                  />
                  {label}
                </label>
              ))}
              <label className="counter-choice">
                <input
                  type="radio"
                  name="energy"
                  value=""
                  defaultChecked={(evaluation?.energy ?? null) === null}
                />
                Not rated
              </label>
            </fieldset>
            <label className="field">
              Reflection
              <Textarea
                name="reflection"
                maxLength={5000}
                disabled={disabled}
                defaultValue={evaluation?.reflection ?? ""}
              />
            </label>
            <label className="field">
              Notes
              <Textarea
                name="notes"
                maxLength={5000}
                disabled={disabled}
                defaultValue={evaluation?.notes ?? ""}
              />
            </label>
            <label className="counter-choice">
              <input
                type="checkbox"
                name="remindTomorrow"
                disabled={disabled}
                defaultChecked={evaluation?.remindTomorrow ?? false}
              />
              Remind me of this tomorrow
            </label>
            <p className="hint">
              Focus in Tadooer this day:{" "}
              {focus === undefined
                ? "none"
                : `${formatClockDuration(focus.ms)} in ${String(focus.intervals)} interval${focus.intervals === 1 ? "" : "s"}`}
              .
              {evaluation !== undefined &&
                evaluation.importedFocusSessionsMs.length > 0 &&
                ` Imported Super Productivity focus sessions: ${evaluation.importedFocusSessionsMs.map(formatClockDuration).join(", ")} (history only, not in the worklog).`}
            </p>
            <Button type="submit" disabled={disabled}>
              Save evaluation
            </Button>
          </form>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <h2 id="counters-manage">Manage counters</h2>
        </CardHeader>
        <CardContent>
          {history !== null && history.counters.length > 0 && (
            <ul className="counter-list" aria-label="Your counters">
              {history.counters.map((counter) => (
                <li key={counter.id} className="worklog-entry">
                  <span>
                    <strong>{counter.title}</strong>{" "}
                    <Badge variant="secondary">{kindLabel[counter.kind]}</Badge>
                    {counter.hidden && (
                      <>
                        {" "}
                        <Badge variant="secondary">Hidden</Badge>
                      </>
                    )}
                    {!counter.enabled && (
                      <>
                        {" "}
                        <Badge variant="secondary">Disabled</Badge>
                      </>
                    )}
                    {counter.provenance !== null && (
                      <>
                        {" "}
                        <Badge variant="secondary">Imported</Badge>
                      </>
                    )}
                  </span>
                  {editing === counter.id ? (
                    <form
                      className="worklog-edit"
                      aria-label={`Edit ${counter.title}`}
                      onSubmit={(event) => {
                        event.preventDefault();
                        const data = new FormData(event.currentTarget);
                        const title = text(data, "title").trim();
                        if (title === "") {
                          invalid("A counter needs a title.");
                          return;
                        }
                        void run(async () => {
                          const result = await editCounter(
                            api,
                            state,
                            counter,
                            {
                              title,
                              enabled: data.get("enabled") === "on",
                              hidden: data.get("hidden") === "on",
                              streak: {
                                ...counter.streak,
                                enabled: data.get("streak") === "on",
                              },
                            },
                            csrfToken,
                          );
                          if (result.saved) setEditing(null);
                          return result;
                        });
                      }}
                    >
                      <label className="field">
                        Title
                        <Input
                          name="title"
                          maxLength={200}
                          defaultValue={counter.title}
                        />
                      </label>
                      <label className="counter-choice">
                        <input
                          type="checkbox"
                          name="enabled"
                          defaultChecked={counter.enabled}
                        />
                        Enabled
                      </label>
                      <label className="counter-choice">
                        <input
                          type="checkbox"
                          name="hidden"
                          defaultChecked={counter.hidden}
                        />
                        Hide from today
                      </label>
                      <label className="counter-choice">
                        <input
                          type="checkbox"
                          name="streak"
                          defaultChecked={counter.streak.enabled}
                        />
                        Track streak
                      </label>
                      <Button type="submit" disabled={disabled}>
                        Save
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        onClick={() => setEditing(null)}
                      >
                        Cancel
                      </Button>
                    </form>
                  ) : (
                    <span className="worklog-actions">
                      <Button
                        type="button"
                        variant="ghost"
                        disabled={disabled}
                        onClick={() => setEditing(counter.id)}
                      >
                        Edit <span className="sr-only">{counter.title}</span>
                      </Button>
                      {confirmDelete === counter.id ? (
                        <Button
                          type="button"
                          variant="destructive"
                          disabled={disabled}
                          onClick={() => {
                            setConfirmDelete(null);
                            void run(() =>
                              removeCounter(api, state, counter, csrfToken),
                            );
                          }}
                        >
                          Delete {counter.title} and its history
                        </Button>
                      ) : (
                        <Button
                          type="button"
                          variant="ghost"
                          disabled={disabled}
                          onClick={() => setConfirmDelete(counter.id)}
                        >
                          Delete{" "}
                          <span className="sr-only">{counter.title}</span>
                        </Button>
                      )}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
          <form
            className="counter-create"
            aria-label="Add a counter"
            onSubmit={create}
          >
            <label className="field">
              Title
              <Input name="title" maxLength={200} disabled={disabled} />
            </label>
            <label className="field">
              Kind
              <NativeSelect
                name="kind"
                value={kind}
                disabled={disabled}
                onChange={(event) =>
                  setKind(
                    event.target.value === "stopwatch"
                      ? "stopwatch"
                      : event.target.value === "repeated_countdown"
                        ? "repeated_countdown"
                        : "click",
                  )
                }
              >
                <NativeSelectOption value="click">
                  {kindLabel.click}
                </NativeSelectOption>
                <NativeSelectOption value="stopwatch">
                  {kindLabel.stopwatch}
                </NativeSelectOption>
                <NativeSelectOption value="repeated_countdown">
                  {kindLabel.repeated_countdown}
                </NativeSelectOption>
              </NativeSelect>
            </label>
            {kind === "repeated_countdown" && (
              <label className="field">
                Countdown length (minutes)
                <Input
                  name="countdown"
                  inputMode="numeric"
                  defaultValue="30"
                  disabled={disabled}
                />
              </label>
            )}
            <fieldset disabled={disabled}>
              <legend>Streak</legend>
              <label className="counter-choice">
                <input type="checkbox" name="streak" />
                Track a streak
              </label>
              <label className="field">
                Minimum per day ({unit(kind)})
                <Input name="streakMin" inputMode="numeric" defaultValue="1" />
              </label>
              <label className="field">
                Rule
                <NativeSelect name="mode" defaultValue="weekdays">
                  <NativeSelectOption value="weekdays">
                    Every selected weekday
                  </NativeSelectOption>
                  <NativeSelectOption value="weekly_frequency">
                    A number of days each week
                  </NativeSelectOption>
                </NativeSelect>
              </label>
              <div role="group" aria-label="Weekdays">
                {weekdayNames.map((name, weekday) => (
                  <label key={name} className="counter-choice">
                    <input
                      type="checkbox"
                      name={`weekday-${String(weekday)}`}
                      defaultChecked={weekday >= 1 && weekday <= 5}
                    />
                    {name.slice(0, 3)}
                  </label>
                ))}
              </div>
              <label className="field">
                Days each week
                <Input
                  name="frequency"
                  type="number"
                  min={1}
                  max={7}
                  defaultValue="3"
                />
              </label>
            </fieldset>
            <Button type="submit" disabled={disabled}>
              Add counter
            </Button>
          </form>
        </CardContent>
      </Card>
    </section>
  );
};
