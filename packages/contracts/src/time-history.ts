import { z } from "zod";

/**
 * Work history contracts (issue #41, ADR 0024). A time entry is a task's
 * tracked time on one owner-zone calendar day. Focus entries are read-only
 * projections of active-session focus intervals; import and manual entries are
 * revisioned daily totals without a time of day.
 */
export const timeEntrySourceSchema = z.enum(["focus", "import", "manual"]);
export const workDateSchema = z.iso.date();
/** One day, in milliseconds. */
export const timeEntryDayLimitMs = 86_400_000;
export const timeReportMaxDays = 366;

const durationSchema = z
  .number()
  .int()
  .min(-timeEntryDayLimitMs)
  .max(timeEntryDayLimitMs)
  .refine((value) => value !== 0, "Duration must not be zero");
const noteSchema = z.string().trim().max(500);

export const timeEntryImportProvenanceSchema = z
  .object({
    source: z.literal("super_productivity"),
    /** `parent_residual`: parent time the source children do not explain. */
    kind: z.enum(["task_day", "parent_residual"]),
    sourceTaskId: z.string().min(1).max(200),
    sourceWorkDate: workDateSchema,
    sourceStore: z.enum(["task", "archiveYoung", "archiveOld"]),
  })
  .strict();

export const timeEntrySchema = z
  .object({
    /** Entry UUID, or the focus interval UUID for a focus entry. */
    id: z.uuid(),
    taskId: z.uuid(),
    workDate: workDateSchema,
    durationMs: z.number().int(),
    source: timeEntrySourceSchema,
    /** Null for focus entries, which the active session owns. */
    revision: z.number().int().positive().nullable(),
    note: z.string(),
    /** Focus only: the part of the interval on this day. */
    startedAt: z.iso.datetime().nullable(),
    endedAt: z.iso.datetime().nullable(),
    running: z.boolean(),
    provenance: timeEntryImportProvenanceSchema.nullable(),
    createdAt: z.iso.datetime().nullable(),
    updatedAt: z.iso.datetime().nullable(),
  })
  .strict();

export const timeEntryCreateRequestSchema = z
  .object({
    /** Client-chosen UUID; a retry with the same content replays. */
    id: z.uuid(),
    taskId: z.uuid(),
    workDate: workDateSchema,
    durationMs: durationSchema,
    note: noteSchema.default(""),
  })
  .strict();

