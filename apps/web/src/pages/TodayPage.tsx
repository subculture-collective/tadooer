import type { SyntheticEvent } from "react";
import type {
  ActiveSession,
  DayPlanResponse,
  PlannerResponse,
  Task,
} from "@suite/contracts";
import { Field } from "../field.tsx";
import { FocusPanel, type FocusPanelCommand } from "../focus-panel.tsx";
import { useState } from "react";

export interface TodayPageProps {
  readonly dayPlan: DayPlanResponse | undefined;
  readonly tasks: readonly Task[];
  readonly activeSession: ActiveSession | null;
  readonly clientId: string | null;
  readonly syncStatus: "online" | "offline" | "syncing" | undefined;
  readonly planner: PlannerResponse | null;
  readonly busy: boolean;
  readonly onFocusCommand: (command: FocusPanelCommand) => void;
  readonly onSubmitTask: (
    event: SyntheticEvent<HTMLFormElement, SubmitEvent>,
  ) => Promise<void>;
}

export const TodayPage = ({
  dayPlan,
  tasks,
  activeSession,
  clientId,
  syncStatus,
  planner,
  busy,
  onFocusCommand,
  onSubmitTask,
}: TodayPageProps) => {
  const [hiddenCalendarIds, setHiddenCalendarIds] = useState<readonly string[]>(
    [],
  );

  return (
    <>
      {dayPlan !== undefined && (
        <section className="today-status" aria-labelledby="today-title">
          <p className="step">Calm daily workspace</p>
          <h3 id="today-title">
            {dayPlan.state.replaceAll("_", " ")}
          </h3>
          <p>
            {dayPlan.nextTask === null
              ? "No scheduled task is ready next."
              : `Next: ${dayPlan.nextTask.title}`}
          </p>
          <p className="hint">
            {dayPlan.reminder.suppressed
              ? `Quiet: ${dayPlan.reminder.reason.replaceAll("_", " ")}`
              : "Ready for the next planned task."}
          </p>
        </section>
      )}
      <FocusPanel
        tasks={tasks}
        activeSession={activeSession ?? null}
        clientId={clientId ?? null}
        busy={busy}
        online={syncStatus === "online"}
        onCommand={(command) => onFocusCommand(command)}
      />
      <section
        className="week-plan"
        aria-labelledby="week-plan-title"
      >
        <div className="section-heading">
          <div>
            <p className="step">Real calendar context</p>
            <h3 id="week-plan-title">Week plan</h3>
          </div>
          {planner !== null && (
            <span
              className={`freshness freshness--${planner.freshness.state}`}
            >
              {planner.freshness.message}
            </span>
          )}
        </div>
        {planner === null ||
        planner.events.length === 0 ? (
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
                    onChange={(event) =>
                      setHiddenCalendarIds((current) =>
                        event.currentTarget.checked
                          ? current.filter((id) => id !== calendarId)
                          : [...current, calendarId],
                      )
                    }
                  />
                  {source.providerDisplayLabel} ·{" "}
                  {source.calendarName}
                </label>
              ))}
            </fieldset>
            <ol className="timeline">
              {planner.events
                .filter(
                  (event) =>
                    !hiddenCalendarIds.includes(
                      event.identity.calendarId,
                    ),
                )
                .map((event) => (
                  <li
                    key={`${event.identity.calendarId}:${event.href}`}
                  >
                    <time dateTime={event.startsAt}>
                      {new Date(event.startsAt).toLocaleString()}
                    </time>
                    <strong>
                      {event.summary || "Untitled event"}
                    </strong>
                    <span className="source-badge">
                      {event.source.providerDisplayLabel} ·{" "}
                      {event.source.calendarName}
                    </span>
                    <span>
                      until{" "}
                      {new Date(event.endsAt).toLocaleTimeString()}
                    </span>
                  </li>
                ))}
            </ol>
          </>
        )}
      </section>
      <form
        className="task-capture"
        onSubmit={(event) => void onSubmitTask(event)}
      >
        <h3>Capture a task</h3>
        <Field
          label="What needs doing?"
          name="title"
          autoComplete="off"
        />
        <Field
          label="Notes"
          name="notes"
          autoComplete="off"
          required={false}
        />
        <label className="field">
          <span>Estimate minutes</span>
          <input
            name="estimateMinutes"
            type="number"
            min="1"
            max="720"
          />
        </label>
        <button disabled={busy}>
          {busy ? "Capturing…" : "Capture task"}
        </button>
      </form>
    </>
  );
};
