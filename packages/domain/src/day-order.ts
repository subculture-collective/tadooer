import { zonedCalendarDate } from "./date-only-planning.ts";
import { addCalendarDays } from "./recurrence.ts";

/**
 * Saved day order and the start of a planning day (issue #98, ADR 0027).
 *
 * A day's members are the open, active, date-only tasks planned for that
 * owner-zone calendar date. A saved order only ranks members: saved IDs that
 * are no longer members are ignored, and members without a saved rank follow
 * the ranked ones in the derived order (task ID).
 */

export const defaultDayStartsAt = "00:00";

const minutesOf = (time: string): number =>
  Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));

const localMinutes = (at: Date, timeZone: string): number => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const value = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value ?? "0");
  return value("hour") * 60 + value("minute");
};

/**
 * The owner's planning date at an instant. Before `dayStartsAt` local time the
 * previous calendar date is still "today", as with Super Productivity's
 * start-of-next-day setting. Wall-clock based, so daylight-saving changes do
 * not shift the boundary.
 */
export const planningDate = (
  at: string | Date,
  timeZone: string,
  dayStartsAt: string = defaultDayStartsAt,
): string => {
  const instant = typeof at === "string" ? new Date(at) : at;
  const date = zonedCalendarDate(instant, timeZone);
  return localMinutes(instant, timeZone) < minutesOf(dayStartsAt)
    ? addCalendarDays(date, -1)
    : date;
};

type Local = Readonly<
  Record<"year" | "month" | "day" | "hour" | "minute", number>
>;

const zonedLocal = (at: Date, timeZone: string): Local => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const value = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value ?? "0");
  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    hour: value("hour"),
    minute: value("minute"),
  };
};

/**
 * The first instant at or after a local wall-clock time. A time skipped by a
 * daylight-saving change resolves to the first instant after the gap.
 */
const instantAtLocal = (date: string, time: string, timeZone: string): Date => {
  const [year, month, day] = date.split("-").map(Number) as [
    number,
    number,
    number,
  ];
  const target = Date.UTC(
    year,
    month - 1,
    day,
    Number(time.slice(0, 2)),
    Number(time.slice(3, 5)),
  );
  let candidate = target;
  for (let pass = 0; pass < 4; pass += 1) {
    const local = zonedLocal(new Date(candidate), timeZone);
    const represented = Date.UTC(
      local.year,
      local.month - 1,
      local.day,
      local.hour,
      local.minute,
    );
    if (represented === target) return new Date(candidate);
    candidate += target - represented;
  }
  // The wall-clock time does not exist: step forward to the first minute
  // whose local time is at or after it.
  let probe = candidate - 3 * 3_600_000;
  for (let step = 0; step < 6 * 60; step += 1) {
    const local = zonedLocal(new Date(probe), timeZone);
    const represented = Date.UTC(
      local.year,
      local.month - 1,
      local.day,
      local.hour,
      local.minute,
    );
    if (represented >= target) return new Date(probe);
    probe += 60_000;
  }
  return new Date(candidate);
};

/** Half-open window [from, to) of a planning date that starts at `dayStartsAt`. */
export const planningDayWindow = (
  date: string,
  timeZone: string,
  dayStartsAt: string = defaultDayStartsAt,
): { readonly from: string; readonly to: string } => ({
  from: instantAtLocal(date, dayStartsAt, timeZone).toISOString(),
  to: instantAtLocal(
    addCalendarDays(date, 1),
    dayStartsAt,
    timeZone,
  ).toISOString(),
});

export interface DayOrderCandidate {
  readonly id: string;
  readonly status: "open" | "completed";
  readonly plannedStart?: string | null | undefined;
  readonly plannedDay?: string | null | undefined;
  readonly deletedAt?: string | null | undefined;
  readonly archivedAt?: string | null | undefined;
}

/** Members of a date in the derived order (task ID). */
export const dayOrderMembers = (
  tasks: readonly DayOrderCandidate[],
  date: string,
): readonly string[] =>
  tasks
    .filter(
      (task) =>
        task.status === "open" &&
        task.deletedAt == null &&
        task.archivedAt == null &&
        task.plannedStart == null &&
        task.plannedDay === date,
    )
    .map(({ id }) => id)
    .toSorted((left, right) => left.localeCompare(right));

/**
 * Sort members by a saved order. Saved IDs that are not members are ignored;
 * unranked members keep their given relative order after the ranked ones.
 */
export const applyDayOrder = (
  members: readonly string[],
  saved: readonly string[],
): readonly string[] => {
  const present = new Set(members);
  const ranked = saved.filter((id) => present.has(id));
  const rankedSet = new Set(ranked);
  return [...ranked, ...members.filter((id) => !rankedSet.has(id))];
};

/** Whether a proposed full-list order names every member exactly once. */
export const isCompleteDayOrder = (
  members: readonly string[],
  proposed: readonly string[],
): boolean => {
  if (members.length !== proposed.length) return false;
  const present = new Set(members);
  return (
    new Set(proposed).size === proposed.length &&
    proposed.every((id) => present.has(id))
  );
};

/** Move one ID by one place; returns the list unchanged at either end. */
export const moveInDayOrder = (
  order: readonly string[],
  taskId: string,
  direction: -1 | 1,
): readonly string[] => {
  const index = order.indexOf(taskId);
  const neighbour = index === -1 ? undefined : order[index + direction];
  if (neighbour === undefined) return order;
  const next = [...order];
  next[index] = neighbour;
  next[index + direction] = taskId;
  return next;
};
