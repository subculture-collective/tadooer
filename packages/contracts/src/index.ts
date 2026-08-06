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
  createdAt: z.iso.datetime().optional(),
  lastSeenAt: z.iso.datetime().optional(),
  revokedAt: z.iso.datetime().nullable().optional(),
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
  projectId: entityIdSchema.nullable().optional(),
  tagIds: z
    .array(entityIdSchema)
    .max(25)
    .refine((tagIds) => new Set(tagIds).size === tagIds.length, {
      message: "Task tags must be unique",
    })
    .optional(),
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

export const projectSchema = z.object({
  id: entityIdSchema,
  ownerId: entityIdSchema,
  title: z.string().trim().min(1).max(240),
  revision: revisionSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  archivedAt: z.iso.datetime().nullable(),
});

export const tagSchema = z.object({
  id: entityIdSchema,
  ownerId: entityIdSchema,
  displayName: z.string().trim().min(1).max(100),
  normalizedName: z.string().trim().min(1).max(100),
  revision: revisionSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  archivedAt: z.iso.datetime().nullable(),
});

export const subtaskSchema = z.object({
  id: entityIdSchema,
  taskId: entityIdSchema,
  title: z.string().trim().min(1).max(240),
  completed: z.boolean(),
  revision: revisionSchema,
  position: z.number().int().nonnegative(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const clientRegistrationRequestSchema = z
  .object({
    label: z.string().trim().min(1).max(100),
  })
  .strict();

export const clientCredentialSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

export const clientRegistrationResponseSchema = z.object({
  client: clientIdentitySchema,
  clientCredential: clientCredentialSchema,
  initialCursor: z.string().min(1).max(512),
});

export const clientAuthenticationHeadersSchema = z
  .object({
    clientId: entityIdSchema,
    clientCredential: clientCredentialSchema,
  })
  .strict();

export const syncCursorSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z0-9._~-]+$/);

export const coreTaskFieldSchema = z.enum([
  "title",
  "notes",
  "status",
  "estimateMinutes",
  "projectId",
  "tagIds",
]);

export const taskFieldVersionsSchema = z.object({
  title: revisionSchema,
  notes: revisionSchema,
  status: revisionSchema,
  estimateMinutes: revisionSchema,
  projectId: revisionSchema,
  tagIds: revisionSchema,
});

export const syncTaskSnapshotSchema = z.object({
  task: taskSchema,
  fieldVersions: taskFieldVersionsSchema,
  changeSequence: revisionSchema,
});

const syncPatchFieldsSchema = z
  .object({
    title: z.string().trim().min(1).max(240).optional(),
    notes: z.string().max(20_000).optional(),
    estimateMinutes: z.number().int().min(1).max(720).nullable().optional(),
  })
  .strict()
  .refine((fields) => Object.keys(fields).length > 0, {
    message: "At least one syncable task field is required",
  });

const syncPatchBaseVersionsSchema = z
  .object({
    title: revisionSchema.optional(),
    notes: revisionSchema.optional(),
    estimateMinutes: revisionSchema.optional(),
  })
  .strict();

const syncOperationBaseSchema = z.object({
  operationId: entityIdSchema,
  clientSequence: revisionSchema,
  createdAt: z.iso.datetime(),
  requestHash: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});

export const syncOperationSchema = z.discriminatedUnion("kind", [
  syncOperationBaseSchema.extend({
    kind: z.literal("task.create"),
    task: z
      .object({
        id: entityIdSchema,
        title: z.string().trim().min(1).max(240),
        notes: z.string().max(20_000),
        estimateMinutes: z.number().int().min(1).max(720).nullable(),
      })
      .strict(),
  }),
  syncOperationBaseSchema
    .extend({
      kind: z.literal("task.patch"),
      taskId: entityIdSchema,
      fields: syncPatchFieldsSchema,
      baseFieldVersions: syncPatchBaseVersionsSchema,
    })
    .refine(
      ({ fields, baseFieldVersions }) => {
        const fieldNames = Object.keys(fields).sort();
        const versionNames = Object.keys(baseFieldVersions).sort();
        return (
          fieldNames.length === versionNames.length &&
          fieldNames.every((name, index) => name === versionNames[index])
        );
      },
      { message: "Patch base versions must exactly match changed fields" },
    ),
  syncOperationBaseSchema.extend({
    kind: z.enum(["task.complete", "task.reopen"]),
    taskId: entityIdSchema,
    baseStatusVersion: revisionSchema,
  }),
  syncOperationBaseSchema.extend({
    kind: z.enum(["task.delete", "task.restore"]),
    taskId: entityIdSchema,
    baseRevision: revisionSchema,
  }),
]);

export const syncOperationOutcomeSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.enum(["applied", "replayed"]),
    operationId: entityIdSchema,
    entityId: entityIdSchema,
    entityRevision: revisionSchema,
    changeSequence: revisionSchema,
  }),
  z.object({
    kind: z.literal("conflict"),
    operationId: entityIdSchema,
    code: z.enum(["SYNC_FIELD_CONFLICT", "SYNC_RESOURCE_CONFLICT"]),
    taskId: entityIdSchema,
    taskRevision: revisionSchema,
    conflictingFields: z.array(coreTaskFieldSchema).min(1).max(6).optional(),
  }),
  z.object({
    kind: z.literal("rejected"),
    operationId: entityIdSchema,
    code: z.enum([
      "IDEMPOTENCY_CONFLICT",
      "INVALID_SYNC_OPERATION",
      "TASK_ID_CONFLICT",
      "CLIENT_REVOKED",
    ]),
  }),
]);

