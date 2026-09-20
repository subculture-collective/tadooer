import { describe, expect, it } from "vitest";
import { deriveHabitMetrics } from "./habits.ts";

describe("deriveHabitMetrics", () => {
  it("derives daily streaks from immutable occurrence facts", () => {
    expect(
      deriveHabitMetrics(
        { startedOn: "2026-08-18", cadence: { kind: "daily" } },
        [
          { habitId: "habit-1", periodKey: "2026-08-18", completedAt: "2026-08-18T09:00:00.000Z" },
          { habitId: "habit-1", periodKey: "2026-08-20", completedAt: "2026-08-20T09:00:00.000Z" },
          { habitId: "habit-1", periodKey: "2026-08-21", completedAt: "2026-08-21T09:00:00.000Z" },
        ],
        "2026-08-21",
      ),
    ).toEqual({ currentStreak: 2, longestStreak: 2, completedPeriods: 3 });
  });

  it("only counts selected weekdays for weekly habits", () => {
    expect(
      deriveHabitMetrics(
        { startedOn: "2026-08-17", cadence: { kind: "weekly", weekdays: [0, 2] } },
        [
          { habitId: "habit-1", periodKey: "2026-08-17", completedAt: "2026-08-17T09:00:00.000Z" },
          { habitId: "habit-1", periodKey: "2026-08-19", completedAt: "2026-08-19T09:00:00.000Z" },
        ],
        "2026-08-21",
      ),
    ).toEqual({ currentStreak: 2, longestStreak: 2, completedPeriods: 2 });
  });
});
