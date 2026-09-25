import type { CalendarEventProjection, Task } from "@suite/contracts";
import { CalendarDaysIcon, CheckSquareIcon } from "lucide-react";
import { useEffect, useState, type CSSProperties } from "react";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import {
  buildCalendarRange,
  type CalendarRange,
  type CalendarView,
} from "./calendar-range.ts";
import "./planner-time-grid.css";

export interface PlannerTimeGridProps {
  readonly view: CalendarView;
  readonly range: CalendarRange;
  readonly timeZone: string;
  readonly events: readonly CalendarEventProjection[];
  readonly tasks: readonly Task[];
  readonly onSelectEntry?: (entry: PlannerGridEntry) => void;
  /** ADR 0027: saved order of each date's date-only tasks. */
  readonly dayOrders?: ReadonlyMap<string, readonly string[]> | undefined;
}

export type PlannerGridEntry =
  | { readonly kind: "event"; readonly event: CalendarEventProjection }
  | { readonly kind: "task"; readonly task: Task };

type LinkedCalendarEvent = CalendarEventProjection & {
  readonly linkedTaskId?: string;
};

interface CalendarDay {
  readonly start: Date;
  readonly end: Date;
  readonly key: string;
  readonly label: string;
  readonly longLabel: string;
}

interface TimedEntry {
  readonly id: string;
  readonly kind: "event" | "task";
  readonly title: string;
  readonly start: Date;
  readonly end: Date;
  readonly detail: string;
  readonly source?: PlannerGridEntry;
}

interface PositionedEntry extends TimedEntry {
  readonly top: number;
  readonly height: number;
  readonly column: number;
  readonly columns: number;
}

const dayCount: Readonly<Record<CalendarView, number>> = {
  day: 1,
  "3day": 3,
  week: 7,
};

const timeLabel = (value: Date, timeZone: string): string =>
  new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
  }).format(value);

const dateKey = (value: Date, timeZone: string): string => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((candidate) => candidate.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
};

/** Builds local calendar days from the already-authoritative request range. */
export const plannerCalendarDays = (
  range: CalendarRange,
  view: CalendarView,
  timeZone: string,
): readonly CalendarDay[] => {
  const days: CalendarDay[] = [];
  let start = new Date(range.from);
  for (let index = 0; index < dayCount[view]; index++) {
    const dayRange = buildCalendarRange(
      "day",
      new Date(start.getTime() + 12 * 60 * 60 * 1000),
      timeZone,
    );
    const end = new Date(dayRange.to);
    days.push({
      start,
      end,
      key: dateKey(start, timeZone),
      label: new Intl.DateTimeFormat("en-US", {
        timeZone,
        weekday: "short",
        day: "numeric",
      }).format(start),
      longLabel: new Intl.DateTimeFormat("en-US", {
        timeZone,
        weekday: "long",
        month: "long",
        day: "numeric",
      }).format(start),
    });
    start = end;
  }
  return days;
};

const intersects = (entry: TimedEntry, day: CalendarDay): boolean =>
  entry.start < day.end && entry.end > day.start;

const clipped = (entry: TimedEntry, day: CalendarDay): TimedEntry => ({
  ...entry,
  start: entry.start > day.start ? entry.start : day.start,
  end: entry.end < day.end ? entry.end : day.end,
});

/** Assign a horizontal lane to each overlapping entry without hiding any item. */
export const positionTimedEntries = (
  entries: readonly TimedEntry[],
  day: CalendarDay,
): readonly PositionedEntry[] => {
  const duration = day.end.getTime() - day.start.getTime();
  const sorted = entries
    .filter((entry) => intersects(entry, day))
    .map((entry) => clipped(entry, day))
    .toSorted(
      (left, right) =>
        left.start.getTime() - right.start.getTime() ||
        right.end.getTime() - left.end.getTime() ||
        left.id.localeCompare(right.id),
    );
  const groups: TimedEntry[][] = [];
  let group: TimedEntry[] = [];
  let latestEnd = -Infinity;
  for (const entry of sorted) {
    if (group.length > 0 && entry.start.getTime() >= latestEnd) {
      groups.push(group);
      group = [];
      latestEnd = -Infinity;
    }
    group.push(entry);
    latestEnd = Math.max(latestEnd, entry.end.getTime());
  }
  if (group.length > 0) groups.push(group);

  return groups.flatMap((overlapGroup) => {
    const lanes: Date[] = [];
    const withLane = overlapGroup.map((entry) => {
      let lane = lanes.findIndex((end) => end <= entry.start);
      if (lane === -1) {
        lane = lanes.length;
        lanes.push(entry.end);
      } else lanes[lane] = entry.end;
      return { entry, lane };
    });
    return withLane.map(({ entry, lane }) => ({
      ...entry,
      top: ((entry.start.getTime() - day.start.getTime()) / duration) * 100,
      height: Math.max(
        ((entry.end.getTime() - entry.start.getTime()) / duration) * 100,
        2.5,
      ),
      column: lane,
      columns: lanes.length,
    }));
  });
};

