import { z } from "zod";
import { organizationIconSchema } from "./organization.ts";
import { timeReportMaxDays, workDateSchema } from "./time-history.ts";

/**
 * Simple counters and daily evaluations (issue #64, ADR 0025). Both are
 * online HTTP records with revisions; they are not in the sync change feed or
 * the offline cache. Streaks are derived on read and never stored.
 */

// Local copies avoid an import cycle with index.ts, which re-exports this file.
const id = z.uuid();
const revision = z.number().int().positive();
const timestamp = z.iso.datetime();

export const counterKindSchema = z.enum([
  "click",
  "stopwatch",
  "repeated_countdown",
]);
export const counterStreakModeSchema = z.enum(["weekdays", "weekly_frequency"]);
/** Largest count per day; stopwatch days are bounded by the day's length. */
export const counterMaxCount = 1_000_000;
/** The longest owner-zone day (25 hours), in milliseconds. */
export const counterMaxDayMs = 90_000_000;

const titleSchema = z.string().trim().min(1).max(200);
const countdownSchema = z.number().int().min(1_000).max(86_400_000);

export const counterStreakSchema = z
  .object({
    enabled: z.boolean(),
    /** Smallest qualifying day value: a count, or milliseconds for a stopwatch. */
    minValue: z.number().int().min(1).max(counterMaxDayMs),
    mode: counterStreakModeSchema,
    /** Weekdays that must qualify in `weekdays` mode; 0 is Sunday. */
    weekdays: z
      .array(z.number().int().min(0).max(6))
      .max(7)
      .refine((days) => new Set(days).size === days.length, {
        message: "Weekdays must be unique",
      }),
    /** Qualifying days per Monday-to-Sunday week in `weekly_frequency` mode. */
    weeklyFrequency: z.number().int().min(1).max(7),
  })
  .strict();

export const defaultCounterStreak: z.infer<typeof counterStreakSchema> = {
  enabled: false,
  minValue: 1,
  mode: "weekdays",
  weekdays: [1, 2, 3, 4, 5],
  weeklyFrequency: 3,
};

export const counterSchema = z
  .object({
    id,
    title: z.string(),
    kind: counterKindSchema,
    icon: z.string().nullable(),
    enabled: z.boolean(),
    /** Hidden counters stay out of the daily controls but keep their history. */
    hidden: z.boolean(),
    position: z.number().int(),
    streak: counterStreakSchema,
    /** Repeated countdown length; null for other kinds. */
    countdownMs: z.number().int().positive().nullable(),
    /** Stopwatch start instant while running (server clock). */
    runningSince: timestamp.nullable(),
    /** Derived on the owner's today; null when streaks are off. */
    currentStreak: z.number().int().nonnegative().nullable(),
    revision,
    createdAt: timestamp,
    updatedAt: timestamp,
    deletedAt: timestamp.nullable(),
    provenance: z
      .object({
        source: z.literal("super_productivity"),
        sourceCounterId: z.string().min(1).max(200),
      })
      .strict()
      .nullable(),
  })
  .strict();

export const counterDayValueSchema = z
  .object({
    counterId: id,
    day: workDateSchema,
    /** A count, or milliseconds for a stopwatch. */
    value: z.number().int().nonnegative(),
    revision,
    updatedAt: timestamp,
    /** The Super Productivity countOnDay value when the day was imported. */
    importedValue: z.number().int().nonnegative().nullable(),
  })
  .strict();

const rangeSchema = z
  .object({ from: workDateSchema, to: workDateSchema })
  .strict()
  .refine(({ from, to }) => from <= to, {
    message: "The range must end on or after its start",
  })
  .refine(
    ({ from, to }) =>
      (Date.parse(`${to}T00:00:00.000Z`) -
        Date.parse(`${from}T00:00:00.000Z`)) /
        86_400_000 <
      timeReportMaxDays,
    { message: `A range covers at most ${String(timeReportMaxDays)} days` },
  );
export const counterHistoryQuerySchema = rangeSchema;
export const evaluationListQuerySchema = rangeSchema;

