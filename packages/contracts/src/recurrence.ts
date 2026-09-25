import { z } from "zod";
import { taskStartReminderSchema } from "./task-planning.ts";

/**
 * Recurring series contracts (issue #42, ADR 0023). A series is an
 * owner-scoped template and rule; every generated occurrence is an ordinary
 * task linked to the series by (series ID, occurrence date).
 */
const idSchema = z.uuid();
const revision = z.number().int().positive();
export const recurrenceDateSchema = z.iso.date();
export const recurrenceStartTimeSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use a 24-hour HH:MM time");
export const recurrenceIntervalSchema = z.number().int().min(1).max(366);

export const recurrenceMonthlyAnchorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("day_of_month") }).strict(),
  z.object({ kind: z.literal("last_day") }).strict(),
  z
    .object({
      kind: z.literal("nth_weekday"),
      week: z.union([
        z.literal(1),
        z.literal(2),
        z.literal(3),
        z.literal(4),
        z.literal(-1),
      ]),
      weekday: z.number().int().min(0).max(6),
    })
    .strict(),
]);

export const recurrenceRuleSchema = z.discriminatedUnion("cycle", [
  z
    .object({ cycle: z.literal("daily"), interval: recurrenceIntervalSchema })
    .strict(),
  z
    .object({
      cycle: z.literal("weekly"),
      interval: recurrenceIntervalSchema,
      /** 0 = Sunday … 6 = Saturday; ascending and unique. */
      weekdays: z
        .array(z.number().int().min(0).max(6))
        .min(1)
        .max(7)
        .refine(
          (days) =>
            days.every(
              (day, index) => index === 0 || day > (days[index - 1] ?? -1),
            ),
          { message: "Weekdays must be ascending and unique" },
        ),
    })
    .strict(),
  z
    .object({
      cycle: z.literal("monthly"),
      interval: recurrenceIntervalSchema,
      monthly: recurrenceMonthlyAnchorSchema,
    })
    .strict(),
  z
    .object({ cycle: z.literal("yearly"), interval: recurrenceIntervalSchema })
    .strict(),
]);

/** A child task created under every new instance (ADR 0018). */
export const recurrenceChildTemplateSchema = z
  .object({
    title: z.string().trim().min(1).max(240),
    notes: z.string().max(20_000).default(""),
    estimateMinutes: z.number().int().min(1).max(720).nullable().default(null),
  })
  .strict();

const tagIdsSchema = z
  .array(idSchema)
  .max(25)
  .refine((ids) => new Set(ids).size === ids.length, {
    message: "Tags must be unique",
  });

/** Fields shared by create and patch; every one is a template or rule field. */
const seriesFields = {
  title: z.string().trim().min(1).max(240),
  notes: z.string().max(20_000),
  projectId: idSchema.nullable(),
  tagIds: tagIdsSchema,
  estimateMinutes: z.number().int().min(1).max(720).nullable(),
  rule: recurrenceRuleSchema,
  startDate: recurrenceDateSchema,
  endDate: recurrenceDateSchema.nullable(),
  /** Instances get a planned start at this owner-local time, else a planned day. */
  startTime: recurrenceStartTimeSchema.nullable(),
  startReminder: taskStartReminderSchema,
  /** `completion` moves the pattern base to the latest completion date. */
  anchor: z.enum(["schedule", "completion"]),
  /** Create the next instance only when no instance is open. */
  waitForCompletion: z.boolean(),
  /** After downtime: `latest` creates the newest missed instance; `skip` none. */
  missedOccurrences: z.enum(["skip", "latest"]),
  childTemplates: z.array(recurrenceChildTemplateSchema).max(20),
};

const reminderNeedsTime = (input: {
  readonly startTime?: string | null | undefined;
  readonly startReminder?: { readonly kind: string } | undefined;
}) =>
  input.startReminder === undefined ||
  input.startReminder.kind === "default" ||
  input.startTime != null;
const reminderMessage = {
  message: "A start reminder needs a start time",
  path: ["startReminder"],
};
const endAfterStart = (input: {
  readonly startDate?: string | undefined;
  readonly endDate?: string | null | undefined;
}) =>
  input.startDate === undefined ||
  input.endDate == null ||
  input.endDate >= input.startDate;
const endMessage = {
  message: "The end date must not precede the start date",
  path: ["endDate"],
};

