export { superProductivityImportLimits } from "./import-limits.ts";
export * from "./organization.ts";
export * from "./task-planning.ts";
export * from "./task-links.ts";
export * from "./task-archive.ts";
export * from "./recurrence.ts";
export * from "./time-history.ts";
import { z } from "zod";
import {
  automationNoteMutationInputSchema,
  automationOrganizationOrderInputSchema,
  automationProjectBacklogInputSchema,
  automationProjectMutationInputSchema as projectMutationInput,
  automationTagMutationInputSchema as tagMutationInput,
  noteListResponseSchema,
  noteMutationResponseSchema,
  organizationColorSchema,
  organizationIconSchema,
  projectPatchFields,
  tagPatchFields,
} from "./organization.ts";
import {
  automationTaskLinkMutationInputSchema,
  taskLinksResourceInputSchema,
  taskLinksResponseSchema,
} from "./task-links.ts";
import {
  plannedDayAndStartExclusive,
  plannedDayAndStartMessage,
  taskPlanningFieldsSchema,
} from "./task-planning.ts";
import {
  historicalReferenceSchema,
  taskArchiveReviewReasonSchema,
  taskHistoryProvenanceSchema,
  taskHistoryQuerySchema,
} from "./task-archive.ts";
import {
  automationRecurrenceCreateInputSchema,
  automationRecurrenceOccurrenceInputSchema,
  automationRecurrenceStateInputSchema,
  automationRecurrenceUpdateInputSchema,
  recurringSeriesListResponseSchema,
  recurringSeriesMutationResponseSchema,
  taskRecurrenceSchema,
} from "./recurrence.ts";
import {
  automationTimeEntryMutationInputSchema,
  timeEntryMutationResponseSchema,
  timeReportQuerySchema,
  timeReportResponseSchema,
} from "./time-history.ts";

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

export const ianaTimeZoneSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .refine(
    (value) => {
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: value }).format(
          new Date(0),
        );
        return true;
      } catch {
        return false;
      }
    },
    { message: "Time zone must be a supported IANA identifier" },
  );

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

export const habitCadenceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("daily") }),
  z.object({
    kind: z.literal("weekly"),
    weekdays: z
      .array(z.number().int().min(0).max(6))
      .min(1)
      .max(7)
      .refine((weekdays) => new Set(weekdays).size === weekdays.length, {
        message: "Weekly habit weekdays must be unique",
      }),
  }),
  z.object({
    kind: z.literal("custom"),
    intervalDays: z.number().int().min(1).max(365),
  }),
]);

export const habitSchema = z.object({
  id: entityIdSchema,
  ownerId: entityIdSchema,
  title: z.string().trim().min(1).max(240),
  cadence: habitCadenceSchema,
  startedOn: z.iso.date(),
  timeZone: ianaTimeZoneSchema,
  revision: revisionSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  archivedAt: z.iso.datetime().nullable(),
});

export const habitOccurrenceSchema = z.object({
  id: entityIdSchema,
  habitId: entityIdSchema,
  periodKey: z.iso.date(),
  completedAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
});

export const createHabitRequestSchema = z.object({
  title: z.string().trim().min(1).max(240),
  cadence: habitCadenceSchema,
  startedOn: z.iso.date(),
  timeZone: ianaTimeZoneSchema,
});

// Schedule identity is immutable once created; edits do not reinterpret past occurrences.
export const patchHabitRequestSchema = z
  .object({
    title: z.string().trim().min(1).max(240).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "A habit edit is required",
  });

export const habitCommandSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("habit.create"),
      habit: createHabitRequestSchema.extend({ id: entityIdSchema }).strict(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("habit.patch"),
      habitId: entityIdSchema,
      baseRevision: revisionSchema,
      fields: patchHabitRequestSchema,
    })
    .strict(),
  z
    .object({
      kind: z.enum(["habit.archive", "habit.restore"]),
      habitId: entityIdSchema,
      baseRevision: revisionSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("habit.complete"),
      habitId: entityIdSchema,
      baseRevision: revisionSchema,
      periodKey: z.iso.date(),
    })
    .strict(),
]);

export const completeHabitRequestSchema = z.object({
  periodKey: z.iso.date(),
});

export const habitListResponseSchema = z.object({
  habits: z.array(habitSchema),
  occurrences: z.array(habitOccurrenceSchema),
});

export const taskDeadlineSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("date"), value: z.iso.date() }),
  z.object({ kind: z.literal("instant"), value: z.iso.datetime() }),
]);

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
  ...taskPlanningFieldsSchema.shape,
  deadline: taskDeadlineSchema.nullable().optional(),
  estimateMinutes: z.number().int().min(1).max(720).nullable().optional(),
  projectId: entityIdSchema.nullable().optional(),
  tagIds: z
    .array(entityIdSchema)
    .max(25)
    .refine((tagIds) => new Set(tagIds).size === tagIds.length, {
      message: "Task tags must be unique",
    })
    .optional(),
  /** ADR 0018: top-level parent; absent or null for a top-level task. */
  parentId: entityIdSchema.nullable().optional(),
  /** Sparse order key among the parent's children; null for top-level tasks. */
  childPosition: z.number().int().nullable().optional(),
  /** ADR 0022: set only on archived history; active tasks omit it. */
  archivedAt: z.iso.datetime().nullable().optional(),
  /** ADR 0023: the series and occurrence date of a recurring instance. */
  recurrence: taskRecurrenceSchema.nullable().optional(),
});

export const createTaskRequestSchema = z.object({
  structured: z.boolean().optional(),
  estimateMinutes: z.number().int().min(1).max(720).nullable().optional(),
  title: z.string().trim().min(1).max(240),
  notes: z.string().max(20_000).default(""),
  plannedStart: z.iso.datetime().nullable().optional(),
  ...taskPlanningFieldsSchema.shape,
  deadline: taskDeadlineSchema.nullable().optional(),
  projectId: entityIdSchema.nullable().optional(),
  tagIds: z.array(entityIdSchema).max(25).optional(),
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
    ...taskPlanningFieldsSchema.shape,
    deadline: taskDeadlineSchema.nullable().optional(),
    estimateMinutes: z.number().int().min(1).max(720).nullable().optional(),
  })
  .refine((input) => Object.keys(input).length > 0, {
    message: "At least one mutable task field is required",
  })
  .refine(plannedDayAndStartExclusive, {
    message: plannedDayAndStartMessage,
  });

// ADR 0018 task hierarchy: two levels, full child tasks, revisioned moves.
export const taskHierarchyIndexSchema = z.number().int().min(0).max(10_000);
export const taskMoveRequestSchema = z
  .object({
    parentId: entityIdSchema.nullable(),
    index: taskHierarchyIndexSchema.nullable().optional(),
  })
  .strict();
export const taskChildCreateRequestSchema = createTaskRequestSchema.extend({
  index: taskHierarchyIndexSchema.nullable().optional(),
});
const taskChildOrderItemsSchema = z
  .array(z.object({ id: entityIdSchema, revision: revisionSchema }).strict())
  .max(500)
  .refine((items) => new Set(items.map(({ id }) => id)).size === items.length, {
    message: "Child task ids must be unique",
  });
export const taskChildOrderRequestSchema = z
  .object({ items: taskChildOrderItemsSchema })
  .strict();
export const taskChildrenResponseSchema = z
  .object({ parent: taskSchema, children: z.array(taskSchema) })
  .strict();

// ADR 0022 archived history. A history entry is a top-level archived task with
// the children archived with it; each carries read-only import provenance.
export const archivedTaskSchema = z
  .object({
    task: taskSchema,
    provenance: taskHistoryProvenanceSchema.nullable(),
  })
  .strict();
export const taskHistoryEntrySchema = archivedTaskSchema
  .extend({ children: z.array(archivedTaskSchema) })
  .strict();
export const taskHistoryResponseSchema = z
  .object({
    entries: z.array(taskHistoryEntrySchema),
    total: z.number().int().nonnegative(),
    nextCursor: z.string().nullable(),
  })
  .strict();
export const taskArchiveMutationResponseSchema = z
  .object({
    archive: z
      .object({
        action: z.enum(["archived", "restored"]),
        task: taskSchema,
        children: z.array(taskSchema),
      })
      .strict(),
  })
  .strict();

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
    allDay: z.boolean(),
    linkedTaskId: entityIdSchema.optional(),
    recurrence: z.enum(["none", "instance"]),
    projectedAt: z.iso.datetime(),
    source: z.object({
      providerKind: calendarProviderKindSchema,
      providerDisplayLabel: z.string().trim().min(1).max(100),
      calendarName: z.string().trim().min(1).max(240),
    }),
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

export const googleConnectorStateSchema = z.enum([
  "disconnected",
  "connected",
  "reconnect_required",
  "stale",
]);
export const googleCalendarFreshnessSchema = z.object({
  calendarId: entityIdSchema,
  state: z.enum(["fresh", "stale", "unavailable"]),
  lastSuccessfulSyncAt: z.iso.datetime().nullable(),
  message: z.string().min(1).max(240),
});
export const googleConnectorStatusResponseSchema = z.object({
  configured: z.boolean(),
  connected: z.boolean(),
  state: googleConnectorStateSchema,
  providerId: entityIdSchema.nullable(),
  accountLabel: z.string().nullable(),
  grantedScopes: z.array(z.string()),
  calendars: z.array(calendarCollectionSchema),
  freshness: z.array(googleCalendarFreshnessSchema),
});
export const googleAuthorizationResponseSchema = z.object({
  authorizationUrl: z.url(),
  expiresAt: z.iso.datetime(),
});
export const googleSyncRequestSchema = z
  .object({
    full: z.boolean().default(false),
  })
  .strict();