export const counterHistoryResponseSchema = z
  .object({
    from: workDateSchema,
    to: workDateSchema,
    /** The owner's current calendar date, used for streaks. */
    today: workDateSchema,
    timeZone: z.string().min(1),
    generatedAt: timestamp,
    counters: z.array(counterSchema),
    values: z.array(counterDayValueSchema),
  })
  .strict();

export const counterCreateRequestSchema = z
  .object({
    /** Client-chosen UUID; a retry with the same content replays. */
    id,
    title: titleSchema,
    kind: counterKindSchema,
    icon: organizationIconSchema.nullable().default(null),
    enabled: z.boolean().default(true),
    hidden: z.boolean().default(false),
    streak: counterStreakSchema.default(defaultCounterStreak),
    countdownMs: countdownSchema.nullable().default(null),
  })
  .strict()
  .refine(
    (counter) =>
      counter.kind === "repeated_countdown" || counter.countdownMs === null,
    { message: "Only a repeated countdown has a countdown length" },
  );

export const counterPatchRequestSchema = z
  .object({
    title: titleSchema.optional(),
    icon: organizationIconSchema.nullable().optional(),
    enabled: z.boolean().optional(),
    hidden: z.boolean().optional(),
    streak: counterStreakSchema.optional(),
    countdownMs: countdownSchema.nullable().optional(),
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, {
    message: "Change at least one field",
  });

/** A day write names the day's revision it read; 0 when the day had no value. */
const dayRevision = z.number().int().nonnegative();
export const counterDayWriteRequestSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("set"),
      value: z.number().int().min(0).max(counterMaxDayMs),
      expectedRevision: dayRevision,
    })
    .strict(),
  z
    .object({
      action: z.literal("increment"),
      /** Negative to decrement; the value stops at zero. */
      delta: z
        .number()
        .int()
        .min(-counterMaxDayMs)
        .max(counterMaxDayMs)
        .refine((value) => value !== 0, "Delta must not be zero"),
      expectedRevision: dayRevision,
    })
    .strict(),
]);

export const counterStopwatchRequestSchema = z
  .object({ action: z.enum(["start", "stop"]) })
  .strict();

export const counterMutationResponseSchema = z
  .object({
    counter: counterSchema,
    /** Day values the write changed. */
    values: z.array(counterDayValueSchema),
    /** Stopwatch time that did not fit into a day's length and was dropped. */
    clampedMs: z.number().int().nonnegative(),
  })
  .strict();

const evaluationText = z.string().trim().max(5_000);
export const evaluationImpactSchema = z.number().int().min(1).max(4);
export const evaluationEnergySchema = z.number().int().min(1).max(3);

export const dailyEvaluationSchema = z
  .object({
    id,
    day: workDateSchema,
    notes: z.string(),
    reflection: z.string(),
    /** Impact of the day's work, 1 to 4. */
    impact: evaluationImpactSchema.nullable(),
    /** Energy check-in, 1 (exhausted) to 3 (good). */
    energy: evaluationEnergySchema.nullable(),
    remindTomorrow: z.boolean(),
    /**
     * Super Productivity focus session durations in milliseconds. Kept as
     * evaluation history; they are not time entries.
     */
    importedFocusSessionsMs: z.array(z.number().int().positive()),
    revision,
    createdAt: timestamp,
    updatedAt: timestamp,
    provenance: z
      .object({
        source: z.literal("super_productivity"),
        sourceDay: workDateSchema,
      })
      .strict()
      .nullable(),
  })
  .strict();

export const evaluationWriteRequestSchema = z
  .object({
    /** The evaluation revision read; 0 when the day has none. */
    expectedRevision: dayRevision,
    notes: evaluationText.optional(),
    reflection: evaluationText.optional(),
    impact: evaluationImpactSchema.nullable().optional(),
    energy: evaluationEnergySchema.nullable().optional(),
    remindTomorrow: z.boolean().optional(),
  })
  .strict()
  .refine((input) => Object.keys(input).length > 1, {
    message: "Change at least one field",
  });

