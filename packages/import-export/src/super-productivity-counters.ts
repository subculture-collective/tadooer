import { createHash } from "node:crypto";
import { organizationIconPattern } from "@suite/contracts";
import type { FieldDisposition } from "./super-productivity-schema.ts";

/**
 * Super Productivity 19.1.0 simple counters and metric days (issue #64,
 * ADR 0025). Read from `src/app/features/simple-counter` and
 * `src/app/features/metric`:
 *
 * - `simpleCounter` holds counter definitions and `countOnDay`, a map from the
 *   recording device's local date to a whole number: clicks for
 *   `ClickCounter`, completed countdowns for `RepeatedCountdownReminder`, and
 *   milliseconds for `StopWatch`. `isOn` is transient; the source turns it off
 *   when it loads data.
 * - `metric` holds one record per local date (the record ID) with the
 *   evaluation fields and `focusSessions`, a list of focus session durations
 *   in milliseconds.
 *
 * Streaks are not stored in the source and are never imported: Tadooer derives
 * them from the day values.
 */
export const superProductivitySimpleCounterFields = {
  id: "applied",
  title: "applied",
  isEnabled: "applied",
  isHideButton: "applied",
  icon: "applied",
  type: "applied",
  isTrackStreaks: "applied",
  streakMinValue: "applied",
  streakMode: "applied",
  streakWeekDays: "applied",
  streakWeeklyFrequency: "applied",
  countdownDuration: "applied",
  countOnDay: "applied",
  // Running state; the source resets it to off when it loads data.
  isOn: "ignored",
} as const satisfies Record<string, FieldDisposition>;

export const superProductivityMetricFields = {
  id: "applied",
  notes: "applied",
  reflections: "applied",
  remindTomorrow: "applied",
  impactOfWork: "applied",
  energyCheckin: "applied",
  // Durations stay evaluation history; they are not time entries (ADR 0025).
  focusSessions: "applied",
  // Marked for removal in the source; Tadooer derives these from tasks and
  // the worklog. Kept in the evaluation's import provenance.
  totalWorkMinutes: "retained",
  completedTasks: "retained",
  plannedTasks: "retained",
} as const satisfies Record<string, FieldDisposition>;

type ObjectValue = Readonly<Record<string, unknown>>;
type Report = (code: string, sourceId: string | null, detail: string) => void;

const object = (value: unknown): ObjectValue | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as ObjectValue)
    : undefined;

const isDate = (value: string): boolean =>
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(`${value}T00:00:00.000Z`)) &&
  new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;

const stableJson = (value: unknown): string =>
  JSON.stringify(value, (_key, nested: unknown) =>
    nested !== null && typeof nested === "object" && !Array.isArray(nested)
      ? Object.fromEntries(
          Object.entries(nested as Record<string, unknown>).toSorted(
            ([left], [right]) => (left < right ? -1 : left > right ? 1 : 0),
          ),
        )
      : nested,
  );
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");

/** Offset of a zone from UTC at an instant, in milliseconds. */
const zoneOffset = (instant: number, timeZone: string): number => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(instant));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((candidate) => candidate.type === type)?.value ?? 0);
  return (
    Date.UTC(
      part("year"),
      part("month") - 1,
      part("day"),
      part("hour"),
      part("minute"),
      part("second"),
    ) -
    instant +
    (instant % 1000)
  );
};
const zoneMidnight = (day: string, timeZone: string): number => {
  const local = Date.parse(`${day}T00:00:00.000Z`);
  let instant = local - zoneOffset(local, timeZone);
  instant = local - zoneOffset(instant, timeZone);
  return instant;
};
/** Length of a calendar day in the owner's zone: 23, 24 or 25 hours. */
export const zoneDayLengthMs = (day: string, timeZone: string): number => {
  const next = new Date(Date.parse(`${day}T00:00:00.000Z`) + 86_400_000)
    .toISOString()
    .slice(0, 10);
  return zoneMidnight(next, timeZone) - zoneMidnight(day, timeZone);
};

const counterKinds = {
  ClickCounter: "click",
  StopWatch: "stopwatch",
  RepeatedCountdownReminder: "repeated_countdown",
} as const;
const maxCount = 1_000_000;
const untitledCounter = "Untitled counter";
// The source's defaults for a counter created from EMPTY_SIMPLE_COUNTER.
const defaultWeekdays = [1, 2, 3, 4, 5];

/** A counter definition with its day values; matches the persistence import. */
export interface SourceCounter {
  readonly sourceId: string;
  readonly sourceHash: string;
  readonly sourceJson: string;
  readonly title: string;
  readonly kind: (typeof counterKinds)[keyof typeof counterKinds];
  readonly icon: string | null;
  readonly enabled: boolean;
  readonly hidden: boolean;
  readonly streak: {
    readonly enabled: boolean;
    readonly minValue: number;
    readonly mode: "weekdays" | "weekly_frequency";
    readonly weekdays: readonly number[];
    readonly weeklyFrequency: number;
  };
  readonly countdownMs: number | null;
  readonly values: readonly { readonly day: string; readonly value: number }[];
}

