import { z } from "zod";

/**
 * Date-only planning and per-task reminder contracts (issue #29, ADR 0020).
 *
 * A planned day is a calendar date interpreted in the owner's planning time
 * zone. It is mutually exclusive with an exact planned start.
 */
export const taskPlannedDaySchema = z.iso.date();

/** Super Productivity 19.1.0 TaskReminderOption offsets, in minutes. */
export const taskReminderOffsetMinutes = [0, 5, 10, 15, 30, 60] as const;
export const taskReminderOffsetSchema = z.union(
  taskReminderOffsetMinutes.map((minutes) => z.literal(minutes)) as [
    z.ZodLiteral<0>,
    z.ZodLiteral<5>,
    z.ZodLiteral<10>,
    z.ZodLiteral<15>,
    z.ZodLiteral<30>,
    z.ZodLiteral<60>,
  ],
);

/**
 * `default` follows the owner's notification preferences (15-minute lead and
 * at-start toggles). `none` disables start reminders for this task.
 * `before_start` sends exactly one reminder the given minutes before the
 * planned start (0 means at start) and ignores the owner's lead/at-start
 * toggles. The owner-level enable switch always applies.
 */
export const taskStartReminderSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("default") }).strict(),
  z.object({ kind: z.literal("none") }).strict(),
  z
    .object({
      kind: z.literal("before_start"),
      minutes: taskReminderOffsetSchema,
    })
    .strict(),
]);

/** Only a deadline with a time can carry a reminder, as in the source app. */
export const taskDeadlineReminderSchema = z
  .object({ minutes: taskReminderOffsetSchema })
  .strict();

export const taskPlanningFieldsSchema = z.object({
  plannedDay: taskPlannedDaySchema.nullable().optional(),
  startReminder: taskStartReminderSchema.optional(),
  deadlineReminder: taskDeadlineReminderSchema.nullable().optional(),
});

export const plannedDayAndStartExclusive = (input: {
  readonly plannedStart?: string | null | undefined;
  readonly plannedDay?: string | null | undefined;
}): boolean => input.plannedStart == null || input.plannedDay == null;

export const plannedDayAndStartMessage =
  "A task is planned for a day or for an exact start, not both";

export type TaskStartReminder = z.infer<typeof taskStartReminderSchema>;
export type TaskDeadlineReminder = z.infer<typeof taskDeadlineReminderSchema>;
