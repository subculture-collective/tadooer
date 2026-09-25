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
      newTags: [],
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
      links: [],
    });
  });

  it("resolves a bare weekday after the current planning-zone weekday", () => {
    for (const context of [
      {
        at: new Date("2026-08-22T01:00:00.000Z"),
        timezoneOffsetMinutes: -300,
        timeZone: "America/Chicago",
      },
      {
        at: new Date("2026-08-20T16:00:00.000Z"),
        timezoneOffsetMinutes: 540,
        timeZone: "Asia/Tokyo",
      },
    ]) {
      expect(
        parseStructuredCapture("Review !Friday", context).deadline,
      ).toEqual({ kind: "date", value: "2026-08-28" });
    }
  });

  it("plans a day for @date without a time and a start for @date time (ADR 0020)", () => {
    expect(parseStructuredCapture("Plan @tomorrow", context)).toMatchObject({
      plannedDay: "2026-08-22",
      plannedStart: undefined,
    });
    expect(
      parseStructuredCapture("Plan @tomorrow 14:30", context),
    ).toMatchObject({
      plannedDay: undefined,
      plannedStart: "2026-08-22T14:30:00.000Z",
    });
    expect(() =>
      parseStructuredCapture("Plan @tomorrow @every day", context),
    ).toThrow("Only one planned-time marker");
  });

  it("reports unknown tags as newTags only when allowed, case-folded and deduplicated", () => {
    const capture = parseStructuredCapture(
      "Review #Urgent #urgent #Später #später",
      context,
    );
    const tag = { id: "tag", displayName: "URGENT", archivedAt: null };
    expect(
      resolveCaptureReferences(capture, [], [tag], { allowNewTags: true }),
    ).toEqual({ tagIds: ["tag"], newTags: ["Später"] });
    expect(() => resolveCaptureReferences(capture, [], [tag])).toThrow(
      "confirm tag creation",
    );
    expect(() =>
      resolveCaptureReferences(
        capture,
        [],
        [tag, { id: "old", displayName: "später", archivedAt: "2026-01-01" }],
        { allowNewTags: true },
      ),
    ).toThrow("archived");
  });
});

describe("estimate syntax", () => {
  it.each([
    ["Write report 30m", 30],
    ["Write report 1h", 60],
    ["Write report 1h30m", 90],
    ["Write report 90m", 90],
    ["Write report 1.5h", 90],
    ["Write report 12H", 720],
    ["1h Write report", 60],
    ["Write report +Work 45m", 45],
    ["Write report #deep 2h", 120],
  ])("maps %s to %i minutes", (input, minutes) => {
    const capture = parseStructuredCapture(input, context);
    expect(capture.estimateMinutes).toBe(minutes);
    expect(capture.title).toBe("Write report");
  });

  it("keeps the project or tag name before an estimate word", () => {
    expect(parseStructuredCapture("Do +Work 45m", context)).toMatchObject({
      projectName: "Work",
      estimateMinutes: 45,
    });
    expect(parseStructuredCapture("Do #deep 2h", context)).toMatchObject({
      tagNames: ["deep"],
      estimateMinutes: 120,
    });
  });

  it("rejects out-of-range or fractional-minute estimates instead of rounding", () => {
    expect(() => parseStructuredCapture("Task 0m", context)).toThrow(
      "outside 1–720",
    );
    expect(() => parseStructuredCapture("Task 721m", context)).toThrow(
      "outside 1–720",
    );
    expect(() => parseStructuredCapture("Task 13h", context)).toThrow(
      "outside 1–720",
    );
    expect(() => parseStructuredCapture("Task 1.333h", context)).toThrow(
      "whole number of minutes",
    );
    expect(() => parseStructuredCapture("Task 30m 1h", context)).toThrow(
      "Only one estimate",
    );
  });

  it("leaves quoted, escaped, date and deadline estimate-like words alone", () => {
    expect(parseStructuredCapture('"Run 5k in 1h"', context)).toMatchObject({
      title: "Run 5k in 1h",
      estimateMinutes: undefined,
    });
    expect(
      parseStructuredCapture(String.raw`Run 5k in \1h`, context),
    ).toMatchObject({ title: "Run 5k in 1h", estimateMinutes: undefined });
    expect(() =>
      parseStructuredCapture("Task !tomorrow 9am 30m", context),
    ).toThrow("Could not resolve");
    expect(
      parseStructuredCapture("Task 30m !tomorrow 9am", context),
    ).toMatchObject({ estimateMinutes: 30, deadline: { kind: "instant" } });
    expect(parseStructuredCapture("Task 30min", context)).toMatchObject({
      title: "Task 30min",
      estimateMinutes: undefined,
    });
  });
});

