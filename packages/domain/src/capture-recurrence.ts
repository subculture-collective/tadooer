import {
  addCalendarDays,
  recurrenceIntervalMax,
  type RecurrenceRule,
} from "./recurrence.ts";

/**
 * ADR 0031: the `@every …` capture grammar and its mapping to a recurring
 * series rule (ADR 0023). Every supported phrase maps to one rule; anything
 * else is reported as unsupported rather than guessed.
 */
export interface CaptureRecurrence {
  readonly rule: RecurrenceRule;
  /** First occurrence on or after the capture date, in the planning zone. */
  readonly startDate: string;
  /** HH:MM when the phrase ends with a time of day; else null. */
  readonly startTime: string | null;
  /** The phrase as captured, for previews. */
  readonly text: string;
}

export class CaptureRecurrenceError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "CaptureRecurrenceError";
  }
}

const weekdayNames: Readonly<Record<string, number>> = {
  sun: 0,
  sunday: 0,
  mon: 1,
  monday: 1,
  tue: 2,
  tues: 2,
  tuesday: 2,
  wed: 3,
  wednesday: 3,
  thu: 4,
  thur: 4,
  thurs: 4,
  thursday: 4,
  fri: 5,
  friday: 5,
  sat: 6,
  saturday: 6,
};

const weekdayOf = (unit: string): number | undefined =>
  weekdayNames[unit] ?? weekdayNames[unit.replace(/s$/, "")];

const weekdayOfDate = (date: string): number =>
  new Date(`${date}T00:00:00.000Z`).getUTCDay();

const nextWeekday = (from: string, weekday: number): string =>
  addCalendarDays(from, (weekday - weekdayOfDate(from) + 7) % 7);

const nextDayOfMonth = (from: string, day: number): string | undefined => {
  const [year, month] = from.split("-").map(Number) as [number, number];
  for (let offset = 0; offset < 24; offset += 1) {
    const candidate = new Date(Date.UTC(year, month - 1 + offset, day));
    if (candidate.getUTCDate() !== day) continue;
    const value = candidate.toISOString().slice(0, 10);
    if (value >= from) return value;
  }
  return undefined;
};

const trailingTime = /^(.*?)\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i;

const splitTime = (
  phrase: string,
): { readonly rule: string; readonly time: string | null } => {
  const match = trailingTime.exec(phrase);
  if (match === null) return { rule: phrase, time: null };
  let hour = Number(match[2]);
  const minute = Number(match[3] ?? "0");
  const meridiem = match[4]?.toLowerCase();
  if (meridiem === "pm" && hour < 12) hour += 12;
  if (meridiem === "am" && hour === 12) hour = 0;
  if (hour > 23 || minute > 59)
    throw new CaptureRecurrenceError(
      `“${phrase}” does not end with a valid time of day`,
    );
  return {
    rule: match[1] ?? "",
    time: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
  };
};

const rule = (
  cycle: RecurrenceRule["cycle"],
  interval: number,
  weekdays: readonly number[] = [],
): RecurrenceRule => {
  if (interval < 1 || interval > recurrenceIntervalMax)
    throw new CaptureRecurrenceError(
      `Repeat interval must be between 1 and ${String(recurrenceIntervalMax)}`,
    );
  return {
    cycle,
    interval,
    weekdays,
    monthly: cycle === "monthly" ? { kind: "day_of_month" } : null,
  };
};

export const captureRepeatHelp =
  "Supported repeats: every day, every N days, every week, every N weeks, every monday, every N mondays, every weekday, every month, every N months, every 15th, every year, every N years; optionally followed by a time such as 09:00";

/**
 * Parses an `@` marker value as a repeat phrase. Returns undefined when the
 * value is not a repeat phrase at all (so it may be a date); throws when it
 * starts like one but cannot be mapped.
 */
export const parseCaptureRepeat = (
  value: string,
  today: string,
): CaptureRecurrence | undefined => {
  const text = value.trim();
  const lower = text.toLowerCase();
  if (
    !/^(?:daily|weekly|monthly|yearly|annually)(?:\s|$)|^every\s+/.test(lower)
  )
    return undefined;
  const { rule: phrase, time } = splitTime(lower);
  const result = (parsed: RecurrenceRule, startDate: string) => ({
    rule: parsed,
    startDate,
    startTime: time,
    text,
  });
  const fail = (): never => {
    throw new CaptureRecurrenceError(
      `Unsupported repeat “${text}”. ${captureRepeatHelp}.`,
    );
  };
  switch (phrase) {
    case "daily":
      return result(rule("daily", 1), today);
    case "weekly":
      return result(rule("weekly", 1, [weekdayOfDate(today)]), today);
    case "monthly":
      return result(rule("monthly", 1), today);
    case "yearly":
    case "annually":
      return result(rule("yearly", 1), today);
    default:
      break;
  }
  const every =
    /^every\s+(?:(\d{1,3})\s+)?([a-z]+|\d{1,2}(?:st|nd|rd|th))$/.exec(phrase);
  if (every === null) return fail();
  const interval = every[1] === undefined ? 1 : Number(every[1]);
  const unit = every[2] ?? "";
  const ordinal = /^(\d{1,2})(?:st|nd|rd|th)$/.exec(unit);
  if (ordinal !== null) {
    if (every[1] !== undefined) return fail();
    const day = Number(ordinal[1]);
    const startDate =
      day >= 1 && day <= 31 ? nextDayOfMonth(today, day) : undefined;
    if (startDate === undefined) return fail();
    return result(rule("monthly", 1), startDate);
  }
  const weekday = weekdayOf(unit);
  if (weekday !== undefined)
    return result(
      rule("weekly", interval, [weekday]),
      nextWeekday(today, weekday),
    );
  if (/^(weekdays?|workdays?)$/.test(unit)) {
    if (every[1] !== undefined) return fail();
    const start = [0, 6].includes(weekdayOfDate(today))
      ? nextWeekday(today, 1)
      : today;
    return result(rule("weekly", 1, [1, 2, 3, 4, 5]), start);
  }
  if (/^days?$/.test(unit)) return result(rule("daily", interval), today);
  if (/^weeks?$/.test(unit))
    return result(rule("weekly", interval, [weekdayOfDate(today)]), today);
  if (/^months?$/.test(unit)) return result(rule("monthly", interval), today);
  if (/^years?$/.test(unit)) return result(rule("yearly", interval), today);
  return fail();
};
