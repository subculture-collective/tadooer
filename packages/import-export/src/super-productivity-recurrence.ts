import { createHash } from "node:crypto";
import {
  fieldsWith,
  populated,
  superProductivitySystemTagIds,
  type FieldDisposition,
} from "./super-productivity-schema.ts";

/**
 * Super Productivity 19.1.0 repeat configurations (issue #42, ADR 0023).
 * Every TaskRepeatCfgCopy field is classified; an unreviewed field blocks.
 */
export const superProductivityRepeatCfgFields = {
  id: "applied",
  title: "applied",
  notes: "applied",
  projectId: "applied",
  tagIds: "applied",
  defaultEstimate: "applied",
  // Instance start time and its reminder option (TaskReminderOptionId).
  startTime: "applied",
  remindAt: "applied",
  isPaused: "applied",
  repeatCycle: "applied",
  repeatEvery: "applied",
  startDate: "applied",
  monday: "applied",
  tuesday: "applied",
  wednesday: "applied",
  thursday: "applied",
  friday: "applied",
  saturday: "applied",
  sunday: "applied",
  monthlyWeekOfMonth: "applied",
  monthlyWeekday: "applied",
  monthlyLastDay: "applied",
  repeatFromCompletionDate: "applied",
  waitForCompletion: "applied",
  skipOverdue: "applied",
  shouldInheritSubtasks: "applied",
  subTaskTemplates: "applied",
  deletedInstanceDates: "applied",
  // Generation cursor: the newest day the source already handled.
  lastTaskCreationDay: "applied",
  // Legacy epoch form of the cursor, used only when the day is absent.
  lastTaskCreation: "applied",
  // Deprecated insert position; Tadooer has no manual task order yet.
  order: "retained",
  // Tadooer never copies an instance's child edits back into the templates.
  disableAutoUpdateSubtasks: "retained",
  // Form preset derived from the pattern fields.
  quickSetting: "ignored",
} as const satisfies Record<string, FieldDisposition>;

type Source = Readonly<Record<string, unknown>>;
const object = (value: unknown): Source =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Source)
    : {};

/** Stored recurrence rule; mirrors @suite/domain RecurrenceRule. */
export interface ImportedRecurrenceRule {
  readonly cycle: "daily" | "weekly" | "monthly" | "yearly";
  readonly interval: number;
  readonly weekdays: readonly number[];
  readonly monthly:
    | { readonly kind: "day_of_month" }
    | { readonly kind: "last_day" }
    | {
        readonly kind: "nth_weekday";
        readonly week: 1 | 2 | 3 | 4 | -1;
        readonly weekday: number;
      }
    | null;
}

/** One repeat configuration mapped to a Tadooer recurring series. */
export interface SuperProductivitySeriesRecord {
  readonly sourceId: string;
  readonly sourceHash: string;
  readonly sourceJson: string;
  readonly title: string;
  readonly notes: string;
  readonly projectSourceId: string | null;
  readonly tagSourceIds: readonly string[];
  readonly estimateMinutes: number | null;
  readonly rule: ImportedRecurrenceRule;
  readonly startDate: string;
  readonly endDate: null;
  readonly startTime: string | null;
  readonly startReminder:
    | { readonly kind: "default" }
    | { readonly kind: "none" }
    | { readonly kind: "before_start"; readonly minutes: number };
  readonly anchor: "schedule" | "completion";
  readonly anchorDate: string;
  readonly waitForCompletion: boolean;
  readonly missedOccurrences: "skip" | "latest";
  readonly childTemplates: readonly {
    readonly title: string;
    readonly notes: string;
    readonly estimateMinutes: number | null;
  }[];
  readonly paused: boolean;
  readonly cursorDate: string | null;
  readonly deletedDates: readonly string[];
  readonly createdAt: null;
}

export interface SuperProductivityOccurrenceLink {
  readonly taskSourceId: string;
  readonly seriesSourceId: string;
  readonly occurrenceDate: string;
}

const isDate = (value: unknown): value is string =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(`${value}T00:00:00.000Z`)) &&
  new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;

