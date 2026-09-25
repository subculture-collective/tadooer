import { z } from "zod";

/**
 * Archived task history contracts (issue #38, ADR 0022). Task-bearing history
 * responses are composed in index.ts, next to the task schema.
 */
export const taskArchiveReviewReasonSchema = z.enum([
  "blank_title",
  "notes_unrepresentable",
  "estimate_unrepresentable",
]);

export const historicalReferenceSchema = z
  .object({
    kind: z.enum(["project", "tag", "repeat_config", "parent"]),
    sourceId: z.string().min(1).max(200),
    reason: z.enum([
      "missing_from_export",
      "system_tag",
      "recurrence_unsupported",
      "lifecycle_mismatch",
    ]),
  })
  .strict();

/** Read-only import provenance shown with a historical task. */
export const taskHistoryProvenanceSchema = z
  .object({
    source: z.literal("super_productivity"),
    sourceStore: z.enum(["task", "archiveYoung", "archiveOld"]),
    review: z.array(taskArchiveReviewReasonSchema),
    historicalReferences: z.array(historicalReferenceSchema),
  })
  .strict();

/** Owner-scoped history search. Matching is case-insensitive for ASCII. */
export const taskHistoryQuerySchema = z
  .object({
    query: z.string().trim().max(200).optional(),
    cursor: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,400}$/)
      .optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  })
  .strict();

/** Title given to an archived source record whose title was blank. */
export const untitledArchivedTaskTitle = "Untitled archived task";

export type TaskArchiveReviewReason = z.infer<
  typeof taskArchiveReviewReasonSchema
>;
export type HistoricalReference = z.infer<typeof historicalReferenceSchema>;
export type TaskHistoryProvenance = z.infer<typeof taskHistoryProvenanceSchema>;
export type TaskHistoryQuery = z.infer<typeof taskHistoryQuerySchema>;
