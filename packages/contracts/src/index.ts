import { z } from "zod";

export const serviceStatusSchema = z.enum(["ok", "not_ready"]);

export const healthResponseSchema = z.object({
  service: z.literal("productivity-suite"),
  status: z.literal("ok"),
  timestamp: z.iso.datetime(),
});

export const readinessResponseSchema = z.object({
  service: z.literal("productivity-suite"),
  status: serviceStatusSchema,
  checks: z.object({
    database: z.enum(["ok", "error"]),
    migrations: z.enum(["current", "pending", "error"]),
  }),
  instanceId: z.uuid().nullable(),
  migrationCount: z.number().int().nonnegative(),
  timestamp: z.iso.datetime(),
});

export const buildResponseSchema = z.object({
  service: z.literal("productivity-suite"),
  version: z.string().min(1),
  revision: z.string().min(1),
  builtAt: z.iso.datetime().nullable(),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;
export type ReadinessResponse = z.infer<typeof readinessResponseSchema>;
export type BuildResponse = z.infer<typeof buildResponseSchema>;

export const apiErrorCodeSchema = z
  .string()
  .regex(/^[A-Z][A-Z0-9_]*$/)
  .max(64);

export const apiErrorSchema = z.object({
  code: apiErrorCodeSchema,
  message: z.string().min(1),
  requestId: z.uuid(),
});

export const idempotencyKeySchema = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9._~-]+$/);

export const revisionSchema = z.number().int().positive();
export const entityIdSchema = z.uuid();
export const quotedRevisionEtagSchema = z.string().regex(/^"[1-9][0-9]*"$/);
export const strongDavEtagSchema = z.string().regex(/^"[^"\r\n]+"$/);

export const setupStatusResponseSchema = z.object({
  setupRequired: z.boolean(),
});

export const ownerSetupRequestSchema = z.object({
  username: z
    .string()
    .min(3)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9._-]*$/),
  displayName: z.string().trim().min(1).max(100),
  password: z.string().min(14).max(1024),
});

export const loginRequestSchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(1024),
});

export const ownerSchema = z.object({
  id: z.uuid(),
  username: z.string(),
  displayName: z.string(),
});

export const sessionResponseSchema = z.object({
  owner: ownerSchema,
  csrfToken: z.string().min(32),
  expiresAt: z.iso.datetime(),
});

export const baikalConnectRequestSchema = z.object({
  username: z.string().trim().min(1).max(128),
  password: z.string().min(1).max(1024),
});

export const calendarCollectionSchema = z.object({
  id: entityIdSchema,
  providerId: entityIdSchema,
  href: z.string().min(1),
  displayName: z.string().min(1),
  supportsEvents: z.boolean(),
  supportsTodos: z.boolean(),
});

export const baikalStatusResponseSchema = z.object({
  connected: z.boolean(),
  providerId: entityIdSchema.nullable(),
  endpoint: z.url(),
  username: z.string().nullable(),
  verifiedAt: z.iso.datetime().nullable(),
  calendars: z.array(calendarCollectionSchema),
});

export const calendarProviderKindSchema = z.enum([
  "baikal",
  "caldav",
  "google",
]);

export const clientIdentitySchema = z.object({
  id: entityIdSchema,
  ownerId: entityIdSchema,
  label: z.string().trim().min(1).max(100),
});

export const calendarProviderSchema = z.object({
  id: entityIdSchema,
  ownerId: entityIdSchema,
  kind: calendarProviderKindSchema,
});

export const calendarEventIdentitySchema = z.object({
  providerId: entityIdSchema,
  calendarId: entityIdSchema,
  eventId: z.string().trim().min(1).max(1024),
});

export const taskStatusSchema = z.enum(["open", "completed"]);

export const taskSchema = z.object({
  id: entityIdSchema,
  title: z.string().trim().min(1).max(240),
  notes: z.string().max(20_000),
  status: taskStatusSchema,
  revision: revisionSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  completedAt: z.iso.datetime().nullable().optional(),
  deletedAt: z.iso.datetime().nullable().optional(),
  plannedStart: z.iso.datetime().nullable().optional(),
  estimateMinutes: z.number().int().min(1).max(720).nullable().optional(),
});

export const createTaskRequestSchema = z.object({
  title: z.string().trim().min(1).max(240),
  notes: z.string().max(20_000).default(""),
});

export const taskMutationResponseSchema = z.object({
  task: taskSchema,
  replayed: z.boolean(),
});

export const taskListResponseSchema = z.object({
  tasks: z.array(taskSchema),
});

export const taskPatchRequestSchema = z
  .object({
    title: z.string().trim().min(1).max(240).optional(),
    notes: z.string().max(20_000).optional(),
    plannedStart: z.iso.datetime().nullable().optional(),
    estimateMinutes: z.number().int().min(1).max(720).nullable().optional(),
  })
  .refine((input) => Object.keys(input).length > 0, {
    message: "At least one mutable task field is required",
  });

export const conditionalRequestHeadersSchema = z.object({
  ifMatch: quotedRevisionEtagSchema,
});

export const conditionalTaskMutationResponseSchema = z.object({
  task: taskSchema,
});

export const taskRestoreRequestSchema = z.object({}).strict();

export const taskRecoveryListResponseSchema = z.object({
  tasks: z.array(taskSchema),
});

