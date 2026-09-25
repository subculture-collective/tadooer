import { zonedDayWindow } from "./day-planning.ts";

/**
 * Date-only planning (ADR 0020). A planned day is a calendar date in the
 * owner's IANA planning time zone; it never implies a time of day.
 */

const dateFormatters = new Map<string, Intl.DateTimeFormat>();

/** The owner-local calendar date (YYYY-MM-DD) that contains an instant. */
export const zonedCalendarDate = (at: string | Date, timeZone: string) => {
  let formatter = dateFormatters.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    dateFormatters.set(timeZone, formatter);
  }
  const parts = formatter.formatToParts(
    typeof at === "string" ? new Date(at) : at,
  );
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((candidate) => candidate.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
};

export const isCalendarDate = (value: string): boolean =>
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(`${value}T00:00:00.000Z`)) &&
  new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;

/**
 * The half-open instant window [from, to) of a calendar date in a time zone.
 * The window is 23 or 25 hours long on daylight-saving transition days.
 */
export const plannedDayWindow = (
  day: string,
  timeZone: string,
): { readonly from: string; readonly to: string } => {
  if (!isCalendarDate(day)) throw new RangeError("Invalid calendar date");
  const [year, month, date] = day.split("-").map(Number) as [
    number,
    number,
    number,
  ];
  // UTC offsets span -12:00..+14:00, so noon or midnight UTC always falls on
  // the requested local date; the last candidate is a defensive fallback.
  for (const hour of [12, 0, 23]) {
    const candidate = new Date(Date.UTC(year, month - 1, date, hour));
    if (zonedCalendarDate(candidate, timeZone) === day)
      return zonedDayWindow(candidate.toISOString(), timeZone);
  }
  throw new RangeError("Calendar date cannot be resolved in the time zone");
};

export interface PlannedTask {
  readonly plannedStart?: string | null | undefined;
  readonly plannedDay?: string | null | undefined;
}

/** A planned start always wins over a planned day (source-app precedence). */
export const effectivePlan = (
  task: PlannedTask,
):
  | { readonly kind: "start"; readonly value: string }
  | { readonly kind: "day"; readonly value: string }
  | null =>
  task.plannedStart != null
    ? { kind: "start", value: task.plannedStart }
    : task.plannedDay != null
      ? { kind: "day", value: task.plannedDay }
      : null;

/** Whether a task's plan overlaps an instant window, such as a planner range. */
export const plannedWithinWindow = (
  task: PlannedTask,
  window: { readonly from: string; readonly to: string },
  timeZone: string,
): boolean => {
  const plan = effectivePlan(task);
  if (plan === null) return false;
  const from = Date.parse(window.from);
  const to = Date.parse(window.to);
  if (plan.kind === "start") {
    const start = Date.parse(plan.value);
    return start >= from && start < to;
  }
  const day = plannedDayWindow(plan.value, timeZone);
  return Date.parse(day.from) < to && Date.parse(day.to) > from;
};

/** Sort key: exact start, or the start of the planned day in the time zone. */
export const planSortInstant = (
  task: PlannedTask,
  timeZone: string,
): number => {
  const plan = effectivePlan(task);
  if (plan === null) return Number.POSITIVE_INFINITY;
  return plan.kind === "start"
    ? Date.parse(plan.value)
    : Date.parse(plannedDayWindow(plan.value, timeZone).from);
};
