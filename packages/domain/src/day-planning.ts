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

const minuteOfDay = (date: Date): number =>
  date.getUTCHours() * 60 + date.getUTCMinutes();
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
  const currentMinute = minuteOfDay(now);
  const workingDay = input.preferences.workingDays.includes(now.getUTCDay());
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