export const activeSessionPhaseSchema = z.enum(["focus", "break"]);
export const activeSessionStateSchema = z.enum([
  "running",
  "paused",
  "completed",
  "expired",
]);

export const trackedIntervalSchema = z
  .object({
    id: entityIdSchema,
    sessionId: entityIdSchema,
    taskId: entityIdSchema,
    phase: activeSessionPhaseSchema,
    ordinal: revisionSchema,
    startedAt: z.iso.datetime(),
    endedAt: z.iso.datetime().nullable(),
  })
  .refine(
    ({ startedAt, endedAt }) =>
      endedAt === null || Date.parse(endedAt) >= Date.parse(startedAt),
    { message: "Interval end must not be before its start" },
  );

export const activeSessionSchema = z
  .object({
    id: entityIdSchema,
    ownerId: entityIdSchema,
    taskId: entityIdSchema,
    controllerClientId: entityIdSchema.nullable(),
    state: activeSessionStateSchema,
    phase: activeSessionPhaseSchema,
    revision: revisionSchema,
    startedAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    leaseExpiresAt: z.iso.datetime().nullable(),
    hardExpiresAt: z.iso.datetime().nullable(),
    currentIntervalId: entityIdSchema.nullable(),
  })
  .refine(
    ({
      state,
      controllerClientId,
      leaseExpiresAt,
      hardExpiresAt,
      currentIntervalId,
    }) =>
      state !== "running" ||
      (controllerClientId !== null &&
        leaseExpiresAt !== null &&
        hardExpiresAt !== null &&
        currentIntervalId !== null),
    { message: "Running sessions require a lease and open interval" },
  );

const sessionCommandBaseSchema = z.object({
  idempotencyKey: idempotencyKeySchema,
});

export const activeSessionCommandSchema = z.discriminatedUnion("command", [
  sessionCommandBaseSchema.extend({
    command: z.literal("start"),
    taskId: entityIdSchema,
  }),
  sessionCommandBaseSchema.extend({
    command: z.enum([
      "pause",
      "resume",
      "start_break",
      "end_break",
      "complete",
      "takeover",
      "heartbeat",
    ]),
    sessionId: entityIdSchema,
    expectedRevision: revisionSchema,
  }),
]);

export const activeSessionCommandResponseSchema = z.object({
  session: activeSessionSchema,
  openedInterval: trackedIntervalSchema.nullable(),
  closedInterval: trackedIntervalSchema.nullable(),
  replayed: z.boolean(),
  changeSequence: revisionSchema,
});

export const syncEntitySnapshotSchema = z.discriminatedUnion("entityKind", [
  z.object({ entityKind: z.literal("task"), value: syncTaskSnapshotSchema }),
  z.object({ entityKind: z.literal("project"), value: projectSchema }),
  z.object({ entityKind: z.literal("tag"), value: tagSchema }),
  z.object({ entityKind: z.literal("subtask"), value: subtaskSchema }),
  z.object({
    entityKind: z.literal("active_session"),
    value: activeSessionSchema,
  }),
]);

export const syncChangeSchema = z.object({
  sequence: revisionSchema,
  entityKind: z.enum(["task", "project", "tag", "subtask", "active_session"]),
  entityId: entityIdSchema,
  kind: z.enum(["upsert", "deleted", "session_changed"]),
  entityRevision: revisionSchema,
  changedAt: z.iso.datetime(),
  snapshot: syncEntitySnapshotSchema.nullable(),
});

