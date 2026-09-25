import { addCalendarDays } from "./recurrence.ts";
import {
  isCalendarDate,
  plannedDayWindow,
  zonedCalendarDate,
} from "./date-only-planning.ts";

/**
 * Work history (issue #41, ADR 0024). A task's tracked time on a calendar day
 * comes from three sources:
 *
 * - `focus`: focus intervals of the server-authoritative active session. They
 *   are projected onto owner-zone days on read and never copied.
 * - `import`: daily totals imported from Super Productivity. They have a day
 *   but no time of day, so no interval is synthesized for them.
 * - `manual`: owner-entered daily totals and corrections.
 */
export const timeEntrySources = ["focus", "import", "manual"] as const;
export type TimeEntrySource = (typeof timeEntrySources)[number];

/** One entry never exceeds a day, and a task-day total stays within one. */
export const maxDayMilliseconds = 86_400_000;
/** Longest report range, inclusive, in days. */
export const maxReportDays = 366;

export interface DaySegment {
  readonly workDate: string;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly durationMs: number;
}

/**
 * Splits the half-open instant range [startedAt, endedAt) at owner-zone
 * midnights. Daylight-saving days are 23 or 25 hours long, so segments follow
 * the zone's calendar days rather than fixed 24-hour steps.
 */
export const splitIntervalByDay = (
  startedAt: string,
  endedAt: string,
  timeZone: string,
): readonly DaySegment[] => {
  const end = Date.parse(endedAt);
  let cursor = Date.parse(startedAt);
  if (!Number.isFinite(cursor) || !Number.isFinite(end))
    throw new RangeError("Invalid interval instant");
  const segments: DaySegment[] = [];
  while (cursor < end) {
    const workDate = zonedCalendarDate(new Date(cursor), timeZone);
    const dayEnd = Date.parse(plannedDayWindow(workDate, timeZone).to);
    const segmentEnd = Math.min(end, dayEnd);
    if (segmentEnd <= cursor)
      throw new RangeError("Day window did not advance");
    segments.push({
      workDate,
      startedAt: new Date(cursor).toISOString(),
      endedAt: new Date(segmentEnd).toISOString(),
      durationMs: segmentEnd - cursor,
    });
    cursor = segmentEnd;
  }
  return segments;
};

const utcDay = (date: string): number => {
  if (!isCalendarDate(date)) throw new RangeError("Invalid calendar date");
  return Date.parse(`${date}T00:00:00.000Z`);
};

/** Calendar-date arithmetic; independent of any time zone. */
// One calendar-day helper is shared with recurrence (ADR 0023).
export { addCalendarDays };

/** Inclusive number of calendar days from `from` to `to`. */
export const calendarDaySpan = (from: string, to: string): number =>
  Math.round((utcDay(to) - utcDay(from)) / 86_400_000) + 1;

/** Monday of the ISO week that contains the date. */
export const weekStartOf = (date: string): string => {
  const weekday = new Date(utcDay(date)).getUTCDay();
  return addCalendarDays(date, -((weekday + 6) % 7));
};

export type TimeEntryViolation =
  | "task_unavailable"
  | "entry_read_only"
  | "duration_invalid"
  | "day_total_negative"
  | "day_total_exceeds_day"
  | "focus_running";

export interface TimeEntryDayChange {
  /** Task-day total from every source before the write. */
  readonly before: number;
  /** Task-day total from every source after the write. */
  readonly after: number;
  /** A focus interval on this task and day is still open. */
  readonly focusRunning: boolean;
}

/**
 * Rules for a manual write (create, edit or delete) of an import or manual
 * entry. Focus entries are projections of the active session and are never
 * edited here; the session owns them.
 *
 * - The task must be active: archived history and soft-deleted tasks are
 *   read-only.
 * - A manual entry is a nonzero whole number of milliseconds within one day;
 *   a negative manual entry is a correction. An imported entry stays positive.
 * - Each affected task-day total stays between zero and one day.
 * - While a focus interval on the task is running on an affected day, a write
 *   that lowers that day's total is refused: the running amount is not final.
 */
export const validateTimeEntryWrite = (input: {
  readonly task:
    | {
        readonly deletedAt: string | null;
        readonly archivedAt?: string | null | undefined;
      }
    | undefined;
  readonly source: "import" | "manual" | "focus";
  /** New duration; null for a delete. */
  readonly durationMs: number | null;
  readonly days: readonly TimeEntryDayChange[];
}): TimeEntryViolation | null => {
  if (input.source === "focus") return "entry_read_only";
  if (input.task?.deletedAt !== null || input.task.archivedAt != null)
    return "task_unavailable";
  const duration = input.durationMs;
  if (
    duration !== null &&
    (!Number.isSafeInteger(duration) ||
      duration === 0 ||
      Math.abs(duration) > maxDayMilliseconds ||
      (input.source === "import" && duration < 0))
  )
    return "duration_invalid";
  for (const day of input.days) {
    if (day.after < 0) return "day_total_negative";
    if (day.after > maxDayMilliseconds) return "day_total_exceeds_day";
  }
  if (input.days.some((day) => day.focusRunning && day.after < day.before))
    return "focus_running";
  return null;
};

/** `h:mm`, rounded to the nearest minute, with a sign for corrections. */
export const formatClockDuration = (milliseconds: number): string => {
  const minutes = Math.round(Math.abs(milliseconds) / 60_000);
  const sign = milliseconds < 0 && minutes > 0 ? "-" : "";
  return `${sign}${String(Math.floor(minutes / 60))}:${String(minutes % 60).padStart(2, "0")}`;
};

export interface WorklogCsvRow {
  readonly date: string;
  readonly task: string;
  readonly parentTask: string;
  readonly project: string;
  readonly durationMs: number;
  readonly estimateMinutes: number | null;
  readonly sources: readonly TimeEntrySource[];
}

/**
 * Leading `= + - @ TAB CR` make spreadsheets evaluate a cell as a formula, so
 * such text cells gain a leading apostrophe (OWASP CSV injection).
 */
const csvCell = (value: string | number, userText = false): string => {
  const raw = String(value);
  const text = userText && /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

export const worklogCsvHeader = [
  "Date",
  "Task",
  "Parent task",
  "Project",
  "Time (h:mm)",
  "Hours",
  "Milliseconds",
  "Estimate (h:mm)",
  "Sources",
] as const;

/**
 * A basic worklog export: one row per task and day, exact milliseconds next
 * to rounded display values. Lines end with CRLF (RFC 4180).
 */
export const worklogCsv = (rows: readonly WorklogCsvRow[]): string =>
  [
    worklogCsvHeader.join(","),
    ...rows.map((row) =>
      [
        csvCell(row.date),
        csvCell(row.task, true),
        csvCell(row.parentTask, true),
        csvCell(row.project, true),
        ...[
          formatClockDuration(row.durationMs),
          (row.durationMs / 3_600_000).toFixed(2),
          row.durationMs,
          row.estimateMinutes === null
            ? ""
            : formatClockDuration(row.estimateMinutes * 60_000),
          row.sources.join(" "),
        ].map((cell) => csvCell(cell)),
      ].join(","),
    ),
  ].join("\r\n") + "\r\n";
