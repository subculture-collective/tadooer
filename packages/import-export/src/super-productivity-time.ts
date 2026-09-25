/**
 * Super Productivity 19.1.0 work history (issue #41, ADR 0024).
 *
 * - `timeSpentOnDay` maps a logical local date (the recording device's zone,
 *   shifted by the start-of-next-day setting) to milliseconds. No zone or time
 *   of day is recorded, so each value imports as one daily total.
 * - A parent's `timeSpentOnDay` is the sum of its children's, and its
 *   `timeSpent` is the sum of its days. Only the part a parent's day exceeds
 *   its children's (for example time tracked before the first child existed,
 *   or a child that is missing from the export) is the parent's own time.
 * - `timeTracking` (live and in both archives) records per project, tag and
 *   the Today tag and day: first tracked minute `s`, last tracked minute `e`,
 *   break count `b` and break time `bt`. Stores merge field by field with the
 *   live state first, then archiveYoung, then archiveOld, as the source does.
 */

export const dayLimitMs = 86_400_000;

type ObjectValue = Readonly<Record<string, unknown>>;
const object = (value: unknown): ObjectValue | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as ObjectValue)
    : undefined;

type Report = (code: string, sourceId: string | null, detail: string) => void;

const isDate = (value: string): boolean =>
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(`${value}T00:00:00.000Z`)) &&
  new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;

const hours = (milliseconds: number): string =>
  `${(milliseconds / 3_600_000).toLocaleString("en-US", { maximumFractionDigits: 2 })} h`;
const ms = (milliseconds: number): string =>
  `${milliseconds.toLocaleString("en-US")} ms (${hours(milliseconds)})`;

export interface SourceTaskTime {
  readonly sourceId: string;
  /** Source parent ID as exported, including detached parents. */
  readonly parentId: string | null;
  readonly store: "task" | "archiveYoung" | "archiveOld";
  readonly trackedMilliseconds: number;
  /** Positive daily values; zero days carry no time. */
  readonly daily: Readonly<Record<string, number>>;
}

export interface SourceTimeEntry {
  readonly workDate: string;
  readonly durationMs: number;
  readonly kind: "task_day" | "parent_residual";
  readonly sourceTaskId: string;
  readonly sourceStore: SourceTaskTime["store"];
}

export interface TimeReconciliation {
  /** Leaf `timeSpent`, the source's own worklog total. */
  readonly sourceLeafMs: number;
  /** Leaf daily values, the only dated record. */
  readonly sourceLeafDailyMs: number;
  readonly taskDayEntries: number;
  readonly taskDayMs: number;
  readonly parentResidualEntries: number;
  readonly parentResidualMs: number;
  /** Leaf `timeSpent` without a day; not imported. */
  readonly undatedMs: number;
  /** Leaf daily time above the task's `timeSpent`; imported. */
  readonly datedExcessMs: number;
  readonly workContextDays: number;
}

/**
 * Daily entries per task that count every tracked millisecond once: a leaf
 * imports its days; a parent imports only the part of each day its source
 * children do not explain. Reports each total mismatch explicitly.
 */
