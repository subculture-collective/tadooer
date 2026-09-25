import { describe, expect, it } from "vitest";
import { evaluateReminder } from "./notifications.ts";
import { scheduledReminders } from "./reminder-schedule.ts";

const on = {
  enabled: true,
  leadReminderEnabled: true,
  atStartReminderEnabled: true,
};
const base = {
  id: "task",
  status: "open" as const,
  deletedAt: null,
  plannedStart: "2026-09-24T15:00:00.000Z",
};

describe("per-task reminder schedule", () => {
  it("keeps the owner's 15-minute lead and at-start defaults for default tasks", () => {
    expect(scheduledReminders(base, on)).toEqual([
      {
        taskId: "task",
        kind: "lead",
        occurrenceStart: base.plannedStart,
        dueAt: "2026-09-24T14:45:00.000Z",
      },
      {
        taskId: "task",
        kind: "at_start",
        occurrenceStart: base.plannedStart,
        dueAt: base.plannedStart,
      },
    ]);
    expect(
      scheduledReminders(base, { ...on, leadReminderEnabled: false }).map(
        ({ kind }) => kind,
      ),
    ).toEqual(["at_start"]);
  });

  it("replaces both default toggles with one explicit offset or none", () => {
    for (const [minutes, kind, dueAt] of [
      [0, "at_start", "2026-09-24T15:00:00.000Z"],
      [5, "lead", "2026-09-24T14:55:00.000Z"],
      [30, "lead", "2026-09-24T14:30:00.000Z"],
      [60, "lead", "2026-09-24T14:00:00.000Z"],
    ] as const)
      expect(
        scheduledReminders(
          { ...base, startReminder: { kind: "before_start", minutes } },
          { ...on, leadReminderEnabled: false, atStartReminderEnabled: false },
        ),
      ).toEqual([
        { taskId: "task", kind, occurrenceStart: base.plannedStart, dueAt },
      ]);
    expect(
      scheduledReminders({ ...base, startReminder: { kind: "none" } }, on),
    ).toEqual([]);
  });

  it("never bypasses the owner switch or schedules closed or date-only work", () => {
    const explicit = {
      ...base,
      startReminder: { kind: "before_start", minutes: 10 } as const,
    };
    expect(scheduledReminders(explicit, { ...on, enabled: false })).toEqual([]);
    expect(
      scheduledReminders({ ...explicit, status: "completed" }, on),
    ).toEqual([]);
    expect(
      scheduledReminders(
        { ...explicit, deletedAt: "2026-09-24T10:00:00.000Z" },
        on,
      ),
    ).toEqual([]);
    // A planned day has no reminder time.
    expect(scheduledReminders({ ...explicit, plannedStart: null }, on)).toEqual(
      [],
    );
  });

  it("schedules deadline reminders only for a timed deadline", () => {
    const deadline = {
      ...base,
      plannedStart: null,
      deadlineAt: "2026-09-25T17:00:00.000Z",
      deadlineReminderMinutes: 60,
    };
    expect(scheduledReminders(deadline, on)).toEqual([
      {
        taskId: "task",
        kind: "deadline",
        occurrenceStart: "2026-09-25T17:00:00.000Z",
        dueAt: "2026-09-25T16:00:00.000Z",
      },
    ]);
    expect(scheduledReminders({ ...deadline, deadlineAt: null }, on)).toEqual(
      [],
    );
    expect(
      scheduledReminders({ ...deadline, deadlineReminderMinutes: null }, on),
    ).toEqual([]);
  });

  it("delivers deadline reminders regardless of calendar freshness or working hours", () => {
    const input = {
      now: "2026-09-26T03:00:00.000Z",
      taskId: "task",
      occurrenceStart: "2026-09-26T04:00:00.000Z",
      kind: "deadline" as const,
      preferences: {
        workingDays: [1, 2, 3, 4, 5],
        workdayStart: "09:00",
        workdayEnd: "17:00",
        breakStart: null,
        breakEnd: null,
        timeZone: "UTC",
      },
      calendarFresh: false,
      busy: [],
      activeFocusTaskId: "task",
    };
    expect(evaluateReminder({ ...input, taskStatus: "open" })).toEqual({
      action: "deliver",
      reason: "ready",
    });
    expect(evaluateReminder({ ...input, taskStatus: "completed" })).toEqual({
      action: "suppress",
      reason: "task_completed",
    });
  });
});
