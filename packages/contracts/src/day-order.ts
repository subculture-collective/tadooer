import { z } from "zod";

/**
 * Saved day order (issue #98, ADR 0027). A day order ranks the date-only tasks
 * planned for one owner-zone calendar date. Membership stays derived from the
 * tasks' planned day; the order only sorts. Today's order is the order of the
 * owner's current planning date.
 */
export const dayOrderDateSchema = z.iso.date();
/** Largest number of tasks one day order may rank. */
export const dayOrderMaxTasks = 500;
/** Largest inclusive range of days one list request may read. */
export const dayOrderMaxRangeDays = 62;
/** Largest number of tasks one plan-day request may add. */
export const dayOrderMaxPlannedTasks = 50;

/**
 * Local time at which a new planning day starts ("HH:MM", default "00:00").
 * Before this time the Today view still shows the previous date.
 */
export const dayStartsAtSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use a 24-hour HH:MM time");

const uniqueTaskIds = (max: number) =>
  z
    .array(z.uuid())
    .max(max)
    .refine((ids) => new Set(ids).size === ids.length, {
      message: "Task IDs must be unique",
    });

export const dayOrderSchema = z
  .object({
    date: dayOrderDateSchema,
    /** 0 until the first saved reorder of this date. */
    revision: z.number().int().nonnegative(),
    /** Every current member, saved ranks first, then the derived order. */
    taskIds: uniqueTaskIds(dayOrderMaxTasks),
  })
  .strict();

export const dayOrderResponseSchema = z
  .object({ dayOrder: dayOrderSchema })
  .strict();

export const dayOrderListResponseSchema = z
  .object({ dayOrders: z.array(dayOrderSchema) })
  .strict();

const utcDay = (date: string): number => Date.parse(`${date}T00:00:00.000Z`);

export const dayOrderRangeSchema = z
  .object({ from: dayOrderDateSchema, to: dayOrderDateSchema })
  .strict()
  .refine(
    ({ from, to }) =>
      from <= to &&
      (utcDay(to) - utcDay(from)) / 86_400_000 < dayOrderMaxRangeDays,
    { message: `Use a range of at most ${String(dayOrderMaxRangeDays)} days` },
  );

/** Full-list reorder: every current member exactly once. */
export const dayOrderReorderRequestSchema = z
  .object({
    expectedRevision: z.number().int().nonnegative(),
    taskIds: uniqueTaskIds(dayOrderMaxTasks),
  })
  .strict();

/** Plan tasks for a date and place them after its current members. */
export const dayOrderPlanRequestSchema = z
  .object({
    expectedRevision: z.number().int().nonnegative(),
    tasks: z
      .array(
        z
          .object({
            taskId: z.uuid(),
            expectedRevision: z.number().int().positive(),
          })
          .strict(),
      )
      .min(1)
      .max(dayOrderMaxPlannedTasks)
      .refine(
        (tasks) =>
          new Set(tasks.map(({ taskId }) => taskId)).size === tasks.length,
        { message: "Task IDs must be unique" },
      ),
  })
  .strict();

/** Assistant read: one date, or the owner's current planning date. */
export const dayOrderResourceInputSchema = z
  .object({ date: dayOrderDateSchema.optional() })
  .strict();

export const automationDayOrderReorderInputSchema = z
  .object({
    date: dayOrderDateSchema,
    expectedRevision: z.number().int().nonnegative(),
    taskIds: uniqueTaskIds(200),
  })
  .strict();

export type DayOrder = z.infer<typeof dayOrderSchema>;
export type DayOrderReorderRequest = z.infer<
  typeof dayOrderReorderRequestSchema
>;
export type DayOrderPlanRequest = z.infer<typeof dayOrderPlanRequestSchema>;
