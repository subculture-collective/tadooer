import { describe, expect, it } from "vitest";
import {
  addCalendarDays,
  calendarDaySpan,
  formatClockDuration,
  splitIntervalByDay,
  validateTimeEntryWrite,
  weekStartOf,
  worklogCsv,
} from "./time-history.ts";

const chicago = "America/Chicago";

describe("focus intervals on owner-zone days", () => {
  it("splits an interval at local midnight", () => {
    // 23:30 CDT on September 23 to 00:45 CDT on September 24.
    expect(
      splitIntervalByDay(
        "2026-09-24T04:30:00.000Z",
        "2026-09-24T05:45:00.000Z",
        chicago,
      ),
    ).toEqual([
      {
        workDate: "2026-09-23",
        startedAt: "2026-09-24T04:30:00.000Z",
        endedAt: "2026-09-24T05:00:00.000Z",
        durationMs: 30 * 60_000,
      },
      {
        workDate: "2026-09-24",
        startedAt: "2026-09-24T05:00:00.000Z",
        endedAt: "2026-09-24T05:45:00.000Z",
        durationMs: 45 * 60_000,
      },
    ]);
  });

  it("uses the 23-hour spring-forward day and the 25-hour fall-back day", () => {
    // March 8, 2026 starts at 06:00Z (CST) and ends at 05:00Z (CDT).
    const spring = splitIntervalByDay(
      "2026-03-08T05:00:00.000Z",
      "2026-03-09T06:00:00.000Z",
      chicago,
    );
    expect(
      spring.map(({ workDate, durationMs }) => [workDate, durationMs]),
    ).toEqual([
      ["2026-03-07", 60 * 60_000],
      ["2026-03-08", 23 * 60 * 60_000],
      ["2026-03-09", 60 * 60_000],
    ]);
    // November 1, 2026 starts at 05:00Z (CDT) and ends at 06:00Z (CST).
    const fall = splitIntervalByDay(
      "2026-11-01T05:00:00.000Z",
      "2026-11-02T06:00:00.000Z",
      chicago,
    );
    expect(
      fall.map(({ workDate, durationMs }) => [workDate, durationMs]),
    ).toEqual([["2026-11-01", 25 * 60 * 60_000]]);
  });

  it("returns nothing for an empty interval and rejects invalid instants", () => {
    expect(
      splitIntervalByDay(
        "2026-09-24T05:00:00.000Z",
        "2026-09-24T05:00:00.000Z",
        chicago,
      ),
    ).toEqual([]);
    expect(() =>
      splitIntervalByDay("nope", "2026-09-24T05:00:00.000Z", chicago),
    ).toThrow(RangeError);
  });
});

describe("calendar arithmetic", () => {
  it("adds days, spans ranges and finds Monday weeks across month ends", () => {
    expect(addCalendarDays("2026-02-28", 1)).toBe("2026-03-01");
    expect(addCalendarDays("2026-03-08", 1)).toBe("2026-03-09");
    expect(calendarDaySpan("2026-09-01", "2026-09-30")).toBe(30);
    expect(calendarDaySpan("2026-01-01", "2026-12-31")).toBe(365);
    expect(weekStartOf("2026-09-24")).toBe("2026-09-21");
    expect(weekStartOf("2026-09-21")).toBe("2026-09-21");
    expect(weekStartOf("2026-03-01")).toBe("2026-02-23");
  });
});

describe("manual time entry rules", () => {
  const active = { deletedAt: null, archivedAt: null };
  const day = (before: number, after: number, focusRunning = false) => ({
    before,
    after,
    focusRunning,
  });

  it("accepts additions and corrections that keep the day between zero and 24 hours", () => {
    expect(
      validateTimeEntryWrite({
        task: active,
        source: "manual",
        durationMs: 30 * 60_000,
        days: [day(0, 30 * 60_000)],
      }),
    ).toBeNull();
    expect(
      validateTimeEntryWrite({
        task: active,
        source: "manual",
        durationMs: -10 * 60_000,
        days: [day(30 * 60_000, 20 * 60_000)],
      }),
    ).toBeNull();
  });

  it("rejects archived or deleted tasks, focus entries and invalid durations", () => {
    const base = { source: "manual" as const, durationMs: 60_000, days: [] };
    expect(
      validateTimeEntryWrite({
        ...base,
        task: { deletedAt: null, archivedAt: "2026-09-24T00:00:00.000Z" },
      }),
    ).toBe("task_unavailable");
    expect(
      validateTimeEntryWrite({
        ...base,
        task: { deletedAt: "2026-09-24T00:00:00.000Z" },
      }),
    ).toBe("task_unavailable");
    expect(validateTimeEntryWrite({ ...base, task: undefined })).toBe(
      "task_unavailable",
    );
    expect(
      validateTimeEntryWrite({ ...base, task: active, source: "focus" }),
    ).toBe("entry_read_only");
    for (const durationMs of [0, 1.5, 86_400_001, -86_400_001])
      expect(
        validateTimeEntryWrite({ ...base, task: active, durationMs }),
      ).toBe("duration_invalid");
    expect(
      validateTimeEntryWrite({
        ...base,
        task: active,
        source: "import",
        durationMs: -60_000,
      }),
    ).toBe("duration_invalid");
  });

  it("keeps task-day totals in range and refuses to lower a day with running focus", () => {
    const write = (change: ReturnType<typeof day>, durationMs: number | null) =>
      validateTimeEntryWrite({
        task: active,
        source: "manual",
        durationMs,
        days: [change],
      });
    expect(write(day(10, -5), -15)).toBe("day_total_negative");
    expect(write(day(86_000_000, 86_500_000), 500_000)).toBe(
      "day_total_exceeds_day",
    );
    expect(write(day(600_000, 300_000, true), -300_000)).toBe("focus_running");
    expect(write(day(600_000, 0, true), null)).toBe("focus_running");
    expect(write(day(600_000, 900_000, true), 300_000)).toBeNull();
  });
});

describe("worklog CSV", () => {
  it("quotes separators, neutralizes formulas and keeps exact milliseconds", () => {
    expect(formatClockDuration(90 * 60_000 + 29_000)).toBe("1:30");
    expect(formatClockDuration(-5 * 60_000)).toBe("-0:05");
    const csv = worklogCsv([
      {
        date: "2026-09-24",
        task: '=HYPERLINK("x")',
        parentTask: "Report, draft",
        project: "",
        durationMs: 5_400_123,
        estimateMinutes: 120,
        sources: ["focus", "manual"],
      },
      {
        date: "2026-09-24",
        task: "-negative text",
        parentTask: "",
        project: "Ops",
        durationMs: -300_000,
        estimateMinutes: null,
        sources: ["manual"],
      },
    ]);
    expect(csv.split("\r\n")).toEqual([
      "Date,Task,Parent task,Project,Time (h:mm),Hours,Milliseconds,Estimate (h:mm),Sources",
      `2026-09-24,"'=HYPERLINK(""x"")","Report, draft",,1:30,1.50,5400123,2:00,focus manual`,
      "2026-09-24,'-negative text,,Ops,-0:05,-0.08,-300000,,manual",
      "",
    ]);
  });
});
