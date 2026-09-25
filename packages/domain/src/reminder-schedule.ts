/**
 * Per-task reminder intent (ADR 0020). The server ledger derives at most one
 * row per task, occurrence and reminder kind from this schedule; delivery,
 * suppression and deduplication stay in the durable notification authority.
 */

export type ScheduledReminderKind = "lead" | "at_start" | "deadline";

export type StartReminderSetting =
  | { readonly kind: "default" }
  | { readonly kind: "none" }
  | { readonly kind: "before_start"; readonly minutes: number };

export interface ReminderScheduleTask {
  readonly id: string;
  readonly status: "open" | "completed";
  readonly deletedAt: string | null;
  readonly plannedStart: string | null;
  readonly deadlineAt?: string | null | undefined;
  readonly startReminder?: StartReminderSetting | undefined;
  readonly deadlineReminderMinutes?: number | null | undefined;
}

export interface ReminderSchedulePreferences {
  readonly enabled: boolean;
  readonly leadReminderEnabled: boolean;
  readonly atStartReminderEnabled: boolean;
}

export interface ScheduledReminder {
  readonly taskId: string;
  readonly kind: ScheduledReminderKind;
  /** Planned start, or the deadline instant for deadline reminders. */
  readonly occurrenceStart: string;
  readonly dueAt: string;
}

/** The owner-level lead offset used when a task keeps the default setting. */
export const defaultLeadReminderMinutes = 15;

const minutesBefore = (instant: string, minutes: number): string =>
  new Date(Date.parse(instant) - minutes * 60_000).toISOString();

/**
 * Reminders a task should have. The owner-level switch always applies.
 * `default` follows the owner's lead/at-start toggles; an explicit per-task
 * setting replaces both toggles with exactly one reminder or none. Date-only
 * plans and date-only deadlines have no time, so they produce no reminder.
 */
export const scheduledReminders = (
  task: ReminderScheduleTask,
  preferences: ReminderSchedulePreferences,
  /**
   * ADR 0030: the owner's default reminder. A task that keeps `default`
   * resolves to this setting first; `default` here keeps ADR 0016 behaviour.
   */
  ownerDefault: StartReminderSetting = { kind: "default" },
): readonly ScheduledReminder[] => {
  if (!preferences.enabled || task.status !== "open" || task.deletedAt !== null)
    return [];
  const reminders: ScheduledReminder[] = [];
  const start = task.plannedStart;
  if (start !== null) {
    const own = task.startReminder ?? { kind: "default" };
    const setting = own.kind === "default" ? ownerDefault : own;
    if (setting.kind === "default") {
      if (preferences.leadReminderEnabled)
        reminders.push({
          taskId: task.id,
          kind: "lead",
          occurrenceStart: start,
          dueAt: minutesBefore(start, defaultLeadReminderMinutes),
        });
      if (preferences.atStartReminderEnabled)
        reminders.push({
          taskId: task.id,
          kind: "at_start",
          occurrenceStart: start,
          dueAt: start,
        });
    } else if (setting.kind === "before_start") {
      reminders.push({
        taskId: task.id,
        kind: setting.minutes === 0 ? "at_start" : "lead",
        occurrenceStart: start,
        dueAt: minutesBefore(start, setting.minutes),
      });
    }
  }
  if (task.deadlineAt != null && task.deadlineReminderMinutes != null)
    reminders.push({
      taskId: task.id,
      kind: "deadline",
      occurrenceStart: task.deadlineAt,
      dueAt: minutesBefore(task.deadlineAt, task.deadlineReminderMinutes),
    });
  return reminders;
};
