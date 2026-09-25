import { describe, expect, it } from "vitest";
import {
  buildCalmDay,
  buildTodayQueue,
  zonedDayWindow,
} from "./day-planning.ts";

const preferences = {
  workingDays: [1, 2, 3, 4, 5],
  workdayStart: "09:00",
  workdayEnd: "17:00",
  breakStart: "12:00",
  breakEnd: "12:30",
  timeZone: "UTC",
};
const tasks = [
  {
    id: "later",
    status: "open" as const,
    plannedStart: "2026-08-10T14:00:00.000Z",
  },
  {
    id: "next",
    status: "open" as const,
    plannedStart: "2026-08-10T11:00:00.000Z",
  },
  { id: "unscheduled", status: "open" as const, plannedStart: null },
];

describe("calm daily planning", () => {
  it("classifies overdue, scheduled-today, unscheduled, and future tasks", () => {
    expect(
      buildTodayQueue({
        at: "2026-08-10T15:00:00.000Z",
        timeZone: "America/Chicago",
        tasks: [
          {
            id: "overdue-b",
            status: "open",
            plannedStart: "2026-08-10T13:00:00.000Z",
          },
          {
            id: "overdue-a",
            status: "open",
            plannedStart: "2026-08-09T18:00:00.000Z",
          },
          {
            id: "now",
            status: "open",
            plannedStart: "2026-08-10T15:00:00.000Z",
          },
          {
            id: "today",
            status: "open",
            plannedStart: "2026-08-11T04:59:59.999Z",
          },
          {
            id: "future",
            status: "open",
            plannedStart: "2026-08-11T05:00:00.000Z",
          },
          { id: "unscheduled-b", status: "open", plannedStart: null },
          { id: "unscheduled-a", status: "open", plannedStart: null },
          {
            id: "completed",
            status: "completed",
            plannedStart: "2026-08-10T14:00:00.000Z",
          },
          {
            id: "deleted",
            status: "open",
            plannedStart: "2026-08-10T14:00:00.000Z",
            deletedAt: "2026-08-10T14:30:00.000Z",
          },
        ],
      }),
    ).toEqual({
      overdueTaskIds: ["overdue-a", "overdue-b"],
      scheduledTodayTaskIds: ["now", "today"],
      plannedTodayTaskIds: [],
      unscheduledTaskIds: ["unscheduled-a", "unscheduled-b"],
      futureScheduledCount: 1,
    });
  });

  it("uses the owner's civil-day end across DST transitions", () => {
    expect(
      buildTodayQueue({
        at: "2026-03-08T07:30:00.000Z",
        timeZone: "America/Chicago",
        tasks: [
          {
            id: "last-today",
            status: "open",
            plannedStart: "2026-03-09T04:59:59.999Z",
          },
          {
            id: "first-tomorrow",
            status: "open",
            plannedStart: "2026-03-09T05:00:00.000Z",
          },
        ],
      }),
    ).toMatchObject({
      scheduledTodayTaskIds: ["last-today"],
      futureScheduledCount: 1,
    });
    expect(
      buildTodayQueue({
        at: "2026-11-01T07:30:00.000Z",
        timeZone: "America/Chicago",
        tasks: [
          {
            id: "last-today",
            status: "open",
            plannedStart: "2026-11-02T05:59:59.999Z",
          },
          {
            id: "first-tomorrow",
            status: "open",
            plannedStart: "2026-11-02T06:00:00.000Z",
          },
        ],
      }),
    ).toMatchObject({
      scheduledTodayTaskIds: ["last-today"],
      futureScheduledCount: 1,
    });
  });

  it("orders scheduled tasks first and exposes the next task", () =>
    expect(
      buildCalmDay({
        at: "2026-08-10T10:00:00.000Z",
        tasks,
        busy: [],
        preferences,
        calendarFresh: true,
      }),
    ).toMatchObject({
      state: "working",
      orderedTaskIds: ["next", "later", "unscheduled"],
      nextTaskId: "next",
      reminder: { suppressed: false, reason: "ready" },
    }));
  it("suppresses quietly during breaks, busy time, finished time, and stale projections", () => {
    expect(
      buildCalmDay({
        at: "2026-08-10T12:05:00.000Z",
        tasks,
        busy: [],
        preferences,
        calendarFresh: true,
      }).reminder.reason,
    ).toBe("scheduled_break");
    expect(
      buildCalmDay({
        at: "2026-08-10T10:00:00.000Z",
        tasks,
        busy: [
          {
            startsAt: "2026-08-10T09:30:00.000Z",
            endsAt: "2026-08-10T10:30:00.000Z",
          },
        ],
        preferences,
        calendarFresh: true,
      }).reminder.reason,
    ).toBe("calendar_busy");
    expect(
      buildCalmDay({
        at: "2026-08-10T18:00:00.000Z",
        tasks,
        busy: [],
        preferences,
        calendarFresh: true,
      }).state,
    ).toBe("finished_for_today");
    expect(
      buildCalmDay({
        at: "2026-08-10T10:00:00.000Z",
        tasks,
        busy: [],
        preferences,
        calendarFresh: false,
      }).reminder.reason,
    ).toBe("stale_calendar");
  });

  it("uses the owner's civil time across Chicago DST transitions", () => {
    const chicago = {
      ...preferences,
      workingDays: [0],
      workdayStart: "00:00",
      workdayEnd: "23:59",
      breakStart: "01:00",
      breakEnd: "02:00",
      timeZone: "America/Chicago",
    };
    expect(
      buildCalmDay({
        at: "2026-03-08T07:30:00.000Z",
        tasks,
        busy: [],
        preferences: chicago,
        calendarFresh: true,
      }).state,
    ).toBe("scheduled_break");
    expect(
      buildCalmDay({
        at: "2026-03-08T08:30:00.000Z",
        tasks,
        busy: [],
        preferences: chicago,
        calendarFresh: true,
      }).state,
    ).toBe("working");
    expect(
      zonedDayWindow("2026-03-08T12:00:00.000Z", chicago.timeZone),
    ).toEqual({
      from: "2026-03-08T06:00:00.000Z",
      to: "2026-03-09T05:00:00.000Z",
    });
    expect(
      zonedDayWindow("2026-11-01T12:00:00.000Z", chicago.timeZone),
    ).toEqual({
      from: "2026-11-01T05:00:00.000Z",
      to: "2026-11-02T06:00:00.000Z",
    });
  });
});
