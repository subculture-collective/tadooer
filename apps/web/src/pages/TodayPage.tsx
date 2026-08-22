import { useEffect, useState, type SyntheticEvent } from "react";
import type {
  ActiveSession,
  BaikalStatusResponse,
  DayPlanResponse,
  PlanningPreferences,
  PlannerResponse,
  Task,
} from "@suite/contracts";
import { FocusPanel, type FocusPanelCommand } from "../focus-panel.tsx";
import { TodayQueue } from "../today-queue.tsx";
import { TaskCaptureForm } from "../components/tasks/TaskCaptureForm.tsx";

export interface TodayPageProps {
  readonly dayPlan: DayPlanResponse | undefined;
  readonly planningPreferences: PlanningPreferences | undefined;
  readonly tasks: readonly Task[];
  readonly activeSession: ActiveSession | null;
  readonly clientId: string | null;
  readonly syncStatus: "online" | "offline" | "syncing" | undefined;
  readonly planner: PlannerResponse | null;
  readonly baikalCalendars: BaikalStatusResponse["calendars"];
  readonly calendarActionsAvailable: boolean;
  readonly focusActionsAvailable: boolean;
  readonly busy: boolean;
  readonly onFocusCommand: (command: FocusPanelCommand) => void;
  readonly onSubmitTask: (
    event: SyntheticEvent<HTMLFormElement, SubmitEvent>,
  ) => Promise<void>;
  readonly onChangeTaskStatus: (
    task: Task,
    action: "complete" | "reopen",
  ) => Promise<boolean>;
  readonly onSubmitTimeBlock: (
    event: SyntheticEvent<HTMLFormElement, SubmitEvent>,
    task: Task,
  ) => Promise<void>;
  readonly onRemoveTimeBlock: (task: Task) => Promise<void>;
  readonly onViewTasks: () => void;
}
const calmStateLabel: Readonly<Record<DayPlanResponse["state"], string>> = {
  working: "Working",
  scheduled_break: "Scheduled break",
  unavailable: "Unavailable right now",
  finished_for_today: "Finished for today",
};

export const updateHiddenCalendarIds = (
  current: readonly string[],
  calendarId: string,
  checked: boolean,
): readonly string[] =>
  checked
    ? current.filter((id) => id !== calendarId)
    : current.includes(calendarId)
      ? current
      : [...current, calendarId];

export const TodayPage = (props: TodayPageProps) => {
  const {
    dayPlan,
    planningPreferences,
    tasks,
    activeSession,
    clientId,
    syncStatus,
    planner,
    baikalCalendars,
    calendarActionsAvailable,
    focusActionsAvailable,
    busy,
    onFocusCommand,
    onSubmitTask,
    onChangeTaskStatus,
    onSubmitTimeBlock,
    onRemoveTimeBlock,
    onViewTasks,
  } = props;
  const [logicalAt, setLogicalAt] = useState(
    dayPlan?.at ?? new Date().toISOString(),
  );
  const [hiddenCalendarIds, setHiddenCalendarIds] = useState<readonly string[]>(
    [],
  );
  useEffect(() => {
    if (dayPlan?.at !== undefined) setLogicalAt(dayPlan.at);
  }, [dayPlan?.at]);
  useEffect(() => {
    const timer = window.setInterval(
      () => setLogicalAt(new Date().toISOString()),
      60_000,
    );
    return () => window.clearInterval(timer);
  }, []);
  const preferences = planningPreferences ?? dayPlan?.preferences;
  return (
    <div className="today-page">
      <header className="today-header">
        <p className="step">Calm daily workspace</p>
        <h1>Today</h1>
        <p>
          {dayPlan === undefined
            ? "Choose the next useful task from your local workspace."
            : calmStateLabel[dayPlan.state]}
        </p>
        {dayPlan?.nextTask === null ? (
          <p className="hint">No scheduled task is ready next.</p>
        ) : dayPlan?.nextTask !== undefined ? (
          <p className="hint">Next: {dayPlan.nextTask.title}</p>
        ) : null}
      </header>
      <p className="today-capabilities" aria-live="polite">
        {syncStatus === "offline"
          ? "Offline. Tasks can be captured, completed, and reopened."
          : syncStatus === "syncing"
            ? "Syncing local tasks."
            : "Task sync is available."}
      </p>
      <TaskCaptureForm busy={busy} onSubmit={onSubmitTask} />
      <FocusPanel
        tasks={tasks}
        activeSession={activeSession}
        clientId={clientId}
        busy={busy}
        online={focusActionsAvailable}
        onCommand={onFocusCommand}
        showStartForm={false}
      />
      <TodayQueue
        at={logicalAt}
        preferences={preferences}
        tasks={tasks}
        activeSession={activeSession}
        calendars={baikalCalendars}
        busy={busy}
        calendarActionsAvailable={calendarActionsAvailable}
        focusActionsAvailable={focusActionsAvailable}
        onStartFocus={(task) =>
          onFocusCommand({ command: "start", taskId: task.id })
        }
        onChangeTaskStatus={onChangeTaskStatus}
        onSubmitTimeBlock={onSubmitTimeBlock}
        onRemoveTimeBlock={onRemoveTimeBlock}
        onViewTasks={onViewTasks}
      />
      <section className="week-plan" aria-labelledby="week-plan-title">
        <div className="section-heading">
          <div>
            <p className="step">Real calendar context</p>
            <h2 id="week-plan-title">Week plan</h2>
          </div>
          {planner !== null ? (
            <span className={`freshness freshness--${planner.freshness.state}`}>
              {planner.freshness.message}
            </span>
          ) : null}
        </div>
        {planner === null || planner.events.length === 0 ? (
          <p className="muted">No supported events in this week.</p>
        ) : (
          <>
            <fieldset className="calendar-filters">
              <legend>Calendars</legend>
              {Array.from(
                new Map(
                  planner.events.map((event) => [
                    event.identity.calendarId,
                    event.source,
                  ]),
                ),
              ).map(([calendarId, source]) => (
                <label key={calendarId}>
                  <input
                    type="checkbox"
                    checked={!hiddenCalendarIds.includes(calendarId)}
                    onChange={(event) => {
                      const checked = event.currentTarget.checked;
                      setHiddenCalendarIds((current) =>
                        updateHiddenCalendarIds(current, calendarId, checked),
                      );
                    }}
                  />
                  {source.providerDisplayLabel} · {source.calendarName}
                </label>
              ))}
            </fieldset>
            <ol className="timeline">
              {planner.events
                .filter(
                  (event) =>
                    !hiddenCalendarIds.includes(event.identity.calendarId),
                )
                .map((event) => (
                  <li key={`${event.identity.calendarId}:${event.href}`}>
                    <time dateTime={event.startsAt}>
                      {preferences === undefined
                        ? new Date(event.startsAt).toLocaleString()
                        : new Intl.DateTimeFormat("en-US", {
                            timeZone: preferences.timeZone,
                            dateStyle: "medium",
                            timeStyle: "short",
                          }).format(new Date(event.startsAt))}
                    </time>
                    <strong>{event.summary || "Untitled event"}</strong>
                    <span className="source-badge">
                      {event.source.providerDisplayLabel} ·{" "}
                      {event.source.calendarName}
                    </span>
                  </li>
                ))}
            </ol>
          </>
        )}
      </section>
    </div>
  );
};