export const reconcileTaskTime = (
  tasks: readonly SourceTaskTime[],
  issue: Report,
): {
  readonly entries: ReadonlyMap<string, readonly SourceTimeEntry[]>;
  readonly totals: Omit<TimeReconciliation, "workContextDays">;
} => {
  const children = new Map<string, SourceTaskTime[]>();
  for (const task of tasks)
    if (task.parentId !== null)
      children.set(task.parentId, [
        ...(children.get(task.parentId) ?? []),
        task,
      ]);
  const entries = new Map<string, SourceTimeEntry[]>();
  let sourceLeafMs = 0;
  let sourceLeafDailyMs = 0;
  let taskDayEntries = 0;
  let taskDayMs = 0;
  let parentResidualEntries = 0;
  let parentResidualMs = 0;
  let undatedMs = 0;
  let datedExcessMs = 0;
  for (const task of tasks) {
    const days = Object.entries(task.daily).toSorted(([left], [right]) =>
      left.localeCompare(right),
    );
    const dailyTotal = days.reduce((sum, [, value]) => sum + value, 0);
    const kids = children.get(task.sourceId) ?? [];
    if (dailyTotal !== task.trackedMilliseconds)
      issue(
        "time_total_mismatch",
        task.sourceId,
        dailyTotal < task.trackedMilliseconds
          ? `timeSpent is ${ms(task.trackedMilliseconds)} but the daily entries sum to ${ms(dailyTotal)}; the dated entries are imported and the ${ms(task.trackedMilliseconds - dailyTotal)} without a day stays only in import provenance`
          : `timeSpent is ${ms(task.trackedMilliseconds)} but the daily entries sum to ${ms(dailyTotal)}; the dated entries are imported because timeSpent has no day`,
      );
    const own: SourceTimeEntry[] = [];
    if (kids.length === 0) {
      sourceLeafMs += task.trackedMilliseconds;
      sourceLeafDailyMs += dailyTotal;
      undatedMs += Math.max(0, task.trackedMilliseconds - dailyTotal);
      datedExcessMs += Math.max(0, dailyTotal - task.trackedMilliseconds);
      for (const [workDate, durationMs] of days) {
        own.push({
          workDate,
          durationMs,
          kind: "task_day",
          sourceTaskId: task.sourceId,
          sourceStore: task.store,
        });
        taskDayEntries++;
        taskDayMs += durationMs;
      }
    } else {
      const childDaily = new Map<string, number>();
      for (const kid of kids)
        for (const [date, value] of Object.entries(kid.daily))
          childDaily.set(date, (childDaily.get(date) ?? 0) + value);
      let residual = 0;
      let residualDays = 0;
      let shortfall = 0;
      let shortfallDays = 0;
      for (const date of [
        ...new Set([...Object.keys(task.daily), ...childDaily.keys()]),
      ].toSorted()) {
        const difference =
          (task.daily[date] ?? 0) - (childDaily.get(date) ?? 0);
        if (difference > 0) {
          own.push({
            workDate: date,
            durationMs: difference,
            kind: "parent_residual",
            sourceTaskId: task.sourceId,
            sourceStore: task.store,
          });
          residual += difference;
          residualDays++;
        } else if (difference < 0) {
          shortfall -= difference;
          shortfallDays++;
        }
      }
      parentResidualEntries += own.length;
      parentResidualMs += residual;
      if (residual > 0)
        issue(
          "time_parent_residual",
          task.sourceId,
          `The parent's daily time exceeds its children's by ${ms(residual)} on ${String(residualDays)} day${residualDays === 1 ? "" : "s"}; that difference is imported as the parent's own time, the rest stays with the children`,
        );
      if (shortfall > 0)
        issue(
          "time_parent_shortfall",
          task.sourceId,
          `The children's daily time exceeds the parent's by ${ms(shortfall)} on ${String(shortfallDays)} day${shortfallDays === 1 ? "" : "s"}; the children's entries are imported and the parent's lower total adds nothing`,
        );
    }
    if (own.length > 0) entries.set(task.sourceId, own);
  }
  return {
    entries,
    totals: {
      sourceLeafMs,
      sourceLeafDailyMs,
      taskDayEntries,
      taskDayMs,
      parentResidualEntries,
      parentResidualMs,
      undatedMs,
      datedExcessMs,
    },
  };
};

export interface SourceWorkContextDay {
  readonly contextKind: "project" | "tag" | "today";
  readonly sourceContextId: string;
  readonly workDate: string;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly breakCount: number | null;
  readonly breakMs: number | null;
  /** Highest-priority store that holds a record for this day. */
  readonly sourceStore: "timeTracking" | "archiveYoung" | "archiveOld";
}

const workContextFields = new Set(["s", "e", "b", "bt"]);

/**
 * Validates and merges the three `timeTracking` states. Malformed values
 * block; records for projects or tags absent from the export are kept with
 * their source ID and reported once.
 */
