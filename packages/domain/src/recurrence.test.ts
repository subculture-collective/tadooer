import { describe, expect, it } from "vitest";
import {
  isOccurrence,
  nextOccurrence,
  nthWeekdayOfMonth,
  planGeneration,
  previousOccurrence,
  upcomingOccurrences,
  validateRecurrenceRule,
  zonedStartInstant,
  type RecurrenceRule,
  type RecurrenceWindow,
} from "./recurrence.ts";

const rule = (overrides: Partial<RecurrenceRule>): RecurrenceRule => ({
  cycle: "daily",
  interval: 1,
  weekdays: [],
  monthly: null,
  ...overrides,
});
const window = (
  startDate: string,
  overrides: Partial<RecurrenceWindow> = {},
): RecurrenceWindow => ({
  startDate,
  endDate: null,
  anchorDate: startDate,
  ...overrides,
});

describe("recurrence rules", () => {
  it("validates cycle-specific fields", () => {
    const from = { startDate: "2026-09-01", endDate: null };
    expect(validateRecurrenceRule(rule({ interval: 0 }), from)).toBe(
      "interval_invalid",
    );
    expect(validateRecurrenceRule(rule({ cycle: "weekly" }), from)).toBe(
      "weekdays_required",
    );
    expect(
      validateRecurrenceRule(rule({ cycle: "weekly", weekdays: [3, 1] }), from),
    ).toBe("weekdays_invalid");
    expect(validateRecurrenceRule(rule({ weekdays: [1] }), from)).toBe(
      "weekdays_not_weekly",
    );
    expect(validateRecurrenceRule(rule({ cycle: "monthly" }), from)).toBe(
      "monthly_anchor_required",
    );
    expect(
      validateRecurrenceRule(rule({}), {
        startDate: "2026-09-02",
        endDate: "2026-09-01",
      }),
    ).toBe("end_before_start");
    expect(
      validateRecurrenceRule(
        rule({
          cycle: "monthly",
          monthly: { kind: "nth_weekday", week: -1, weekday: 5 },
        }),
        from,
      ),
    ).toBeNull();
  });

  it("repeats every n days and weeks from the anchor date", () => {
    const everyThird = rule({ interval: 3 });
    expect(
      upcomingOccurrences(everyThird, window("2026-09-01"), "2026-09-02", 3),
    ).toEqual(["2026-09-04", "2026-09-07", "2026-09-10"]);
    // Every second week on Monday and Thursday; the 2026-09-01 block is on.
    const biweekly = rule({ cycle: "weekly", interval: 2, weekdays: [1, 4] });
    expect(
      upcomingOccurrences(biweekly, window("2026-09-01"), "2026-09-01", 4),
    ).toEqual(["2026-09-03", "2026-09-07", "2026-09-17", "2026-09-21"]);
    expect(
      previousOccurrence(biweekly, window("2026-09-01"), "2026-09-16"),
    ).toBe("2026-09-07");
  });

  it("clamps a month-end day of month and keeps the last-day anchor", () => {
    const monthEnd = rule({
      cycle: "monthly",
      monthly: { kind: "day_of_month" },
    });
    expect(
      upcomingOccurrences(monthEnd, window("2026-01-31"), "2026-01-01", 4),
    ).toEqual(["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30"]);
    const lastDay = rule({ cycle: "monthly", monthly: { kind: "last_day" } });
    // The last-day anchor never backdates: the first date is the start month's end.
    expect(
      upcomingOccurrences(lastDay, window("2026-09-10"), "2026-09-10", 3),
    ).toEqual(["2026-09-30", "2026-10-31", "2026-11-30"]);
    expect(
      upcomingOccurrences(
        rule({ cycle: "monthly", interval: 3, monthly: { kind: "last_day" } }),
        window("2024-02-01"),
        "2024-02-01",
        2,
      ),
    ).toEqual(["2024-02-29", "2024-05-31"]);
  });

  it("finds Nth and last weekdays and never precedes the start date", () => {
    expect(nthWeekdayOfMonth(2026, 9, 1, 1)).toBe("2026-09-07");
    expect(nthWeekdayOfMonth(2026, 9, 5, -1)).toBe("2026-09-25");
    expect(nthWeekdayOfMonth(2026, 2, 0, -1)).toBe("2026-02-22");
    expect(nthWeekdayOfMonth(2026, 2, 0, 4)).toBe("2026-02-22");
    const firstMonday = rule({
      cycle: "monthly",
      monthly: { kind: "nth_weekday", week: 1, weekday: 1 },
    });
    expect(
      nextOccurrence(firstMonday, window("2026-09-10"), "2026-09-10"),
    ).toBe("2026-10-05");
    expect(isOccurrence(firstMonday, window("2026-09-10"), "2026-09-07")).toBe(
      false,
    );
  });

  it("moves February 29 to February 28 in common years", () => {
    const yearly = rule({ cycle: "yearly" });
    expect(
      upcomingOccurrences(yearly, window("2024-02-29"), "2024-01-01", 3),
    ).toEqual(["2024-02-29", "2025-02-28", "2026-02-28"]);
    expect(
      previousOccurrence(
        rule({ cycle: "yearly", interval: 2 }),
        window("2024-09-24"),
        "2027-01-01",
      ),
    ).toBe("2026-09-24");
  });

  it("respects the end date", () => {
    const bounded = window("2026-09-01", { endDate: "2026-09-03" });
    expect(upcomingOccurrences(rule({}), bounded, "2026-09-01", 9)).toEqual([
      "2026-09-01",
      "2026-09-02",
      "2026-09-03",
    ]);
    expect(previousOccurrence(rule({}), bounded, "2027-01-01")).toBe(
      "2026-09-03",
    );
  });

  it("scans in time proportional to the interval, not to downtime", () => {
    const started = performance.now();
    expect(
      previousOccurrence(
        rule({ cycle: "weekly", weekdays: [2] }),
        window("1970-01-01"),
        "2999-12-31",
      ),
    ).toBe("2999-12-31");
    expect(performance.now() - started).toBeLessThan(250);
  });
});