const dateFormatters = new Map<string, Intl.DateTimeFormat>();
/** The calendar date of an epoch-millisecond instant in a time zone. */
export const localDate = (epoch: number, timeZone: string): string | null => {
  if (
    !Number.isSafeInteger(epoch) ||
    !Number.isFinite(new Date(epoch).getTime())
  )
    return null;
  let formatter = dateFormatters.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    dateFormatters.set(timeZone, formatter);
  }
  const parts = formatter.formatToParts(new Date(epoch));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value ?? "";
  const date = `${part("year")}-${part("month")}-${part("day")}`;
  return isDate(date) ? date : null;
};

/** TaskReminderOptionId to a start reminder; undefined when unknown. */
const reminderOptions: Readonly<
  Record<string, SuperProductivitySeriesRecord["startReminder"]>
> = {
  DoNotRemind: { kind: "none" },
  AtStart: { kind: "before_start", minutes: 0 },
  m5: { kind: "before_start", minutes: 5 },
  m10: { kind: "before_start", minutes: 10 },
  m15: { kind: "before_start", minutes: 15 },
  m30: { kind: "before_start", minutes: 30 },
  h1: { kind: "before_start", minutes: 60 },
};

const weekdayFields = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
] as const;

/** Whole minutes up to 720 from milliseconds; null for empty, undefined if not representable. */
const minutes = (value: unknown): number | null | undefined => {
  if (value === undefined || value === null || value === 0) return null;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value % 60000 !== 0 ||
    value > 720 * 60000
  )
    return undefined;
  return value / 60000;
};

/**
 * Maps every repeat configuration or reports why it cannot be represented.
 * `problem` findings block apply; `notice` findings are reported only.
 */
