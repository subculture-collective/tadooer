import { describe, expect, it } from "vitest";
import { prepareSuperProductivityImport } from "./super-productivity-apply.ts";

const state = (entities: Record<string, unknown>) => ({
  ids: Object.keys(entities),
  entities,
});
const created = 1758000000000;

const exportWith = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    task: state({
      t1: { id: "t1", title: "One", dueDay: "2026-09-24", created },
      t2: { id: "t2", title: "Two", dueDay: "2026-09-24", created },
      timed: {
        id: "timed",
        title: "Timed",
        dueWithTime: Date.parse("2026-09-24T15:00:00.000Z"),
        created,
      },
      done: {
        id: "done",
        title: "Done",
        dueDay: "2026-09-24",
        isDone: true,
        doneOn: created,
        created,
      },
      later: { id: "later", title: "Later", dueDay: "2026-09-26", created },
    }),
    tag: state({
      TODAY: {
        id: "TODAY",
        title: "Today",
        taskIds: ["t2", "missing", "t1", "timed", "done"],
      },
    }),
    planner: {
      days: { "2026-09-26": ["later", "gone"], "2026-09-24": ["t1"] },
      addPlannedTasksDialogLastShown: "2026-09-20",
    },
    ...extra,
  });

describe("Super Productivity Today and planner-day order (ADR 0027)", () => {
  it("applies Today's order to the import date and planner days to their dates", () => {
    const { report, dayOrders } = prepareSuperProductivityImport(exportWith(), {
      timeZone: "America/Chicago",
      today: "2026-09-24",
    });
    expect(report.canApply).toBe(true);
    expect(dayOrders).toEqual([
      { date: "2026-09-24", sourceTaskIds: ["t2", "t1"] },
      { date: "2026-09-26", sourceTaskIds: ["later"] },
    ]);
    const notices = report.issues
      .filter(({ code }) => code === "day_order_notice")
      .map(({ sourceId, detail, blocking }) => ({
        sourceId,
        detail,
        blocking,
      }));
    expect(notices).toEqual([
      {
        sourceId: "TODAY",
        detail:
          "1 entry in the order for 2026-09-24 references a task absent from the export and is not imported",
        blocking: false,
      },
      {
        sourceId: "TODAY",
        detail:
          "2 tasks in the order for 2026-09-24 are not an open date-only task planned for that date; they keep their own date or time order",
        blocking: false,
      },
      {
        sourceId: "TODAY",
        detail:
          "Today's task order is applied as the order of 2026-09-24, the current day in the planning time zone",
        blocking: false,
      },
      {
        sourceId: "planner",
        detail:
          "The planner order for 2026-09-24 is not imported; Today's task order applies to that date",
        blocking: false,
      },
      {
        sourceId: "planner",
        detail:
          "1 entry in the order for 2026-09-26 references a task absent from the export and is not imported",
        blocking: false,
      },
    ]);
    // The planner section is applied, not reported as configuration.
    expect(
      report.issues.some(({ detail }) => detail.startsWith("planner is")),
    ).toBe(false);
  });

  it("reports a stale Today order when the import date differs", () => {
    const { report, dayOrders } = prepareSuperProductivityImport(exportWith(), {
      timeZone: "America/Chicago",
      today: "2026-09-25",
    });
    expect(report.canApply).toBe(true);
    expect(dayOrders).toEqual([
      { date: "2026-09-24", sourceTaskIds: ["t1"] },
      { date: "2026-09-26", sourceTaskIds: ["later"] },
    ]);
    expect(report.issues.map(({ detail }) => detail)).toContain(
      "Today's task order is not applied: none of its tasks is an open date-only task planned for 2026-09-25, the current day in the planning time zone",
    );
  });

  it("reports a start-of-next-day setting without applying it", () => {
    const notices = (startOfNextDayTime: string) =>
      prepareSuperProductivityImport(
        exportWith({ globalConfig: { misc: { startOfNextDayTime } } }),
        { timeZone: "UTC", today: "2026-09-24" },
      ).report.issues.filter(({ sourceId }) => sourceId === "globalConfig");
    expect(
      notices("03:00").map(({ code, blocking }) => [code, blocking]),
    ).toEqual([["day_order_notice", false]]);
    expect(notices("00:00")).toEqual([]);
  });

  it("blocks a malformed planner and unreviewed planner fields", () => {
    for (const planner of [
      { days: { "2026-02-30": ["t1"] } },
      { days: { "2026-09-26": "later" } },
      { days: [] },
      { days: {}, pinnedDays: {} },
      "planner",
    ]) {
      const { report } = prepareSuperProductivityImport(
        exportWith({ planner }),
        { timeZone: "UTC", today: "2026-09-24" },
      );
      expect(report.canApply, JSON.stringify(planner)).toBe(false);
    }
    expect(
      prepareSuperProductivityImport(
        exportWith({
          tag: state({ TODAY: { id: "TODAY", title: "Today", taskIds: [1] } }),
        }),
        { timeZone: "UTC", today: "2026-09-24" },
      ).report.canApply,
    ).toBe(false);
  });
});
