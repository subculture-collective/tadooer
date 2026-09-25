import { z } from "zod";
import { taskLinkUrlSchema } from "./task-links.ts";
import {
  recurrenceDateSchema,
  recurrenceRuleSchema,
  recurrenceStartTimeSchema,
} from "./recurrence.ts";

// Capture syntax (issue #90, ADR 0031). Local id/revision copies avoid an
// import cycle with index.ts, which re-exports this file.
const id = z.uuid();
const revision = z.number().int().min(0);

export const captureUrlBehaviorSchema = z.enum([
  "keep",
  "extract",
  "keep_and_attach",
]);
export const capturePreferencesSchema = z
  .object({ urlBehavior: captureUrlBehaviorSchema })
  .strict();
export const capturePreferencesResponseSchema = z
  .object({ preferences: capturePreferencesSchema, revision })
  .strict();
export const capturePreferencesUpdateRequestSchema = z
  .object({ preferences: capturePreferencesSchema, expectedRevision: revision })
  .strict();

/** A tag created with the task; the id is fixed at preview time. */
export const captureNewTagSchema = z
  .object({ id, title: z.string().trim().min(1).max(100) })
  .strict();
/** A link attachment created with the task (ADR 0021 address rules). */
export const captureLinkSchema = z
  .object({ title: z.string().trim().min(1).max(500), url: taskLinkUrlSchema })
  .strict();
/** A recurring series started from the task (ADR 0023). */
export const captureRecurrenceSchema = z
  .object({
    rule: recurrenceRuleSchema,
    startDate: recurrenceDateSchema,
    startTime: recurrenceStartTimeSchema.nullable(),
  })
  .strict();

/**
 * Fields a resolved capture adds to a task create request. `createTags` is
 * the owner's consent on the session API; the other three are the resolved
 * form that an automation preview stores for its confirmation.
 */
export const captureCreateFields = {
  createTags: z.boolean().optional(),
  newTags: z.array(captureNewTagSchema).max(25).optional(),
  attachments: z.array(captureLinkSchema).max(100).optional(),
  recurrence: captureRecurrenceSchema.optional(),
};

export const captureBatchMaxTasks = 100;

/** Session preview of pasted text; no side effects. */
export const capturePreviewRequestSchema = z
  .object({
    text: z.string().min(1).max(200_000),
    structured: z.boolean().default(false),
  })
  .strict();

const previewChild = z
  .object({
    title: z.string(),
    notes: z.string(),
    estimateMinutes: z.number().int().nullable(),
    projectTitle: z.string().nullable(),
    tagTitles: z.array(z.string()),
    newTags: z.array(z.string()),
    plannedDay: z.iso.date().nullable(),
    plannedStart: z.iso.datetime().nullable(),
    deadline: z.string().nullable(),
    recurrence: z.string().nullable(),
    links: z.array(captureLinkSchema),
  })
  .strict();
export const capturePreviewItemSchema = previewChild.extend({
  children: z.array(previewChild),
});
const sourceChild = z
  .object({ title: z.string(), notes: z.string(), structured: z.boolean() })
  .strict();
/** The items to send to the batch create, as parsed from the paste. */
export const captureBatchSourceSchema = z
  .object({
    items: z
      .array(sourceChild.extend({ children: z.array(sourceChild) }))
      .max(captureBatchMaxTasks),
  })
  .strict();
export const capturePreviewResponseSchema = z
  .object({
    kind: z.enum(["single", "markdown", "email"]),
    items: z.array(capturePreviewItemSchema).max(captureBatchMaxTasks),
    /** Every tag the confirmation would create, case-folded unique. */
    newTags: z.array(z.string()),
    skippedCompleted: z.number().int().min(0),
    truncated: z.boolean(),
    request: captureBatchSourceSchema,
  })
  .strict();

export type CaptureUrlBehavior = z.infer<typeof captureUrlBehaviorSchema>;
export type CapturePreferences = z.infer<typeof capturePreferencesSchema>;
export type CapturePreferencesResponse = z.infer<
  typeof capturePreferencesResponseSchema
>;
export type CapturePreviewRequest = z.input<typeof capturePreviewRequestSchema>;
export type CapturePreviewResponse = z.infer<
  typeof capturePreviewResponseSchema
>;
export type CapturePreviewItem = z.infer<typeof capturePreviewItemSchema>;
