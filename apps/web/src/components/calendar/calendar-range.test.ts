import { describe, expect, it } from "vitest";
import { buildCalendarRange, shiftCalendarAnchor } from "./calendar-range.ts";

describe("buildCalendarRange", () => {
  it("uses the 23-hour spring day and 25-hour fall day", () => {
    expect(
      buildCalendarRange(
        "day",
        new Date("2026-03-08T12:00:00Z"),
        "America/Chicago",
      ),
    ).toEqual({
      from: "2026-03-08T06:00:00.000Z",
      to: "2026-03-09T05:00:00.000Z",
    });
    expect(
      buildCalendarRange(
        "day",
        new Date("2026-11-01T12:00:00Z"),
        "America/Chicago",
      ),
    ).toEqual({
      from: "2026-11-01T05:00:00.000Z",
      to: "2026-11-02T06:00:00.000Z",
    });
  });
  it("moves one local date even near midnight across DST", () => {
    const next = shiftCalendarAnchor(
      "day",
      new Date("2026-03-08T05:30:00Z"),
      1,
      "America/Chicago",
    );
    expect(buildCalendarRange("day", next, "America/Chicago").from).toBe(
      "2026-03-08T06:00:00.000Z",
    );
    const previous = shiftCalendarAnchor(
      "day",
      new Date("2026-11-02T06:30:00Z"),
      -1,
      "America/Chicago",
    );
    expect(buildCalendarRange("day", previous, "America/Chicago").from).toBe(
      "2026-11-01T05:00:00.000Z",
    );
  });
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