export const recurringSeriesCreateRequestSchema = z
  .object({
    ...seriesFields,
    notes: seriesFields.notes.default(""),
    projectId: seriesFields.projectId.default(null),
    tagIds: seriesFields.tagIds.default([]),
    estimateMinutes: seriesFields.estimateMinutes.default(null),
    endDate: seriesFields.endDate.default(null),
    startTime: seriesFields.startTime.default(null),
    startReminder: seriesFields.startReminder.default({ kind: "default" }),
    anchor: seriesFields.anchor.default("schedule"),
    waitForCompletion: seriesFields.waitForCompletion.default(false),
    missedOccurrences: seriesFields.missedOccurrences.default("latest"),
    childTemplates: seriesFields.childTemplates.default([]),
    /**
     * An active top-level task that becomes the first occurrence instead of a
     * newly generated instance. Its fields are not changed.
     */
    sourceTaskId: idSchema.optional(),
  })
  .strict()
  .refine(reminderNeedsTime, reminderMessage)
  .refine(endAfterStart, endMessage);

export const recurringSeriesPatchRequestSchema = z
  .object(seriesFields)
  .partial()
  .strict()
  .refine((input) => Object.keys(input).length > 0, {
    message: "Change at least one field",
  })
  .refine(endAfterStart, endMessage);

export const recurringSeriesStateRequestSchema = z
  .object({ action: z.enum(["pause", "resume", "end"]) })
  .strict();

export const recurrenceOccurrenceRequestSchema = z
  .object({ action: z.enum(["skip", "unskip", "delete_instance"]) })
  .strict();

export const recurrenceOccurrenceStateSchema = z.enum([
  "generated",
  "imported",
  "linked",
  "skipped",
  "deleted",
]);

export const recurringSeriesSchema = z
  .object({
    id: idSchema,
    ...seriesFields,
    state: z.enum(["active", "paused", "ended"]),
    /** Pattern base; see `anchor`. */
    anchorDate: recurrenceDateSchema,
    /** Newest occurrence date already processed; null before the first. */
    cursorDate: recurrenceDateSchema.nullable(),
    /**
     * No occurrence before this date is created. Set to the owner-local day
     * of creation, of a schedule change and of a resume.
     */
    floorDate: recurrenceDateSchema.nullable(),
    revision,
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    pausedAt: z.iso.datetime().nullable(),
    endedAt: z.iso.datetime().nullable(),
    /** Next occurrence dates in the owner's zone; skipped ones are flagged. */
    upcoming: z.array(
      z.object({ date: recurrenceDateSchema, skipped: z.boolean() }).strict(),
    ),
    /** Recorded exceptions, newest first (at most 100). */
    exceptions: z.array(
      z
        .object({
          date: recurrenceDateSchema,
          state: z.enum(["skipped", "deleted"]),
        })
        .strict(),
    ),
    /** Linked instance tasks (active and archived), not deleted. */
    instanceCount: z.number().int().nonnegative(),
    source: z.enum(["tadooer", "super_productivity"]),
  })
  .strict();

export const recurringSeriesListResponseSchema = z
  .object({ series: z.array(recurringSeriesSchema) })
  .strict();

export const recurringSeriesMutationResponseSchema = z
  .object({
    series: recurringSeriesSchema,
    /** Instances created by the write's generation pass. */
    generatedTaskIds: z.array(idSchema),
    /** Open instances that received propagated template changes. */
    updatedTaskIds: z.array(idSchema),
    replayed: z.boolean(),
  })
  .strict();

/** Series link carried by an instance task. */
export const taskRecurrenceSchema = z
  .object({
    seriesId: idSchema,
    occurrenceDate: recurrenceDateSchema,
  })
  .strict();

// Assistant inputs. Each write freezes the series revision in its preview.
export const automationRecurrenceCreateInputSchema =
  recurringSeriesCreateRequestSchema;
export const automationRecurrenceUpdateInputSchema = z
  .object({
    seriesId: idSchema,
    expectedRevision: revision,
    patch: recurringSeriesPatchRequestSchema,
  })
  .strict();
export const automationRecurrenceStateInputSchema = z
  .object({
    seriesId: idSchema,
    expectedRevision: revision,
    action: recurringSeriesStateRequestSchema.shape.action,
  })
  .strict();
export const automationRecurrenceOccurrenceInputSchema = z
  .object({
    seriesId: idSchema,
    expectedRevision: revision,
    date: recurrenceDateSchema,
    action: recurrenceOccurrenceRequestSchema.shape.action,
  })
  .strict();

export type RecurrenceRuleInput = z.infer<typeof recurrenceRuleSchema>;
export type RecurringSeries = z.infer<typeof recurringSeriesSchema>;
export type RecurringSeriesCreateRequest = z.input<
  typeof recurringSeriesCreateRequestSchema
>;
export type RecurringSeriesPatchRequest = z.infer<
  typeof recurringSeriesPatchRequestSchema
>;
export type RecurringSeriesMutationResponse = z.infer<
  typeof recurringSeriesMutationResponseSchema
>;
export type RecurringSeriesListResponse = z.infer<
  typeof recurringSeriesListResponseSchema
>;
export type TaskRecurrence = z.infer<typeof taskRecurrenceSchema>;