/** A metric day mapped to a daily evaluation. */
export interface SourceEvaluation {
  readonly day: string;
  readonly sourceHash: string;
  readonly sourceJson: string;
  readonly notes: string;
  readonly reflection: string;
  readonly impact: number | null;
  readonly energy: number | null;
  readonly remindTomorrow: boolean;
  readonly focusSessionsMs: readonly number[];
}

export interface CounterReconciliation {
  readonly definitions: number;
  readonly dayValues: number;
  readonly clickCount: number;
  readonly stopwatchMs: number;
  readonly evaluations: number;
  readonly focusSessions: number;
  readonly focusSessionMs: number;
}

const safeCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/**
 * Counter definitions in source order. Findings: invalid or unknown data
 * blocks; notices explain what changed or was left out.
 */
export const readSimpleCounters = (
  records: ObjectValue,
  order: readonly string[],
  timeZone: string,
  issue: Report,
): SourceCounter[] => {
  const counters: SourceCounter[] = [];
  const unknown = new Map<string, number>();
  for (const id of order) {
    const raw = object(records[id]);
    if (raw?.id !== id) {
      issue("invalid_counter", id, "Counter requires a matching ID");
      continue;
    }
    for (const field of Object.keys(raw))
      if (!Object.hasOwn(superProductivitySimpleCounterFields, field))
        unknown.set(field, (unknown.get(field) ?? 0) + 1);
    const invalid = (detail: string) => {
      issue("invalid_counter", id, detail);
      return undefined;
    };
    const kind =
      typeof raw.type === "string" && Object.hasOwn(counterKinds, raw.type)
        ? counterKinds[raw.type as keyof typeof counterKinds]
        : invalid(
            "Counter type must be ClickCounter, StopWatch or RepeatedCountdownReminder",
          );
    let title = typeof raw.title === "string" ? raw.title.trim() : "";
    if (raw.title !== undefined && typeof raw.title !== "string")
      invalid("Counter title must be text");
    else if (title.length > 200)
      invalid("Counter title exceeds 200 characters");
    else if (title === "") {
      title = untitledCounter;
      issue(
        "counter_notice",
        id,
        `Counter has no title; it is imported as "${untitledCounter}"`,
      );
    }
    for (const field of [
      "isEnabled",
      "isHideButton",
      "isTrackStreaks",
    ] as const)
      if (raw[field] !== undefined && typeof raw[field] !== "boolean")
        invalid(`${field} must be true or false`);
    let icon: string | null = null;
    if (typeof raw.icon === "string" && organizationIconPattern.test(raw.icon))
      icon = raw.icon;
    else if (raw.icon !== undefined && raw.icon !== null && raw.icon !== "")
      issue(
        "counter_notice",
        id,
        "Counter icon is not an icon name or emoji; the counter is imported without an icon",
      );
    const trackStreaks = raw.isTrackStreaks === true;
    let minValue = 1;
    if (
      raw.streakMinValue === undefined ||
      raw.streakMinValue === null ||
      raw.streakMinValue === 0
    ) {
      if (trackStreaks)
        issue(
          "counter_notice",
          id,
          "Streak tracking has no minimum; a day counts toward the streak from a value of 1",
        );
    } else if (
      !safeCount(raw.streakMinValue) ||
      raw.streakMinValue > 90_000_000
    )
      invalid("streakMinValue must be a positive whole number");
    else minValue = raw.streakMinValue;
    const mode =
      raw.streakMode === undefined || raw.streakMode === "specific-days"
        ? "weekdays"
        : raw.streakMode === "weekly-frequency"
          ? "weekly_frequency"
          : invalid("streakMode must be specific-days or weekly-frequency");
    let weekdays = defaultWeekdays;
    if (raw.streakWeekDays !== undefined && raw.streakWeekDays !== null) {
      const days = object(raw.streakWeekDays);
      if (
        days === undefined ||
        Object.entries(days).some(
          ([key, value]) => !/^[0-6]$/.test(key) || typeof value !== "boolean",
        )
      )
        invalid("streakWeekDays must map weekdays 0 to 6 to true or false");
      else
        weekdays = Object.entries(days)
          .filter(([, value]) => value === true)
          .map(([key]) => Number(key))
          .toSorted((left, right) => left - right);
    }
    let weeklyFrequency = 3;
    if (
      raw.streakWeeklyFrequency !== undefined &&
      raw.streakWeeklyFrequency !== null
    ) {
      if (
        !safeCount(raw.streakWeeklyFrequency) ||
        raw.streakWeeklyFrequency < 1 ||
        raw.streakWeeklyFrequency > 7
      )
        invalid("streakWeeklyFrequency must be a whole number from 1 to 7");
      else weeklyFrequency = raw.streakWeeklyFrequency;
    }
    let countdownMs: number | null = null;
    if (
      kind === "repeated_countdown" &&
      raw.countdownDuration !== undefined &&
      raw.countdownDuration !== null
    ) {
      if (
        !safeCount(raw.countdownDuration) ||
        raw.countdownDuration < 1_000 ||
        raw.countdownDuration > 86_400_000
      )
        invalid(
          "countdownDuration must be 1 second to 24 hours in milliseconds",
        );
      else countdownMs = raw.countdownDuration;
    }
    if (kind === "repeated_countdown")
      issue(
        "counter_notice",
        id,
        "The countdown timer and its reminder banner are not ported; the counter keeps its countdown length and records completions as a count",
      );
    if (raw.isOn === true)
      issue(
        "counter_notice",
        id,
        "Counter was running in the export; running state is not imported, and time that was not yet saved to countOnDay is not included",
      );
    const values: { day: string; value: number }[] = [];
    const days = raw.countOnDay === undefined ? {} : object(raw.countOnDay);
    if (days === undefined)
      invalid("countOnDay must map calendar dates to values");
    else
      for (const [day, value] of Object.entries(days)) {
        // The source repairs null values to 0; zero days carry nothing.
        if (value === null || value === 0) continue;
        if (!isDate(day) || !safeCount(value)) {
          issue(
            "invalid_counter_value",
            id,
            "countOnDay must map calendar dates to nonnegative whole numbers",
          );
          continue;
        }
        const limit =
          kind === "stopwatch" ? zoneDayLengthMs(day, timeZone) : maxCount;
        if (value > limit) {
          issue(
            "invalid_counter_value",
            id,
            kind === "stopwatch"
              ? `A stopwatch day holds more milliseconds than ${day} has; correct it in Super Productivity before importing`
              : `A day's count exceeds ${maxCount.toLocaleString("en-US")}`,
          );
          continue;
        }
        values.push({ day, value });
      }
    if (kind === undefined || mode === undefined) continue;
    const definition = Object.fromEntries(
      Object.entries(raw).filter(
        ([key]) => key !== "countOnDay" && key !== "isOn",
      ),
    );
    const sourceJson = stableJson(definition);
    counters.push({
      sourceId: id,
      sourceHash: hash(sourceJson),
      sourceJson,
      title,
      kind,
      icon,
      enabled: raw.isEnabled === true,
      hidden: raw.isHideButton === true,
      streak: {
        enabled: trackStreaks,
        minValue,
        mode,
        weekdays,
        weeklyFrequency,
      },
      countdownMs,
      values: values.toSorted((left, right) => (left.day < right.day ? -1 : 1)),
    });
  }
  for (const [field, count] of unknown)
    issue(
      "unknown_counter_field",
      null,
      `${String(count)} counter records contain unreviewed field ${field}`,
    );
  return counters;
};