describe("generation planning", () => {
  const daily = rule({});
  it("creates only the newest missed occurrence after downtime", () => {
    expect(
      planGeneration({
        rule: daily,
        window: window("2026-01-01"),
        cursorDate: "2026-09-01",
        floorDate: null,
        today: "2026-09-24",
        missed: "latest",
      }),
    ).toEqual({ kind: "create", date: "2026-09-24" });
    // Weekly on Monday: downtime ending on a Thursday creates last Monday.
    expect(
      planGeneration({
        rule: rule({ cycle: "weekly", weekdays: [1] }),
        window: window("2026-01-01"),
        cursorDate: "2026-08-31",
        floorDate: null,
        today: "2026-09-24",
        missed: "latest",
      }),
    ).toEqual({ kind: "create", date: "2026-09-21" });
  });

  it("skips a missed occurrence by advancing the cursor only", () => {
    expect(
      planGeneration({
        rule: rule({ cycle: "weekly", weekdays: [1] }),
        window: window("2026-01-01"),
        cursorDate: "2026-08-31",
        floorDate: null,
        today: "2026-09-24",
        missed: "skip",
      }),
    ).toEqual({ kind: "advance", date: "2026-09-21" });
  });

  it("does nothing when the cursor or resume floor already covers today", () => {
    const base = {
      rule: daily,
      window: window("2026-01-01"),
      today: "2026-09-24",
      missed: "latest" as const,
    };
    expect(
      planGeneration({ ...base, cursorDate: "2026-09-24", floorDate: null }),
    ).toEqual({ kind: "none" });
    expect(
      planGeneration({
        ...base,
        rule: rule({ cycle: "weekly", weekdays: [1] }),
        cursorDate: null,
        floorDate: "2026-09-24",
      }),
    ).toEqual({ kind: "none" });
  });
});

describe("zoned start instants", () => {
  it("keeps the wall-clock time across America/Chicago transitions", () => {
    expect(zonedStartInstant("2026-03-07", "09:00", "America/Chicago")).toBe(
      "2026-03-07T15:00:00.000Z",
    );
    expect(zonedStartInstant("2026-03-08", "09:00", "America/Chicago")).toBe(
      "2026-03-08T14:00:00.000Z",
    );
    expect(zonedStartInstant("2026-10-31", "09:00", "America/Chicago")).toBe(
      "2026-10-31T14:00:00.000Z",
    );
    expect(zonedStartInstant("2026-11-01", "09:00", "America/Chicago")).toBe(
      "2026-11-01T15:00:00.000Z",
    );
  });

  it("moves a skipped time forward and takes the first repeated time", () => {
    // 02:30 does not exist on 2026-03-08; it becomes 03:30 CDT.
    expect(zonedStartInstant("2026-03-08", "02:30", "America/Chicago")).toBe(
      "2026-03-08T08:30:00.000Z",
    );
    // 01:30 happens twice on 2026-11-01; the CDT one comes first.
    expect(zonedStartInstant("2026-11-01", "01:30", "America/Chicago")).toBe(
      "2026-11-01T06:30:00.000Z",
    );
  });
});
