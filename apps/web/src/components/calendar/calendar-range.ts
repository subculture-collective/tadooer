export type CalendarView = "day" | "3day" | "week";

export interface CalendarRange {
  readonly from: string;
  readonly to: string;
}

interface LocalDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

const dateParts = (date: Date, timeZone: string): LocalDate => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = new Map(parts.map(({ type, value }) => [type, value]));
  const year = Number(values.get("year"));
  const month = Number(values.get("month"));
  const day = Number(values.get("day"));

  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day)
  ) {
    throw new Error("Could not derive calendar date");
  }

  return { year, month, day };
};

const zoneOffsetMilliseconds = (date: Date, timeZone: string): number => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const values = new Map(parts.map(({ type, value }) => [type, value]));
  const localAsUtc = Date.UTC(
    Number(values.get("year")),
    Number(values.get("month")) - 1,
    Number(values.get("day")),
    Number(values.get("hour")),
    Number(values.get("minute")),
    Number(values.get("second")),
  );
  return localAsUtc - date.getTime();
};

const localMidnight = (date: LocalDate, timeZone: string): Date => {
  const guess = Date.UTC(date.year, date.month - 1, date.day);
  const initial = new Date(
    guess - zoneOffsetMilliseconds(new Date(guess), timeZone),
  );
  return new Date(guess - zoneOffsetMilliseconds(initial, timeZone));
};

const addDays = (date: LocalDate, days: number): LocalDate => {
  const result = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return {
    year: result.getUTCFullYear(),
    month: result.getUTCMonth() + 1,
    day: result.getUTCDate(),
  };
};

const daysForView: Readonly<Record<CalendarView, number>> = {
  day: 1,
  "3day": 3,
  week: 7,
};

export const buildCalendarRange = (
  view: CalendarView,
  anchor: Date,
  timeZone: string,
): CalendarRange => {
  const localAnchor = dateParts(anchor, timeZone);
  const weekday = new Date(
    Date.UTC(localAnchor.year, localAnchor.month - 1, localAnchor.day),
  ).getUTCDay();
  const start =
    view === "week"
      ? addDays(localAnchor, weekday === 0 ? -6 : 1 - weekday)
      : localAnchor;
  const end = addDays(start, daysForView[view]);

  return {
    from: localMidnight(start, timeZone).toISOString(),
    to: localMidnight(end, timeZone).toISOString(),
  };
};

export const shiftCalendarAnchor = (
  view: CalendarView,
  anchor: Date,
  direction: -1 | 1,
  timeZone = "UTC",
): Date =>
  new Date(
    localMidnight(
      addDays(dateParts(anchor, timeZone), direction * daysForView[view]),
      timeZone,
    ).getTime() +
      12 * 60 * 60 * 1000,
  );