export const googleSyncResponseSchema = z.object({
  status: googleConnectorStatusResponseSchema,
  resetCalendars: z.array(entityIdSchema),
});

export const planningPreferencesSchema = z
  .object({
    workingDays: z.array(z.number().int().min(0).max(6)).min(1).max(7),
    workdayStart: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    workdayEnd: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    breakStart: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
      .nullable(),
    breakEnd: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
      .nullable(),
    timeZone: ianaTimeZoneSchema,
  })
  .refine(({ workdayStart, workdayEnd }) => workdayStart < workdayEnd, {
    message: "Workday end must follow start",
  })
  .refine(
    ({ breakStart, breakEnd, workdayStart, workdayEnd }) =>
      breakStart === null
        ? breakEnd === null
        : breakEnd !== null &&
          breakStart < breakEnd &&
          breakStart >= workdayStart &&
          breakEnd <= workdayEnd,
    { message: "Break boundaries must be a valid pair" },
  );
export const dayPlanResponseSchema = z.object({
  at: z.iso.datetime(),
  state: z.enum([
    "working",
    "scheduled_break",
    "unavailable",
    "finished_for_today",
  ]),
  preferences: planningPreferencesSchema,
  orderedTasks: z.array(taskSchema),
  nextTask: taskSchema.nullable(),
  reminder: z.object({
    suppressed: z.boolean(),
    reason: z.enum([
      "ready",
      "stale_calendar",
      "outside_working_hours",
      "scheduled_break",
      "calendar_busy",
      "no_scheduled_task",
    ]),
  }),
  freshness: calendarProjectionFreshnessSchema,
});

export const notificationPreferencesSchema = z
  .object({
    enabled: z.boolean(),
    leadReminderEnabled: z.boolean(),
    atStartReminderEnabled: z.boolean(),
    detailedContentEnabled: z.boolean(),
  })
  .strict();

export const notificationDeliveryStateSchema = z.enum([
  "pending",
  "delivered",
  "suppressed",
  "cancelled",
  "failed",
]);

export const notificationStatusResponseSchema = z
  .object({
    configured: z.boolean(),
    enabled: z.boolean(),
    state: z.enum(["ready", "degraded", "unavailable"]),
    pendingCount: z.number().int().nonnegative(),
    failedCount: z.number().int().nonnegative(),
    lastDelivery: z
      .object({
        state: notificationDeliveryStateSchema,
        kind: z.enum(["lead", "at_start", "deadline", "test"]),
        occurredAt: z.iso.datetime(),
        errorCode: apiErrorCodeSchema.nullable(),
      })
      .strict()
      .nullable(),
  })
  .strict();

export const notificationDeliveryInputSchema = z
  .object({ deliveryId: entityIdSchema })
  .strict();
export const notificationDeliveryResponseSchema = z
  .object({
    delivery: z
      .object({
        id: entityIdSchema,
        state: notificationDeliveryStateSchema,
        kind: z.enum(["lead", "at_start", "deadline", "test"]),
        attemptCount: z.number().int().nonnegative(),
        updatedAt: z.iso.datetime(),
        deliveredAt: z.iso.datetime().nullable(),
        errorCode: apiErrorCodeSchema.nullable(),
      })
      .strict(),
  })
  .strict();

export const notificationTestResponseSchema = z
  .object({
    accepted: z.boolean(),
    state: z.enum(["delivered", "failed", "unavailable"]),
    errorCode: apiErrorCodeSchema.nullable(),
  })
  .strict();

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

export const projectCreateRequestSchema = z
  .object({ title: z.string().trim().min(1).max(240) })
  .strict();
export const tagCreateRequestSchema = z
  .object({ title: z.string().trim().min(1).max(100) })
  .strict();
const organizationFields = { archived: z.boolean().optional() };
export const projectPatchRequestSchema = projectCreateRequestSchema
  .partial()
  .extend(organizationFields)
  .extend(projectPatchFields)
  .strict()
  .refine((input) => Object.keys(input).length > 0, {
    message: "An organization edit is required",
  });
export const tagPatchRequestSchema = tagCreateRequestSchema
  .partial()
  .extend(organizationFields)
  .extend(tagPatchFields)
  .strict()
  .refine((input) => Object.keys(input).length > 0, {
    message: "An organization edit is required",
  });

export const projectSchema = z.object({
  id: entityIdSchema,
  ownerId: entityIdSchema,
  title: z.string().trim().min(1).max(240),
  revision: revisionSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  archivedAt: z.iso.datetime().nullable(),
  // Defaults keep snapshots cached before migration 0022 readable.
  color: organizationColorSchema.nullable().default(null),
  icon: organizationIconSchema.nullable().default(null),
  position: z.number().int().nonnegative().default(0),
  hiddenFromMenu: z.boolean().default(false),
  /** Completion also archives; reopen or restore clears both (SP 19.1.0). */
  completedAt: z.iso.datetime().nullable().default(null),
  backlogEnabled: z.boolean().default(false),
  /** Ordered active tasks of this project that sit in its backlog. */
  backlogTaskIds: z.array(entityIdSchema).default([]),
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
  color: organizationColorSchema.nullable().default(null),
  icon: organizationIconSchema.nullable().default(null),
  position: z.number().int().nonnegative().default(0),
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

export const subtaskCreateRequestSchema = subtaskSchema
  .pick({ title: true, position: true })
  .strict();
export const subtaskPatchRequestSchema = subtaskSchema
  .pick({ title: true, completed: true, position: true })
  .partial()
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, {
    message: "A checklist edit is required",
  });
export const subtaskOrderRequestSchema = z
  .object({
    items: z
      .array(
        z.object({ id: entityIdSchema, revision: revisionSchema }).strict(),
      )
      .min(1)
      .max(200)
      .refine(
        (items) => new Set(items.map((item) => item.id)).size === items.length,
        { message: "Checklist ids must be unique" },
      ),
  })
  .strict();
export const checklistCommandSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("create"),
      taskId: entityIdSchema,
      id: entityIdSchema,
      ...subtaskCreateRequestSchema.shape,
    })
    .strict(),
  z
    .object({
      action: z.literal("update"),
      taskId: entityIdSchema,
      id: entityIdSchema,
      expectedRevision: revisionSchema,
      patch: subtaskPatchRequestSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal("delete"),
      taskId: entityIdSchema,
      id: entityIdSchema,
      expectedRevision: revisionSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal("reorder"),
      taskId: entityIdSchema,
      ...subtaskOrderRequestSchema.shape,
    })
    .strict(),
]);
export type ChecklistCommand = z.infer<typeof checklistCommandSchema>;

// Templates are deliberately not tasks. They have their own lifecycle and
// query surface, so they can never leak into active-task calculations.
export const templateSubtaskBlueprintSchema = z.object({
  id: entityIdSchema,
  templateId: entityIdSchema,
  title: z.string().trim().min(1).max(240),
  position: z.number().int().nonnegative(),
  revision: revisionSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const taskTemplateSchema = z.object({
  id: entityIdSchema,
  ownerId: entityIdSchema,
  title: z.string().trim().min(1).max(240),
  notes: z.string().max(20_000),
  estimateMinutes: z.number().int().min(1).max(720).nullable(),
  suggestedProjectId: entityIdSchema.nullable(),
  tagIds: z
    .array(entityIdSchema)
    .max(25)
    .refine((ids) => new Set(ids).size === ids.length),
  revision: revisionSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  archivedAt: z.iso.datetime().nullable(),
});

export const templateSetSchema = z.object({
  id: entityIdSchema,
  ownerId: entityIdSchema,
  title: z.string().trim().min(1).max(240),
  revision: revisionSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  archivedAt: z.iso.datetime().nullable(),
});

export const templateSetMemberSchema = z.object({
  setId: entityIdSchema,
  templateId: entityIdSchema,
  position: z.number().int().nonnegative(),
});
export const createTemplateSetRequestSchema = z
  .object({
    title: z.string().trim().min(1).max(240),
    templateIds: z
      .array(entityIdSchema)
      .min(1)
      .max(100)
      .refine((ids) => new Set(ids).size === ids.length),
  })
  .strict();
export const templateSetPatchRequestSchema = createTemplateSetRequestSchema
  .partial()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one mutable template set field is required",
  });

export const taskTemplateProvenanceSchema = z.object({
  taskId: entityIdSchema,
  templateId: entityIdSchema,
  templateRevision: revisionSchema,
  instantiationId: entityIdSchema,
  instantiatedAt: z.iso.datetime(),
});

export const createTaskTemplateRequestSchema = z
  .object({
    title: z.string().trim().min(1).max(240),
    notes: z.string().max(20_000).default(""),
    estimateMinutes: z.number().int().min(1).max(720).nullable().default(null),
    suggestedProjectId: entityIdSchema.nullable().default(null),
    tagIds: z.array(entityIdSchema).max(25).default([]),
    subtasks: z
      .array(z.object({ title: z.string().trim().min(1).max(240) }).strict())
      .max(100)
      .default([]),
  })
  .strict();
export const createTaskTemplateFromTaskRequestSchema = z
  .object({ taskId: entityIdSchema })
  .strict();
export const taskTemplatePatchRequestSchema = createTaskTemplateRequestSchema
  .partial()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one mutable template field is required",
  });
