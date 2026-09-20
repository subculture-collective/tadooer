export type HabitCadence =
  | { readonly kind: "daily" }
  | { readonly kind: "weekly"; readonly weekdays: readonly number[] }
  | { readonly kind: "custom"; readonly intervalDays: number };

export interface HabitSchedule {
  readonly startedOn: string;
  readonly cadence: HabitCadence;
}

export interface HabitOccurrence {
  readonly habitId: string;
  readonly periodKey: string;
  readonly completedAt: string;
}

export interface HabitMetrics {
  readonly currentStreak: number;
  readonly longestStreak: number;
  readonly completedPeriods: number;
}

const dayMillis = 86_400_000;

const dateFor = (value: string): Date => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value))
    throw new Error(`Invalid calendar date: ${value}`);
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()))
    throw new Error(`Invalid calendar date: ${value}`);
  return date;
};

const dateKey = (date: Date): string => date.toISOString().slice(0, 10);

const addDays = (value: string, days: number): string =>
  dateKey(new Date(dateFor(value).getTime() + days * dayMillis));

const periodKeysThrough = (
  schedule: HabitSchedule,
  through: string,
): readonly string[] => {
  const start = dateFor(schedule.startedOn);
  const end = dateFor(through);
  if (end < start) return [];
  if (schedule.cadence.kind === "weekly") {
    const allowed = new Set(schedule.cadence.weekdays);
    if (
      allowed.size === 0 ||
      [...allowed].some(
        (weekday) => !Number.isInteger(weekday) || weekday < 0 || weekday > 6,
      )
    )
      throw new Error("Weekly habits require weekdays from 0 through 6");
    const keys: string[] = [];
    for (
      let current = schedule.startedOn;
      dateFor(current) <= end;
      current = addDays(current, 1)
    ) {
      if (allowed.has((dateFor(current).getUTCDay() + 6) % 7))
        keys.push(current);
    }
    return keys;
  }
  const interval =
    schedule.cadence.kind === "daily" ? 1 : schedule.cadence.intervalDays;
  if (!Number.isInteger(interval) || interval < 1)
    throw new Error("Custom habits require a positive intervalDays");
  const keys: string[] = [];
  for (
    let current = schedule.startedOn;
    dateFor(current) <= end;
    current = addDays(current, interval)
  )
    keys.push(current);
  return keys;
};

export const deriveHabitMetrics = (
  schedule: HabitSchedule,
  occurrences: readonly HabitOccurrence[],
  through: string,
): HabitMetrics => {
  const keys = periodKeysThrough(schedule, through);
  const completed = new Set(occurrences.map(({ periodKey }) => periodKey));
  let currentStreak = 0;
  for (const key of [...keys].reverse()) {
    if (!completed.has(key)) break;
    currentStreak += 1;
  }
  let longestStreak = 0;
  let run = 0;
  for (const key of keys) {
    run = completed.has(key) ? run + 1 : 0;
    longestStreak = Math.max(longestStreak, run);
  }
  return {
    currentStreak,
    longestStreak,
    completedPeriods: keys.filter((key) => completed.has(key)).length,
  };
};
