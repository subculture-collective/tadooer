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