export const templateSearchRequestSchema = z
  .object({
    query: z.string().trim().max(240).default(""),
    includeArchived: z.boolean().default(false),
  })
  .strict();
export const instantiateTemplateRequestSchema = z
  .object({
    destinationProjectId: entityIdSchema,
    idempotencyKey: idempotencyKeySchema,
  })
  .strict();
export const instantiateTemplateSetRequestSchema =
  instantiateTemplateRequestSchema;
export const instantiatedTaskTreeSchema = z.object({
  task: taskSchema,
  subtasks: z.array(subtaskSchema),
  provenance: taskTemplateProvenanceSchema,
});
export const templateInstantiationResponseSchema = z
  .object({
    instantiationId: entityIdSchema,
    tasks: z.array(instantiatedTaskTreeSchema).min(1),
    replayed: z.boolean(),
  })
  .strict();
export const templatePoolSlotSchema = z.object({
  id: entityIdSchema,
  templateId: entityIdSchema,
  poolId: entityIdSchema,
  pickCount: z.number().int().min(1).max(25),
  position: z.number().int().nonnegative(),
  createdAt: z.iso.datetime(),
});
export const taskTemplateLibraryResponseSchema = z
  .object({
    templates: z.array(taskTemplateSchema),
    blueprints: z.array(templateSubtaskBlueprintSchema),
    provenance: z.array(taskTemplateProvenanceSchema).default([]),
    poolSlots: z.array(templatePoolSlotSchema).default([]),
  })
  .strict();
export const templateSetLibraryResponseSchema = z
  .object({
    sets: z.array(templateSetSchema),
    members: z.array(templateSetMemberSchema),
  })
  .strict();

export const choicePoolPolicySchema = z.enum([
  "none",
  "cooldown",
  "cycle",
  "one_shot",
]);
export const choicePoolSchema = z.object({
  id: entityIdSchema,
  ownerId: entityIdSchema,
  title: z.string().trim().min(1).max(240),
  policy: choicePoolPolicySchema,
  pickCount: z.number().int().min(1).max(25),
  cooldownSeconds: z.number().int().min(1).max(31_536_000).nullable(),
  revision: revisionSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  archivedAt: z.iso.datetime().nullable(),
});
export const choicePoolItemSchema = z.object({
  id: entityIdSchema,
  poolId: entityIdSchema,
  title: z.string().trim().min(1).max(240),
  position: z.number().int().nonnegative(),
  revision: revisionSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  archivedAt: z.iso.datetime().nullable(),
});
export const choicePoolHistoryEventSchema = z.object({
  id: entityIdSchema,
  poolId: entityIdSchema,
  itemId: entityIdSchema,
  placeholderId: entityIdSchema.nullable(),
  kind: z.enum(["selected", "completed"]),
  cycle: revisionSchema,
  overridden: z.boolean(),
  occurredAt: z.iso.datetime(),
});
export const planningPlaceholderSchema = z.object({
  id: entityIdSchema,
  ownerId: entityIdSchema,
  taskId: entityIdSchema,
  poolId: entityIdSchema,
  pickCount: z.number().int().min(1).max(25),
  position: z.number().int().nonnegative(),
  state: z.enum(["unresolved", "resolved"]),
  revision: revisionSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  resolvedAt: z.iso.datetime().nullable(),
});
export const choicePoolEligibilitySchema = z.object({
  itemId: entityIdSchema,
  eligible: z.boolean(),
  reason: z.enum([
    "eligible",
    "archived",
    "cooldown",
    "cycle_selected",
    "one_shot_selected",
  ]),
  eligibleAt: z.iso.datetime().nullable(),
  lastSelectedAt: z.iso.datetime().nullable(),
});
export const choicePoolSuggestionResponseSchema = z.object({
  pool: choicePoolSchema,
  selectedItemIds: z.array(entityIdSchema).max(25),
  cycle: revisionSchema,
  eligibility: z.array(choicePoolEligibilitySchema).max(250),
  logicalTime: z.iso.datetime(),
});
export const createChoicePoolRequestSchema = z
  .object({
    title: z.string().trim().min(1).max(240),
    policy: choicePoolPolicySchema,
    pickCount: z.number().int().min(1).max(25),
    cooldownSeconds: z.number().int().min(1).max(31_536_000).nullable(),
    items: z
      .array(z.object({ title: z.string().trim().min(1).max(240) }).strict())
      .min(1)
      .max(250),
  })
  .strict()
  .superRefine(({ policy, cooldownSeconds }, context) => {
    if (policy === "cooldown" && cooldownSeconds === null)
      context.addIssue({
        code: "custom",
        message: "Cooldown policy requires cooldownSeconds",
      });
    if (policy !== "cooldown" && cooldownSeconds !== null)
      context.addIssue({
        code: "custom",
        message: "Only cooldown policy accepts cooldownSeconds",
      });
  });
export const updateChoicePoolRequestSchema = z
  .object({
    title: z.string().trim().min(1).max(240),
    policy: choicePoolPolicySchema,
    pickCount: z.number().int().min(1).max(25),
    cooldownSeconds: z.number().int().min(1).max(31_536_000).nullable(),
    items: z
      .array(
        z
          .object({
            id: entityIdSchema.optional(),
            title: z.string().trim().min(1).max(240),
          })
          .strict(),
      )
      .min(1)
      .max(250),
  })
  .strict();
export const createTemplatePoolSlotRequestSchema = z
  .object({
    poolId: entityIdSchema,
    pickCount: z.number().int().min(1).max(25),
    position: z.number().int().nonnegative(),
  })
  .strict();
export const completeChoicePoolItemRequestSchema = z
  .object({
    placeholderId: entityIdSchema.nullable().default(null),
    occurredAt: z.iso.datetime(),
  })
  .strict();
export const createPlanningPlaceholderRequestSchema = z
  .object({
    taskId: entityIdSchema,
    poolId: entityIdSchema,
    pickCount: z.number().int().min(1).max(25).optional(),
  })
  .strict();
export const resolvePlanningPlaceholderPreviewInputSchema = z
  .object({
    placeholderId: entityIdSchema,
    selectedItemIds: z.array(entityIdSchema).min(1).max(25),
    logicalTime: z.iso.datetime(),
    override: z.boolean().default(false),
    expectedRevision: revisionSchema,
  })
  .strict()
  .refine(
    ({ selectedItemIds }) =>
      new Set(selectedItemIds).size === selectedItemIds.length,
    {
      message: "Selected pool items must be unique",
    },
  );
export const resolvePlanningPlaceholderRequestSchema = z
  .object({
    placeholderId: entityIdSchema.optional(),
    selectedItemIds: z.array(entityIdSchema).min(1).max(25),
    logicalTime: z.iso.datetime(),
    override: z.boolean().default(false),
    expectedRevision: revisionSchema,
    idempotencyKey: idempotencyKeySchema,
  })
  .strict()
  .refine(
    ({ selectedItemIds }) =>
      new Set(selectedItemIds).size === selectedItemIds.length,
    { message: "Selected pool items must be unique" },
  );
export const planningPlaceholderResolutionSchema = z.object({
  id: entityIdSchema,
  placeholderId: entityIdSchema,
  selectedItemIds: z.array(entityIdSchema).min(1).max(25),
  subtaskIds: z.array(entityIdSchema).min(1).max(25),
  historyIds: z.array(entityIdSchema).min(1).max(25),
  logicalTime: z.iso.datetime(),
  overridden: z.boolean(),
  createdAt: z.iso.datetime(),
});
export const planningPlaceholderResolutionResponseSchema = z.object({
  placeholder: planningPlaceholderSchema,
  resolution: planningPlaceholderResolutionSchema,
  subtasks: z.array(subtaskSchema).min(1).max(25),
  history: z.array(choicePoolHistoryEventSchema).min(1).max(25),
  replayed: z.boolean(),
});
export const choicePoolLibraryResponseSchema = z.object({
  pools: z.array(choicePoolSchema),
  items: z.array(choicePoolItemSchema),
  history: z.array(choicePoolHistoryEventSchema),
  placeholders: z.array(planningPlaceholderSchema),
});

export const clientRegistrationRequestSchema = z
  .object({
    label: z.string().trim().min(1).max(100),
  })
  .strict();

export const clientCredentialSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

export const clientRegistrationResponseSchema = z.object({
  protocolVersion: z.literal(2),
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
  "deadline",
]);

export const taskFieldVersionsSchema = z.object({
  title: revisionSchema,
  notes: revisionSchema,
  status: revisionSchema,
  estimateMinutes: revisionSchema,
  projectId: revisionSchema,
  tagIds: revisionSchema,
  deadline: revisionSchema,
  /** Parent/order version; the base for an offline `task.move`. */
  parent: revisionSchema.optional(),
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
    deadline: taskDeadlineSchema.nullable().optional(),
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
    deadline: revisionSchema.optional(),
  })
  .strict();

const syncOperationBaseSchema = z.object({
  operationId: entityIdSchema,
  clientSequence: revisionSchema,
  createdAt: z.iso.datetime(),
  requestHash: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});

export const habitSyncOperationSchema = z.discriminatedUnion("kind", [
  habitCommandSchema.options[0].extend(syncOperationBaseSchema.shape),
  habitCommandSchema.options[1].extend(syncOperationBaseSchema.shape),
  habitCommandSchema.options[2].extend(syncOperationBaseSchema.shape),
  habitCommandSchema.options[3].extend(syncOperationBaseSchema.shape),
]);