export const allDayFor = (
  events: readonly CalendarEventProjection[],
  day: CalendarDay,
): readonly CalendarEventProjection[] =>
  events.filter(
    (event) =>
      event.allDay &&
      event.startsAt.slice(0, 10) <= day.key &&
      event.endsAt.slice(0, 10) > day.key,
  );

const entriesFor = (
  events: readonly CalendarEventProjection[],
  tasks: readonly Task[],
): readonly TimedEntry[] => [
  ...events
    .filter((event) => !event.allDay)
    .map((event) => ({
      id: `event:${event.identity.calendarId}:${event.href}`,
      kind: "event" as const,
      title: event.summary || "Untitled event",
      start: new Date(event.startsAt),
      end: new Date(event.endsAt),
      detail: `${event.source.providerDisplayLabel} · ${event.source.calendarName}`,
      source: { kind: "event" as const, event },
    })),
  ...tasks
    .filter(
      (task) =>
        !events.some(
          (event) => (event as LinkedCalendarEvent).linkedTaskId === task.id,
        ),
    )
    .flatMap((task) => {
      if (task.plannedStart == null) return [];
      const start = new Date(task.plannedStart);
      const estimateMinutes = task.estimateMinutes ?? 30;
      return [
        {
          id: `task:${task.id}`,
          kind: "task" as const,
          title: task.title,
          start,
          end: new Date(start.getTime() + estimateMinutes * 60 * 1000),
          detail:
            task.estimateMinutes == null
              ? "Suite task · 30 min placeholder"
              : `Suite task · ${String(task.estimateMinutes)} min`,
          source: { kind: "task" as const, task },
        },
      ];
    }),
];

const hourMarkers = (
  day: CalendarDay,
  timeZone: string,
): readonly { label: string; top: number }[] => {
  const markers: { label: string; top: number }[] = [];
  const interval = 60 * 60 * 1000;
  for (
    let time = day.start.getTime();
    time < day.end.getTime();
    time += interval
  ) {
    const point = new Date(time);
    markers.push({
      label: timeLabel(point, timeZone),
      top:
        ((time - day.start.getTime()) /
          (day.end.getTime() - day.start.getTime())) *
        100,
    });
  }
  return markers;
};