export const syncRoundRequestSchema = z
  .object({
    cursor: syncCursorSchema.nullable(),
    operations: z.array(syncOperationSchema).max(100),
    pullLimit: z.number().int().min(1).max(200),
  })
  .strict()
  .refine(
    ({ operations }) =>
      new Set(operations.map((operation) => operation.operationId)).size ===
      operations.length,
    { message: "Sync operation IDs must be unique in a round" },
  );

export const syncRoundResponseSchema = z.object({
  outcomes: z.array(syncOperationOutcomeSchema).max(100),
  changes: z.array(syncChangeSchema).max(200),
  nextCursor: syncCursorSchema,
  hasMore: z.boolean(),
  serverTimestamp: z.iso.datetime(),
});

export const syncCursorExpiredSchema = apiErrorSchema.extend({
  code: z.literal("SYNC_CURSOR_EXPIRED"),
  action: z.literal("replace_cache_from_snapshot"),
});

export const syncSnapshotResponseSchema = z.object({
  snapshots: z.array(syncEntitySnapshotSchema).max(200),
  nextCursor: syncCursorSchema,
  hasMore: z.boolean(),
  serverTimestamp: z.iso.datetime(),
});

export const syncDiagnosticOperationSchema = z
  .object({
    operationId: entityIdSchema,
    entityId: entityIdSchema.nullable(),
    kind: z.enum([
      "task.create",
      "task.patch",
      "task.complete",
      "task.reopen",
      "task.delete",
      "task.restore",
    ]),
    state: z.enum([
      "queued",
      "sending",
      "acknowledged",
      "conflicted",
      "rejected",
    ]),
    requestHash: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    baseRevision: revisionSchema.nullable(),
    safeErrorCode: apiErrorCodeSchema.nullable(),
  })
  .strict();

export const syncDiagnosticManifestSchema = z
  .object({
    schemaVersion: z.literal("suite-sync-diagnostics-v1"),
    exportedAt: z.iso.datetime(),
    installationId: entityIdSchema,
    clientId: entityIdSchema,
    cursor: syncCursorSchema.nullable(),
    pendingOperationCount: z.number().int().nonnegative(),
    conflictCount: z.number().int().nonnegative(),
    operations: z.array(syncDiagnosticOperationSchema).max(500),
  })
  .strict();

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
export type Project = z.infer<typeof projectSchema>;
export type Tag = z.infer<typeof tagSchema>;
export type Subtask = z.infer<typeof subtaskSchema>;
export type ClientRegistrationRequest = z.infer<
  typeof clientRegistrationRequestSchema
>;
export type ClientRegistrationResponse = z.infer<
  typeof clientRegistrationResponseSchema
>;
export type ClientAuthenticationHeaders = z.infer<
  typeof clientAuthenticationHeadersSchema
>;
export type SyncCursor = z.infer<typeof syncCursorSchema>;
export type CoreTaskField = z.infer<typeof coreTaskFieldSchema>;
export type TaskFieldVersions = z.infer<typeof taskFieldVersionsSchema>;
export type SyncTaskSnapshot = z.infer<typeof syncTaskSnapshotSchema>;
export type SyncOperation = z.infer<typeof syncOperationSchema>;
export type SyncOperationOutcome = z.infer<typeof syncOperationOutcomeSchema>;
export type TrackedInterval = z.infer<typeof trackedIntervalSchema>;
export type ActiveSession = z.infer<typeof activeSessionSchema>;
export type ActiveSessionCommand = z.infer<typeof activeSessionCommandSchema>;
export type ActiveSessionCommandResponse = z.infer<
  typeof activeSessionCommandResponseSchema
>;
export type SyncEntitySnapshot = z.infer<typeof syncEntitySnapshotSchema>;
export type SyncChange = z.infer<typeof syncChangeSchema>;
export type SyncRoundRequest = z.infer<typeof syncRoundRequestSchema>;
export type SyncRoundResponse = z.infer<typeof syncRoundResponseSchema>;
export type SyncCursorExpired = z.infer<typeof syncCursorExpiredSchema>;
export type SyncSnapshotResponse = z.infer<typeof syncSnapshotResponseSchema>;
export type SyncDiagnosticManifest = z.infer<
  typeof syncDiagnosticManifestSchema
>;
