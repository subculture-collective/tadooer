import { describe, expect, it } from "vitest";
import {
  applyDayOrder,
  dayOrderMembers,
  isCompleteDayOrder,
  moveInDayOrder,
  planningDate,
  planningDayWindow,
} from "./day-order.ts";
import { buildTodayQueue } from "./day-planning.ts";

const chicago = "America/Chicago";
const hours = (window: { from: string; to: string }) =>
  (Date.parse(window.to) - Date.parse(window.from)) / 3_600_000;

describe("planning date and day start (ADR 0027)", () => {
  it("changes date at local midnight by default", () => {
    // 23:59 and 00:00 CDT on either side of midnight.
    expect(planningDate("2026-09-25T04:59:00.000Z", chicago)).toBe(
      "2026-09-24",
    );
    expect(planningDate("2026-09-25T05:00:00.000Z", chicago)).toBe(
      "2026-09-25",
    );
  });

  it("keeps the previous date until the configured day start", () => {
    expect(planningDate("2026-09-25T08:59:00.000Z", chicago, "04:00")).toBe(
      "2026-09-24",
    );
    expect(planningDate("2026-09-25T09:00:00.000Z", chicago, "04:00")).toBe(
      "2026-09-25",
    );
    // Across a month and year boundary.
    expect(planningDate("2027-01-01T09:59:00.000Z", chicago, "04:00")).toBe(
      "2026-12-31",
    );
  });

  it("uses wall-clock time on daylight-saving change days", () => {
    // 2026-11-01: 06:30Z is 01:30 CDT, before the repeated hour; 08:00Z is
    // 02:00 CST, after it.
    expect(planningDate("2026-11-01T06:30:00.000Z", chicago, "02:00")).toBe(
      "2026-10-31",
    );
    expect(planningDate("2026-11-01T08:00:00.000Z", chicago, "02:00")).toBe(
      "2026-11-01",
    );
    // 2026-03-08 03:00 CDT follows the skipped hour.
    expect(planningDate("2026-03-08T08:00:00.000Z", chicago, "02:30")).toBe(
      "2026-03-08",
    );
    expect(planningDate("2026-03-08T07:59:00.000Z", chicago, "02:30")).toBe(
      "2026-03-07",
    );
  });

  it("builds 23- and 25-hour days and resolves a skipped start time", () => {
    expect(planningDayWindow("2026-03-08", chicago)).toEqual({
      from: "2026-03-08T06:00:00.000Z",
      to: "2026-03-09T05:00:00.000Z",
    });
    expect(hours(planningDayWindow("2026-11-01", chicago))).toBe(25);
    expect(planningDayWindow("2026-03-07", chicago, "04:00")).toEqual({
      from: "2026-03-07T10:00:00.000Z",
      to: "2026-03-08T09:00:00.000Z",
    });
    // 02:30 does not exist on 2026-03-08; the day starts at 03:00 CDT.
    expect(planningDayWindow("2026-03-07", chicago, "02:30")).toEqual({
      from: "2026-03-07T08:30:00.000Z",
      to: "2026-03-08T08:00:00.000Z",
    });
    expect(hours(planningDayWindow("2026-09-24", chicago, "04:00"))).toBe(24);
  });
});

describe("saved day order", () => {
  it("ranks saved members first and appends the rest in derived order", () => {
    expect(applyDayOrder(["a", "b", "c", "d"], ["c", "gone", "a"])).toEqual([
      "c",
      "a",
      "b",
      "d",
    ]);
    expect(applyDayOrder(["a", "b"], [])).toEqual(["a", "b"]);
  });

  it("accepts only a complete list of the current members", () => {
    expect(isCompleteDayOrder(["a", "b"], ["b", "a"])).toBe(true);
    expect(isCompleteDayOrder(["a", "b"], ["a"])).toBe(false);
    expect(isCompleteDayOrder(["a", "b"], ["a", "a"])).toBe(false);
    expect(isCompleteDayOrder(["a", "b"], ["a", "c"])).toBe(false);
  });

  it("moves one task by one place and stops at the ends", () => {
    const order = ["a", "b", "c"];
    expect(moveInDayOrder(order, "b", -1)).toEqual(["b", "a", "c"]);
    expect(moveInDayOrder(order, "b", 1)).toEqual(["a", "c", "b"]);
    expect(moveInDayOrder(order, "a", -1)).toBe(order);
    expect(moveInDayOrder(order, "missing", 1)).toBe(order);
  });

  it("derives members from open, active, date-only tasks of the date", () => {
    expect(
      dayOrderMembers(
        [
          { id: "b", status: "open", plannedDay: "2026-09-25" },
          { id: "a", status: "open", plannedDay: "2026-09-25" },
          { id: "done", status: "completed", plannedDay: "2026-09-25" },
          {
            id: "timed",
            status: "open",
            plannedDay: "2026-09-25",
            plannedStart: "2026-09-25T15:00:00.000Z",
          },
          {
            id: "deleted",
            status: "open",
            plannedDay: "2026-09-25",
            deletedAt: "2026-09-24T00:00:00.000Z",
          },
          {
            id: "archived",
            status: "open",
            plannedDay: "2026-09-25",
            archivedAt: "2026-09-24T00:00:00.000Z",
          },
          { id: "other", status: "open", plannedDay: "2026-09-26" },
        ],
        "2026-09-25",
      ),
    ).toEqual(["a", "b"]);
  });
});

describe("Today queue with a saved order and a day start", () => {
  const tasks = [
    { id: "yesterday", status: "open" as const, plannedDay: "2026-09-24" },
    { id: "b", status: "open" as const, plannedDay: "2026-09-25" },
    { id: "a", status: "open" as const, plannedDay: "2026-09-25" },
    { id: "c", status: "open" as const, plannedDay: "2026-09-25" },
    {
      id: "early",
      status: "open" as const,
      plannedStart: "2026-09-25T08:30:00.000Z",
    },
    {
      id: "late",
      status: "open" as const,
      plannedStart: "2026-09-25T09:30:00.000Z",
    },
  ];

  it("sorts today's date-only tasks by the saved order", () => {
    expect(
      buildTodayQueue({
        at: "2026-09-25T15:00:00.000Z",
        timeZone: chicago,
        tasks,
        plannedTodayOrder: ["c", "removed", "a"],
      }).plannedTodayTaskIds,
    ).toEqual(["c", "a", "b"]);
  });

  it("keeps the previous date as today until the day start", () => {
    // 02:00 CDT on 2026-09-25 with a 04:00 day start: still 2026-09-24.
    const queue = buildTodayQueue({
      at: "2026-09-25T07:00:00.000Z",
      timeZone: chicago,
      dayStartsAt: "04:00",
      tasks,
    });
    expect(queue.plannedTodayTaskIds).toEqual(["yesterday"]);
    expect(queue.overdueTaskIds).toEqual([]);
    // 03:30 is before the next day starts; 04:30 is tomorrow.
    expect(queue.scheduledTodayTaskIds).toEqual(["early"]);
    expect(queue.futureScheduledCount).toBe(4);
    // Without the setting the same instant is already the 25th.
    const midnight = buildTodayQueue({
      at: "2026-09-25T07:00:00.000Z",
      timeZone: chicago,
      tasks,
    });
    expect(midnight.plannedTodayTaskIds).toEqual(["a", "b", "c"]);
    expect(midnight.overdueTaskIds).toEqual(["yesterday"]);
  });
});