/** Metric days with any recorded value, mapped to evaluations. */
export const readMetrics = (
  records: ObjectValue,
  order: readonly string[],
  issue: Report,
): SourceEvaluation[] => {
  const evaluations: SourceEvaluation[] = [];
  const unknown = new Map<string, number>();
  let retained = 0;
  for (const id of order) {
    const raw = object(records[id]);
    if (raw?.id !== id || !isDate(id)) {
      issue("invalid_metric", id, "Metric day requires a calendar date ID");
      continue;
    }
    for (const field of Object.keys(raw))
      if (!Object.hasOwn(superProductivityMetricFields, field))
        unknown.set(field, (unknown.get(field) ?? 0) + 1);
    const check = { valid: true };
    const invalid = (detail: string) => {
      check.valid = false;
      issue("invalid_metric", id, detail);
    };
    const text = (field: "notes") => {
      const value = raw[field];
      if (value === undefined || value === null) return "";
      if (typeof value !== "string") {
        invalid(`${field} must be text`);
        return "";
      }
      if (value.trim().length > 5_000)
        invalid(`${field} exceeds 5,000 characters`);
      return value.trim();
    };
    const notes = text("notes");
    let reflection = "";
    if (raw.reflections !== undefined && raw.reflections !== null) {
      const list = raw.reflections;
      if (
        !Array.isArray(list) ||
        list.some(
          (entry) =>
            typeof object(entry)?.text !== "string" ||
            (object(entry)?.created !== undefined &&
              !safeCount(object(entry)?.created)),
        )
      )
        invalid("reflections must list entries with text and a creation time");
      else if (list.length > 1)
        issue(
          "metric_reflections_multiple",
          id,
          "The day has more than one reflection; Super Productivity 19.1.0 keeps one per day. Reduce it to one before importing",
        );
      else {
        const first = object(list[0])?.text;
        reflection = typeof first === "string" ? first.trim() : "";
        if (reflection.length > 5_000)
          invalid("reflection exceeds 5,000 characters");
      }
    }
    const scale = (field: "impactOfWork" | "energyCheckin", max: number) => {
      const value = raw[field];
      if (value === undefined || value === null) return null;
      if (!safeCount(value) || value < 1 || value > max) {
        invalid(`${field} must be a whole number from 1 to ${String(max)}`);
        return null;
      }
      return value;
    };
    const impact = scale("impactOfWork", 4);
    const energy = scale("energyCheckin", 3);
    if (
      raw.remindTomorrow !== undefined &&
      typeof raw.remindTomorrow !== "boolean"
    )
      invalid("remindTomorrow must be true or false");
    const remindTomorrow = raw.remindTomorrow === true;
    let focusSessionsMs: number[] = [];
    if (raw.focusSessions !== undefined && raw.focusSessions !== null) {
      if (
        !Array.isArray(raw.focusSessions) ||
        raw.focusSessions.some(
          (duration) =>
            !safeCount(duration) || duration === 0 || duration > 86_400_000,
        )
      )
        invalid(
          "focusSessions must list positive durations of at most 24 hours in milliseconds",
        );
      else focusSessionsMs = [...(raw.focusSessions as number[])];
    }
    const retainedFields = Object.fromEntries(
      Object.entries(raw).filter(
        ([key, value]) =>
          (superProductivityMetricFields as Record<string, string>)[key] ===
            "retained" &&
          value !== undefined &&
          value !== null,
      ),
    );
    if (Object.keys(retainedFields).length > 0) retained++;
    if (!check.valid) continue;
    const empty =
      notes === "" &&
      reflection === "" &&
      impact === null &&
      energy === null &&
      !remindTomorrow &&
      focusSessionsMs.length === 0;
    if (empty) continue;
    evaluations.push({
      day: id,
      sourceHash: hash(stableJson(raw)),
      sourceJson: stableJson(retainedFields),
      notes,
      reflection,
      impact,
      energy,
      remindTomorrow,
      focusSessionsMs,
    });
  }
  for (const [field, count] of unknown)
    issue(
      "unknown_metric_field",
      null,
      `${String(count)} metric records contain unreviewed field ${field}`,
    );
  if (retained > 0)
    issue(
      "metric_field_retained",
      null,
      `${retained.toLocaleString("en-US")} metric day${retained === 1 ? " has" : "s have"} totalWorkMinutes, completedTasks or plannedTasks; they are kept in import provenance and not shown, since Tadooer derives them from tasks and the worklog`,
    );
  return evaluations.toSorted((left, right) => (left.day < right.day ? -1 : 1));
};

