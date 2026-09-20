import { useEffect, useMemo, useState } from "react";
import type { PlannerResponse } from "@suite/contracts";
import {
  buildCalendarRange,
  shiftCalendarAnchor,
  type CalendarRange,
  type CalendarView,
} from "../components/calendar/calendar-range.ts";

interface PlannerPageProps {
  readonly planner: PlannerResponse | null;
  readonly timeZone: string;
  readonly busy: boolean;
  readonly loading?: boolean;
  readonly error?: string | null;
  readonly onLoadPlanner: (range: CalendarRange) => Promise<void>;
}

const calendarViewLabel: Readonly<Record<CalendarView, string>> = {
  day: "Day",
  "3day": "3 days",
  week: "Week",
};

const displayTime = (value: string, timeZone: string): string =>
  new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));

export const PlannerPage = ({
  planner,
  timeZone,
  busy,
  loading = false,
  error = null,
  onLoadPlanner,
}: PlannerPageProps) => {
  const [view, setView] = useState<CalendarView>("week");
  const [anchor, setAnchor] = useState(() => new Date());
  const range = useMemo(
    () => buildCalendarRange(view, anchor, timeZone),
    [anchor, timeZone, view],
  );
  const matchesRange =
    planner !== null &&
    planner.window.from === range.from &&
    planner.window.to === range.to;

  useEffect(() => {
    void onLoadPlanner(range);
  }, [onLoadPlanner, range]);

  return (
    <div className="today-page">
      <header className="today-header">
        <p className="step">Calendar context</p>
        <h1>Planner</h1>
        <p>Review Suite tasks beside projected calendar events.</p>
      </header>
      <section className="week-plan" aria-label="Planner controls">
        <div className="filter-bar">
          <button
            type="button"
            onClick={() => setAnchor(new Date())}
            disabled={busy}
          >
            Today
          </button>
          <button
            type="button"
            aria-label="Previous period"
            onClick={() =>
              setAnchor((current) =>
                shiftCalendarAnchor(view, current, -1, timeZone),
              )
            }
            disabled={busy}
          >
            Previous
          </button>
          <button
            type="button"
            aria-label="Next period"
            onClick={() =>
              setAnchor((current) =>
                shiftCalendarAnchor(view, current, 1, timeZone),
              )
            }
            disabled={busy}
          >
            Next
          </button>
          <label className="field">
            <span>Calendar view</span>
            <select
              value={view}
              onChange={(event) =>
                setView(event.currentTarget.value as CalendarView)
              }
            >
              {(Object.keys(calendarViewLabel) as readonly CalendarView[]).map(
                (value) => (
                  <option key={value} value={value}>
                    {calendarViewLabel[value]}
                  </option>
                ),
              )}
            </select>
          </label>
        </div>
        <p className="hint">
          {displayTime(range.from, timeZone)} —{" "}
          {displayTime(range.to, timeZone)}
        </p>
        {loading && <p role="status">Loading the selected period…</p>}
        {error !== null && (
          <p role="alert">
            Could not refresh this period: {error}.{" "}
            {matchesRange
              ? "Showing saved data for this period."
              : "The previous period is hidden."}{" "}
            <button
              type="button"
              disabled={loading}
              onClick={() => void onLoadPlanner(range)}
            >
              Retry
            </button>
          </p>
        )}
        {planner === null || !matchesRange ? (
          <p className="muted">
            {error === null
              ? "Waiting for calendar context for this period…"
              : "No current data for the selected period."}
          </p>
        ) : (
          <>
            <p className={`freshness freshness--${planner.freshness.state}`}>
              {planner.freshness.message}
            </p>
            <div className="planner-grid" data-view={view}>
              <section aria-labelledby="planner-events-title">
                <h2 id="planner-events-title">Calendar events</h2>
                {planner.events.length === 0 ? (
                  <p className="muted">No projected events in this period.</p>
                ) : (
                  <ol className="timeline">
                    {planner.events.map((event) => (
                      <li key={`${event.identity.calendarId}:${event.href}`}>
                        <time dateTime={event.startsAt}>
                          {event.allDay
                            ? "All day"
                            : displayTime(event.startsAt, timeZone)}
                        </time>
                        <strong>{event.summary || "Untitled event"}</strong>
                        <span className="source-badge">
                          {event.source.providerDisplayLabel} ·{" "}
                          {event.source.calendarName}
                        </span>
                      </li>
                    ))}
                  </ol>
                )}
              </section>
              <section aria-labelledby="planner-tasks-title">
                <h2 id="planner-tasks-title">Planned tasks</h2>
                {planner.tasks.length === 0 ? (
                  <p className="muted">
                    No Suite tasks planned in this period.
                  </p>
                ) : (
                  <ol className="timeline">
                    {planner.tasks.map((task) => (
                      <li key={task.id}>
                        <time dateTime={task.plannedStart ?? undefined}>
                          {task.plannedStart === undefined ||
                          task.plannedStart === null
                            ? "No time set"
                            : displayTime(task.plannedStart, timeZone)}
                        </time>
                        <strong>{task.title}</strong>
                      </li>
                    ))}
                  </ol>
                )}
              </section>
            </div>
          </>
        )}
      </section>
    </div>
  );
};
