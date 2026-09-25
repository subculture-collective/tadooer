import {
  buildCalmDay,
  type BusyInterval,
  type CalmPreferences,
} from "./day-planning.ts";

export type ReminderKind = "lead" | "at_start" | "deadline";
export type ReminderDecision =
  | { readonly action: "deliver"; readonly reason: "ready" }
  | {
      readonly action: "defer";
      readonly reason:
        "outside_working_hours" | "scheduled_break" | "calendar_busy";
      readonly nextEligibleAt: string;
    }
  | {
      readonly action: "suppress";
      readonly reason:
        | "stale_calendar"
        | "outside_working_hours"
        | "scheduled_break"
        | "calendar_busy"
        | "task_completed"
        | "focus_active";
    };

export const reminderDueAt = (
  occurrenceStart: string,
  kind: ReminderKind,
): string =>
  new Date(
    Date.parse(occurrenceStart) - (kind === "lead" ? 15 * 60_000 : 0),
  ).toISOString();

export const evaluateReminder = (input: {
  readonly now: string;
  readonly taskId: string;
  readonly taskStatus: "open" | "completed";
  readonly occurrenceStart: string;
  readonly kind: ReminderKind;
  readonly preferences: CalmPreferences;
  readonly calendarFresh: boolean;
  readonly busy: readonly BusyInterval[];
  readonly activeFocusTaskId: string | null;
}): ReminderDecision => {
  if (input.taskStatus === "completed")
    return { action: "suppress", reason: "task_completed" };
  // A deadline passes regardless of calendar availability or working hours,
  // so its reminder is not deferred by the calm-day rules (ADR 0020).
  if (input.kind === "deadline") return { action: "deliver", reason: "ready" };
  if (input.kind === "at_start" && input.activeFocusTaskId === input.taskId)
    return { action: "suppress", reason: "focus_active" };
  const calm = buildCalmDay({
    at: input.now,
    tasks: [
      {
        id: input.taskId,
        status: input.taskStatus,
        plannedStart: input.occurrenceStart,
      },
    ],
    busy: input.busy,
    preferences: input.preferences,
    calendarFresh: input.calendarFresh,
  });
  if (calm.reminder.reason === "ready")
    return { action: "deliver", reason: "ready" };
  if (calm.reminder.reason === "stale_calendar")
    return { action: "suppress", reason: "stale_calendar" };
  const suppressible = calm.reminder.reason;
  if (
    suppressible !== "outside_working_hours" &&
    suppressible !== "scheduled_break" &&
    suppressible !== "calendar_busy"
  )
    return { action: "suppress", reason: "outside_working_hours" };
  const nowTime = Date.parse(input.now);
  const occurrenceTime = Date.parse(input.occurrenceStart);
  if (input.kind === "lead" && nowTime < occurrenceTime)
    return {
      action: "defer",
      reason: suppressible,
      nextEligibleAt: new Date(
        Math.min(nowTime + 60_000, occurrenceTime),
      ).toISOString(),
    };
  return { action: "suppress", reason: suppressible };
};