export const plannerWindowSchema = z
  .object({
    from: z.iso.datetime(),
    to: z.iso.datetime(),
  })
  .refine(
    ({ from, to }) => {
      const fromTime = Date.parse(from);
      const toTime = Date.parse(to);
      return (
        Number.isFinite(fromTime) &&
        Number.isFinite(toTime) &&
        toTime > fromTime &&
        toTime - fromTime <= 31 * 24 * 60 * 60 * 1000
      );
    },
    { message: "Planner window must be positive and no longer than 31 days" },
  );

export const calendarEventProjectionSchema = z
  .object({
    identity: calendarEventIdentitySchema,
    href: z.string().trim().min(1).max(1024),
    uid: z.string().trim().min(1).max(1024),
    etag: strongDavEtagSchema,
    summary: z.string().max(1024),
    startsAt: z.iso.datetime(),
    endsAt: z.iso.datetime(),
    allDay: z.literal(false),
    recurrence: z.literal("none"),
    projectedAt: z.iso.datetime(),
  })
  .refine(({ startsAt, endsAt }) => Date.parse(endsAt) > Date.parse(startsAt), {
    message: "Event end must be after event start",
  });

export const calendarProjectionFreshnessSchema = z.object({
  state: z.enum(["fresh", "stale", "unavailable"]),
  projectedAt: z.iso.datetime().nullable(),
  message: z.string().trim().min(1).max(240),
});

export const plannerResponseSchema = z.object({
  window: plannerWindowSchema,
  tasks: z.array(taskSchema),
  events: z.array(calendarEventProjectionSchema),
  freshness: calendarProjectionFreshnessSchema,
});

export const createTaskTimeBlockRequestSchema = z.object({
  calendarId: entityIdSchema,
  startsAt: z.iso.datetime(),
  durationMinutes: z.number().int().min(1).max(720),
});

export const taskEventMappingSchema = z.object({
  id: entityIdSchema,
  taskId: entityIdSchema,
  event: calendarEventIdentitySchema,
  href: z.string().trim().min(1).max(1024),
  uid: z.string().trim().min(1).max(1024),
  etag: strongDavEtagSchema,
  state: z.enum(["active", "needs_reconciliation", "released"]),
  createdBySuite: z.literal(true),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const taskTimeBlockMutationResponseSchema = z.object({
  task: taskSchema,
  mapping: taskEventMappingSchema,
  replayed: z.boolean(),
});

export const calendarEventConflictSchema = apiErrorSchema.extend({
  code: z.literal("CALENDAR_EVENT_CONFLICT"),
  action: z.literal("refresh_and_replan"),
  mappingId: entityIdSchema.nullable(),
});

export const importTaskCandidateSchema = z.object({
  externalId: z.string().trim().min(1).max(1024),
  title: z.string().trim().min(1).max(240),
  notes: z.string().max(20_000).default(""),
  completed: z.boolean(),
  provenance: z.object({
    source: z.string().trim().min(1).max(100),
    sourceRevision: z.string().trim().min(1).max(1024),
  }),
});

export type ApiError = z.infer<typeof apiErrorSchema>;
export type SetupStatusResponse = z.infer<typeof setupStatusResponseSchema>;
export type OwnerSetupRequest = z.infer<typeof ownerSetupRequestSchema>;
export type LoginRequest = z.infer<typeof loginRequestSchema>;
export type Owner = z.infer<typeof ownerSchema>;
export type SessionResponse = z.infer<typeof sessionResponseSchema>;
export type BaikalConnectRequest = z.infer<typeof baikalConnectRequestSchema>;
export type CalendarCollection = z.infer<typeof calendarCollectionSchema>;
export type BaikalStatusResponse = z.infer<typeof baikalStatusResponseSchema>;
export type CalendarEventIdentity = z.infer<typeof calendarEventIdentitySchema>;
export type Task = z.infer<typeof taskSchema>;
export type CreateTaskRequest = z.infer<typeof createTaskRequestSchema>;
export type TaskMutationResponse = z.infer<typeof taskMutationResponseSchema>;
export type TaskListResponse = z.infer<typeof taskListResponseSchema>;
export type TaskPatchRequest = z.infer<typeof taskPatchRequestSchema>;
export type ConditionalRequestHeaders = z.infer<
  typeof conditionalRequestHeadersSchema
>;
export type ConditionalTaskMutationResponse = z.infer<
  typeof conditionalTaskMutationResponseSchema
>;
export type TaskRestoreRequest = z.infer<typeof taskRestoreRequestSchema>;
export type PlannerWindow = z.infer<typeof plannerWindowSchema>;
export type CalendarEventProjection = z.infer<
  typeof calendarEventProjectionSchema
>;
export type CalendarProjectionFreshness = z.infer<
  typeof calendarProjectionFreshnessSchema
>;
export type PlannerResponse = z.infer<typeof plannerResponseSchema>;
export type CreateTaskTimeBlockRequest = z.infer<
  typeof createTaskTimeBlockRequestSchema
>;
export type TaskEventMapping = z.infer<typeof taskEventMappingSchema>;
export type TaskTimeBlockMutationResponse = z.infer<
  typeof taskTimeBlockMutationResponseSchema
>;
export type CalendarEventConflict = z.infer<typeof calendarEventConflictSchema>;
