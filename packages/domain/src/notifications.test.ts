import { describe, expect, it } from "vitest";
import { evaluateReminder, reminderDueAt } from "./notifications.ts";

const preferences = {
  workingDays: [1, 2, 3, 4, 5],
  workdayStart: "09:00",
  workdayEnd: "17:00",
  breakStart: "12:00",
  breakEnd: "12:30",
  timeZone: "America/Chicago",
};

describe("notification timing and calm-day suppression", () => {
  it("calculates the exact lead and at-start instants", () => {
    expect(reminderDueAt("2026-08-10T16:00:00.000Z", "lead")).toBe(
      "2026-08-10T15:45:00.000Z",
    );
    expect(reminderDueAt("2026-08-10T16:00:00.000Z", "at_start")).toBe(
      "2026-08-10T16:00:00.000Z",
    );
  });

  it("defers a lead through a break but suppresses an ineligible start", () => {
    const base = {
      now: "2026-08-10T17:05:00.000Z",
      taskId: "task-1",
      taskStatus: "open" as const,
      occurrenceStart: "2026-08-10T17:20:00.000Z",
      preferences,
      calendarFresh: true,
      busy: [],
      activeFocusTaskId: null,
    };
    expect(evaluateReminder({ ...base, kind: "lead" })).toMatchObject({
      action: "defer",
      reason: "scheduled_break",
      nextEligibleAt: "2026-08-10T17:06:00.000Z",
    });
    expect(
      evaluateReminder({
        ...base,
        now: base.occurrenceStart,
        kind: "at_start",
      }),
    ).toMatchObject({ action: "suppress", reason: "scheduled_break" });
  });

  it("suppresses stale calendars, completed work, busy time, and active focus", () => {
    const base = {
      now: "2026-08-10T15:45:00.000Z",
      taskId: "task-1",
      taskStatus: "open" as const,
      occurrenceStart: "2026-08-10T16:00:00.000Z",
      kind: "lead" as const,
      preferences,
      calendarFresh: true,
      busy: [],
      activeFocusTaskId: null,
    };
    expect(evaluateReminder({ ...base, calendarFresh: false })).toMatchObject({
      action: "suppress",
      reason: "stale_calendar",
    });
    expect(
      evaluateReminder({ ...base, taskStatus: "completed" }),
    ).toMatchObject({ action: "suppress", reason: "task_completed" });
    expect(
      evaluateReminder({
        ...base,
        busy: [
          {
            startsAt: "2026-08-10T15:30:00.000Z",
            endsAt: "2026-08-10T16:30:00.000Z",
          },
        ],
      }),
    ).toMatchObject({ action: "defer", reason: "calendar_busy" });
    expect(
      evaluateReminder({
        ...base,
        now: base.occurrenceStart,
        kind: "at_start",
        activeFocusTaskId: "task-1",
      }),
    ).toMatchObject({ action: "suppress", reason: "focus_active" });
  });
});