export const syncOperationSchema = z.discriminatedUnion("kind", [
  ...habitSyncOperationSchema.options,
  syncOperationBaseSchema.extend({
    kind: z.literal("task.create"),
    task: z
      .object({
        id: entityIdSchema,
        title: z.string().trim().min(1).max(240),
        notes: z.string().max(20_000),
        estimateMinutes: z.number().int().min(1).max(720).nullable(),
        deadline: taskDeadlineSchema.nullable().optional(),
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
  // ADR 0018: structural move. A stale parent version or an invalid target is
  // a resource conflict and changes nothing, so replay cannot orphan or cycle.
  syncOperationBaseSchema.extend({
    kind: z.literal("task.move"),
    taskId: entityIdSchema,
    parentId: entityIdSchema.nullable(),
    index: taskHierarchyIndexSchema.nullable(),
    baseParentVersion: revisionSchema,
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
    conflictingFields: z.array(coreTaskFieldSchema).min(1).max(7).optional(),
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

export const syncTaskTemplateSnapshotSchema = z
  .object({
    template: taskTemplateSchema,
    blueprints: z.array(templateSubtaskBlueprintSchema).max(100),
    poolSlots: z.array(templatePoolSlotSchema).max(25).default([]),
  })
  .strict();

export const syncTemplateSetSnapshotSchema = z
  .object({
    set: templateSetSchema,
    members: z.array(templateSetMemberSchema).max(100),
  })
  .strict();

export const syncChoicePoolSnapshotSchema = z.object({
  pool: choicePoolSchema,
  items: z.array(choicePoolItemSchema).max(250),
  history: z.array(choicePoolHistoryEventSchema).max(2_000),
});
export const syncPlanningPlaceholderSnapshotSchema = z.object({
  placeholder: planningPlaceholderSchema,
  resolution: planningPlaceholderResolutionSchema.nullable(),
});

export const syncEntitySnapshotSchema = z.discriminatedUnion("entityKind", [
  z.object({ entityKind: z.literal("habit"), value: habitSchema }),
  z.object({
    entityKind: z.literal("habit_occurrence"),
    value: habitOccurrenceSchema,
  }),
  z.object({ entityKind: z.literal("task"), value: syncTaskSnapshotSchema }),
  z.object({ entityKind: z.literal("project"), value: projectSchema }),
  z.object({ entityKind: z.literal("tag"), value: tagSchema }),
  z.object({ entityKind: z.literal("subtask"), value: subtaskSchema }),
  z.object({
    entityKind: z.literal("template"),
    value: syncTaskTemplateSnapshotSchema,
  }),
  z.object({
    entityKind: z.literal("template_set"),
    value: syncTemplateSetSnapshotSchema,
  }),
  z.object({
    entityKind: z.literal("choice_pool"),
    value: syncChoicePoolSnapshotSchema,
  }),
  z.object({
    entityKind: z.literal("planning_placeholder"),
    value: syncPlanningPlaceholderSnapshotSchema,
  }),
  z.object({
    entityKind: z.literal("active_session"),
    value: activeSessionSchema,
  }),
]);

export const syncChangeSchema = z.object({
  sequence: revisionSchema,
  entityKind: z.enum([
    "habit",
    "habit_occurrence",
    "task",
    "project",
    "tag",
    "subtask",
    "template",
    "template_set",
    "choice_pool",
    "planning_placeholder",
    "active_session",
  ]),
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
  protocolVersion: z.literal(2),
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
  protocolVersion: z.literal(2),
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
      "habit.create",
      "habit.patch",
      "habit.archive",
      "habit.restore",
      "habit.complete",
      "task.create",
      "task.patch",
      "task.complete",
      "task.reopen",
      "task.delete",
      "task.restore",
      "task.move",
    ]),
    state: z.enum([
      "queued",
      "sending",
      "acknowledged",
      "resolved",
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

// Phase 4 automation is a separate actor from browser sessions and registered
// sync clients. These contracts deliberately describe the public, safe edge:
// raw token secrets and preview input are never returned in inventories, audit
// records, or diagnostic exports.
export const automationTokenScopeSchema = z.enum([
  "notifications:test",
  "notifications:read",
  "notifications:write",
  "planning:write",
  "tasks:read",
  "tasks:write",
  "schedule:read",
  "schedule:write",
  "projects:read",
  "projects:write",
  "tags:read",
  "tags:write",
  "focus:read",
  "focus:write",
  "templates:read",
  "templates:write",
  "pools:read",
  "pools:write",
  "habits:read",
  "habits:write",
  "notes:read",
  "notes:write",
  "task_links:read",
  "task_links:write",
]);

export const automationTokenSchema = z
  .object({
    id: entityIdSchema,
    ownerId: entityIdSchema,
    label: z.string().trim().min(1).max(100),
    scopes: z
      .array(automationTokenScopeSchema)
      .min(1)
      .max(automationTokenScopeSchema.options.length),
    createdAt: z.iso.datetime(),
    lastUsedAt: z.iso.datetime().nullable(),
    expiresAt: z.iso.datetime(),
    revokedAt: z.iso.datetime().nullable(),
  })
  .strict()
  .refine(({ scopes }) => new Set(scopes).size === scopes.length, {
    message: "Automation token scopes must be unique",
  });

export const createAutomationTokenRequestSchema = z
  .object({
    label: z.string().trim().min(1).max(100),
    scopes: z
      .array(automationTokenScopeSchema)
      .min(1)
      .max(automationTokenScopeSchema.options.length),
    expiresAt: z.iso.datetime(),
  })
  .strict()
  .refine(({ scopes }) => new Set(scopes).size === scopes.length, {
    message: "Automation token scopes must be unique",
  });

export const automationTokenSecretSchema = z
  .string()
  .regex(
    /^suite_at_[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/,
    "Automation token must be an opaque Suite credential",
  );

export const createAutomationTokenResponseSchema = z
  .object({ token: automationTokenSecretSchema, record: automationTokenSchema })
  .strict();

export const automationTokenListResponseSchema = z
  .object({ tokens: z.array(automationTokenSchema) })
  .strict();

export const automationOperationSchema = z.enum([
  "planning.update_preferences",
  "notifications.send_test",
  "notifications.update_preferences",
  "subtasks.mutate",
  "projects.mutate",
  "projects.reorder",
  "projects.set_backlog",
  "tags.mutate",
  "tags.reorder",
  "notes.mutate",
  "task_links.mutate",
  "tasks.assign_project",
  "tasks.set_tags",
  "tasks.hierarchy",
  "tasks.create",
  "tasks.update",
  "tasks.set_completed",
  "tasks.delete",
  "tasks.restore",
  "tasks.archive",
  "tasks.unarchive",
  "recurrence.create",
  "recurrence.update",
  "recurrence.set_state",
  "recurrence.occurrence",
  "time_entries.mutate",
  "schedule.create_time_block",
  "focus.start",
  "focus.pause",
  "focus.resume",
  "focus.start_break",
  "focus.end_break",
  "focus.complete",
  "focus.takeover",
  "templates.instantiate",
  "template_sets.instantiate",
  "placeholders.resolve",
  "habits.mutate",
]);

const automationSessionCommandBaseSchema = z.object({
  sessionId: entityIdSchema,
  expectedRevision: revisionSchema,
});

export const automationFocusCommandInputSchema = z.discriminatedUnion(
  "operation",
  [
    z.object({ operation: z.literal("focus.start"), taskId: entityIdSchema }),
    ...[
      "focus.pause",
      "focus.resume",
      "focus.start_break",
      "focus.end_break",
      "focus.complete",
      "focus.takeover",
    ].map((operation) =>
      automationSessionCommandBaseSchema.extend({
        operation: z.literal(
          operation as Exclude<
            Extract<
              z.infer<typeof automationOperationSchema>,
              `focus.${string}`
            >,
            "focus.start"
          >,
        ),
      }),
    ),
  ],
);

export const automationTaskUpdateInputSchema = z
  .object({
    taskId: entityIdSchema,
    expectedRevision: revisionSchema,
    patch: taskPatchRequestSchema,
  })
  .strict();
export const automationTaskLifecycleInputSchema = z
  .object({
    taskId: entityIdSchema,
    expectedRevision: revisionSchema,
  })
  .strict();
export const automationTaskCompletionInputSchema = z
  .object({
    taskId: entityIdSchema,
    expectedRevision: revisionSchema,
    completed: z.boolean(),
  })
  .strict();

export const automationProjectMutationInputSchema = projectMutationInput(
  projectCreateRequestSchema.shape.title,
);
export const automationTagMutationInputSchema = tagMutationInput(
  tagCreateRequestSchema.shape.title,
);
export const automationAssignProjectInputSchema = z
  .object({
    taskId: entityIdSchema,
    expectedRevision: revisionSchema,
    projectId: entityIdSchema.nullable(),
  })
  .strict();
export const automationSetTagsInputSchema = z
  .object({
    taskId: entityIdSchema,
    expectedRevision: revisionSchema,
    tagIds: z
      .array(entityIdSchema)
      .max(25)
      .refine((ids) => new Set(ids).size === ids.length, {
        message: "Tag ids must be unique",
      }),
  })
  .strict();

export const automationTaskHierarchyInputSchema = z.discriminatedUnion(
  "action",
  [
    z
      .object({
        action: z.literal("create_child"),
        parentId: entityIdSchema,
        expectedParentRevision: revisionSchema,
        index: taskHierarchyIndexSchema.nullable().optional(),
        task: createTaskRequestSchema.omit({ structured: true }).strict(),
      })
      .strict(),
    z
      .object({
        action: z.literal("move"),
        taskId: entityIdSchema,
        expectedRevision: revisionSchema,
        parentId: entityIdSchema.nullable(),
        index: taskHierarchyIndexSchema.nullable().optional(),
      })
      .strict(),
    z
      .object({
        action: z.literal("reorder"),
        parentId: entityIdSchema,
        expectedParentRevision: revisionSchema,
        items: taskChildOrderItemsSchema,
      })
      .strict(),
  ],
);
export const taskHierarchyMutationResponseSchema = z
  .object({
    hierarchy: z
      .object({
        task: taskSchema.nullable(),
        parent: taskSchema.nullable(),
        children: z.array(taskSchema),
      })
      .strict(),
    replayed: z.boolean(),
  })
  .strict();

export const automationChecklistInputSchema = z
  .object({
    expectedTaskRevision: revisionSchema,
    command: checklistCommandSchema,
  })
  .strict();
export const checklistResourceInputSchema = z
  .object({ taskId: entityIdSchema })
  .strict();
export const checklistResourceSchema = z
  .object({ taskId: entityIdSchema, subtasks: z.array(subtaskSchema) })
  .strict();
export const checklistMutationResponseSchema = checklistResourceSchema
  .extend({ deletedIds: z.array(entityIdSchema).max(1) })
  .strict();

export const planningPreferenceSnapshotSchema =
  planningPreferencesSchema.safeExtend({
    revision: z.number().int().nonnegative(),
  });
export const notificationPreferenceSnapshotSchema =
  notificationPreferencesSchema.safeExtend({
    revision: z.number().int().nonnegative(),
  });
export const planningPreferenceMutationInputSchema = z
  .object({
    expectedRevision: z.number().int().nonnegative(),
    preferences: planningPreferencesSchema,
  })
  .strict();
export const notificationPreferenceMutationInputSchema = z
  .object({
    expectedRevision: z.number().int().nonnegative(),
    preferences: notificationPreferencesSchema,
  })
  .strict();

export const notificationTestInputSchema = z
  .object({
    expectedRevision: z.number().int().nonnegative(),
  })
  .strict();
export const notificationTestQueuedSchema = z
  .object({
    notificationTest: z
      .object({ deliveryId: entityIdSchema, state: z.literal("pending") })
      .strict(),
  })
  .strict();

export const automationPreviewCommandSchema = z.discriminatedUnion(
  "operation",
  [
    z.object({
      operation: z.literal("notifications.send_test"),
      input: notificationTestInputSchema,
    }),
    z.object({
      operation: z.literal("planning.update_preferences"),
      input: planningPreferenceMutationInputSchema,
    }),
    z.object({
      operation: z.literal("notifications.update_preferences"),
      input: notificationPreferenceMutationInputSchema,
    }),
    z.object({
      operation: z.literal("subtasks.mutate"),
      input: automationChecklistInputSchema,
    }),
    z.object({
      operation: z.literal("time_entries.mutate"),
      input: automationTimeEntryMutationInputSchema,
    }),
    z.object({
      operation: z.literal("projects.mutate"),
      input: automationProjectMutationInputSchema,
    }),
    z.object({
      operation: z.literal("tags.mutate"),
      input: automationTagMutationInputSchema,
    }),
    z.object({
      operation: z.literal("projects.reorder"),
      input: automationOrganizationOrderInputSchema,
    }),
    z.object({
      operation: z.literal("tags.reorder"),
      input: automationOrganizationOrderInputSchema,
    }),
    z.object({
      operation: z.literal("projects.set_backlog"),
      input: automationProjectBacklogInputSchema,
    }),
    z.object({
      operation: z.literal("notes.mutate"),
      input: automationNoteMutationInputSchema,
    }),
    z.object({
      operation: z.literal("task_links.mutate"),
      input: automationTaskLinkMutationInputSchema,
    }),
    z.object({
      operation: z.literal("tasks.assign_project"),
      input: automationAssignProjectInputSchema,
    }),
    z.object({
      operation: z.literal("tasks.set_tags"),
      input: automationSetTagsInputSchema,
    }),
    z.object({
      operation: z.literal("tasks.hierarchy"),
      input: automationTaskHierarchyInputSchema,
    }),
    z.object({
      operation: z.literal("habits.mutate"),
      input: habitCommandSchema,
    }),
    z.object({
      operation: z.literal("tasks.delete"),
      input: automationTaskLifecycleInputSchema,
    }),
    z.object({
      operation: z.literal("tasks.restore"),
      input: automationTaskLifecycleInputSchema,
    }),
    z.object({
      operation: z.literal("tasks.archive"),
      input: automationTaskLifecycleInputSchema,
    }),
    z.object({
      operation: z.literal("tasks.unarchive"),
      input: automationTaskLifecycleInputSchema,
    }),
    z.object({
      operation: z.literal("recurrence.create"),
      input: automationRecurrenceCreateInputSchema,
    }),
    z.object({
      operation: z.literal("recurrence.update"),
      input: automationRecurrenceUpdateInputSchema,
    }),
    z.object({
      operation: z.literal("recurrence.set_state"),
      input: automationRecurrenceStateInputSchema,
    }),
    z.object({
      operation: z.literal("recurrence.occurrence"),
      input: automationRecurrenceOccurrenceInputSchema,
    }),
    z.object({
      operation: z.literal("tasks.update"),
      input: automationTaskUpdateInputSchema,
    }),
    z.object({
      operation: z.literal("tasks.set_completed"),
      input: automationTaskCompletionInputSchema,
    }),
    z.object({
      operation: z.literal("tasks.create"),
      input: createTaskRequestSchema,
    }),
    z.object({
      operation: z.literal("schedule.create_time_block"),
      input: z
        .object({ taskId: entityIdSchema })
        .extend(createTaskTimeBlockRequestSchema.shape),
    }),
    z.object({
      operation: z.literal("templates.instantiate"),
      input: z.object({
        templateId: entityIdSchema,
        destinationProjectId: entityIdSchema,
      }),
    }),
    z.object({
      operation: z.literal("template_sets.instantiate"),
      input: z.object({
        setId: entityIdSchema,
        destinationProjectId: entityIdSchema,
      }),
    }),
    z.object({
      operation: z.literal("placeholders.resolve"),
      input: resolvePlanningPlaceholderPreviewInputSchema,
    }),
    ...[
      "focus.start",
      "focus.pause",
      "focus.resume",
      "focus.start_break",
      "focus.end_break",
      "focus.complete",
      "focus.takeover",
    ].map((operation) =>
      z.object({
        operation: z.literal(
          operation as Extract<
            z.infer<typeof automationOperationSchema>,
            `focus.${string}`
          >,
        ),
        input: automationFocusCommandInputSchema.refine(
          (input) => input.operation === operation,
          { message: "Focus preview operation and input must agree" },
        ),
      }),
    ),
  ],
);

const automationToolInputSchema = (
  operation: z.infer<typeof automationOperationSchema>,
): z.ZodType => {
  if (operation === "notifications.send_test")
    return z.object({
      operation: z.literal(operation),
      input: notificationTestInputSchema,
    });
  if (operation === "planning.update_preferences")
    return z.object({
      operation: z.literal(operation),
      input: planningPreferenceMutationInputSchema,
    });
  if (operation === "notifications.update_preferences")
    return z.object({
      operation: z.literal(operation),
      input: notificationPreferenceMutationInputSchema,
    });
  if (operation === "subtasks.mutate")
    return z.object({
      operation: z.literal(operation),
      input: automationChecklistInputSchema,
    });
  if (operation === "projects.mutate")
    return z.object({
      operation: z.literal(operation),
      input: automationProjectMutationInputSchema,
    });
  if (operation === "tags.mutate")
    return z.object({
      operation: z.literal(operation),
      input: automationTagMutationInputSchema,
    });
  if (operation === "projects.reorder" || operation === "tags.reorder")
    return z.object({
      operation: z.literal(operation),
      input: automationOrganizationOrderInputSchema,
    });
  if (operation === "projects.set_backlog")
    return z.object({
      operation: z.literal(operation),
      input: automationProjectBacklogInputSchema,
    });
  if (operation === "notes.mutate")
    return z.object({
      operation: z.literal(operation),
      input: automationNoteMutationInputSchema,
    });
  if (operation === "task_links.mutate")
    return z.object({
      operation: z.literal(operation),
      input: automationTaskLinkMutationInputSchema,
    });
  if (operation === "time_entries.mutate")
    return z.object({
      operation: z.literal(operation),
      input: automationTimeEntryMutationInputSchema,
    });
  if (operation === "tasks.assign_project")
    return z.object({
      operation: z.literal(operation),
      input: automationAssignProjectInputSchema,
    });
  if (operation === "tasks.set_tags")
    return z.object({
      operation: z.literal(operation),
      input: automationSetTagsInputSchema,
    });
  if (operation === "tasks.hierarchy")
    return z.object({
      operation: z.literal(operation),
      input: automationTaskHierarchyInputSchema,
    });
  if (operation === "habits.mutate")
    return z.object({
      operation: z.literal(operation),
      input: habitCommandSchema,
    });
  if (
    operation === "tasks.delete" ||
    operation === "tasks.restore" ||
    operation === "tasks.archive" ||
    operation === "tasks.unarchive"
  )
    return z.object({
      operation: z.literal(operation),
      input: automationTaskLifecycleInputSchema,
    });
  if (operation === "tasks.update")
    return z.object({
      operation: z.literal(operation),
      input: automationTaskUpdateInputSchema,
    });
  if (operation === "recurrence.create")
    return z.object({
      operation: z.literal(operation),
      input: automationRecurrenceCreateInputSchema,
    });
  if (operation === "recurrence.update")
    return z.object({
      operation: z.literal(operation),
      input: automationRecurrenceUpdateInputSchema,
    });
  if (operation === "recurrence.set_state")
    return z.object({
      operation: z.literal(operation),
      input: automationRecurrenceStateInputSchema,
    });
  if (operation === "recurrence.occurrence")
    return z.object({
      operation: z.literal(operation),
      input: automationRecurrenceOccurrenceInputSchema,
    });
  if (operation === "tasks.set_completed")
    return z.object({
      operation: z.literal(operation),
      input: automationTaskCompletionInputSchema,
    });
  if (operation === "tasks.create")
    return z.object({
      operation: z.literal("tasks.create"),
      input: createTaskRequestSchema,
    });
  if (operation === "schedule.create_time_block")
    return z.object({
      operation: z.literal("schedule.create_time_block"),
      input: z
        .object({ taskId: entityIdSchema })
        .extend(createTaskTimeBlockRequestSchema.shape),
    });
  if (operation === "templates.instantiate")
    return z.object({
      operation: z.literal("templates.instantiate"),
      input: z.object({
        templateId: entityIdSchema,
        destinationProjectId: entityIdSchema,
      }),
    });
  if (operation === "template_sets.instantiate")
    return z.object({
      operation: z.literal("template_sets.instantiate"),
      input: z.object({
        setId: entityIdSchema,
        destinationProjectId: entityIdSchema,
      }),
    });
  if (operation === "placeholders.resolve")
    return z.object({
      operation: z.literal("placeholders.resolve"),
      input: resolvePlanningPlaceholderPreviewInputSchema,
    });
  if (operation === "focus.start")
    return z.object({
      operation: z.literal("focus.start"),
      input: z.object({
        operation: z.literal("focus.start"),
        taskId: entityIdSchema,
      }),
    });
  return z.object({
    operation: z.literal(operation),
    input: automationSessionCommandBaseSchema.extend({
      operation: z.literal(operation),
    }),
  });
};

export const automationAffectedEntitySchema = z
  .object({
    entityKind: z.enum([
      "planning_preferences",
      "notification_preferences",
      "habit",
      "task",
      "subtask",
      "calendar",
      "active_session",
      "template",
      "template_set",
      "project",
      "tag",
      "note",
      "task_attachment",
      "task_issue_link",
      "time_entry",
      "choice_pool",
      "planning_placeholder",
      "pool_item",
      "recurring_series",
    ]),
    entityId: entityIdSchema,
  })
  .strict();

const existingAutomationBaseRevisionSchema = z
  .object({
    entityKind: z.enum([
      "habit",
      "task",
      "subtask",
      "active_session",
      "template",
      "template_set",
      "project",
      "tag",
      "note",
      "task_attachment",
      "task_issue_link",
      "time_entry",
      "choice_pool",
      "planning_placeholder",
      "pool_item",
      "recurring_series",
    ]),
    entityId: entityIdSchema,
    revision: revisionSchema,
  })
  .strict();

export const automationBaseRevisionSchema = z.union([
  existingAutomationBaseRevisionSchema,
  z
    .object({
      entityKind: z.enum(["planning_preferences", "notification_preferences"]),
      entityId: entityIdSchema,
      revision: z.number().int().nonnegative(),
    })
    .strict(),
]);

export const automationPreviewSchema = z
  .object({
    id: entityIdSchema,
    operation: automationOperationSchema,
    inputHash: z.string().regex(/^[a-f0-9]{64}$/),
    summary: z.string().trim().min(1).max(1_000),
    affected: z.array(automationAffectedEntitySchema).max(201),
    baseRevisions: z.array(automationBaseRevisionSchema).max(201),
    expiresAt: z.iso.datetime(),
    requiresConfirmation: z.literal(true),
  })
  .strict();

export const automationPreviewResponseSchema = z
  .object({ preview: automationPreviewSchema })
  .strict();

export const automationConfirmRequestSchema = z
  .object({ idempotencyKey: idempotencyKeySchema })
  .strict();

export const automationConfirmToolInputSchema = z
  .object({ previewId: entityIdSchema, idempotencyKey: idempotencyKeySchema })
  .strict();

export const habitMutationResponseSchema = z
  .object({
    habit: habitSchema,
    occurrence: habitOccurrenceSchema.nullable(),
    replayed: z.boolean(),
  })
  .strict();

export const automationExecutionResultSchema = z.union([
  notificationTestQueuedSchema,
  z.object({ planningPreferences: planningPreferenceSnapshotSchema }).strict(),
  z
    .object({ notificationPreferences: notificationPreferenceSnapshotSchema })
    .strict(),
  checklistMutationResponseSchema,
  taskHierarchyMutationResponseSchema,
  taskArchiveMutationResponseSchema,
  recurringSeriesMutationResponseSchema,
  timeEntryMutationResponseSchema,
  z.object({ project: projectSchema }).strict(),
  z.object({ tag: tagSchema }).strict(),
  z.object({ projects: z.array(projectSchema) }).strict(),
  z.object({ tags: z.array(tagSchema) }).strict(),
  noteMutationResponseSchema,
  taskLinksResponseSchema,
  habitMutationResponseSchema,
  taskTimeBlockMutationResponseSchema,
  activeSessionCommandResponseSchema,
  taskMutationResponseSchema,
  templateInstantiationResponseSchema,
  planningPlaceholderResolutionResponseSchema,
]);

export const automationConfirmationResponseSchema = z
  .object({
    previewId: entityIdSchema,
    operation: automationOperationSchema,
    replayed: z.boolean(),
    result: automationExecutionResultSchema,
  })
  .strict();

export const automationTaskResourceSchema = z
  .object({ tasks: z.array(taskSchema) })
  .strict();
export const automationScheduleResourceSchema = plannerResponseSchema;
export const automationProjectResourceSchema = z
  .object({ projects: z.array(projectSchema) })
  .strict();
export const automationTagResourceSchema = z
  .object({ tags: z.array(tagSchema) })
  .strict();
export const automationActiveSessionResourceSchema = z
  .object({ session: activeSessionSchema.nullable() })
  .strict();
export const automationTemplateResourceSchema =
  taskTemplateLibraryResponseSchema;
export const automationTemplateSetResourceSchema =
  templateSetLibraryResponseSchema;
export const automationChoicePoolResourceSchema =
  choicePoolLibraryResponseSchema;

export interface AutomationCatalogEntry {
  readonly id: string;
  readonly kind: "resource" | "tool";
  readonly scopes: readonly z.infer<typeof automationTokenScopeSchema>[];
  readonly confirmationRequired: boolean;
  readonly apiPath: string;
  readonly mcpName: string;
  readonly mcpUri?: string;
  readonly inputSchema: z.ZodType;
  readonly outputSchema: z.ZodType;
}

// This is the only automation catalog. HTTP handlers and the stdio adapter must
// import it instead of maintaining parallel operation lists.
export const dayPlanInputSchema = z.object({ at: z.iso.datetime() }).strict();

export const automationCatalog = [
  {
    id: "planning.day_plan",
    kind: "resource",
    scopes: ["schedule:read"],
    confirmationRequired: false,
    apiPath: "/api/automation/v1/resources/day-plan",
    mcpName: "suite.planning.day_plan",
    mcpUri: "suite://v1/day-plan",
    inputSchema: dayPlanInputSchema,
    outputSchema: dayPlanResponseSchema,
  },
  {
    id: "planning.preferences",
    kind: "resource",
    scopes: ["schedule:read"],
    confirmationRequired: false,
    apiPath: "/api/automation/v1/resources/planning-preferences",
    mcpName: "suite.planning.preferences",
    mcpUri: "suite://v1/planning-preferences",
    inputSchema: z.object({}).strict(),
    outputSchema: planningPreferenceSnapshotSchema,
  },
  {
    id: "notifications.preferences",
    kind: "resource",
    scopes: ["notifications:read"],
    confirmationRequired: false,
    apiPath: "/api/automation/v1/resources/notification-preferences",
    mcpName: "suite.notifications.preferences",
    mcpUri: "suite://v1/notification-preferences",
    inputSchema: z.object({}).strict(),
    outputSchema: notificationPreferenceSnapshotSchema,
  },
  {
    id: "notifications.delivery",
    kind: "resource",
    scopes: ["notifications:read"],
    confirmationRequired: false,
    apiPath: "/api/automation/v1/resources/notification-delivery",
    mcpName: "suite.notifications.delivery",
    mcpUri: "suite://v1/notification-delivery",
    inputSchema: notificationDeliveryInputSchema,
    outputSchema: notificationDeliveryResponseSchema,
  },
  {
    id: "notifications.status",
    kind: "resource",
    scopes: ["notifications:read"],
    confirmationRequired: false,
    apiPath: "/api/automation/v1/resources/notification-status",
    mcpName: "suite.notifications.status",
    mcpUri: "suite://v1/notification-status",
    inputSchema: z.object({}).strict(),
    outputSchema: notificationStatusResponseSchema,
  },

  {
    id: "subtasks.list",
    kind: "resource",
    scopes: ["tasks:read"],
    confirmationRequired: false,
    apiPath: "/api/automation/v1/resources/subtasks",
    mcpName: "suite.subtasks.list",
    mcpUri: "suite://v1/subtasks",
    inputSchema: checklistResourceInputSchema,
    outputSchema: checklistResourceSchema,
  },

  {
    id: "habits.list",
    kind: "resource",
    scopes: ["habits:read"],
    confirmationRequired: false,
    apiPath: "/api/automation/v1/resources/habits",
    mcpName: "suite.habits.list",
    mcpUri: "suite://v1/habits",
    inputSchema: z.object({}).strict(),
    outputSchema: habitListResponseSchema,
  },
  {
    id: "tasks.list",
    kind: "resource",
    scopes: ["tasks:read"],
    confirmationRequired: false,
    apiPath: "/api/automation/v1/resources/tasks",
    mcpName: "suite.tasks.list",
    mcpUri: "suite://v1/tasks",
    inputSchema: z.object({}).strict(),
    outputSchema: automationTaskResourceSchema,
  },
  {
    id: "tasks.deleted",
    kind: "resource",
    scopes: ["tasks:read"],
    confirmationRequired: false,
    apiPath: "/api/automation/v1/resources/tasks/deleted",
    mcpName: "suite.tasks.deleted",
    mcpUri: "suite://v1/tasks/deleted",
    inputSchema: z.object({}).strict(),
    outputSchema: automationTaskResourceSchema,
  },
  {
    id: "tasks.history",
    kind: "resource",
    scopes: ["tasks:read"],
    confirmationRequired: false,
    apiPath: "/api/automation/v1/resources/tasks/history",
    mcpName: "suite.tasks.history",
    mcpUri: "suite://v1/tasks/history{?query,cursor,limit}",
    inputSchema: taskHistoryQuerySchema,
    outputSchema: taskHistoryResponseSchema,
  },
  {
    id: "recurrence.list",
    kind: "resource",
    scopes: ["tasks:read"],
    confirmationRequired: false,
    apiPath: "/api/automation/v1/resources/recurrence",
    mcpName: "suite.recurrence.list",
    mcpUri: "suite://v1/recurrence",
    inputSchema: z.object({}).strict(),
    outputSchema: recurringSeriesListResponseSchema,
    id: "time.report",
    kind: "resource",
    scopes: ["tasks:read"],
    confirmationRequired: false,
    apiPath: "/api/automation/v1/resources/time-report",
    mcpName: "suite.time.report",
    mcpUri: "suite://v1/time-report{?from,to}",
    inputSchema: timeReportQuerySchema,
    outputSchema: timeReportResponseSchema,
  },
  {
    id: "schedule.get",
    kind: "resource",
    scopes: ["schedule:read"],
    confirmationRequired: false,
    apiPath: "/api/automation/v1/resources/schedule",
    mcpName: "suite.schedule.get",
    mcpUri: "suite://v1/schedule{?from,to}",
    inputSchema: plannerWindowSchema,
    outputSchema: automationScheduleResourceSchema,
  },
  {
    id: "projects.list",
    kind: "resource",
    scopes: ["projects:read"],
    confirmationRequired: false,
    apiPath: "/api/automation/v1/resources/projects",
    mcpName: "suite.projects.list",
    mcpUri: "suite://v1/projects",
    inputSchema: z.object({}).strict(),
    outputSchema: automationProjectResourceSchema,
  },
  {
    id: "tags.list",
    kind: "resource",
    scopes: ["tags:read"],
    confirmationRequired: false,
    apiPath: "/api/automation/v1/resources/tags",
    mcpName: "suite.tags.list",
    mcpUri: "suite://v1/tags",
    inputSchema: z.object({}).strict(),
    outputSchema: automationTagResourceSchema,
  },
  {
    id: "notes.list",
    kind: "resource",
    scopes: ["notes:read"],
    confirmationRequired: false,
    apiPath: "/api/automation/v1/resources/notes",
    mcpName: "suite.notes.list",
    mcpUri: "suite://v1/notes",
    inputSchema: z.object({}).strict(),
    outputSchema: noteListResponseSchema,
  },
  {
    id: "task_links.get",
    kind: "resource",
    scopes: ["task_links:read"],
    confirmationRequired: false,
    apiPath: "/api/automation/v1/resources/task-links",
    mcpName: "suite.task_links.get",
    mcpUri: "suite://v1/task-links{?taskId}",
    inputSchema: taskLinksResourceInputSchema,
    outputSchema: taskLinksResponseSchema,
  },
  {
    id: "active-session.get",
    kind: "resource",
    scopes: ["focus:read"],
    confirmationRequired: false,
    apiPath: "/api/automation/v1/resources/active-session",
    mcpName: "suite.active_session.get",
    mcpUri: "suite://v1/active-session",
    inputSchema: z.object({}).strict(),
    outputSchema: automationActiveSessionResourceSchema,
  },
  {
    id: "templates.list",
    kind: "resource",
    scopes: ["templates:read"],
    confirmationRequired: false,
    apiPath: "/api/automation/v1/resources/templates",
    mcpName: "suite.templates.list",
    mcpUri: "suite://v1/templates",
    inputSchema: templateSearchRequestSchema,
    outputSchema: automationTemplateResourceSchema,
  },
  {
    id: "template-sets.list",
    kind: "resource",
    scopes: ["templates:read"],
    confirmationRequired: false,
    apiPath: "/api/automation/v1/resources/template-sets",
    mcpName: "suite.template_sets.list",
    mcpUri: "suite://v1/template-sets",
    inputSchema: z.object({}).strict(),
    outputSchema: automationTemplateSetResourceSchema,
  },
  {
    id: "pools.list",
    kind: "resource",
    scopes: ["pools:read"],
    confirmationRequired: false,
    apiPath: "/api/automation/v1/resources/pools",
    mcpName: "suite.pools.list",
    mcpUri: "suite://v1/pools",
    inputSchema: z.object({}).strict(),
    outputSchema: automationChoicePoolResourceSchema,
  },
  ...automationOperationSchema.options.map((id) => ({
    id,
    kind: "tool" as const,
    scopes: [
      id === "notifications.send_test"
        ? "notifications:test"
        : id === "planning.update_preferences"
          ? "planning:write"
          : id === "notifications.update_preferences"
            ? "notifications:write"
            : id.startsWith("projects.")
              ? "projects:write"
              : id.startsWith("tags.")
                ? "tags:write"
                : id === "notes.mutate"
                  ? "notes:write"
                  : id === "task_links.mutate"
                    ? "task_links:write"
                    : id === "habits.mutate"
                      ? "habits:write"
                      : id.startsWith("tasks.") ||
                          id.startsWith("recurrence.") ||
                          id === "subtasks.mutate" ||
                          id === "time_entries.mutate"
                        ? "tasks:write"
                        : id === "schedule.create_time_block"
                          ? "schedule:write"
                          : id.startsWith("templates.") ||
                              id.startsWith("template_sets.")
                            ? "templates:write"
                            : id === "placeholders.resolve"
                              ? "pools:write"
                              : "focus:write",
    ] as const,
    confirmationRequired: true,
    apiPath: "/api/automation/v1/previews",
    mcpName: `suite.${id}`,
    inputSchema: automationToolInputSchema(id),
    outputSchema: automationPreviewResponseSchema,
  })),
  {
    id: "automation.confirm",
    kind: "tool",
    scopes: [
      "notifications:test",
      "planning:write",
      "notifications:write",
      "tasks:write",
      "projects:write",
      "tags:write",
      "schedule:write",
      "focus:write",
      "templates:write",
      "pools:write",
      "habits:write",
      "notes:write",
      "task_links:write",
    ],
    confirmationRequired: false,
    apiPath: "/api/automation/v1/previews/{previewId}/confirm",
    mcpName: "suite.confirm",
    inputSchema: automationConfirmToolInputSchema,
    outputSchema: automationConfirmationResponseSchema,
  },
] as const satisfies readonly AutomationCatalogEntry[];

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

export const calendarImportSourceSchema = z.enum(["ics", "google_ics"]);
export const calendarImportIssueSchema = z.object({
  code: z.enum([
    "malformed_component",
    "missing_uid",
    "duplicate_uid",
    "recurrence_preserved",
    "attendees_preserved",
    "alarms_preserved",
    "unknown_properties_preserved",
  ]),
  detail: z.string().min(1).max(2048),
});
export const calendarImportCandidateSchema = z.object({
  externalId: z.string().min(1).max(1024),
  uid: z.string().min(1).max(1024),
  summary: z.string().max(1024),
  rawIcs: z
    .string()
    .min(1)
    .max(4 * 1024 * 1024),
  recurrence: z.boolean(),
  attendeeCount: z.number().int().nonnegative(),
  alarmCount: z.number().int().nonnegative(),
  unknownProperties: z.array(z.string()).max(100),
  issues: z.array(calendarImportIssueSchema),
});
export const calendarImportReportSchema = z.object({
  source: calendarImportSourceSchema,
  inputHash: z.string().regex(/^[a-f0-9]{64}$/),
  candidates: z.array(calendarImportCandidateSchema).max(10_000),
  skipped: z.array(calendarImportIssueSchema).max(10_000),
  totals: z.object({
    components: z.number().int().nonnegative(),
    ready: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
    recurring: z.number().int().nonnegative(),
    attendees: z.number().int().nonnegative(),
    alarms: z.number().int().nonnegative(),
    unknownProperties: z.number().int().nonnegative(),
  }),
});
export const calendarImportPreviewRequestSchema = z.object({
  source: calendarImportSourceSchema,
  calendarId: entityIdSchema,
  rawIcs: z
    .string()
    .min(1)
    .max(4 * 1024 * 1024),
});
export const calendarImportItemSchema = z.object({
  externalId: z.string(),
  uid: z.string(),
  href: z.string(),
  state: z.enum(["pending", "applied", "reconciliation_required", "skipped"]),
  appliedAt: z.iso.datetime().nullable(),
});
export const calendarImportJobSchema = z.object({
  id: entityIdSchema,
  calendarId: entityIdSchema,
  source: calendarImportSourceSchema,
  inputHash: z.string().regex(/^[a-f0-9]{64}$/),
  state: z.enum(["previewed", "applied", "partial"]),
  report: calendarImportReportSchema,
  items: z.array(calendarImportItemSchema),
  createdAt: z.iso.datetime(),
  appliedAt: z.iso.datetime().nullable(),
});
export const calendarImportMutationResponseSchema = z.object({
  job: calendarImportJobSchema,
  replayed: z.boolean(),
});
export const calendarFeedCreateRequestSchema = z.object({
  calendarId: entityIdSchema,
  label: z.string().trim().min(1).max(100),
});
export const calendarFeedCapabilitySchema = z.object({
  id: entityIdSchema,
  calendarId: entityIdSchema,
  label: z.string(),
  createdAt: z.iso.datetime(),
  revokedAt: z.iso.datetime().nullable(),
});
export const calendarFeedCreateResponseSchema = z.object({
  capability: calendarFeedCapabilitySchema,
  url: z.string().min(1),
});
export const calendarFeedListResponseSchema = z.object({
  capabilities: z.array(calendarFeedCapabilitySchema),
});

export type ApiError = z.infer<typeof apiErrorSchema>;
export type CalendarImportReport = z.infer<typeof calendarImportReportSchema>;
export type CalendarImportJob = z.infer<typeof calendarImportJobSchema>;
export type CalendarImportMutationResponse = z.infer<
  typeof calendarImportMutationResponseSchema
>;
export type CalendarFeedCapability = z.infer<
  typeof calendarFeedCapabilitySchema
>;
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
export type HabitListResponse = z.infer<typeof habitListResponseSchema>;
export type TaskPatchRequest = z.infer<typeof taskPatchRequestSchema>;
export type TaskMoveRequest = z.infer<typeof taskMoveRequestSchema>;
export type TaskChildCreateRequest = z.infer<
  typeof taskChildCreateRequestSchema
>;
export type TaskChildrenResponse = z.infer<typeof taskChildrenResponseSchema>;
export type ArchivedTask = z.infer<typeof archivedTaskSchema>;
export type TaskHistoryEntry = z.infer<typeof taskHistoryEntrySchema>;
export type TaskHistoryResponse = z.infer<typeof taskHistoryResponseSchema>;
export type TaskArchiveMutationResponse = z.infer<
  typeof taskArchiveMutationResponseSchema
>;
export type TaskHierarchyMutationResponse = z.infer<
  typeof taskHierarchyMutationResponseSchema
>;
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
export type GoogleConnectorStatusResponse = z.infer<
  typeof googleConnectorStatusResponseSchema
>;
export type GoogleSyncResponse = z.infer<typeof googleSyncResponseSchema>;
export type PlanningPreferences = z.infer<typeof planningPreferencesSchema>;
export type DayPlanResponse = z.infer<typeof dayPlanResponseSchema>;
export type NotificationPreferences = z.infer<
  typeof notificationPreferencesSchema
>;
export type NotificationStatusResponse = z.infer<
  typeof notificationStatusResponseSchema
>;
export type NotificationTestResponse = z.infer<
  typeof notificationTestResponseSchema
>;
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
export type TaskTemplate = z.infer<typeof taskTemplateSchema>;
export type TemplateSubtaskBlueprint = z.infer<
  typeof templateSubtaskBlueprintSchema
>;
export type TemplateSet = z.infer<typeof templateSetSchema>;
export type TemplateSetMember = z.infer<typeof templateSetMemberSchema>;
export type TaskTemplateProvenance = z.infer<
  typeof taskTemplateProvenanceSchema
>;
export type CreateTaskTemplateRequest = z.infer<
  typeof createTaskTemplateRequestSchema
>;
export type CreateTemplateSetRequest = z.infer<
  typeof createTemplateSetRequestSchema
>;
export type InstantiateTemplateRequest = z.infer<
  typeof instantiateTemplateRequestSchema
>;
export type TemplateInstantiationResponse = z.infer<
  typeof templateInstantiationResponseSchema
>;
export type ChoicePool = z.infer<typeof choicePoolSchema>;
export type ChoicePoolItem = z.infer<typeof choicePoolItemSchema>;
export type ChoicePoolHistoryEvent = z.infer<
  typeof choicePoolHistoryEventSchema
>;
export type PlanningPlaceholder = z.infer<typeof planningPlaceholderSchema>;
export type ChoicePoolSuggestionResponse = z.infer<
  typeof choicePoolSuggestionResponseSchema
>;
export type PlanningPlaceholderResolution = z.infer<
  typeof planningPlaceholderResolutionSchema
>;
export type PlanningPlaceholderResolutionResponse = z.infer<
  typeof planningPlaceholderResolutionResponseSchema
>;
export type TemplatePoolSlot = z.infer<typeof templatePoolSlotSchema>;
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
export type AutomationTokenScope = z.infer<typeof automationTokenScopeSchema>;
export type AutomationToken = z.infer<typeof automationTokenSchema>;
export type CreateAutomationTokenRequest = z.infer<
  typeof createAutomationTokenRequestSchema
>;
export type CreateAutomationTokenResponse = z.infer<
  typeof createAutomationTokenResponseSchema
>;
export type AutomationPreviewCommand = z.infer<
  typeof automationPreviewCommandSchema
>;
export type AutomationPreview = z.infer<typeof automationPreviewSchema>;
export type AutomationPreviewResponse = z.infer<
  typeof automationPreviewResponseSchema
>;
export type AutomationConfirmRequest = z.infer<
  typeof automationConfirmRequestSchema
>;
export type AutomationConfirmationResponse = z.infer<
  typeof automationConfirmationResponseSchema
>;

export { ApiRequestError, createAutomationClient } from "./http-client.ts";

export type HabitCommand = z.infer<typeof habitCommandSchema>;
export type HabitSyncOperation = z.infer<typeof habitSyncOperationSchema>;

export const isHabitSyncOperation = (
  operation: SyncOperation,
): operation is HabitSyncOperation => operation.kind.startsWith("habit.");

export type Habit = z.infer<typeof habitSchema>;
export type HabitOccurrence = z.infer<typeof habitOccurrenceSchema>;

export const superProductivityPreviewSchema = z.object({
  source: z.literal("super_productivity"),
  inputHash: z.string().regex(/^[a-f0-9]{64}$/),
  canApply: z.boolean(),
  totals: z.object({
    tasks: z.number().int().nonnegative(),
    completed: z.number().int().nonnegative(),
    archived: z.number().int().nonnegative(),
    childTasks: z.number().int().nonnegative(),
    projects: z.number().int().nonnegative(),
    tags: z.number().int().nonnegative(),
    repeatConfigurations: z.number().int().nonnegative(),
    trackedMilliseconds: z.number().nonnegative(),
    /** Work history reconciliation (ADR 0024), in milliseconds and counts. */
    time: z
      .object({
        sourceLeafMs: z.number().int().nonnegative(),
        sourceLeafDailyMs: z.number().int().nonnegative(),
        taskDayEntries: z.number().int().nonnegative(),
        taskDayMs: z.number().int().nonnegative(),
        parentResidualEntries: z.number().int().nonnegative(),
        parentResidualMs: z.number().int().nonnegative(),
        undatedMs: z.number().int().nonnegative(),
        datedExcessMs: z.number().int().nonnegative(),
        workContextDays: z.number().int().nonnegative(),
      })
      .optional(),
  }),
  tasks: z.array(
    z.object({
      sourceId: z.string(),
      title: z.string(),
      completed: z.boolean(),
      archived: z.boolean(),
      parentId: z.string().nullable(),
      projectId: z.string().nullable(),
      repeatConfigId: z.string().nullable(),
      estimateMilliseconds: z.number().nonnegative(),
      trackedMilliseconds: z.number().nonnegative(),
      scheduledAt: z.iso.datetime().nullable(),
      scheduledDay: z.string().nullable(),
      deadlineAt: z.iso.datetime().nullable(),
      deadlineDay: z.string().nullable(),
      // ADR 0022: source store, review reasons and unresolved references.
      store: z.enum(["task", "archiveYoung", "archiveOld"]).optional(),
      review: z.array(taskArchiveReviewReasonSchema).optional(),
      historicalReferences: z.array(historicalReferenceSchema).optional(),
      /** ADR 0023: occurrence date when the task links to a repeat configuration. */
      occurrenceDate: z.string().nullable().optional(),
    }),
  ),
  issues: z.array(
    z.object({
      code: z.string(),
      sourceId: z.string().nullable(),
      detail: z.string(),
      /** False for a reported disposition that does not prevent apply. */
      blocking: z.boolean().optional(),
    }),
  ),
});
export type SuperProductivityPreview = z.infer<
  typeof superProductivityPreviewSchema
>;

export const taskImportApplyResponseSchema = z
  .object({
    created: z.number().int().nonnegative(),
    existing: z.number().int().nonnegative(),
    /** ADR 0023: repeat configurations applied as recurring series. */
    recurringSeries: z
      .object({
        created: z.number().int().nonnegative(),
        existing: z.number().int().nonnegative(),
      })
      .strict()
      .optional(),
  })
  .strict();