export function PlannerTimeGrid({
  view,
  range,
  timeZone,
  events,
  tasks,
  onSelectEntry,
  dayOrders,
}: PlannerTimeGridProps) {
  const [now, setNow] = useState(() => new Date());
  const days = plannerCalendarDays(range, view, timeZone);
  const entries = entriesFor(events, tasks);
  const hasItems = events.length > 0 || tasks.length > 0;

  useEffect(() => {
    const interval = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(interval);
  }, []);

  return (
    <section
      className="planner-time-grid"
      aria-label={`${view === "3day" ? "Three-day" : view} calendar grid`}
      data-view={view}
    >
      {!hasItems && (
        <EmptyState
          icon={<CalendarDaysIcon />}
          title="Nothing is planned in this range"
          description="Projected calendar events and Suite tasks with a planned time or day will appear here."
        />
      )}
      <div className="planner-time-grid__legend" aria-label="Calendar legend">
        <Badge variant="calendar">Calendar event</Badge>
        <Badge variant="secondary">Suite task</Badge>
        <span>Times shown in {timeZone}</span>
      </div>
      <div
        className="planner-time-grid__days"
        style={{ "--planner-days": days.length } as CSSProperties}
      >
        {days.map((day, index) => {
          const allDay = allDayFor(events, day);
          // Date-only tasks have no time; they sit in the all-day lane of
          // their owner-zone day and never create a timed overlap (ADR 0020).
          const dayTasks = tasks
            .filter(
              (task) =>
                task.plannedStart == null && task.plannedDay === day.key,
            )
            .toSorted((left, right) => left.id.localeCompare(right.id));
          const rank = new Map(
            (dayOrders?.get(day.key) ?? []).map((id, position) => [
              id,
              position,
            ]),
          );
          // Saved order first, then the derived order (ADR 0027).
          dayTasks.sort(
            (left, right) =>
              (rank.get(left.id) ?? rank.size) -
              (rank.get(right.id) ?? rank.size),
          );
          const positioned = positionTimedEntries(entries, day);
          const currentTimeTop =
            now >= day.start && now < day.end
              ? ((now.getTime() - day.start.getTime()) /
                  (day.end.getTime() - day.start.getTime())) *
                100
              : null;
          return (
            <section
              className="planner-time-grid__day"
              key={day.key}
              aria-labelledby={`planner-day-${day.key}`}
            >
              <header className="planner-time-grid__day-header">
                <h3 id={`planner-day-${day.key}`}>{day.label}</h3>
                <span className="sr-only">{day.longLabel}</span>
              </header>
              <div
                className="planner-time-grid__all-day"
                aria-label={`All-day events for ${day.longLabel}`}
              >
                <span className="planner-time-grid__all-day-label">
                  All day
                </span>
                <div>
                  {dayTasks.map((task) => (
                    <button
                      type="button"
                      tabIndex={0}
                      className="planner-time-grid__all-day-event planner-time-grid__all-day-task"
                      key={`task:${task.id}`}
                      aria-label={`${task.title}, planned for ${day.longLabel}, no time set. Suite task`}
                      onClick={() => onSelectEntry?.({ kind: "task", task })}
                    >
                      <strong>{task.title}</strong>
                      <span>Suite task · no time</span>
                    </button>
                  ))}
                  {allDay.length === 0 && dayTasks.length === 0 ? (
                    <span className="planner-time-grid__all-day-empty">—</span>
                  ) : (
                    allDay.map((event) => (
                      <button
                        type="button"
                        tabIndex={0}
                        className="planner-time-grid__all-day-event"
                        key={`${event.identity.calendarId}:${event.href}`}
                        onClick={() =>
                          onSelectEntry?.({ kind: "event", event })
                        }
                      >
                        <strong>{event.summary || "Untitled event"}</strong>
                        <span>{event.source.calendarName}</span>
                      </button>
                    ))
                  )}
                </div>
              </div>
              <div
                className="planner-time-grid__hours"
                aria-label={`Timed schedule for ${day.longLabel}`}
              >
                {hourMarkers(day, timeZone).map((marker, markerIndex) => (
                  <div
                    className="planner-time-grid__hour"
                    key={`${day.key}-${String(markerIndex)}`}
                    style={{ top: `${String(marker.top)}%` }}
                  >
                    {index === 0 && <time>{marker.label}</time>}
                  </div>
                ))}
                {currentTimeTop !== null && (
                  <div
                    className="planner-time-grid__now"
                    style={{ top: `${String(currentTimeTop)}%` }}
                    aria-label={`Current time: ${timeLabel(now, timeZone)}`}
                  >
                    <span>{timeLabel(now, timeZone)}</span>
                  </div>
                )}
                {positioned.map((entry) => (
                  <button
                    type="button"
                    tabIndex={0}
                    className={`planner-time-grid__entry planner-time-grid__entry--${entry.kind}`}
                    key={entry.id}
                    style={{
                      top: `${String(entry.top)}%`,
                      height: `${String(entry.height)}%`,
                      left: `calc(${String((entry.column / entry.columns) * 100)}% + 0.2rem)`,
                      width: `calc(${String(100 / entry.columns)}% - 0.4rem)`,
                    }}
                    aria-label={`${entry.title}, ${timeLabel(entry.start, timeZone)} to ${timeLabel(entry.end, timeZone)}. ${entry.detail}`}
                    onClick={() => {
                      if (entry.source !== undefined)
                        onSelectEntry?.(entry.source);
                    }}
                  >
                    {entry.kind === "task" && (
                      <CheckSquareIcon aria-hidden="true" />
                    )}
                    <strong>{entry.title}</strong>
                    <time dateTime={entry.start.toISOString()}>
                      {timeLabel(entry.start, timeZone)}–
                      {timeLabel(entry.end, timeZone)}
                    </time>
                    <span>{entry.detail}</span>
                  </button>
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </section>
  );
}
