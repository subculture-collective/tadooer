import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { prepareSuperProductivityImport } from "./super-productivity-apply.ts";

const state = (entities: Record<string, unknown>) => ({
  ids: Object.keys(entities),
  entities,
});
const prepare = (task: Record<string, unknown>, extra = {}) =>
  prepareSuperProductivityImport(
    JSON.stringify({
      task: state({ t: { id: "t", title: "Task", ...task } }),
      ...extra,
    }),
  );
const due = Date.parse("2026-03-08T15:00:00.000Z");
const minutes = (value: number) => value * 60_000;

describe("Super Productivity planning and reminder import", () => {
  it("maps dueDay to a planned day exactly and never invents a time", () => {
    const { report, records } = prepare({ dueDay: "2026-03-08" });
    expect(report.canApply).toBe(true);
    expect(records[0]).toMatchObject({
      plannedDay: "2026-03-08",
      plannedStart: null,
      startReminder: { kind: "default" },
    });
    expect(JSON.parse(records[0]?.sourceJson ?? "{}")).toMatchObject({
      dueDay: "2026-03-08",
    });
  });

  it("lets dueWithTime win over a legacy dueDay and keeps the earlier provenance hash", () => {
    const { report, records } = prepare({
      dueWithTime: due,
      dueDay: "2026-03-01",
      remindAt: due,
    });
    expect(report.canApply).toBe(true);
    expect(records[0]).toMatchObject({
      plannedStart: "2026-03-08T15:00:00.000Z",
      plannedDay: null,
      startReminder: { kind: "before_start", minutes: 0 },
    });
    const withoutReminder = prepare({ dueWithTime: due, dueDay: "2026-03-01" })
      .records[0];
    // Before #29 dueDay was not preserved and remindAt blocked the import;
    // an export imported then must hash identically now.
    const earlier = JSON.stringify({
      id: "t",
      title: "Task",
      dueWithTime: due,
    });
    expect(withoutReminder?.sourceJson).toBe(earlier);
    expect(withoutReminder?.sourceHash).toBe(
      createHash("sha256").update(earlier).digest("hex"),
    );
  });

  it("converts exact source reminder offsets and treats a missing remindAt as no reminder", () => {
    for (const [offset, expected] of [
      [0, 0],
      [5, 5],
      [10, 10],
      [15, 15],
      [30, 30],
      [60, 60],
    ] as const)
      expect(
        prepare({ dueWithTime: due, remindAt: due - minutes(offset) })
          .records[0]?.startReminder,
      ).toEqual({ kind: "before_start", minutes: expected });
    expect(prepare({ dueWithTime: due }).records[0]?.startReminder).toEqual({
      kind: "none",
    });
  });

  it("blocks reminders that are not exact supported offsets instead of rounding", () => {
    for (const task of [
      { dueWithTime: due, remindAt: due - minutes(7) },
      { dueWithTime: due, remindAt: due - minutes(90) },
      { dueWithTime: due, remindAt: due + minutes(5) },
      { dueWithTime: due, remindAt: due - 1_000 },
      { dueDay: "2026-03-08", remindAt: due },
      { remindAt: due },
    ]) {
      const { report } = prepare(task);
      expect(report.canApply, JSON.stringify(task)).toBe(false);
      expect(
        report.issues.some(({ detail }) => detail.includes("remindAt")),
      ).toBe(true);
    }
  });

  it("maps timed deadline reminders exactly and blocks other deadline reminders", () => {
    const deadline = Date.parse("2026-09-25T17:00:00.000Z");
    expect(
      prepare({
        deadlineWithTime: deadline,
        deadlineRemindAt: deadline - minutes(60),
      }).records[0],
    ).toMatchObject({
      deadlineAt: "2026-09-25T17:00:00.000Z",
      deadlineReminderMinutes: 60,
    });
    for (const task of [
      { deadlineWithTime: deadline, deadlineRemindAt: deadline - minutes(45) },
      { deadlineDay: "2026-09-25", deadlineRemindAt: deadline },
    ])
      expect(prepare(task).report.canApply).toBe(false);
  });

  it("keeps the legacy reminders section and reminderId blocked", () => {
    expect(
      prepare({}, { reminders: [{ id: "r", remindAt: due }] }).report.canApply,
    ).toBe(false);
    expect(prepare({ reminderId: "r" }).report.canApply).toBe(false);
  });
});
