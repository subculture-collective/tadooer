import { describe, expect, it } from "vitest";
import {
  effectivePlan,
  planSortInstant,
  plannedDayWindow,
  plannedWithinWindow,
  zonedCalendarDate,
} from "./date-only-planning.ts";
import { buildTodayQueue } from "./day-planning.ts";

const hours = (window: { from: string; to: string }): number =>
  (Date.parse(window.to) - Date.parse(window.from)) / 3_600_000;

describe("date-only planning in the owner's time zone", () => {
  it("resolves planned days across America/Chicago daylight-saving changes", () => {
    expect(plannedDayWindow("2026-03-08", "America/Chicago")).toEqual({
      from: "2026-03-08T06:00:00.000Z",
      to: "2026-03-09T05:00:00.000Z",
    });
    expect(hours(plannedDayWindow("2026-03-08", "America/Chicago"))).toBe(23);
    expect(plannedDayWindow("2026-11-01", "America/Chicago")).toEqual({
      from: "2026-11-01T05:00:00.000Z",
      to: "2026-11-02T06:00:00.000Z",
    });
    expect(hours(plannedDayWindow("2026-11-01", "America/Chicago"))).toBe(25);
    expect(hours(plannedDayWindow("2026-07-01", "America/Chicago"))).toBe(24);
  });

  it("resolves days at the extreme UTC offsets and rejects impossible dates", () => {
    expect(plannedDayWindow("2026-09-24", "Pacific/Kiritimati").from).toBe(
      "2026-09-23T10:00:00.000Z",
    );
    expect(plannedDayWindow("2026-09-24", "Etc/GMT+12").from).toBe(
      "2026-09-24T12:00:00.000Z",
    );
    expect(() => plannedDayWindow("2026-02-30", "UTC")).toThrow(RangeError);
  });

  it("uses the owner-local date at midnight boundaries", () => {
    expect(
      zonedCalendarDate("2026-03-09T04:59:59.999Z", "America/Chicago"),
    ).toBe("2026-03-08");
    expect(
      zonedCalendarDate("2026-03-09T05:00:00.000Z", "America/Chicago"),
    ).toBe("2026-03-09");
    expect(
      zonedCalendarDate("2026-11-02T05:59:59.999Z", "America/Chicago"),
    ).toBe("2026-11-01");
    expect(
      zonedCalendarDate("2026-11-02T06:00:00.000Z", "America/Chicago"),
    ).toBe("2026-11-02");
  });

  it("gives an exact start precedence over a legacy planned day", () => {
    const legacy = {
      plannedStart: "2026-09-24T15:00:00.000Z",
      plannedDay: "2026-09-20",
    };
    expect(effectivePlan(legacy)).toEqual({
      kind: "start",
      value: "2026-09-24T15:00:00.000Z",
    });
    expect(effectivePlan({ plannedDay: "2026-09-20" })).toEqual({
      kind: "day",
      value: "2026-09-20",
    });
    expect(effectivePlan({})).toBeNull();
  });

  it("places date-only tasks in planner windows by owner-zone day, never by an invented time", () => {
    const task = { plannedDay: "2026-03-08" };
    const zone = "America/Chicago";
    // Whole 23-hour local day.
    expect(
      plannedWithinWindow(
        task,
        { from: "2026-03-08T06:00:00.000Z", to: "2026-03-09T05:00:00.000Z" },
        zone,
      ),
    ).toBe(true);
    // The next local day starts at 05:00Z after spring-forward.
    expect(
      plannedWithinWindow(
        task,
        { from: "2026-03-09T05:00:00.000Z", to: "2026-03-10T05:00:00.000Z" },
        zone,
      ),
    ).toBe(false);
    // A UTC-day window overlaps the local day even though no time exists.
    expect(
      plannedWithinWindow(
        task,
        { from: "2026-03-08T00:00:00.000Z", to: "2026-03-08T06:00:00.000Z" },
        zone,
      ),
    ).toBe(false);
    expect(
      plannedWithinWindow(
        task,
        { from: "2026-03-08T00:00:00.000Z", to: "2026-03-08T06:00:00.001Z" },
        zone,
      ),
    ).toBe(true);
    expect(planSortInstant(task, zone)).toBe(
      Date.parse("2026-03-08T06:00:00.000Z"),
    );
    expect(planSortInstant({}, zone)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("Today queue with date-only plans", () => {
  const tasks = [
    { id: "yesterday", status: "open" as const, plannedDay: "2026-03-07" },
    { id: "spring-day", status: "open" as const, plannedDay: "2026-03-08" },
    { id: "next-day", status: "open" as const, plannedDay: "2026-03-09" },
    {
      id: "timed-wins",
      status: "open" as const,
      plannedStart: "2026-03-10T15:00:00.000Z",
      plannedDay: "2026-03-08",
    },
    { id: "loose", status: "open" as const },
    { id: "done", status: "completed" as const, plannedDay: "2026-03-08" },
  ];

  it("keeps a planned day on its local date until local midnight on a DST day", () => {
    expect(
      buildTodayQueue({
        at: "2026-03-09T04:59:59.999Z",
        timeZone: "America/Chicago",
        tasks,
      }),
    ).toEqual({
      overdueTaskIds: ["yesterday"],
      scheduledTodayTaskIds: [],
      plannedTodayTaskIds: ["spring-day"],
      unscheduledTaskIds: ["loose"],
      futureScheduledCount: 2,
    });
    expect(
      buildTodayQueue({
        at: "2026-03-09T05:00:00.000Z",
        timeZone: "America/Chicago",
        tasks,
      }),
    ).toEqual({
      overdueTaskIds: ["yesterday", "spring-day"],
      scheduledTodayTaskIds: [],
      plannedTodayTaskIds: ["next-day"],
      unscheduledTaskIds: ["loose"],
      futureScheduledCount: 1,
    });
  });

  it("handles the repeated hour when daylight saving ends", () => {
    const fallTasks = [
      { id: "fall-day", status: "open" as const, plannedDay: "2026-11-01" },
    ];
    // 23:30 CST on November 1, after the repeated 01:00 hour.
    expect(
      buildTodayQueue({
        at: "2026-11-02T05:30:00.000Z",
        timeZone: "America/Chicago",
        tasks: fallTasks,
      }).plannedTodayTaskIds,
    ).toEqual(["fall-day"]);
    expect(
      buildTodayQueue({
        at: "2026-11-02T06:00:00.000Z",
        timeZone: "America/Chicago",
        tasks: fallTasks,
      }).overdueTaskIds,
    ).toEqual(["fall-day"]);
  });

  it("orders overdue timed and date-only work by when it became due", () => {
    expect(
      buildTodayQueue({
        at: "2026-09-24T18:00:00.000Z",
        timeZone: "America/Chicago",
        tasks: [
          {
            id: "timed-this-morning",
            status: "open",
            plannedStart: "2026-09-24T14:00:00.000Z",
          },
          { id: "day-yesterday", status: "open", plannedDay: "2026-09-23" },
          {
            id: "timed-two-days-ago",
            status: "open",
            plannedStart: "2026-09-22T15:00:00.000Z",
          },
        ],
      }).overdueTaskIds,
    ).toEqual(["timed-two-days-ago", "day-yesterday", "timed-this-morning"]);
  });
});
