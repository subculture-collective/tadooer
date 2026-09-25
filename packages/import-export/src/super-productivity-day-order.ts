/**
 * Super Productivity Today and planner-day order (issue #98, ADR 0027).
 *
 * - `TODAY_TAG.taskIds` is the manual order of Super Productivity's Today
 *   view. It becomes the saved order of the owner's current planning date at
 *   preview/apply time (`today`), because the export records no date for it.
 * - `planner.days[date]` is the order of a future day.
 *
 * Only entries that name an imported, open, active, date-only task planned
 * for that date are applied. Every other entry (a task absent from the
 * export, a timed, completed or archived task, or a task planned for another
 * date) is reported as a non-blocking notice. Membership stays derived from
 * the task dates; the saved order only sorts.
 */

type Source = Record<string, unknown>;
const object = (value: unknown): Source =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Source)
    : {};

/** Reviewed planner state keys (PlannerState in Super Productivity 19.1.0). */
export const superProductivityPlannerKeys = {
  days: "applied",
  // Dialog bookkeeping; no user data.
  addPlannedTasksDialogLastShown: "ignored",
} as const;

const isDate = (value: string): boolean =>
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(`${value}T00:00:00.000Z`)) &&
  new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;

export interface DayOrderTask {
  readonly sourceId: string;
  readonly archived: boolean;
  readonly completed: boolean;
  readonly plannedStart: string | null;
  readonly plannedDay: string | null;
}

export interface SourceDayOrder {
  readonly date: string;
  readonly sourceTaskIds: readonly string[];
}

export const mapSuperProductivityDayOrders = (input: {
  readonly todayTaskIds: unknown;
  readonly planner: unknown;
  /** globalConfig.misc.startOfNextDayTime; reported here, applied by ADR 0030. */
  readonly startOfNextDayTime?: unknown;
  readonly today: string;
  readonly tasks: ReadonlyMap<string, DayOrderTask>;
  readonly problem: (sourceId: string, detail: string) => void;
  readonly notice: (sourceId: string, detail: string) => void;
}): SourceDayOrder[] => {
  const orders: SourceDayOrder[] = [];
  const dayStart = input.startOfNextDayTime;
  if (
    typeof dayStart === "string" &&
    /^([01]?\d|2[0-3]):[0-5]\d$/.test(dayStart) &&
    !/^0?0:00$/.test(dayStart)
  )
    input.notice(
      "globalConfig",
      `Super Productivity starts a new day at ${dayStart}. It is imported as the planning day start only while planning preferences were never saved; otherwise set "New day starts at" to match before importing, so Today's order lands on the same day`,
    );
  const add = (
    sourceId: string,
    date: string,
    ids: readonly string[],
  ): number => {
    let missing = 0;
    let outside = 0;
    const kept: string[] = [];
    for (const id of ids) {
      const task = input.tasks.get(id);
      if (task === undefined) missing++;
      else if (
        task.archived ||
        task.completed ||
        task.plannedStart !== null ||
        task.plannedDay !== date
      )
        outside++;
      else if (!kept.includes(id)) kept.push(id);
    }
    if (missing > 0)
      input.notice(
        sourceId,
        `${String(missing)} ${missing === 1 ? "entry" : "entries"} in the order for ${date} ${missing === 1 ? "references a task" : "reference tasks"} absent from the export and ${missing === 1 ? "is" : "are"} not imported`,
      );
    if (outside > 0)
      input.notice(
        sourceId,
        `${String(outside)} ${outside === 1 ? "task" : "tasks"} in the order for ${date} ${outside === 1 ? "is" : "are"} not an open date-only task planned for that date; ${outside === 1 ? "it keeps its" : "they keep their"} own date or time order`,
      );
    if (kept.length > 0) orders.push({ date, sourceTaskIds: kept });
    return kept.length;
  };

  const todayIds = input.todayTaskIds;
  if (todayIds !== undefined) {
    if (
      !Array.isArray(todayIds) ||
      !todayIds.every((id) => typeof id === "string")
    )
      input.problem("TODAY", "Today's taskIds must be a list of task IDs");
    else if (todayIds.length > 0)
      input.notice(
        "TODAY",
        add("TODAY", input.today, todayIds) > 0
          ? `Today's task order is applied as the order of ${input.today}, the current day in the planning time zone`
          : `Today's task order is not applied: none of its tasks is an open date-only task planned for ${input.today}, the current day in the planning time zone`,
      );
  }

  if (input.planner == null) return orders;
  if (typeof input.planner !== "object" || Array.isArray(input.planner)) {
    input.problem("planner", "planner must be an object");
    return orders;
  }
  const planner = object(input.planner);
  for (const key of Object.keys(planner))
    if (!Object.hasOwn(superProductivityPlannerKeys, key))
      input.problem(
        "planner",
        `planner.${key} is not a reviewed Super Productivity 19.1.0 planner field`,
      );
  if (planner.days === undefined) return orders;
  if (
    planner.days === null ||
    typeof planner.days !== "object" ||
    Array.isArray(planner.days)
  ) {
    input.problem("planner", "planner.days must map dates to task IDs");
    return orders;
  }
  for (const [date, ids] of Object.entries(object(planner.days)).toSorted(
    ([left], [right]) => left.localeCompare(right),
  )) {
    if (
      !isDate(date) ||
      !Array.isArray(ids) ||
      !ids.every((id) => typeof id === "string")
    ) {
      input.problem("planner", "planner.days must map dates to task IDs");
      continue;
    }
    if (ids.length === 0) continue;
    if (date === input.today && orders.some((order) => order.date === date)) {
      input.notice(
        "planner",
        `The planner order for ${date} is not imported; Today's task order applies to that date`,
      );
      continue;
    }
    add("planner", date, ids);
  }
  return orders;
};
