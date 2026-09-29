import { z } from "zod";

/**
 * Google-Baikal calendar bridge owner routes (issue #40, ADR 0041). Online
 * only; not in the sync feed or the automation catalog (#48 owns assistant
 * coverage). Responses never include provider credentials.
 */
export const calendarBridgeDirectionSchema = z.enum([
  "two_way",
  "google_to_baikal",
  "baikal_to_google",
]);
export const calendarBridgeInitialSyncSchema = z.enum([
  "copy_existing",
  "new_only",
]);
export const calendarBridgeSideSchema = z.enum(["google", "baikal"]);

export const calendarBridgeMappingCreateRequestSchema = z
  .object({
    googleCalendarId: z.uuid(),
    baikalCalendarId: z.uuid(),
    direction: calendarBridgeDirectionSchema,
    initialSync: calendarBridgeInitialSyncSchema,
  })
  .strict();

export const calendarBridgeMappingPatchRequestSchema = z
  .object({ enabled: z.boolean() })
  .strict();

export const calendarBridgeConflictResolveRequestSchema = z
  .object({ keep: calendarBridgeSideSchema })
  .strict();

export const calendarBridgeMappingSchema = z.object({
  id: z.uuid(),
  revision: z.number().int().positive(),
  googleCalendarId: z.string(),
  googleCalendarRef: z.string(),
  baikalCalendarId: z.string(),
  baikalCalendarRef: z.string(),
  direction: calendarBridgeDirectionSchema,
  initialSync: calendarBridgeInitialSyncSchema,
  enabled: z.boolean(),
  firstPassAt: z.string().nullable(),
  lastRunAt: z.string().nullable(),
  lastSuccessAt: z.string().nullable(),
  lastErrorCode: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const calendarBridgeRunCountsSchema = z.object({
  settled: z.number().int().nonnegative(),
  enqueued: z.number().int().nonnegative(),
  applied: z.number().int().nonnegative(),
  uncertain: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  conflicts: z.number().int().nonnegative(),
  blocked: z.number().int().nonnegative(),
  excluded: z.number().int().nonnegative(),
});

export const calendarBridgeRunResponseSchema = z.object({
  outcome: z.enum(["completed", "failed", "disabled", "blocked"]),
  reason: z.string().nullable(),
  counts: calendarBridgeRunCountsSchema.nullable(),
  mapping: calendarBridgeMappingSchema,
});

const sideStateSchema = z.object({
  kind: z.enum(["unknown", "present", "deleted"]),
  revision: z.string().nullable(),
  digest: z.string().nullable(),
});

export const calendarBridgeLinkSchema = z.object({
  id: z.uuid(),
  revision: z.number().int().positive(),
  origin: calendarBridgeSideSchema,
  googleEventId: z.string().nullable(),
  googleIcalUid: z.string().nullable(),
  baikalHref: z.string().nullable(),
  baikalUid: z.string().nullable(),
  google: sideStateSchema,
  baikal: sideStateSchema,
  acceptedKind: z.enum(["none", "present", "deleted"]),
  acceptedDigest: z.string().nullable(),
  status: z.enum([
    "pending",
    "active",
    "conflict",
    "blocked",
    "excluded",
    "tombstoned",
  ]),
  statusReason: z.string().nullable(),
  deletionApproval: z
    .object({ side: calendarBridgeSideSchema, proof: z.string() })
    .nullable(),
  updatedAt: z.string(),
});

export const calendarBridgeConflictSchema = z.object({
  id: z.uuid(),
  linkId: z.uuid(),
  reason: z.enum(["concurrent-change", "resurrection"]),
  google: z.object({
    kind: z.enum(["present", "deleted"]),
    revision: z.string().nullable(),
    digest: z.string().nullable(),
  }),
  baikal: z.object({
    kind: z.enum(["present", "deleted"]),
    revision: z.string().nullable(),
    digest: z.string().nullable(),
  }),
  createdAt: z.string(),
});

export const calendarBridgeOperationSchema = z.object({
  id: z.uuid(),
  linkId: z.uuid(),
  sequence: z.number().int().positive(),
  target: calendarBridgeSideSchema,
  action: z.enum(["create", "update", "delete"]),
  reason: z.enum(["propagate", "create", "resolution"]),
  state: z.enum([
    "pending",
    "dispatched",
    "uncertain",
    "applied",
    "failed",
    "cancelled",
  ]),
  attempts: z.number().int().nonnegative(),
  lastError: z.string().nullable(),
  updatedAt: z.string(),
});

export const calendarBridgeLinksResponseSchema = z.object({
  links: z.array(calendarBridgeLinkSchema),
  conflicts: z.array(calendarBridgeConflictSchema),
  operations: z.array(calendarBridgeOperationSchema),
});

/*
 * Bridge controls (issue #48, ADR 0044). Views derived from the ADR 0041 read
 * models for the Connections page and the assistant. A version is read from
 * the retained normalized snapshot; it never carries raw iCalendar or secrets.
 */

/** Minutes without a successful pass after which a mapping is stale. */
export const calendarBridgeStaleAfterMinutes = 24 * 60;
/** Entries per review list; the mapping counts give the totals. */
export const calendarBridgeReviewListLimit = 200;

export const calendarBridgeEventVersionSchema = z.object({
  kind: z.enum(["unknown", "present", "deleted"]),
  revision: z.string().nullable(),
  summary: z.string().nullable(),
  description: z.string().nullable(),
  location: z.string().nullable(),
  allDay: z.boolean().nullable(),
  /** UTC instant, or `YYYY-MM-DD` for an all-day event. */
  start: z.string().nullable(),
  end: z.string().nullable(),
  /** Names of content the bridge does not propagate. */
  unsupported: z.array(z.string()),
});

export const calendarBridgeMappingStateSchema = z.enum([
  "ok",
  "paused",
  "reconnect-required",
  "failing",
  "needs-review",
  "not-run",
]);

export const calendarBridgeAttentionSchema = z.enum([
  "paused",
  "google-disconnected",
  "google-reconnect-required",
  "google-consent-required",
  "google-calendar-unavailable",
  "google-calendar-read-only",
  "baikal-unavailable",
  "last-pass-failed",
  "not-run",
  "stale",
  "conflicts",
  "deletions-awaiting-approval",
  "blocked-events",
  "writes-retrying",
  "writes-unconfirmed",
]);

export const calendarBridgeMappingCountsSchema = z.object({
  links: z.number().int().nonnegative(),
  active: z.number().int().nonnegative(),
  pendingWrites: z.number().int().nonnegative(),
  inFlightWrites: z.number().int().nonnegative(),
  retryingWrites: z.number().int().nonnegative(),
  blocked: z.number().int().nonnegative(),
  pendingDeletions: z.number().int().nonnegative(),
  conflicts: z.number().int().nonnegative(),
  excluded: z.number().int().nonnegative(),
  tombstoned: z.number().int().nonnegative(),
});

export const calendarBridgeMappingSummarySchema =
  calendarBridgeMappingSchema.extend({
    googleCalendarName: z.string().nullable(),
    baikalCalendarName: z.string().nullable(),
    state: calendarBridgeMappingStateSchema,
    stale: z.boolean(),
    attention: z.array(calendarBridgeAttentionSchema),
    counts: calendarBridgeMappingCountsSchema,
  });

export const calendarBridgeOverviewResponseSchema = z.object({
  staleAfterMinutes: z.number().int().positive(),
  mappings: z.array(calendarBridgeMappingSummarySchema),
});

export const calendarBridgeBlockedEventSchema = z.object({
  linkId: z.uuid(),
  linkRevision: z.number().int().positive(),
  title: z.string().nullable(),
  start: z.string().nullable(),
  allDay: z.boolean().nullable(),
  origin: calendarBridgeSideSchema,
  reason: z.string().nullable(),
  /** The side whose copy was deleted, for `deletion-approval`. */
  deletedOn: calendarBridgeSideSchema.nullable(),
  /** True once the owner approved; the next pass deletes the other copy. */
  approved: z.boolean(),
});

export const calendarBridgeReviewConflictSchema = z.object({
  id: z.uuid(),
  linkId: z.uuid(),
  linkRevision: z.number().int().positive(),
  reason: z.enum(["concurrent-change", "resurrection"]),
  title: z.string().nullable(),
  createdAt: z.string(),
  google: calendarBridgeEventVersionSchema,
  baikal: calendarBridgeEventVersionSchema,
});

export const calendarBridgeReviewOperationSchema =
  calendarBridgeOperationSchema.extend({ title: z.string().nullable() });

export const calendarBridgeReviewResponseSchema = z.object({
  mapping: calendarBridgeMappingSummarySchema,
  blocked: z.array(calendarBridgeBlockedEventSchema),
  conflicts: z.array(calendarBridgeReviewConflictSchema),
  operations: z.array(calendarBridgeReviewOperationSchema),
});

export const calendarBridgeCreateRefusalSchema = z.enum([
  "consent-required",
  "google-calendar-not-writable",
  "calendar-in-use",
  "invalid-calendar",
]);

export const calendarBridgeCopyPreviewSchema = z.object({
  from: calendarBridgeSideSchema,
  to: calendarBridgeSideSchema,
  /** Distinct events Tadooer last read from the source calendar. */
  existing: z.number().int().nonnegative(),
  /** Events the first pass would copy; zero for `new_only`. */
  copied: z.number().int().nonnegative(),
  /** Repeating events among `existing`; they may be held for review. */
  repeating: z.number().int().nonnegative(),
  sample: z
    .array(
      z.object({
        summary: z.string(),
        startsAt: z.string(),
        allDay: z.boolean(),
      }),
    )
    .max(10),
  readAt: z.string().nullable(),
});

export const calendarBridgeMappingPreviewResponseSchema = z.object({
  direction: calendarBridgeDirectionSchema,
  initialSync: calendarBridgeInitialSyncSchema,
  refusals: z.array(calendarBridgeCreateRefusalSchema),
  copies: z.array(calendarBridgeCopyPreviewSchema),
});

/* Assistant operations (ADR 0044). */

export const automationCalendarBridgeResourceInputSchema = z
  .object({ mappingId: z.uuid().optional() })
  .strict();

export const automationCalendarBridgeResourceSchema = z
  .object({
    staleAfterMinutes: z.number().int().positive(),
    mappings: z.array(calendarBridgeMappingSummarySchema),
    review: calendarBridgeReviewResponseSchema.nullable(),
  })
  .strict();

export const automationCalendarBridgeDeletionInputSchema = z
  .object({
    mappingId: z.uuid(),
    linkId: z.uuid(),
    expectedRevision: z.number().int().positive(),
    decision: z.enum(["approve", "keep"]),
  })
  .strict();

export const automationCalendarBridgeResolveInputSchema = z
  .object({
    mappingId: z.uuid(),
    conflictId: z.uuid(),
    keep: calendarBridgeSideSchema,
    expectedLinkRevision: z.number().int().positive(),
  })
  .strict();

export type CalendarBridgeSide = z.infer<typeof calendarBridgeSideSchema>;
export type CalendarBridgeDirection = z.infer<
  typeof calendarBridgeDirectionSchema
>;
export type CalendarBridgeInitialSyncChoice = z.infer<
  typeof calendarBridgeInitialSyncSchema
>;
export type CalendarBridgeMappingCreateRequest = z.infer<
  typeof calendarBridgeMappingCreateRequestSchema
>;
export type CalendarBridgeMapping = z.infer<typeof calendarBridgeMappingSchema>;
export type CalendarBridgeLink = z.infer<typeof calendarBridgeLinkSchema>;
export type CalendarBridgeOperation = z.infer<
  typeof calendarBridgeOperationSchema
>;
export type CalendarBridgeRunResponse = z.infer<
  typeof calendarBridgeRunResponseSchema
>;
export type CalendarBridgeEventVersion = z.infer<
  typeof calendarBridgeEventVersionSchema
>;
export type CalendarBridgeMappingState = z.infer<
  typeof calendarBridgeMappingStateSchema
>;
export type CalendarBridgeAttention = z.infer<
  typeof calendarBridgeAttentionSchema
>;
export type CalendarBridgeMappingSummary = z.infer<
  typeof calendarBridgeMappingSummarySchema
>;
export type CalendarBridgeOverviewResponse = z.infer<
  typeof calendarBridgeOverviewResponseSchema
>;
export type CalendarBridgeBlockedEvent = z.infer<
  typeof calendarBridgeBlockedEventSchema
>;
export type CalendarBridgeReviewConflict = z.infer<
  typeof calendarBridgeReviewConflictSchema
>;
export type CalendarBridgeReviewOperation = z.infer<
  typeof calendarBridgeReviewOperationSchema
>;
export type CalendarBridgeReviewResponse = z.infer<
  typeof calendarBridgeReviewResponseSchema
>;
export type CalendarBridgeCreateRefusal = z.infer<
  typeof calendarBridgeCreateRefusalSchema
>;
export type CalendarBridgeCopyPreview = z.infer<
  typeof calendarBridgeCopyPreviewSchema
>;
export type CalendarBridgeMappingPreviewResponse = z.infer<
  typeof calendarBridgeMappingPreviewResponseSchema
>;
export type AutomationCalendarBridgeResource = z.infer<
  typeof automationCalendarBridgeResourceSchema
>;
