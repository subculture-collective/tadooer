/**
 * Recurring series rules and occurrence dates (issue #42, ADR 0023).
 *
 * Occurrence arithmetic works on calendar dates (YYYY-MM-DD) only, so it is
 * independent of time zones and daylight saving. The owner's IANA planning
 * zone is applied twice: to decide which date is "today", and to turn an
 * occurrence date plus a start time into an instant.
 */

export type RecurrenceCycle = "daily" | "weekly" | "monthly" | "yearly";

/** 1..4 is the first to fourth weekday of the month; -1 is the last one. */
export type RecurrenceWeekOfMonth = 1 | 2 | 3 | 4 | -1;

export type MonthlyAnchor =
  | { readonly kind: "day_of_month" }
  | { readonly kind: "last_day" }
  | {
      readonly kind: "nth_weekday";
      readonly week: RecurrenceWeekOfMonth;
      /** 0 = Sunday … 6 = Saturday. */
      readonly weekday: number;
    };

export interface RecurrenceRule {
  readonly cycle: RecurrenceCycle;
  /** Every n days, weeks, months or years; 1..366. */
  readonly interval: number;
  /** Weekly only: 0 = Sunday … 6 = Saturday, sorted and unique. */
  readonly weekdays: readonly number[];
  /** Monthly only; null for other cycles. */
  readonly monthly: MonthlyAnchor | null;
}

/** When the series may produce occurrences, and the pattern's base date. */
export interface RecurrenceWindow {
  readonly startDate: string;
  readonly endDate: string | null;
  /**
   * Pattern base. Equals the start date for a schedule-anchored series; a
   * completion-anchored series moves it to the latest completion date.
   */
  readonly anchorDate: string;
}

export const recurrenceIntervalMax = 366;

export type RecurrenceRuleViolation =
  | "interval_invalid"
  | "weekdays_required"
  | "weekdays_invalid"
  | "weekdays_not_weekly"
  | "monthly_anchor_required"
  | "monthly_anchor_invalid"
  | "monthly_anchor_not_monthly"
  | "start_date_invalid"
  | "end_date_invalid"
  | "end_before_start";

const dayMs = 86_400_000;

const isDate = (value: string): boolean =>
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(`${value}T00:00:00.000Z`)) &&
  new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;

/** Days since 1970-01-01 for a calendar date. */
const toDays = (date: string): number =>
  Date.parse(`${date}T00:00:00.000Z`) / dayMs;
const fromDays = (days: number): string =>
  new Date(days * dayMs).toISOString().slice(0, 10);

