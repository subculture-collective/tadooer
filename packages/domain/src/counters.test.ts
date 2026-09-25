import { describe, expect, it } from "vitest";
import {
  counterStreak,
  dayLengthMs,
  incrementedCounterValue,
  stopwatchDayShares,
  validateCounterDayValue,
  weekdayMask,
  weekdaysFromMask,
  type CounterStreakSettings,
} from "./counters.ts";

const chicago = "America/Chicago";
const hour = 3_600_000;

describe("counter day values in the owner zone", () => {
  it("bounds a stopwatch day by the zone's 23, 24 or 25 hour day", () => {
    expect(dayLengthMs("2026-03-08", chicago)).toBe(23 * hour);
    expect(dayLengthMs("2026-09-24", chicago)).toBe(24 * hour);
    expect(dayLengthMs("2026-11-01", chicago)).toBe(25 * hour);
    const check = (day: string, value: number) =>
      validateCounterDayValue({
        kind: "stopwatch",
        day,
        value,
        timeZone: chicago,
      });
    expect(check("2026-11-01", 25 * hour)).toBeNull();
    expect(check("2026-03-08", 23 * hour + 1)).toBe("value_exceeds_day");
    expect(check("2026-09-24", -1)).toBe("value_invalid");
    expect(check("2026-09-24", 1.5)).toBe("value_invalid");
    expect(check("2026-02-30", 1)).toBe("day_invalid");
    expect(
      validateCounterDayValue({
        kind: "click",
        day: "2026-09-24",
        value: 1_000_001,
        timeZone: chicago,
      }),
    ).toBe("value_exceeds_day");
  });

  it("stops a decrement at zero, as the source does", () => {
    expect(incrementedCounterValue(2, 3)).toBe(5);
    expect(incrementedCounterValue(1, -3)).toBe(0);
  });

  it("splits a stopwatch run at the owner's midnight", () => {
    // 23:30 CDT on September 23 to 00:15 CDT on September 24.
    expect(
      stopwatchDayShares(
        "2026-09-24T04:30:00.000Z",
        "2026-09-24T05:15:00.000Z",
        chicago,
      ),
    ).toEqual([
      { day: "2026-09-23", ms: 30 * 60_000 },
      { day: "2026-09-24", ms: 15 * 60_000 },
    ]);
    // The fall-back day holds all 25 hours of a run from midnight to midnight.
    expect(
      stopwatchDayShares(
        "2026-11-01T05:00:00.000Z",
        "2026-11-02T06:00:00.000Z",
        chicago,
      ),
    ).toEqual([{ day: "2026-11-01", ms: 25 * hour }]);
    expect(
      stopwatchDayShares(
        "2026-09-24T05:00:00.000Z",
        "2026-09-24T05:00:00.000Z",
        chicago,
      ),
    ).toEqual([]);
  });

  it("round-trips weekday masks with Sunday as bit zero", () => {
    expect(weekdayMask([1, 2, 3, 4, 5])).toBe(0b0111110);
    expect(weekdaysFromMask(0b1000001)).toEqual([0, 6]);
  });
});

describe("derived streaks", () => {
  const values = (entries: Record<string, number>) =>
    new Map(Object.entries(entries));
  const weekdays: CounterStreakSettings = {
    enabled: true,
    minValue: 2,
    mode: "weekdays",
    weekdays: [1, 2, 3, 4, 5],
    weeklyFrequency: 3,
  };

  it("returns null when streaks are off and never invents days", () => {
    expect(
      counterStreak({ ...weekdays, enabled: false }, values({}), "2026-09-24"),
    ).toBeNull();
    expect(counterStreak(weekdays, values({}), "2026-09-24")).toBe(0);
    expect(
      counterStreak(
        { ...weekdays, weekdays: [] },
        values({ "2026-09-24": 5 }),
        "2026-09-24",
      ),
    ).toBe(0);
  });

  it("counts selected weekdays back across a weekend and keeps today open", () => {
    // Thursday September 24, 2026; the weekend of the 19th and 20th is skipped.
    const recorded = values({
      "2026-09-17": 2,
      "2026-09-18": 3,
      "2026-09-21": 2,
      "2026-09-22": 2,
      "2026-09-23": 4,
      "2026-09-24": 1,
    });
    // Today is below the minimum but not over yet: Fri 18 through Wed 23.
    expect(counterStreak(weekdays, recorded, "2026-09-24")).toBe(5);
    recorded.set("2026-09-24", 2);
    expect(counterStreak(weekdays, recorded, "2026-09-24")).toBe(6);
    // On Sunday the latest selected weekday is Friday the 25th, which is empty.
    expect(counterStreak(weekdays, recorded, "2026-09-27")).toBe(0);
    // A missed Wednesday ends the run.
    recorded.delete("2026-09-23");
    expect(counterStreak(weekdays, recorded, "2026-09-24")).toBe(1);
  });

  it("counts qualifying days of consecutive Monday weeks for a weekly frequency", () => {
    const weekly: CounterStreakSettings = {
      ...weekdays,
      minValue: 1,
      mode: "weekly_frequency",
      weeklyFrequency: 2,
    };
    // Week of Sep 7: 2 days; week of Sep 14: 3 days; this week so far: 1.
    const recorded = values({
      "2026-09-08": 1,
      "2026-09-10": 1,
      "2026-09-14": 1,
      "2026-09-15": 1,
      "2026-09-20": 1,
      "2026-09-22": 1,
    });
    expect(counterStreak(weekly, recorded, "2026-09-24")).toBe(6);
    recorded.set("2026-09-24", 1);
    expect(counterStreak(weekly, recorded, "2026-09-24")).toBe(7);
    // With no complete week the current week's days are shown.
    expect(
      counterStreak(weekly, values({ "2026-09-22": 1 }), "2026-09-24"),
    ).toBe(1);
  });
});