export const counterReconciliation = (
  counters: readonly SourceCounter[],
  evaluations: readonly SourceEvaluation[],
): CounterReconciliation => {
  const values = counters.flatMap((counter) =>
    counter.values.map((value) => ({ kind: counter.kind, ...value })),
  );
  const sessions = evaluations.flatMap(
    (evaluation) => evaluation.focusSessionsMs,
  );
  return {
    definitions: counters.length,
    dayValues: values.length,
    clickCount: values
      .filter(({ kind }) => kind !== "stopwatch")
      .reduce((sum, { value }) => sum + value, 0),
    stopwatchMs: values
      .filter(({ kind }) => kind === "stopwatch")
      .reduce((sum, { value }) => sum + value, 0),
    evaluations: evaluations.length,
    focusSessions: sessions.length,
    focusSessionMs: sessions.reduce((sum, value) => sum + value, 0),
  };
};

const plural = (count: number, word: string) =>
  `${count.toLocaleString("en-US")} ${word}${count === 1 ? "" : "s"}`;

export const counterReconciliationSummary = (
  totals: CounterReconciliation,
  counters: readonly SourceCounter[],
): string =>
  `${plural(totals.definitions, "counter")} (${String(counters.filter(({ values }) => values.length > 0).length)} with values): ` +
  `${plural(totals.dayValues, "day value")}, ${totals.clickCount.toLocaleString("en-US")} counted, ` +
  `${totals.stopwatchMs.toLocaleString("en-US")} stopwatch ms. ` +
  `${plural(totals.evaluations, "evaluation day")} with ${plural(totals.focusSessions, "focus session")} ` +
  `(${totals.focusSessionMs.toLocaleString("en-US")} ms) kept as evaluation history, not added to the worklog. Streaks are derived, not imported.`;
