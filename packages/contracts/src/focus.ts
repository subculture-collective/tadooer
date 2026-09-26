import { z } from "zod";

// Self-contained like the other contract modules; index.ts adds the
// session-bearing schemas (focusTimerSchema, focusIdleResponseSchema).
const entityIdSchema = z.uuid();
const revisionSchema = z.number().int().positive();

/**
 * Focus presets, idle handling and break reminders (issue #65, ADR 0029).
 *
 * Focus preferences are an owner-scoped, revisioned record. Durations are
 * whole minutes; the server converts them to millisecond targets when a
 * session's plan is set, so a preference edit never changes a running plan.
 */

export const focusModeSchema = z.enum(["pomodoro", "flowtime", "countdown"]);
export type FocusMode = z.infer<typeof focusModeSchema>;

export const focusIdleDispositionSchema = z.enum([
  "assign",
  "break",
  "discard",
]);
export type FocusIdleDisposition = z.infer<typeof focusIdleDispositionSchema>;

const minutes = (max: number) => z.number().int().min(1).max(max);

export const flowtimeBreakRuleSchema = z
  .object({
    /** Focus stretch length from which the rule applies (inclusive). */
    minMinutes: z.number().int().min(0).max(1_440),
    /** Exclusive upper bound; null means no upper bound. */
    maxMinutes: z.number().int().min(1).max(1_440).nullable(),
    breakMinutes: minutes(240),
  })
  .strict()
  .refine(
    ({ minMinutes, maxMinutes }) =>
      maxMinutes === null || maxMinutes > minMinutes,
    { message: "A break rule's upper bound must exceed its lower bound" },
  );

export const focusPreferencesSchema = z
  .object({
    /** Preset applied when a plan is set without an explicit mode. */
    defaultMode: focusModeSchema,
    pomodoro: z
      .object({
        workMinutes: minutes(240),
        shortBreakMinutes: minutes(120),
        longBreakMinutes: minutes(240),
        cyclesBeforeLongBreak: minutes(12),
      })
      .strict(),
    flowtime: z
      .object({
        breakEnabled: z.boolean(),
        breakMode: z.enum(["ratio", "rule"]),
        breakPercentage: z.number().int().min(1).max(100),
        breakRules: z.array(flowtimeBreakRuleSchema).max(10),
      })
      .strict(),
    countdownMinutes: minutes(480),
    /** Apply the default preset when a session starts from a task row. */
    autoStartFocusOnTracking: z.boolean(),
    /** Play a short tone in the browser when a break's time is up. Off by default. */
    breakEndAlarm: z.boolean(),
    idle: z
      .object({
        enabled: z.boolean(),
        minIdleMinutes: minutes(120),
        /** Detect idle only while a session is running. */
        onlyWithTask: z.boolean(),
        /** Do not detect idle while a Pomodoro or countdown timer runs. */
        suppressInFocus: z.boolean(),
      })
      .strict(),
    takeABreak: z
      .object({
        enabled: z.boolean(),
        minWorkingMinutes: minutes(720),
        snoozeMinutes: minutes(120),
        /** `${duration}` is replaced with the working time as h:mm. */
        message: z.string().max(500),
      })
      .strict(),
    trackingReminder: z
      .object({
        enabled: z.boolean(),
        minMinutes: minutes(240),
      })
      .strict(),
  })
  .strict();
export type FocusPreferences = z.infer<typeof focusPreferencesSchema>;

export const defaultFocusPreferences: FocusPreferences = {
  defaultMode: "pomodoro",
  pomodoro: {
    workMinutes: 25,
    shortBreakMinutes: 5,
    longBreakMinutes: 15,
    cyclesBeforeLongBreak: 4,
  },
  flowtime: {
    breakEnabled: false,
    breakMode: "ratio",
    breakPercentage: 20,
    breakRules: [],
  },
  countdownMinutes: 25,
  autoStartFocusOnTracking: false,
  breakEndAlarm: false,
  idle: {
    enabled: true,
    minIdleMinutes: 5,
    onlyWithTask: true,
    suppressInFocus: false,
  },
  takeABreak: {
    enabled: true,
    minWorkingMinutes: 60,
    snoozeMinutes: 15,
    message:
      "You have been working for ${duration} without a break. Step away from the screen for a moment.",
  },
  trackingReminder: { enabled: false, minMinutes: 5 },
};

export const focusPreferenceProvenanceSchema = z
  .object({
    source: z.literal("super_productivity"),
    inputHash: z.string().regex(/^[a-f0-9]{64}$/),
    importedAt: z.iso.datetime(),
    /** Dotted globalConfig keys that were applied, for example `pomodoro.duration`. */
    fields: z.array(z.string().min(1).max(100)).max(50),
  })
  .strict();
export type FocusPreferenceProvenance = z.infer<
  typeof focusPreferenceProvenanceSchema
>;

export const focusPreferencesResponseSchema = z
  .object({
    preferences: focusPreferencesSchema,
    /** 0 until the owner or an import saves the record. */
    revision: z.number().int().nonnegative(),
    imported: focusPreferenceProvenanceSchema.nullable(),
  })
  .strict();