interface Civil {
  readonly year: number;
  /** 1..12 */
  readonly month: number;
  readonly day: number;
}
const civil = (date: string): Civil => {
  const [year, month, day] = date.split("-").map(Number) as [
    number,
    number,
    number,
  ];
  return { year, month, day };
};
const format = ({ year, month, day }: Civil): string =>
  `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

export const addCalendarDays = (date: string, days: number): string =>
  fromDays(toDays(date) + days);

const weekdayOf = (date: string): number =>
  new Date(`${date}T00:00:00.000Z`).getUTCDay();

const daysInMonth = (year: number, month: number): number =>
  new Date(Date.UTC(year, month, 0)).getUTCDate();

const isLeapYear = (year: number): boolean =>
  (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;

/** Month index since year 0, so month arithmetic is plain integer math. */
const monthIndex = ({ year, month }: Pick<Civil, "year" | "month">): number =>
  year * 12 + (month - 1);
const fromMonthIndex = (index: number): Pick<Civil, "year" | "month"> => ({
  year: Math.floor(index / 12),
  month: (((index % 12) + 12) % 12) + 1,
});

/** The Nth (or last) weekday of a month. */
export const nthWeekdayOfMonth = (
  year: number,
  month: number,
  weekday: number,
  week: RecurrenceWeekOfMonth,
): string => {
  if (week === -1) {
    const last = daysInMonth(year, month);
    const lastWeekday = weekdayOf(format({ year, month, day: last }));
    return format({
      year,
      month,
      day: last - ((lastWeekday - weekday + 7) % 7),
    });
  }
  const firstWeekday = weekdayOf(format({ year, month, day: 1 }));
  // 1 + 6 + 3 * 7 = 28, so weeks 1..4 always exist, even in February.
  return format({
    year,
    month,
    day: 1 + ((weekday - firstWeekday + 7) % 7) + (week - 1) * 7,
  });
};

export const validateRecurrenceRule = (
  rule: RecurrenceRule,
  window: Pick<RecurrenceWindow, "startDate" | "endDate">,
): RecurrenceRuleViolation | null => {
  if (
    !Number.isInteger(rule.interval) ||
    rule.interval < 1 ||
    rule.interval > recurrenceIntervalMax
  )
    return "interval_invalid";
  if (!isDate(window.startDate)) return "start_date_invalid";
  if (window.endDate !== null) {
    if (!isDate(window.endDate)) return "end_date_invalid";
    if (window.endDate < window.startDate) return "end_before_start";
  }
  if (rule.cycle === "weekly") {
    if (rule.weekdays.length === 0) return "weekdays_required";
    if (
      rule.weekdays.some(
        (day, index) =>
          !Number.isInteger(day) ||
          day < 0 ||
          day > 6 ||
          (index > 0 && day <= (rule.weekdays[index - 1] ?? -1)),
      )
    )
      return "weekdays_invalid";
  } else if (rule.weekdays.length > 0) return "weekdays_not_weekly";
  if (rule.cycle === "monthly") {
    if (rule.monthly === null) return "monthly_anchor_required";
    if (
      rule.monthly.kind === "nth_weekday" &&
      (![1, 2, 3, 4, -1].includes(rule.monthly.week) ||
        !Number.isInteger(rule.monthly.weekday) ||
        rule.monthly.weekday < 0 ||
        rule.monthly.weekday > 6)
    )
      return "monthly_anchor_invalid";
  } else if (rule.monthly !== null) return "monthly_anchor_not_monthly";
  return null;
};

/** The pattern candidate inside one month, or null when the rule skips it. */
const monthlyCandidate = (
  rule: RecurrenceRule,
  base: Civil,
  index: number,
): string | null => {
  const offset = index - monthIndex(base);
  if (offset < 0 || offset % rule.interval !== 0) return null;
  const { year, month } = fromMonthIndex(index);
  const anchor = rule.monthly ?? { kind: "day_of_month" };
  if (anchor.kind === "nth_weekday")
    return nthWeekdayOfMonth(year, month, anchor.weekday, anchor.week);
  const last = daysInMonth(year, month);
  // Days past the end of a shorter month clamp to its last day.
  return format({
    year,
    month,
    day: anchor.kind === "last_day" ? last : Math.min(base.day, last),
  });
};

/** Feb 29 falls on Feb 28 in common years. */
const yearlyCandidate = (
  rule: RecurrenceRule,
  base: Civil,
  year: number,
): string | null => {
  const offset = year - base.year;
  if (offset < 0 || offset % rule.interval !== 0) return null;
  const day =
    base.month === 2 && base.day === 29 && !isLeapYear(year) ? 28 : base.day;
  return format({ year, month: base.month, day });
};

/** Whether the pattern (ignoring the window bounds) produces this date. */
const patternMatches = (
  rule: RecurrenceRule,
  anchorDate: string,
  date: string,
): boolean => {
  const difference = toDays(date) - toDays(anchorDate);
  if (difference < 0) return false;
  switch (rule.cycle) {
    case "daily":
      return difference % rule.interval === 0;
    case "weekly":
      // Week blocks start on the anchor date, as in the source app.
      return (
        Math.floor(difference / 7) % rule.interval === 0 &&
        rule.weekdays.includes(weekdayOf(date))
      );
    case "monthly":
      return (
        monthlyCandidate(rule, civil(anchorDate), monthIndex(civil(date))) ===
        date
      );
    case "yearly":
      return (
        yearlyCandidate(rule, civil(anchorDate), civil(date).year) === date
      );
  }
};

const lowerBound = (window: RecurrenceWindow): string =>
  window.anchorDate > window.startDate ? window.anchorDate : window.startDate;

const inWindow = (window: RecurrenceWindow, date: string): boolean =>
  date >= lowerBound(window) &&
  (window.endDate === null || date <= window.endDate);

export const isOccurrence = (
  rule: RecurrenceRule,
  window: RecurrenceWindow,
  date: string,
): boolean =>
  isDate(date) &&
  inWindow(window, date) &&
  patternMatches(rule, window.anchorDate, date);

/**
 * Candidates for a scan, newest or oldest first, limited to a span that always
 * contains one period of the rule. Every scan is O(interval), never
 * O(downtime).
 */
const candidates = function* (
  rule: RecurrenceRule,
  anchorDate: string,
  from: string,
  direction: 1 | -1,
): Generator<string> {
  const base = civil(anchorDate);
  switch (rule.cycle) {
    case "daily": {
      const difference = toDays(from) - toDays(anchorDate);
      const steps =
        direction === -1
          ? Math.floor(difference / rule.interval)
          : Math.ceil(difference / rule.interval);
      for (let step = steps, count = 0; count < 2; step += direction, count++)
        yield fromDays(toDays(anchorDate) + step * rule.interval);
      return;
    }
    case "weekly":
      for (let offset = 0; offset <= rule.interval * 7 + 7; offset++)
        yield addCalendarDays(from, offset * direction);
      return;
    case "monthly": {
      const start = monthIndex(civil(from));
      for (let offset = -1; offset <= rule.interval + 1; offset++) {
        const candidate = monthlyCandidate(
          rule,
          base,
          start + offset * direction,
        );
        if (candidate !== null) yield candidate;
      }
      return;
    }
    case "yearly": {
      const start = civil(from).year;
      for (let offset = -1; offset <= rule.interval + 1; offset++) {
        const candidate = yearlyCandidate(
          rule,
          base,
          start + offset * direction,
        );
        if (candidate !== null) yield candidate;
      }
      return;
    }
  }
};

/** The newest occurrence on or before `date`, or null when there is none. */
export const previousOccurrence = (
  rule: RecurrenceRule,
  window: RecurrenceWindow,
  date: string,
): string | null => {
  const ceiling =
    window.endDate !== null && window.endDate < date ? window.endDate : date;
  if (ceiling < lowerBound(window)) return null;
  let best: string | null = null;
  for (const candidate of candidates(rule, window.anchorDate, ceiling, -1))
    if (
      candidate <= ceiling &&
      isOccurrence(rule, window, candidate) &&
      (best === null || candidate > best)
    )
      best = candidate;
  return best;
};

/** The oldest occurrence on or after `date`, or null when there is none. */
export const nextOccurrence = (
  rule: RecurrenceRule,
  window: RecurrenceWindow,
  date: string,
): string | null => {
  const floor = date < lowerBound(window) ? lowerBound(window) : date;
  if (window.endDate !== null && floor > window.endDate) return null;
  let best: string | null = null;
  for (const candidate of candidates(rule, window.anchorDate, floor, 1))
    if (
      candidate >= floor &&
      isOccurrence(rule, window, candidate) &&
      (best === null || candidate < best)
    )
      best = candidate;
  return best;
};

/** Up to `count` occurrences on or after `date`, for previews. */
export const upcomingOccurrences = (
  rule: RecurrenceRule,
  window: RecurrenceWindow,
  date: string,
  count: number,
): string[] => {
  const dates: string[] = [];
  let cursor = date;
  while (dates.length < count) {
    const next = nextOccurrence(rule, window, cursor);
    if (next === null) break;
    dates.push(next);
    cursor = addCalendarDays(next, 1);
  }
  return dates;
};

export type MissedOccurrencePolicy = "skip" | "latest";

/**
 * What one generation pass should do for a series (ADR 0023).
 *
 * The target is the newest occurrence after the cursor and on or before
 * today. Older missed occurrences are never materialized, so a pass creates
 * at most one instance per series, however long the server was down. With
 * `skip`, a target before today only advances the cursor.
 */
export const planGeneration = (input: {
  readonly rule: RecurrenceRule;
  readonly window: RecurrenceWindow;
  readonly cursorDate: string | null;
  /** Earliest date allowed after a resume; null when never paused. */
  readonly floorDate: string | null;
  readonly today: string;
  readonly missed: MissedOccurrencePolicy;
}):
  | { readonly kind: "none" }
  | { readonly kind: "advance"; readonly date: string }
  | { readonly kind: "create"; readonly date: string } => {
  const target = previousOccurrence(input.rule, input.window, input.today);
  if (
    target === null ||
    (input.cursorDate !== null && target <= input.cursorDate) ||
    (input.floorDate !== null && target < input.floorDate)
  )
    return { kind: "none" };
  if (target < input.today && input.missed === "skip")
    return { kind: "advance", date: target };
  return { kind: "create", date: target };
};

// Owner-zone conversions. Formatters are cached per zone.
const civilFormatters = new Map<string, Intl.DateTimeFormat>();
const civilMillis = (instant: number, timeZone: string): number => {
  let formatter = civilFormatters.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    civilFormatters.set(timeZone, formatter);
  }
  const parts = formatter.formatToParts(new Date(instant));
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value);
  return Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
  );
};

export const isStartTime = (value: string): boolean =>
  /^([01]\d|2[0-3]):[0-5]\d$/.test(value);

/**
 * The instant of a local date and HH:MM time in a zone. A time skipped by a
 * daylight-saving gap moves forward by the gap (02:30 on a spring-forward day
 * in America/Chicago is 03:30 CDT). A time repeated when clocks fall back
 * resolves to its first, earlier instant.
 */
export const zonedStartInstant = (
  date: string,
  time: string,
  timeZone: string,
): string => {
  if (!isDate(date) || !isStartTime(time))
    throw new RangeError("Invalid occurrence date or start time");
  const { year, month, day } = civil(date);
  const [hour, minute] = time.split(":").map(Number) as [number, number];
  const local = Date.UTC(year, month - 1, day, hour, minute);
  const offsetAt = (instant: number) =>
    civilMillis(instant, timeZone) - instant;
  const offsets = [
    ...new Set(
      [-dayMs, -dayMs / 2, 0, dayMs / 2, dayMs].map((delta) =>
        offsetAt(local + delta),
      ),
    ),
  ];
  const matches = offsets
    .map((offset) => local - offset)
    .filter((instant) => civilMillis(instant, timeZone) === local)
    .toSorted((left, right) => left - right);
  const first = matches[0];
  if (first !== undefined) return new Date(first).toISOString();
  // In a gap: use the offset in force before the transition.
  return new Date(local - offsetAt(local - dayMs / 2)).toISOString();
};
