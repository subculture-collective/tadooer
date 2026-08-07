import { describe, expect, it } from "vitest";
import { buildCalmDay } from "./day-planning.ts";

const preferences = {
  workingDays: [1, 2, 3, 4, 5],
  workdayStart: "09:00",
  workdayEnd: "17:00",
  breakStart: "12:00",
  breakEnd: "12:30",
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
});
