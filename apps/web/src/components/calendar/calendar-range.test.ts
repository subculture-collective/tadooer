import { describe, expect, it } from "vitest";
import { buildCalendarRange } from "./calendar-range.ts";

describe("buildCalendarRange", () => {
  it("builds a Monday-start week in the supplied timezone", () => {
    expect(
      buildCalendarRange("week", new Date("2026-08-19T12:00:00.000Z"), "UTC"),
    ).toEqual({
      from: "2026-08-17T00:00:00.000Z",
      to: "2026-08-24T00:00:00.000Z",
    });
  });

  it("uses three local calendar days for the three-day view", () => {
    const range = buildCalendarRange(
      "3day",
      new Date("2026-08-19T12:00:00.000Z"),
      "America/Chicago",
    );

    expect(range).toEqual({
      from: "2026-08-19T05:00:00.000Z",
      to: "2026-08-22T05:00:00.000Z",
    });
  });
});