export const timeEntryPatchRequestSchema = z
  .object({
    workDate: workDateSchema.optional(),
    durationMs: durationSchema.optional(),
    note: noteSchema.optional(),
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, {
    message: "Change at least one field",
  });

/**
 * ADR 0050: how many owner-zone days of time entries a sync snapshot and the
 * offline cache hold, counting today. Older history is read online through
 * the time report.
 */
export const syncTimeEntryWindowDays = 90;

/**
 * The first work date inside the window that ends on `today`. Calendar
 * arithmetic on the date itself; no time zone is involved.
 */
export const syncTimeEntryWindowStart = (
  today: string,
  days: number = syncTimeEntryWindowDays,
): string =>
  new Date(Date.parse(`${today}T00:00:00.000Z`) - (days - 1) * 86_400_000)
    .toISOString()
    .slice(0, 10);

/**
 * ADR 0050: the fields an offline `time_entry.create` carries. Every field
 * is explicit so the operation's request hash never depends on a default.
 */
export const syncTimeEntryCreateSchema = z
  .object({
    id: z.uuid(),
    taskId: z.uuid(),
    workDate: workDateSchema,
    durationMs: durationSchema,
    note: noteSchema,
  })
  .strict();

/** ADR 0050: the fields an offline `time_entry.patch` may change. */
export const syncTimeEntryPatchFieldsSchema = z
  .object({
    workDate: workDateSchema.optional(),
    durationMs: durationSchema.optional(),
    note: noteSchema.optional(),
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, {
    message: "Change at least one field",
  });

export const timeEntryMutationResponseSchema = z
  .object({
    timeEntry: timeEntrySchema.nullable(),
    deletedId: z.uuid().nullable(),
    /** Every source for the affected task and day after the write. */
    dayTotalMs: z.number().int(),
  })
  .strict();

export const timeReportQuerySchema = z
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
    { message: `A report covers at most ${String(timeReportMaxDays)} days` },
  );

const millisecondsSchema = z.number().int();
const bySourceSchema = z
  .object({
    focus: millisecondsSchema,
    import: millisecondsSchema,
    manual: millisecondsSchema,
  })
  .strict();

export const timeReportTaskSchema = z
  .object({
    taskId: z.uuid(),
    title: z.string(),
    parentId: z.uuid().nullable(),
    projectId: z.uuid().nullable(),
    status: z.enum(["open", "completed"]),
    archived: z.boolean(),
    estimateMinutes: z.number().int().nullable(),
    /** Own estimate plus the estimates of every child task. */
    rollupEstimateMinutes: z.number().int().nullable(),
    /** The task's own time in the range. */
    ownMs: millisecondsSchema,
    /** Child tasks' own time in the range; zero for a leaf. */
    childrenMs: millisecondsSchema,
    /** Own and children's time across all dates. */
    allTimeMs: millisecondsSchema,
    bySource: bySourceSchema,
  })
  .strict();

export const timeReportDaySchema = z
  .object({
    date: workDateSchema,
    totalMs: millisecondsSchema,
    /** Imported Super Productivity work start/end and breaks for the day. */
    workStart: z.iso.datetime().nullable(),
    workEnd: z.iso.datetime().nullable(),
    breakCount: z.number().int().nonnegative().nullable(),
    breakMs: z.number().int().nonnegative().nullable(),
    tasks: z.array(
      z
        .object({
          taskId: z.uuid(),
          totalMs: millisecondsSchema,
          bySource: bySourceSchema,
        })
        .strict(),
    ),
  })
  .strict();

export const timeReportResponseSchema = z
  .object({
    from: workDateSchema,
    to: workDateSchema,
    timeZone: z.string().min(1),
    generatedAt: z.iso.datetime(),
    totalMs: millisecondsSchema,
    bySource: bySourceSchema,
    days: z.array(timeReportDaySchema),
    weeks: z.array(
      z
        .object({
          weekStart: workDateSchema,
          totalMs: millisecondsSchema,
          daysWorked: z.number().int().nonnegative(),
        })
        .strict(),
    ),
    tasks: z.array(timeReportTaskSchema),
    projects: z.array(
      z
        .object({
          projectId: z.uuid().nullable(),
          title: z.string(),
          totalMs: millisecondsSchema,
          estimateMinutes: z.number().int().nullable(),
        })
        .strict(),
    ),
    entries: z.array(timeEntrySchema),
  })
  .strict();

/** Assistant add/edit/delete of an import or manual entry (preview/confirm). */
export const automationTimeEntryMutationInputSchema = z.discriminatedUnion(
  "action",
  [
    timeEntryCreateRequestSchema.extend({ action: z.literal("add") }),
    z
      .object({
        action: z.literal("update"),
        id: z.uuid(),
        expectedRevision: z.number().int().positive(),
        patch: timeEntryPatchRequestSchema,
      })
      .strict(),
    z
      .object({
        action: z.literal("delete"),
        id: z.uuid(),
        expectedRevision: z.number().int().positive(),
      })
      .strict(),
  ],
);

export type TimeEntrySource = z.infer<typeof timeEntrySourceSchema>;
export type TimeEntry = z.infer<typeof timeEntrySchema>;
export type TimeEntryCreateRequest = z.input<
  typeof timeEntryCreateRequestSchema
>;
export type TimeEntryPatchRequest = z.infer<typeof timeEntryPatchRequestSchema>;
export type TimeEntryMutationResponse = z.infer<
  typeof timeEntryMutationResponseSchema
>;
export type TimeReportQuery = z.infer<typeof timeReportQuerySchema>;
export type TimeReport = z.infer<typeof timeReportResponseSchema>;
export type TimeReportTask = z.infer<typeof timeReportTaskSchema>;
export type TimeReportDay = z.infer<typeof timeReportDaySchema>;
