export interface CalmTask {
  readonly id: string;
  readonly status: "open" | "completed";
  readonly plannedStart?: string | null;
}
export interface BusyInterval {
  readonly startsAt: string;
  readonly endsAt: string;
}
export interface CalmPreferences {
  readonly workingDays: readonly number[];
  readonly workdayStart: string;
  readonly workdayEnd: string;
  readonly breakStart: string | null;
  readonly breakEnd: string | null;
  readonly timeZone: string;
}
export interface CalmDayResult {
  readonly state:
    "working" | "scheduled_break" | "unavailable" | "finished_for_today";
  readonly orderedTaskIds: readonly string[];
  readonly nextTaskId: string | null;
  readonly reminder: {
    readonly suppressed: boolean;
    readonly reason:
      | "ready"
      | "stale_calendar"
      | "outside_working_hours"
      | "scheduled_break"
      | "calendar_busy"
      | "no_scheduled_task";
  };
}

type ZonedParts = Readonly<
  Record<"year" | "month" | "day" | "hour" | "minute" | "weekday", number>
>;

const zonedParts = (date: Date, timeZone: string): ZonedParts => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    weekday: "short",
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? "";
  const weekdays: Readonly<Record<string, number>> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  return {
    year: Number(value("year")),
    month: Number(value("month")),
    day: Number(value("day")),
    hour: Number(value("hour")),
    minute: Number(value("minute")),
    weekday: weekdays[value("weekday")] ?? -1,
  };
};

const instantForZonedLocal = (
  local: Readonly<Record<"year" | "month" | "day" | "hour" | "minute", number>>,
  timeZone: string,
): Date => {
  const target = Date.UTC(
    local.year,
    local.month - 1,
    local.day,
    local.hour,
    local.minute,
  );
  let candidate = target;
  for (let pass = 0; pass < 4; pass += 1) {
    const actual = zonedParts(new Date(candidate), timeZone);
    const represented = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
    );
    candidate += target - represented;
  }
  return new Date(candidate);
};

export const zonedDayWindow = (
  at: string,
  timeZone: string,
): { readonly from: string; readonly to: string } => {
  const current = zonedParts(new Date(at), timeZone);
  const nextDate = new Date(
    Date.UTC(current.year, current.month - 1, current.day + 1),
  );
  return {
    from: instantForZonedLocal(
      {
        year: current.year,
        month: current.month,
        day: current.day,
        hour: 0,
        minute: 0,
      },
      timeZone,
    ).toISOString(),
    to: instantForZonedLocal(
      {
        year: nextDate.getUTCFullYear(),
        month: nextDate.getUTCMonth() + 1,
        day: nextDate.getUTCDate(),
        hour: 0,
        minute: 0,
      },
      timeZone,
    ).toISOString(),
  };
};
const minute = (value: string): number =>
  Number(value.slice(0, 2)) * 60 + Number(value.slice(3));

export const buildCalmDay = (input: {
  readonly at: string;
  readonly tasks: readonly CalmTask[];
  readonly busy: readonly BusyInterval[];
  readonly preferences: CalmPreferences;
  readonly calendarFresh: boolean;
}): CalmDayResult => {
  const now = new Date(input.at);
  const nowTime = now.getTime();
  const local = zonedParts(now, input.preferences.timeZone);
  const currentMinute = local.hour * 60 + local.minute;
  const workingDay = input.preferences.workingDays.includes(local.weekday);
  const ordered = input.tasks
    .filter(({ status }) => status === "open")
    .toSorted((left, right) => {
      const leftTime =
        left.plannedStart == null
          ? Number.POSITIVE_INFINITY
          : Date.parse(left.plannedStart);
      const rightTime =
        right.plannedStart == null
          ? Number.POSITIVE_INFINITY
          : Date.parse(right.plannedStart);
      return leftTime - rightTime || left.id.localeCompare(right.id);
    });
  const next =
    ordered.find(
      ({ plannedStart }) =>
        plannedStart != null && Date.parse(plannedStart) >= nowTime,
    ) ?? null;
  const outside =
    !workingDay || currentMinute < minute(input.preferences.workdayStart);
  const finished =
    workingDay && currentMinute >= minute(input.preferences.workdayEnd);
  const scheduledBreak =
    input.preferences.breakStart !== null &&
    input.preferences.breakEnd !== null &&
    currentMinute >= minute(input.preferences.breakStart) &&
    currentMinute < minute(input.preferences.breakEnd);
  const unavailable = input.busy.some(
    ({ startsAt, endsAt }) =>
      Date.parse(startsAt) <= nowTime && Date.parse(endsAt) > nowTime,
  );
  const state = finished
    ? "finished_for_today"
    : outside
      ? "unavailable"
      : scheduledBreak
        ? "scheduled_break"
        : unavailable
          ? "unavailable"
          : "working";
  const reason = !input.calendarFresh
    ? "stale_calendar"
    : finished || outside
      ? "outside_working_hours"
      : scheduledBreak
        ? "scheduled_break"
        : unavailable
          ? "calendar_busy"
          : next === null
            ? "no_scheduled_task"
            : "ready";
  return {
    state,
    orderedTaskIds: ordered.map(({ id }) => id),
    nextTaskId: next?.id ?? null,
    reminder: { suppressed: reason !== "ready", reason },
  };
};
