import { addCalendarDays } from "./recurrence.ts";
import { isCalendarDate, plannedDayWindow } from "./date-only-planning.ts";
import { splitIntervalByDay, weekStartOf } from "./time-history.ts";

/**
 * Simple counters and daily evaluations (issue #64, ADR 0025).
 *
 * A counter records one whole number per owner-zone calendar day:
 *
 * - `click`: a count the owner raises or lowers.
 * - `stopwatch`: milliseconds. The server records the start instant and, on
 *   stop, adds the elapsed time to each owner-zone day it covered.
 * - `repeated_countdown`: a count of completed countdown sessions; the
 *   countdown length is configuration.
 *
 * Streaks are derived from the day values on read and never stored. Counters
 * are not habits: a habit completes scheduled periods, a counter records an
 * amount.
 */
export const counterKinds = [
  "click",
  "stopwatch",
  "repeated_countdown",
] as const;
export type CounterKind = (typeof counterKinds)[number];

export const counterStreakModes = ["weekdays", "weekly_frequency"] as const;
export type CounterStreakMode = (typeof counterStreakModes)[number];

/** Largest count stored for one day of a click or countdown counter. */
export const maxCounterCount = 1_000_000;

export interface CounterStreakSettings {
  readonly enabled: boolean;
  /** Smallest day value that counts: a count, or milliseconds for a stopwatch. */
  readonly minValue: number;
  readonly mode: CounterStreakMode;
  /** Weekdays that must qualify in `weekdays` mode; 0 is Sunday. */
  readonly weekdays: readonly number[];
  /** Qualifying days per Monday-to-Sunday week in `weekly_frequency` mode. */
  readonly weeklyFrequency: number;
}

/** Length of an owner-zone calendar day: 23, 24 or 25 hours. */
export const dayLengthMs = (day: string, timeZone: string): number => {
  const window = plannedDayWindow(day, timeZone);
  return Date.parse(window.to) - Date.parse(window.from);
};

/** Upper bound of one day's value: a count, or the day's length in milliseconds. */
export const maxCounterDayValue = (
  kind: CounterKind,
  day: string,
  timeZone: string,
): number =>
  kind === "stopwatch" ? dayLengthMs(day, timeZone) : maxCounterCount;

export type CounterValueViolation =
  "day_invalid" | "value_invalid" | "value_exceeds_day";

/** Checks one day's resulting value; null when it can be stored. */
export const validateCounterDayValue = (input: {
  readonly kind: CounterKind;
  readonly day: string;
  readonly value: number;
  readonly timeZone: string;
}): CounterValueViolation | null => {
  if (!isCalendarDate(input.day)) return "day_invalid";
  if (!Number.isSafeInteger(input.value) || input.value < 0)
    return "value_invalid";
  return input.value > maxCounterDayValue(input.kind, input.day, input.timeZone)
    ? "value_exceeds_day"
    : null;
};

/**
 * The new value of an increment. As in Super Productivity, a decrement stops
 * at zero instead of failing.
 */
export const incrementedCounterValue = (current: number, delta: number) =>
  Math.max(0, current + delta);

/**
 * Milliseconds a stopwatch adds to each owner-zone day between its start and
 * stop instants. A run across midnight adds to both days; on daylight-saving
 * days the day is 23 or 25 hours long.
 */
export const stopwatchDayShares = (
  startedAt: string,
  stoppedAt: string,
  timeZone: string,
): readonly { readonly day: string; readonly ms: number }[] =>
  Date.parse(stoppedAt) <= Date.parse(startedAt)
    ? []
    : splitIntervalByDay(startedAt, stoppedAt, timeZone).map((segment) => ({
        day: segment.workDate,
        ms: segment.durationMs,
      }));

const weekdayOf = (day: string): number =>
  new Date(`${day}T00:00:00.000Z`).getUTCDay();

/** Weekday bit set (bit 0 is Sunday) to sorted weekday numbers, and back. */
export const weekdaysFromMask = (mask: number): number[] =>
  [0, 1, 2, 3, 4, 5, 6].filter((weekday) => (mask & (1 << weekday)) !== 0);
export const weekdayMask = (weekdays: readonly number[]): number =>
  [...new Set(weekdays)].reduce((mask, weekday) => mask | (1 << weekday), 0);

/**
 * Current streak, ported from Super Productivity 19.1.0
 * (`get-simple-counter-streak-duration.ts`), evaluated on the owner's `today`.
 *
 * - `weekdays`: consecutive selected weekdays whose value reaches the minimum,
 *   counted back from the latest selected weekday. Today does not break the
 *   streak until it is over.
 * - `weekly_frequency`: the number of qualifying days in the run of
 *   consecutive Monday weeks that each reached the frequency, plus the current
 *   week's days while it is still open. With no complete week it is the
 *   current week's qualifying days, as in the source.
 *
 * Returns null when streaks are off. Nothing here is stored.
 */
export const counterStreak = (
  settings: CounterStreakSettings,
  values: ReadonlyMap<string, number>,
  today: string,
): number | null => {
  if (!settings.enabled) return null;
  if (settings.minValue < 1) return 0;
  const qualifies = (day: string) =>
    (values.get(day) ?? 0) >= settings.minValue;
  if (settings.mode === "weekly_frequency") {
    if (settings.weeklyFrequency < 1) return 0;
    const weekCount = (start: string) =>
      [0, 1, 2, 3, 4, 5, 6].filter((offset) =>
        qualifies(addCalendarDays(start, offset)),
      ).length;
    const currentStart = weekStartOf(today);
    const currentCount = weekCount(currentStart);
    const currentMet = currentCount >= settings.weeklyFrequency;
    let start = currentMet ? currentStart : addCalendarDays(currentStart, -7);
    let total = 0;
    // Each counted week needs recorded values, so the loop is bounded.
    for (;;) {
      const count = weekCount(start);
      if (count < settings.weeklyFrequency) break;
      total += count;
      start = addCalendarDays(start, -7);
    }
    if (total > 0 && !currentMet) return total + currentCount;
    return total > 0 ? total : currentCount;
  }
  const allowed = new Set(settings.weekdays);
  if (allowed.size === 0) return 0;
  const latestAllowed = (day: string) => {
    let current = day;
    while (!allowed.has(weekdayOf(current)))
      current = addCalendarDays(current, -1);
    return current;
  };
  let day = latestAllowed(today);
  if (day === today && !qualifies(day))
    day = latestAllowed(addCalendarDays(day, -1));
  let streak = 0;
  while (qualifies(day)) {
    streak++;
    day = latestAllowed(addCalendarDays(day, -1));
  }
  return streak;
};

/** Daily evaluation scales, as in Super Productivity's evaluation sheet. */
export const evaluationImpactRange = { min: 1, max: 4 } as const;
export const evaluationEnergyRange = { min: 1, max: 3 } as const;