export const readWorkContexts = (
  stores: readonly {
    readonly name: SourceWorkContextDay["sourceStore"];
    readonly value: unknown;
  }[],
  known: { readonly projects: ObjectValue; readonly tags: ObjectValue },
  issue: Report,
): readonly SourceWorkContextDay[] => {
  const merged = new Map<
    string,
    {
      kind: SourceWorkContextDay["contextKind"];
      id: string;
      date: string;
      fields: Record<string, number>;
      store: SourceWorkContextDay["sourceStore"];
    }
  >();
  let overlaps = 0;
  const invalid = (store: string, detail: string) =>
    issue(
      "invalid_time_tracking",
      null,
      `${store} ${detail}; correct it in Super Productivity before importing`,
    );
  // Lowest priority first, so later stores overwrite fields.
  for (const store of stores.toReversed()) {
    if (store.value === undefined) continue;
    const state = object(store.value);
    if (state === undefined) {
      invalid(store.name, "must be an object of project and tag records");
      continue;
    }
    for (const [category, contexts] of Object.entries(state)) {
      if (category !== "project" && category !== "tag") {
        issue(
          "unknown_section",
          null,
          `${store.name}.${category} is not a reviewed Super Productivity 19.1.0 time tracking field`,
        );
        continue;
      }
      const byContext = object(contexts);
      if (byContext === undefined) {
        invalid(store.name, `${category} must map IDs to days`);
        continue;
      }
      for (const [contextId, dates] of Object.entries(byContext)) {
        const byDate = object(dates);
        if (
          contextId === "" ||
          contextId.length > 200 ||
          byDate === undefined
        ) {
          invalid(store.name, `${category} records need an ID and a day map`);
          continue;
        }
        for (const [date, record] of Object.entries(byDate)) {
          const fields = object(record);
          if (!isDate(date) || fields === undefined) {
            invalid(
              store.name,
              `${category} record days must be calendar dates with s, e, b or bt`,
            );
            continue;
          }
          const values: Record<string, number> = {};
          let valid = true;
          for (const [field, value] of Object.entries(fields)) {
            if (
              !workContextFields.has(field) ||
              typeof value !== "number" ||
              !Number.isSafeInteger(value) ||
              value < 0 ||
              ((field === "s" || field === "e") &&
                (value > 8_640_000_000_000_000 ||
                  new Date(value).toISOString().length !== 24))
            )
              valid = false;
            else values[field] = value;
          }
          if (!valid) {
            invalid(
              store.name,
              `${category} day records may hold only nonnegative integer s, e, b and bt values`,
            );
            continue;
          }
          const kind =
            category === "tag" && contextId === "TODAY" ? "today" : category;
          const key = `${kind}\u0000${contextId}\u0000${date}`;
          const prior = merged.get(key);
          if (prior !== undefined) overlaps++;
          merged.set(key, {
            kind,
            id: contextId,
            date,
            fields: { ...prior?.fields, ...values },
            store: store.name,
          });
        }
      }
    }
  }
  if (overlaps > 0)
    issue(
      "work_context_merged",
      null,
      `${overlaps.toLocaleString("en-US")} work-day record${overlaps === 1 ? " appears" : "s appear"} in more than one time tracking store; fields merge with the live state first, then archiveYoung, then archiveOld, as Super Productivity does`,
    );
  const rows = [...merged.values()].map((entry): SourceWorkContextDay => ({
    contextKind: entry.kind,
    sourceContextId: entry.id,
    workDate: entry.date,
    startedAt:
      entry.fields.s === undefined
        ? null
        : new Date(entry.fields.s).toISOString(),
    endedAt:
      entry.fields.e === undefined
        ? null
        : new Date(entry.fields.e).toISOString(),
    breakCount: entry.fields.b ?? null,
    breakMs: entry.fields.bt ?? null,
    sourceStore: entry.store,
  }));
  const unresolved = rows.filter(
    (row) =>
      (row.contextKind === "project" &&
        !Object.hasOwn(known.projects, row.sourceContextId)) ||
      (row.contextKind === "tag" &&
        !Object.hasOwn(known.tags, row.sourceContextId)),
  ).length;
  if (unresolved > 0)
    issue(
      "work_context_historical",
      null,
      `${unresolved.toLocaleString("en-US")} work-day record${unresolved === 1 ? " belongs" : "s belong"} to projects, tags or board markers that are not imported; each is kept with its source ID and shown only by day`,
    );
  return rows.toSorted(
    (left, right) =>
      left.workDate.localeCompare(right.workDate) ||
      left.contextKind.localeCompare(right.contextKind) ||
      left.sourceContextId.localeCompare(right.sourceContextId),
  );
};

/** One non-blocking summary that reconciles the source and imported totals. */
const count = (value: number, singular: string, plural: string): string =>
  `${value.toLocaleString("en-US")} ${value === 1 ? singular : plural}`;

export const reconciliationSummary = (totals: TimeReconciliation): string =>
  `Leaf tasks record ${ms(totals.sourceLeafMs)} as timeSpent and ${ms(totals.sourceLeafDailyMs)} as dated daily entries. ` +
  `Importing ${count(totals.taskDayEntries, "task-day entry", "task-day entries")} totalling ${ms(totals.taskDayMs)} and ${count(totals.parentResidualEntries, "parent-own entry", "parent-own entries")} totalling ${ms(totals.parentResidualMs)}: ` +
  `${ms(totals.taskDayMs + totals.parentResidualMs)} in all, plus ${count(totals.workContextDays, "work start/end record", "work start/end records")}. ` +
  `${ms(totals.undatedMs)} of leaf timeSpent has no day and is not imported; ${ms(totals.datedExcessMs)} of daily entries exceed their task's timeSpent and are imported. Milliseconds are kept exactly.`;
