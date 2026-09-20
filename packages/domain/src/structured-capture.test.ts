import { describe, expect, it } from "vitest";
import { parseStructuredCapture } from "./structured-capture.ts";

const context = {
  at: new Date("2026-08-21T12:00:00.000Z"),
  timezoneOffsetMinutes: 0,
};

describe("parseStructuredCapture", () => {
  it("separates title, organization, planned time, and date deadline", () => {
    expect(
      parseStructuredCapture(
        "Prepare review +Suite #frontend #urgent @tomorrow 09:00 !Friday",
        context,
      ),
    ).toEqual({
      title: "Prepare review",
      projectName: "Suite",
      tagNames: ["frontend", "urgent"],
      plannedStart: "2026-08-22T09:00:00.000Z",
      deadline: { kind: "date", value: "2026-08-28" },
    });
  });

  it("rejects planned dates without a time", () => {
    expect(() => parseStructuredCapture("Plan @tomorrow", context)).toThrow(
      "planned time must include a time of day",
    );
  });
});