export const mapRepeatConfigs = (
  repeats: Source,
  context: {
    readonly projects: Source;
    readonly tags: Source;
    readonly timeZone: string;
    readonly problem: (sourceId: string, detail: string) => void;
    readonly notice: (sourceId: string, detail: string) => void;
  },
): Map<string, SuperProductivitySeriesRecord> => {
  const mapped = new Map<string, SuperProductivitySeriesRecord>();
  const systemTags = new Set<string>(superProductivitySystemTagIds);
  for (const [sourceId, value] of Object.entries(repeats)) {
    const cfg = object(value);
    let valid = true;
    const fail = (detail: string) => {
      valid = false;
      context.problem(sourceId, detail);
    };
    for (const field of Object.keys(cfg))
      if (!Object.hasOwn(superProductivityRepeatCfgFields, field))
        fail(`Unreviewed repeat configuration field ${field} blocks import`);
    if (cfg.id !== sourceId) fail("Repeat configuration identity is invalid");
    const title = typeof cfg.title === "string" ? cfg.title.trim() : "";
    if (title === "" || title.length > 240)
      fail("Repeat configuration needs a title of 1 to 240 characters");
    const notes = cfg.notes ?? "";
    if (typeof notes !== "string" || notes.length > 20000)
      fail("Repeat configuration notes must be text up to 20,000 characters");
    const cycle = {
      DAILY: "daily",
      WEEKLY: "weekly",
      MONTHLY: "monthly",
      YEARLY: "yearly",
    }[typeof cfg.repeatCycle === "string" ? cfg.repeatCycle : ""] as
      ImportedRecurrenceRule["cycle"] | undefined;
    if (cycle === undefined)
      fail("repeatCycle must be DAILY, WEEKLY, MONTHLY or YEARLY");
    const interval = cfg.repeatEvery;
    if (
      typeof interval !== "number" ||
      !Number.isInteger(interval) ||
      interval < 1 ||
      interval > 366
    )
      fail("repeatEvery must be a whole number from 1 to 366");
    if (!isDate(cfg.startDate))
      fail(
        "startDate is required; Super Productivity would count the pattern from 1970-01-01",
      );
    const weekdays = weekdayFields.flatMap((field, day) =>
      cfg[field] === true ? [day] : [],
    );
    for (const field of weekdayFields)
      if (cfg[field] !== undefined && typeof cfg[field] !== "boolean")
        fail(`${field} must be Boolean`);
    if (cycle === "weekly" && weekdays.length === 0)
      fail("A weekly repeat configuration needs at least one weekday");
    // The Nth-weekday anchor needs both fields in range; otherwise the source
    // falls back to the start date's day of month. It wins over monthlyLastDay.
    const week = cfg.monthlyWeekOfMonth;
    const weekday = cfg.monthlyWeekday;
    const nth =
      (week === -1 || week === 1 || week === 2 || week === 3 || week === 4) &&
      typeof weekday === "number" &&
      Number.isInteger(weekday) &&
      weekday >= 0 &&
      weekday <= 6;
    const monthly: ImportedRecurrenceRule["monthly"] =
      cycle !== "monthly"
        ? null
        : nth
          ? { kind: "nth_weekday", week, weekday }
          : cfg.monthlyLastDay === true
            ? { kind: "last_day" }
            : { kind: "day_of_month" };
    // A start time schedules instances only together with a reminder option,
    // as in the source; without one the instance is date-only.
    let startTime: string | null = null;
    let startReminder: SuperProductivitySeriesRecord["startReminder"] = {
      kind: "default",
    };
    if (populated(cfg.startTime)) {
      const match =
        typeof cfg.startTime === "string"
          ? /^(\d{1,2}):(\d{2})$/.exec(cfg.startTime)
          : null;
      const hour = Number(match?.[1]);
      const minute = Number(match?.[2]);
      if (match === null || hour > 23 || minute > 59)
        fail("startTime must be a 24-hour H:MM or HH:MM time");
      else if (!populated(cfg.remindAt))
        context.notice(
          sourceId,
          "startTime has no reminder option, so Super Productivity creates date-only instances; Tadooer does the same and keeps the time in import provenance",
        );
      else {
        const option =
          typeof cfg.remindAt === "string"
            ? reminderOptions[cfg.remindAt]
            : undefined;
        if (option === undefined)
          fail("remindAt must be a Super Productivity reminder option");
        else {
          startTime = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
          startReminder = option;
        }
      }
    }
    const estimate = minutes(cfg.defaultEstimate);
    if (estimate === undefined)
      fail("defaultEstimate must be whole minutes up to 720");
    const projectId =
      typeof cfg.projectId === "string" && cfg.projectId !== ""
        ? cfg.projectId
        : null;
    if (cfg.projectId != null && cfg.projectId !== "" && projectId === null)
      fail("projectId must be a project ID");
    if (projectId !== null && !Object.hasOwn(context.projects, projectId))
      fail("Repeat configuration references a project absent from the export");
    const tagIds: string[] = [];
    if (cfg.tagIds !== undefined && !Array.isArray(cfg.tagIds))
      fail("tagIds must contain tag IDs");
    for (const tagId of Array.isArray(cfg.tagIds) ? cfg.tagIds : []) {
      if (typeof tagId !== "string" || tagId === "TODAY") continue;
      if (systemTags.has(tagId))
        fail(
          "Repeat configuration uses a Super Productivity priority or board tag that is not imported as an ordinary tag",
        );
      else if (!Object.hasOwn(context.tags, tagId))
        fail("Repeat configuration references a tag absent from the export");
      else if (!tagIds.includes(tagId)) tagIds.push(tagId);
    }
    if (tagIds.length > 25) fail("Repeat configuration has more than 25 tags");
    for (const flag of [
      "isPaused",
      "repeatFromCompletionDate",
      "waitForCompletion",
      "skipOverdue",
      "shouldInheritSubtasks",
      "monthlyLastDay",
    ])
      if (cfg[flag] !== undefined && typeof cfg[flag] !== "boolean")
        fail(`${flag} must be Boolean`);
    // Templates apply only when the source would inherit them.
    const childTemplates: SuperProductivitySeriesRecord["childTemplates"][number][] =
      [];
    if (
      cfg.subTaskTemplates !== undefined &&
      !Array.isArray(cfg.subTaskTemplates)
    )
      fail("subTaskTemplates must be a list");
    const templates = Array.isArray(cfg.subTaskTemplates)
      ? cfg.subTaskTemplates
      : [];
    if (cfg.shouldInheritSubtasks === true) {
      if (templates.length > 20)
        fail("More than 20 subtask templates cannot be represented");
      for (const raw of templates) {
        const template = object(raw);
        const templateTitle =
          typeof template.title === "string" ? template.title.trim() : "";
        const templateNotes = template.notes ?? "";
        const templateEstimate = minutes(template.timeEstimate);
        if (
          templateTitle === "" ||
          templateTitle.length > 240 ||
          typeof templateNotes !== "string" ||
          templateNotes.length > 20000 ||
          templateEstimate === undefined
        ) {
          fail(
            "A subtask template needs a title, notes up to 20,000 characters and an estimate in whole minutes up to 720",
          );
          continue;
        }
        childTemplates.push({
          title: templateTitle,
          notes: templateNotes,
          estimateMinutes: templateEstimate,
        });
      }
    } else if (templates.length > 0)
      context.notice(
        sourceId,
        "Subtask templates are not inherited in Super Productivity; they are kept in import provenance and not applied",
      );
    const deletedDates = Array.isArray(cfg.deletedInstanceDates)
      ? cfg.deletedInstanceDates
      : [];
    if (
      (cfg.deletedInstanceDates !== undefined &&
        !Array.isArray(cfg.deletedInstanceDates)) ||
      !deletedDates.every(isDate)
    )
      fail("deletedInstanceDates must contain calendar dates");
    let cursorDate: string | null = null;
    if (populated(cfg.lastTaskCreationDay)) {
      if (!isDate(cfg.lastTaskCreationDay))
        fail("lastTaskCreationDay must be a calendar date");
      else cursorDate = cfg.lastTaskCreationDay;
    } else if (populated(cfg.lastTaskCreation)) {
      cursorDate =
        typeof cfg.lastTaskCreation === "number"
          ? localDate(cfg.lastTaskCreation, context.timeZone)
          : null;
      if (cursorDate === null)
        fail("lastTaskCreation must be an epoch-millisecond timestamp");
    }
    if (!valid || cycle === undefined || !isDate(cfg.startDate)) continue;
    // Keep reviewed fields in provenance; nothing else is stored.
    const preserved = Object.fromEntries(
      fieldsWith(superProductivityRepeatCfgFields, "applied", "retained")
        .filter((key) => cfg[key] !== undefined)
        .map((key) => [key, cfg[key]]),
    );
    const sourceJson = JSON.stringify(preserved);
    const completion = cfg.repeatFromCompletionDate === true;
    mapped.set(sourceId, {
      sourceId,
      sourceJson,
      sourceHash: createHash("sha256").update(sourceJson).digest("hex"),
      title,
      notes: typeof notes === "string" ? notes : "",
      projectSourceId: projectId,
      tagSourceIds: tagIds,
      estimateMinutes: estimate ?? null,
      rule: {
        cycle,
        interval: interval as number,
        weekdays: cycle === "weekly" ? weekdays : [],
        monthly,
      },
      startDate: cfg.startDate,
      endDate: null,
      startTime,
      startReminder,
      anchor: completion ? "completion" : "schedule",
      // The source counts a completion-based pattern from lastTaskCreationDay.
      anchorDate:
        completion && cursorDate !== null && cursorDate > cfg.startDate
          ? cursorDate
          : cfg.startDate,
      waitForCompletion: cfg.waitForCompletion === true,
      missedOccurrences: cfg.skipOverdue === true ? "skip" : "latest",
      childTemplates,
      paused: cfg.isPaused === true,
      cursorDate,
      deletedDates: [...new Set(deletedDates as string[])].toSorted(),
      createdAt: null,
    });
  }
  return mapped;
};

/**
 * The occurrence date of a source instance. Instance IDs created since
 * Super Productivity's deterministic IDs carry it (`rpt_<cfg>_<date>`);
 * otherwise the creation time, which the source sets on the repeat day, is
 * read in the owner's zone.
 */
export const occurrenceDateOf = (
  task: Source,
  repeatCfgId: string,
  timeZone: string,
): string | null => {
  const id = typeof task.id === "string" ? task.id : "";
  const prefix = `rpt_${repeatCfgId}_`;
  if (id.startsWith(prefix) && isDate(id.slice(prefix.length)))
    return id.slice(prefix.length);
  return typeof task.created === "number"
    ? localDate(task.created, timeZone)
    : null;
};
