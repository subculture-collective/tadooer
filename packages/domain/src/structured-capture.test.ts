import { describe, expect, it } from "vitest";
import {
  parseStructuredCapture,
  resolveCaptureReferences,
} from "./structured-capture.ts";

const context = {
  at: new Date("2026-08-21T12:00:00.000Z"),
  timezoneOffsetMinutes: 0,
};

describe("parseStructuredCapture", () => {
  it("protects quoted and escaped markers and rejects incomplete syntax", () => {
    expect(
      parseStructuredCapture(
        String.raw`Discuss \#1 +"Work + Home" #"high ! priority"`,
        context,
      ),
    ).toMatchObject({
      title: "Discuss #1",
      projectName: "Work + Home",
      tagNames: ["high ! priority"],
    });
    expect(
      parseStructuredCapture(`"Read @home" !tomorrow`, context).title,
    ).toBe("Read @home");
    for (const input of [
      'Task +"unfinished',
      "Task +",
      "Task !tomorrow nonsense",
      "Task +One +Two",
      "Task \\ \\ \\ \\".trim(),
    ])
      expect(() => parseStructuredCapture(input, context)).toThrow();
  });

  it("uses the target date's timezone offset and rejects DST gaps and folds", () => {
    const zoned = {
      ...context,
      at: new Date("2026-10-20T12:00:00Z"),
      timeZone: "America/Chicago",
    };
    expect(
      parseStructuredCapture("Review @November 3, 2026 09:00", zoned)
        .plannedStart,
    ).toBe("2026-11-03T15:00:00.000Z");
    expect(
      parseStructuredCapture("Review !November 3, 2026", zoned).deadline,
    ).toEqual({ kind: "date", value: "2026-11-03" });
    expect(() =>
      parseStructuredCapture("Review @November 1, 2026 01:30", zoned),
    ).toThrow("daylight saving");
    expect(() =>
      parseStructuredCapture("Review @March 8, 2027 02:30", zoned),
    ).not.toThrow();
    expect(() =>
      parseStructuredCapture("Review @March 8, 2026 02:30", {
        ...zoned,
        at: new Date("2026-03-01T00:00:00Z"),
      }),
    ).toThrow("daylight saving");
    expect(
      parseStructuredCapture("Review @November 1, 2026 01:30 -0500", zoned)
        .plannedStart,
    ).toBe("2026-11-01T06:30:00.000Z");
  });

  it("rejects unknown, archived, and ambiguous names without creating references", () => {
    const capture = parseStructuredCapture("Review +Work #urgent", context);
    const project = { id: "project", title: "Work", archivedAt: null };
    const tag = { id: "tag", displayName: "urgent", archivedAt: null };
    expect(resolveCaptureReferences(capture, [project], [tag])).toEqual({
      projectId: "project",
      tagIds: ["tag"],
    });
    expect(() => resolveCaptureReferences(capture, [], [tag])).toThrow(
      "unknown",
    );
    expect(() =>
      resolveCaptureReferences(
        capture,
        [project, { ...project, id: "second" }],
        [tag],
      ),
    ).toThrow("ambiguous");
    expect(() =>
      resolveCaptureReferences(
        capture,
        [{ ...project, archivedAt: "2026-01-01" }],
        [tag],
      ),
    ).toThrow("archived");
    expect(() => resolveCaptureReferences(capture, [project], [])).toThrow(
      "Tag",
    );
  });
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