export type FocusPreferencesResponse = z.infer<
  typeof focusPreferencesResponseSchema
>;

/** Assistant snapshot: the preference fields with their revision (like planning). */
export const focusPreferenceSnapshotSchema = focusPreferencesSchema
  .extend({ revision: z.number().int().nonnegative() })
  .strict();

export const focusPreferenceMutationInputSchema = z
  .object({
    expectedRevision: z.number().int().nonnegative(),
    preferences: focusPreferencesSchema,
  })
  .strict();

/** Millisecond targets frozen for one session when its plan is set. */
export const focusPlanSchema = z
  .object({
    mode: focusModeSchema,
    workMs: z.number().int().positive(),
    shortBreakMs: z.number().int().positive(),
    longBreakMs: z.number().int().positive(),
    cyclesBeforeLongBreak: z.number().int().positive(),
    flowtime: z
      .object({
        breakEnabled: z.boolean(),
        breakMode: z.enum(["ratio", "rule"]),
        breakPercentage: z.number().int().min(1).max(100),
        breakRules: z
          .array(
            z
              .object({
                minMs: z.number().int().nonnegative(),
                maxMs: z.number().int().positive().nullable(),
                breakMs: z.number().int().positive(),
              })
              .strict(),
          )
          .max(10),
      })
      .strict(),
  })
  .strict();
export type FocusPlan = z.infer<typeof focusPlanSchema>;

export const focusCountdownSchema = z
  .object({
    phase: z.enum(["focus", "break"]),
    /** Time in the current phase across pauses, at `at`. */
    elapsedMs: z.number().int().nonnegative(),
    /** Null when the phase has no target (flowtime focus, countdown break). */
    targetMs: z.number().int().positive().nullable(),
    remainingMs: z.number().int().nullable(),
    done: z.boolean(),
    /** 1 for the first focus stretch; advances when a break ends. */
    cycle: z.number().int().positive(),
    isLongBreak: z.boolean(),
    /** Server instant at which the target was reached, once it was. */
    reachedAt: z.iso.datetime().nullable(),
  })
  .strict();

export const focusTimerBaseSchema = z
  .object({
    at: z.iso.datetime(),
    plan: focusPlanSchema.nullable(),
    countdown: focusCountdownSchema.nullable(),
    breakReminder: z
      .object({
        enabled: z.boolean(),
        workingWithoutBreakMs: z.number().int().nonnegative(),
        thresholdMs: z.number().int().positive(),
        due: z.boolean(),
        snoozedUntil: z.iso.datetime().nullable(),
      })
      .strict(),
    trackingReminder: z
      .object({
        enabled: z.boolean(),
        untrackedMs: z.number().int().nonnegative().nullable(),
        thresholdMs: z.number().int().positive(),
        due: z.boolean(),
        /** Why a due reminder is held back, or null. */
        suppressedReason: z
          .enum([
            "tracking",
            "outside_working_hours",
            "scheduled_break",
            "calendar_busy",
            "finished_for_today",
          ])
          .nullable(),
      })
      .strict(),
    idle: z
      .object({
        enabled: z.boolean(),
        minIdleMs: z.number().int().positive(),
        onlyWithTask: z.boolean(),
        /** True while a Pomodoro or countdown timer suppresses idle detection. */
        suppressed: z.boolean(),
      })
      .strict(),
  })
  .strict();

export const focusPlanRequestSchema = z
  .object({
    sessionId: entityIdSchema,
    expectedRevision: revisionSchema,
    /** Null clears the plan; the session keeps running without a timer. */
    mode: focusModeSchema.nullable(),
  })
  .strict();
export type FocusPlanRequest = z.infer<typeof focusPlanRequestSchema>;

export const focusIdleRequestSchema = z
  .object({
    sessionId: entityIdSchema,
    expectedRevision: revisionSchema,
    idleStartedAt: z.iso.datetime(),
    disposition: focusIdleDispositionSchema,
    idempotencyKey: z.string().min(1).max(128),
  })
  .strict();
export type FocusIdleRequest = z.infer<typeof focusIdleRequestSchema>;

export const focusIdleCorrectionSchema = z
  .object({
    disposition: focusIdleDispositionSchema,
    /** The applied span; the start is clamped to the open interval. */
    idleStartedAt: z.iso.datetime(),
    idleEndedAt: z.iso.datetime(),
    /** Milliseconds removed from task focus time (0 for `assign`). */
    trimmedMs: z.number().int().nonnegative(),
  })
  .strict();

export const focusIdleDispositionInputSchema = z
  .object({
    sessionId: entityIdSchema,
    expectedRevision: revisionSchema,
    idleStartedAt: z.iso.datetime(),
    disposition: focusIdleDispositionSchema,
  })
  .strict();

export const focusBreakSnoozeResponseSchema = z
  .object({ snoozedUntil: z.iso.datetime() })
  .strict();

/** Ledger kinds owned by focus reminders; rows carry no task ID. */
export const focusReminderKinds = [
  "focus_countdown",
  "focus_break_end",
  "focus_break_reminder",
  "focus_tracking_reminder",
] as const;
export type FocusReminderKind = (typeof focusReminderKinds)[number];