describe("URL handling (ADR 0021 safety)", () => {
  const input = "Read https://example.com/a/b?x=1. and www.example.org/c";

  it("keeps the title and attaches links by default", () => {
    expect(parseStructuredCapture(input, context)).toMatchObject({
      title: input,
      links: [
        {
          title: "https://example.com/a/b?x=1",
          url: "https://example.com/a/b?x=1",
        },
        { title: "www.example.org/c", url: "https://www.example.org/c" },
      ],
    });
  });

  it("removes addresses from the title in extract mode and names a bare address", () => {
    expect(
      parseStructuredCapture(input, context, { urlBehavior: "extract" }),
    ).toMatchObject({ title: "Read and", links: expect.any(Array) });
    expect(
      parseStructuredCapture("https://example.com/docs/guide", context, {
        urlBehavior: "extract",
      }),
    ).toMatchObject({
      title: "example.com guide",
      links: [{ url: "https://example.com/docs/guide" }],
    });
    expect(
      parseStructuredCapture(
        "See [the spec](https://example.com/spec) +Work",
        context,
        { urlBehavior: "extract" },
      ),
    ).toMatchObject({
      title: "See the spec",
      projectName: "Work",
      links: [{ title: "the spec", url: "https://example.com/spec" }],
    });
  });

  it("does nothing in keep mode and never attaches unsafe addresses", () => {
    expect(
      parseStructuredCapture("Read https://user:pw@example.com", context, {
        urlBehavior: "keep",
      }),
    ).toMatchObject({ links: [] });
    expect(() =>
      parseStructuredCapture("Read https://user:pw@example.com", context),
    ).toThrow("user name or password");
    expect(
      parseStructuredCapture("Open file:///etc/passwd ftp://x/y", context),
    ).toMatchObject({ links: [] });
    expect(
      parseStructuredCapture('"https://example.com" literal', context, {
        urlBehavior: "extract",
      }),
    ).toMatchObject({ title: "https://example.com literal", links: [] });
    expect(
      parseStructuredCapture(
        "Same https://example.com/x https://example.com/x",
        context,
      ),
    ).toMatchObject({ links: [{ url: "https://example.com/x" }] });
  });
});

describe("@every recurrence (ADR 0023 mapping)", () => {
  // 2026-08-21 is a Friday.
  it.each([
    ["@every day", { cycle: "daily", interval: 1 }, "2026-08-21", null],
    ["@daily", { cycle: "daily", interval: 1 }, "2026-08-21", null],
    ["@every 3 days", { cycle: "daily", interval: 3 }, "2026-08-21", null],
    [
      "@every week",
      { cycle: "weekly", interval: 1, weekdays: [5] },
      "2026-08-21",
      null,
    ],
    [
      "@every monday",
      { cycle: "weekly", interval: 1, weekdays: [1] },
      "2026-08-24",
      null,
    ],
    [
      "@every 2 fridays 9am",
      { cycle: "weekly", interval: 2, weekdays: [5] },
      "2026-08-21",
      "09:00",
    ],
    [
      "@every weekday at 17:30",
      { cycle: "weekly", interval: 1, weekdays: [1, 2, 3, 4, 5] },
      "2026-08-21",
      "17:30",
    ],
    [
      "@every month",
      { cycle: "monthly", interval: 1, monthly: { kind: "day_of_month" } },
      "2026-08-21",
      null,
    ],
    [
      "@every 15th",
      { cycle: "monthly", interval: 1, monthly: { kind: "day_of_month" } },
      "2026-09-15",
      null,
    ],
    ["@every 31st", { cycle: "monthly", interval: 1 }, "2026-08-31", null],
    ["@yearly", { cycle: "yearly", interval: 1 }, "2026-08-21", null],
    ["@every 2 years", { cycle: "yearly", interval: 2 }, "2026-08-21", null],
  ])("maps %s", (marker, rule, startDate, startTime) => {
    expect(
      parseStructuredCapture(`Task ${marker}`, context).recurrence,
    ).toMatchObject({ rule, startDate, startTime });
  });

  it("starts weekday rules on the next matching day in the planning zone", () => {
    const tokyoSaturday = {
      at: new Date("2026-08-21T16:00:00.000Z"),
      timezoneOffsetMinutes: 540,
      timeZone: "Asia/Tokyo",
    };
    expect(
      parseStructuredCapture("Task @every weekday", tokyoSaturday).recurrence,
    ).toMatchObject({ startDate: "2026-08-24" });
  });

  it("reports unsupported repeat phrases instead of guessing", () => {
    for (const marker of [
      "@every 2nd tuesday",
      "@every other day",
      "@every 0 days",
      "@every 400 days",
      "@every 32nd",
      "@every day 25:00",
      "@every 2 weekdays",
    ])
      expect(() => parseStructuredCapture(`Task ${marker}`, context)).toThrow(
        /Unsupported repeat|Repeat interval|valid time of day/,
      );
  });
});