export const evaluationListResponseSchema = z
  .object({
    from: workDateSchema,
    to: workDateSchema,
    timeZone: z.string().min(1),
    evaluations: z.array(dailyEvaluationSchema),
    /** Tadooer focus time per day, derived from active-session intervals. */
    focus: z.array(
      z
        .object({
          day: workDateSchema,
          ms: z.number().int().nonnegative(),
          intervals: z.number().int().nonnegative(),
        })
        .strict(),
    ),
  })
  .strict();

export const evaluationMutationResponseSchema = z
  .object({ evaluation: dailyEvaluationSchema })
  .strict();

/** Assistant counter definition writes (preview/confirm). */
export const automationCounterMutationInputSchema = z.discriminatedUnion(
  "action",
  [
    z
      .object({
        action: z.literal("create"),
        id,
        title: titleSchema,
        kind: counterKindSchema,
        icon: organizationIconSchema.nullable().default(null),
        enabled: z.boolean().default(true),
        hidden: z.boolean().default(false),
        streak: counterStreakSchema.default(defaultCounterStreak),
        countdownMs: countdownSchema.nullable().default(null),
      })
      .strict(),
    z
      .object({
        action: z.literal("update"),
        id,
        expectedRevision: revision,
        patch: counterPatchRequestSchema,
      })
      .strict(),
    z
      .object({
        action: z.literal("delete"),
        id,
        expectedRevision: revision,
      })
      .strict(),
  ],
);

/** Assistant day value writes and stopwatch control (preview/confirm). */
export const automationCounterRecordInputSchema = z.discriminatedUnion(
  "action",
  [
    z
      .object({
        action: z.literal("set"),
        counterId: id,
        day: workDateSchema,
        value: z.number().int().min(0).max(counterMaxDayMs),
        expectedRevision: dayRevision,
      })
      .strict(),
    z
      .object({
        action: z.literal("increment"),
        counterId: id,
        day: workDateSchema,
        delta: z
          .number()
          .int()
          .min(-counterMaxDayMs)
          .max(counterMaxDayMs)
          .refine((value) => value !== 0, "Delta must not be zero"),
        expectedRevision: dayRevision,
      })
      .strict(),
    z
      .object({
        action: z.enum(["start", "stop"]),
        counterId: id,
        expectedRevision: revision,
      })
      .strict(),
  ],
);

export const automationEvaluationWriteInputSchema = z
  .object({
    day: workDateSchema,
    expectedRevision: dayRevision,
    notes: evaluationText.optional(),
    reflection: evaluationText.optional(),
    impact: evaluationImpactSchema.nullable().optional(),
    energy: evaluationEnergySchema.nullable().optional(),
    remindTomorrow: z.boolean().optional(),
  })
  .strict()
  .refine((input) => Object.keys(input).length > 2, {
    message: "Change at least one field",
  });

export type CounterKind = z.infer<typeof counterKindSchema>;
export type CounterStreak = z.infer<typeof counterStreakSchema>;
export type Counter = z.infer<typeof counterSchema>;
export type CounterDayValue = z.infer<typeof counterDayValueSchema>;
export type CounterHistory = z.infer<typeof counterHistoryResponseSchema>;
export type CounterCreateRequest = z.input<typeof counterCreateRequestSchema>;
export type CounterPatchRequest = z.infer<typeof counterPatchRequestSchema>;
export type CounterDayWriteRequest = z.infer<
  typeof counterDayWriteRequestSchema
>;
export type CounterMutationResponse = z.infer<
  typeof counterMutationResponseSchema
>;
export type DailyEvaluation = z.infer<typeof dailyEvaluationSchema>;
export type EvaluationWriteRequest = z.infer<
  typeof evaluationWriteRequestSchema
>;
export type EvaluationList = z.infer<typeof evaluationListResponseSchema>;
export type EvaluationMutationResponse = z.infer<
  typeof evaluationMutationResponseSchema
>;
