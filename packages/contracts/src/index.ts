export { superProductivityImportLimits } from "./import-limits.ts";
export * from "./organization.ts";
export * from "./calendar-bridge.ts";
export * from "./live-sync.ts";
export * from "./device-sessions.ts";
export * from "./task-planning.ts";
export * from "./task-links.ts";
export * from "./task-archive.ts";
export * from "./recurrence.ts";
export * from "./time-history.ts";
export * from "./counters.ts";
export * from "./plugin-data.ts";
export * from "./day-order.ts";
export * from "./boards.ts";
export * from "./focus.ts";
export * from "./application-preferences.ts";
import {
  applicationPreferenceMutationInputSchema,
  applicationPreferenceSnapshotSchema,
} from "./application-preferences.ts";
export * from "./capture.ts";
export * from "./calendar-subscriptions.ts";
export * from "./data-export.ts";
import { z } from "zod";
import {
  automationCalendarBridgeDeletionInputSchema,
  automationCalendarBridgeResolveInputSchema,
  automationCalendarBridgeResourceInputSchema,
  automationCalendarBridgeResourceSchema,
  calendarBridgeLinkSchema,
  calendarBridgeOperationSchema,
} from "./calendar-bridge.ts";
import { captureBatchMaxTasks, captureCreateFields } from "./capture.ts";
import {
  automationNoteMutationInputSchema,
  automationOrganizationOrderInputSchema,
  automationProjectBacklogInputSchema,
  automationProjectMutationInputSchema as projectMutationInput,
  automationTagMutationInputSchema as tagMutationInput,
  noteListResponseSchema,
  noteMutationResponseSchema,
  noteSchema,
  organizationColorSchema,
  organizationIconSchema,
  projectPatchFields,
  syncNoteCreateSchema,
  syncNotePatchFieldsSchema,
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
import {
  automationCounterMutationInputSchema,
  automationCounterRecordInputSchema,
  automationEvaluationWriteInputSchema,
  counterHistoryQuerySchema,
  counterHistoryResponseSchema,
  counterMutationResponseSchema,
  evaluationListQuerySchema,
  evaluationListResponseSchema,
  evaluationMutationResponseSchema,
} from "./counters.ts";
import { pluginDataListResponseSchema } from "./plugin-data.ts";
import {
  automationDayOrderReorderInputSchema,
  dayOrderResourceInputSchema,
  dayOrderResponseSchema,
  dayOrderSchema,
  dayStartsAtSchema,
} from "./day-order.ts";
import {
  automationBoardMutationInputSchema,
  automationBoardsResourceInputSchema,
  automationBoardsResourceSchema,
  automationMenuFolderMutationInputSchema,
  automationSectionMutationInputSchema,
  automationSectionsResourceInputSchema,
  boardMutationResponseSchema,
  menuFolderListResponseSchema,
  menuFolderMutationResponseSchema,
  sectionListResponseSchema,
  sectionMutationResponseSchema,
  taskViewListResponseSchema,
  taskViewResponseSchema,
  taskViewSetRequestSchema,
} from "./boards.ts";
import {
  focusIdleCorrectionSchema,
  focusIdleDispositionInputSchema,
  focusPreferenceMutationInputSchema,
  focusPreferenceSnapshotSchema,
  focusReminderKinds,
  focusTimerBaseSchema,
} from "./focus.ts";

/** Reminder ledger kinds: task reminders, tests and focus reminders (ADR 0029). */
export const notificationReminderKindSchema = z.enum([
  "lead",
  "at_start",
  "deadline",
  "test",
  ...focusReminderKinds,
]);
import {
  automationCalendarSubscriptionEventInputSchema,
  automationCalendarSubscriptionHideInputSchema,
  automationCalendarSubscriptionRefreshInputSchema,
  calendarSubscriptionEventMutationResponseSchema,
  calendarSubscriptionEventSchema,
  calendarSubscriptionRefreshResponseSchema,
  calendarSubscriptionResourceInputSchema,
  calendarSubscriptionResourceSchema,
} from "./calendar-subscriptions.ts";

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
    /**
     * ADR 0043 background calendar bridge. Informational: it never changes
     * `status`, so a provider outage does not fail readiness.
     */
    calendarBridge: z.enum(["disabled", "idle", "ok", "degraded"]).optional(),
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
  /** ADR 0048: keep this device signed in; absent or false is a browser session. */
  trustDevice: z.boolean().optional(),
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

/** Read-only setup probe of the server-configured Baikal endpoint (ADR 0039). */
export const baikalProbeCalendarSchema = z.object({
  href: z.string().min(1),
  displayName: z.string().min(1),
  supportsEvents: z.boolean(),
  supportsTodos: z.boolean(),
  privileges: z.array(z.string().min(1).max(128)).max(64).nullable(),
  canRead: z.boolean().nullable(),
  canWrite: z.boolean().nullable(),
});

export const baikalProbeResponseSchema = z.object({
  endpoint: z.url(),
  davClasses: z.array(z.string().min(1).max(128)).max(64),
  principalHref: z.string().min(1),
  calendarHomeHref: z.string().min(1),
  calendars: z.array(baikalProbeCalendarSchema).max(50),
  writableEventCalendars: z.number().int().nonnegative(),
});

export const calendarProviderKindSchema = z.enum([
  "baikal",
  "caldav",
  "google",
  // Read-only iCal subscription (ADR 0032).
  "ical",
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
  /** ADR 0031: owner consent for new tags, and the resolved capture extras. */
  ...captureCreateFields,
});

/** ADR 0031: several tasks from a pasted list, at most 100 in one batch. */
export const taskBatchCreateRequestSchema = z
  .object({
    items: z
      .array(
        createTaskRequestSchema.extend({
          children: z
            .array(createTaskRequestSchema)
            .max(captureBatchMaxTasks)
            .default([]),
        }),
      )
      .min(1)
      .max(captureBatchMaxTasks),
    createTags: z.boolean().optional(),
  })
  .strict()
  .refine(
    ({ items }) =>
      items.reduce((count, item) => count + 1 + item.children.length, 0) <=
      captureBatchMaxTasks,
    {
      message: `A batch creates at most ${String(captureBatchMaxTasks)} tasks`,
    },
  );
export const taskBatchMutationResponseSchema = z
  .object({ tasks: z.array(taskSchema), replayed: z.boolean() })
  .strict();

export const taskMutationResponseSchema = z.object({
  task: taskSchema,
  replayed: z.boolean(),
});

/** ADR 0027: tasks planned for a date and the date's resulting order. */
export const dayOrderPlanResponseSchema = z
  .object({ dayOrder: dayOrderSchema, tasks: z.array(taskSchema) })
  .strict();

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
/** ADR 0040: Google calendar roles and the write gate's refusal reasons. */
export const googleAccessRoleSchema = z.enum([
  "freeBusyReader",
  "reader",
  "writer",
  "owner",
]);
export const googleWriteRefusalSchema = z.enum([
  "not-connected",
  "reconnect-required",
  "consent-required",
  "scope-missing",
  "role-unknown",
  "read-only-calendar",
]);
export const googleWriteStatusSchema = z.object({
  /** `lost`: consent was recorded but the grant no longer allows writes. */
  consent: z.enum(["none", "granted", "lost"]),
  consentedAt: z.iso.datetime().nullable(),
  scopeGranted: z.boolean(),
});
export const googleCalendarCapabilitySchema = z.object({
  calendarId: entityIdSchema,
  accessRole: googleAccessRoleSchema.nullable(),
  writable: z.boolean(),
  reason: googleWriteRefusalSchema.nullable(),
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
  write: googleWriteStatusSchema,
  capabilities: z.array(googleCalendarCapabilitySchema),
});
/** Read-only is the default; write is the separate explicit consent step. */
export const googleAuthorizationRequestSchema = z
  .object({
    access: z.enum(["read", "write"]).default("read"),
  })
  .strict();
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
    /** ADR 0027: local start of a planning day; absent means "00:00". */
    dayStartsAt: dayStartsAtSchema.optional(),
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
        kind: notificationReminderKindSchema,
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
        kind: notificationReminderKindSchema,
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

/** ADR 0037: move an existing block; the calendar, when given, must match. */
export const automationTimeBlockMoveInputSchema = z
  .object({
    taskId: entityIdSchema,
    expectedRevision: revisionSchema,
    calendarId: entityIdSchema.optional(),
    startsAt: z.iso.datetime(),
    durationMinutes: createTaskTimeBlockRequestSchema.shape.durationMinutes,
  })
  .strict();
export const automationTimeBlockRemoveInputSchema = z
  .object({ taskId: entityIdSchema, expectedRevision: revisionSchema })
  .strict();

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

// ADR 0036: assistant authoring of templates, sets, pools and placeholders.
// Inputs mirror the browser request schemas; the entity ID and expected
// revision replace the If-Match header.
const templateSubtaskInputSchema = z
  .object({ title: z.string().trim().min(1).max(240) })
  .strict();
export const automationTemplateMutationInputSchema = z.discriminatedUnion(
  "action",
  [
    z
      .object({
        action: z.literal("create"),
        ...createTaskTemplateRequestSchema.shape,
      })
      .strict(),
    z
      .object({
        action: z.literal("create_from_task"),
        taskId: entityIdSchema,
        expectedTaskRevision: revisionSchema,
      })
      .strict(),
    z
      .object({
        action: z.literal("update"),
        templateId: entityIdSchema,
        expectedRevision: revisionSchema,
        title: z.string().trim().min(1).max(240).optional(),
        notes: z.string().max(20_000).optional(),
        estimateMinutes: z.number().int().min(1).max(720).nullable().optional(),
        suggestedProjectId: entityIdSchema.nullable().optional(),
        tagIds: z
          .array(entityIdSchema)
          .max(25)
          .refine((ids) => new Set(ids).size === ids.length)
          .optional(),
        subtasks: z.array(templateSubtaskInputSchema).max(100).optional(),
      })
      .strict()
      .refine(
        (value) =>
          Object.keys(value).some(
            (key) =>
              !["action", "templateId", "expectedRevision"].includes(key),
          ),
        { message: "At least one mutable template field is required" },
      ),
    z
      .object({
        action: z.literal("archive"),
        templateId: entityIdSchema,
        expectedRevision: revisionSchema,
      })
      .strict(),
    z
      .object({
        action: z.literal("add_pool_slot"),
        templateId: entityIdSchema,
        expectedRevision: revisionSchema,
        ...createTemplatePoolSlotRequestSchema.shape,
      })
      .strict(),
  ],
);
export const automationTemplateSetCreateInputSchema =
  createTemplateSetRequestSchema;
const choicePoolCooldownRule = (
  {
    policy,
    cooldownSeconds,
  }: { policy: string; cooldownSeconds: number | null },
  context: z.RefinementCtx,
) => {
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
};
export const automationChoicePoolMutationInputSchema = z.discriminatedUnion(
  "action",
  [
    z
      .object({
        action: z.literal("create"),
        ...createChoicePoolRequestSchema.shape,
      })
      .strict()
      .superRefine(choicePoolCooldownRule),
    z
      .object({
        action: z.literal("update"),
        poolId: entityIdSchema,
        expectedRevision: revisionSchema,
        ...updateChoicePoolRequestSchema.shape,
      })
      .strict()
      .superRefine(choicePoolCooldownRule),
    z
      .object({
        action: z.literal("record_completion"),
        poolId: entityIdSchema,
        itemId: entityIdSchema,
        ...completeChoicePoolItemRequestSchema.shape,
      })
      .strict(),
  ],
);
export const automationPlaceholderCreateInputSchema =
  createPlanningPlaceholderRequestSchema;
export const automationPlaceholderSuggestionInputSchema = z
  .object({
    placeholderId: entityIdSchema,
    at: z.iso.datetime().optional(),
  })
  .strict();
export const templateMutationResponseSchema = z
  .object({
    template: taskTemplateSchema,
    blueprints: z.array(templateSubtaskBlueprintSchema),
    poolSlots: z.array(templatePoolSlotSchema),
  })
  .strict();
export const templateSetMutationResponseSchema = z
  .object({
    set: templateSetSchema,
    members: z.array(templateSetMemberSchema),
  })
  .strict();
export const choicePoolMutationResponseSchema = z
  .object({
    pool: choicePoolSchema,
    items: z.array(choicePoolItemSchema),
    history: z.array(choicePoolHistoryEventSchema),
  })
  .strict();
export const planningPlaceholderMutationResponseSchema = z
  .object({ placeholder: planningPlaceholderSchema })
  .strict();

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
  /** ADR 0033: one version for the exclusive planned start / planned day slot. */
  "plannedStart",
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
  /** Planning slot version (ADR 0033); absent only in pre-0037 snapshots. */
  plannedStart: revisionSchema.optional(),
});

/** The version key that guards a syncable task field (ADR 0033). */
export const syncFieldVersionKey = (field: string): string =>
  field === "plannedDay" ? "plannedStart" : field;

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
    // ADR 0033: planning slot, assignment.
    plannedStart: z.iso.datetime().nullable().optional(),
    plannedDay: taskPlanningFieldsSchema.shape.plannedDay,
    projectId: entityIdSchema.nullable().optional(),
    tagIds: z
      .array(entityIdSchema)
      .max(25)
      .refine((tagIds) => new Set(tagIds).size === tagIds.length, {
        message: "Task tags must be unique",
      })
      .optional(),
  })
  .strict()
  .refine((fields) => Object.keys(fields).length > 0, {
    message: "At least one syncable task field is required",
  })
  .refine(plannedDayAndStartExclusive, { message: plannedDayAndStartMessage });

const syncPatchBaseVersionsSchema = z
  .object({
    title: revisionSchema.optional(),
    notes: revisionSchema.optional(),
    estimateMinutes: revisionSchema.optional(),
    deadline: revisionSchema.optional(),
    plannedStart: revisionSchema.optional(),
    projectId: revisionSchema.optional(),
    tagIds: revisionSchema.optional(),
  })
  .strict();

const syncEntityKindSchema = z.enum([
  "task",
  "project",
  "tag",
  "subtask",
  "note",
]);

// ADR 0033: project and tag lifecycle. Records keep one revision, so a stale
// patch is a resource conflict rather than a field conflict.
const syncOrganizationPatchFieldsSchema = z
  .object({
    title: z.string().trim().min(1).max(240).optional(),
    archived: z.boolean().optional(),
    completed: z.boolean().optional(),
    color: organizationColorSchema.nullable().optional(),
    icon: organizationIconSchema.nullable().optional(),
  })
  .strict()
  .refine((fields) => Object.keys(fields).length > 0, {
    message: "An organization edit is required",
  })
  .refine(
    (fields) => fields.archived === undefined || fields.completed === undefined,
    { message: "Archive and completion cannot change together" },
  );

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
        const fieldNames = [
          ...new Set(Object.keys(fields).map(syncFieldVersionKey)),
        ].sort();
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
  // ADR 0033: projects and tags.
  syncOperationBaseSchema.extend({
    kind: z.literal("project.create"),
    project: z
      .object({ id: entityIdSchema, title: z.string().trim().min(1).max(240) })
      .strict(),
  }),
  syncOperationBaseSchema.extend({
    kind: z.literal("tag.create"),
    tag: z
      .object({ id: entityIdSchema, title: z.string().trim().min(1).max(100) })
      .strict(),
  }),
  syncOperationBaseSchema.extend({
    kind: z.literal("project.patch"),
    projectId: entityIdSchema,
    fields: syncOrganizationPatchFieldsSchema,
    baseRevision: revisionSchema,
  }),
  syncOperationBaseSchema
    .extend({
      kind: z.literal("tag.patch"),
      tagId: entityIdSchema,
      fields: syncOrganizationPatchFieldsSchema,
      baseRevision: revisionSchema,
    })
    .refine(
      ({ fields }) =>
        fields.completed === undefined &&
        (fields.title === undefined || fields.title.length <= 100),
      {
        message:
          "Tags archive and restore only; names are at most 100 characters",
      },
    ),
  // ADR 0033: checklist items keep one revision each.
  syncOperationBaseSchema.extend({
    kind: z.literal("subtask.create"),
    subtask: z
      .object({
        id: entityIdSchema,
        taskId: entityIdSchema,
        title: z.string().trim().min(1).max(240),
        position: z.number().int().nonnegative(),
      })
      .strict(),
  }),
  syncOperationBaseSchema.extend({
    kind: z.literal("subtask.patch"),
    subtaskId: entityIdSchema,
    fields: subtaskPatchRequestSchema,
    baseRevision: revisionSchema,
  }),
  syncOperationBaseSchema.extend({
    kind: z.literal("subtask.delete"),
    subtaskId: entityIdSchema,
    baseRevision: revisionSchema,
  }),
  // ADR 0046: notes keep one record revision. A stale patch or delete is a
  // resource conflict that changes nothing; the review keeps both versions.
  syncOperationBaseSchema.extend({
    kind: z.literal("note.create"),
    note: syncNoteCreateSchema,
  }),
  syncOperationBaseSchema.extend({
    kind: z.literal("note.patch"),
    noteId: entityIdSchema,
    fields: syncNotePatchFieldsSchema,
    baseRevision: revisionSchema,
  }),
  syncOperationBaseSchema.extend({
    kind: z.literal("note.delete"),
    noteId: entityIdSchema,
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
    /** ADR 0033, ADR 0046: which record conflicted; absent means a task. */
    entityKind: syncEntityKindSchema.optional(),
    /** The conflicting entity's ID and revision for every entity kind. */
    taskId: entityIdSchema,
    taskRevision: revisionSchema,
    conflictingFields: z.array(coreTaskFieldSchema).min(1).max(8).optional(),
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

// ADR 0029: focus timer state and idle correction carry the session.
export const focusTimerSchema = focusTimerBaseSchema
  .extend({ session: activeSessionSchema.nullable() })
  .strict();
export type FocusTimer = z.infer<typeof focusTimerSchema>;
export const focusIdleResponseSchema = z
  .object({
    session: activeSessionSchema,
    correction: focusIdleCorrectionSchema,
    replayed: z.boolean(),
  })
  .strict();
export type FocusIdleResponse = z.infer<typeof focusIdleResponseSchema>;

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
  // ADR 0046: the whole note, as the HTTP note routes return it.
  z.object({ entityKind: z.literal("note"), value: noteSchema }),
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
    "note",
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
      "project.create",
      "project.patch",
      "tag.create",
      "tag.patch",
      "subtask.create",
      "subtask.patch",
      "subtask.delete",
      "note.create",
      "note.patch",
      "note.delete",
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

// Assistant operations for import, publication and connector recovery
// (issue #60, ADR 0038). Responses never carry a credential, a capability
// secret or a feed address; candidates omit rawIcs.
export const automationConnectorKindSchema = z.enum(["baikal", "google"]);
export const automationBaikalStatusSchema = z
  .object({
    state: z.enum(["disconnected", "connected", "unavailable"]),
    reason: z.string().min(1).max(100).nullable(),
    providerId: entityIdSchema.nullable(),
    endpointHost: z.string().min(1).max(253),
    username: z.string().nullable(),
    verifiedAt: z.iso.datetime().nullable(),
    calendars: z.array(calendarCollectionSchema),
  })
  .strict();
export const automationRecoveryStepSchema = z
  .object({
    connector: automationConnectorKindSchema,
    actor: z.enum(["assistant", "owner", "none"]),
    operation: z.literal("connectors.resync").nullable(),
    message: z.string().min(1).max(500),
  })
  .strict();
export const automationConnectorStatusResourceSchema = z
  .object({
    baikal: automationBaikalStatusSchema,
    google: googleConnectorStatusResponseSchema,
    recovery: z.array(automationRecoveryStepSchema),
  })
  .strict();
export const automationConnectorResyncInputSchema = z
  .object({
    connector: z.literal("google"),
    full: z.boolean().default(false),
  })
  .strict();
export const automationConnectorResyncResponseSchema = z
  .object({
    status: googleConnectorStatusResponseSchema,
    resetCalendars: z.array(entityIdSchema),
  })
  .strict();

export const automationCalendarImportCandidateSchema =
  calendarImportCandidateSchema.omit({ rawIcs: true });
export const automationCalendarImportReportSchema =
  calendarImportReportSchema.extend({
    candidates: z.array(automationCalendarImportCandidateSchema).max(10_000),
  });
export const automationCalendarImportSummarySchema = z
  .object({
    id: entityIdSchema,
    calendarId: entityIdSchema,
    calendarName: z.string().nullable(),
    source: calendarImportSourceSchema,
    inputHash: z.string().regex(/^[a-f0-9]{64}$/),
    state: z.enum(["previewed", "applied", "partial"]),
    createdAt: z.iso.datetime(),
    appliedAt: z.iso.datetime().nullable(),
    totals: calendarImportReportSchema.shape.totals,
    itemCounts: z
      .object({
        pending: z.number().int().nonnegative(),
        applied: z.number().int().nonnegative(),
        reconciliationRequired: z.number().int().nonnegative(),
        skipped: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();
export const automationCalendarImportJobSchema =
  automationCalendarImportSummarySchema
    .extend({
      report: automationCalendarImportReportSchema,
      items: z.array(calendarImportItemSchema),
    })
    .strict();
export const automationCalendarImportResourceInputSchema = z
  .object({ jobId: entityIdSchema.optional() })
  .strict();
export const automationTaskImportProvenanceSchema = z
  .object({
    entityKind: z.string().min(1).max(100),
    count: z.number().int().nonnegative(),
    lastImportedAt: z.iso.datetime(),
  })
  .strict();
export const automationCalendarImportResourceSchema = z
  .object({
    jobs: z.array(automationCalendarImportSummarySchema),
    job: automationCalendarImportJobSchema.nullable(),
    superProductivity: z
      .object({
        lastImportedAt: z.iso.datetime().nullable(),
        entities: z.array(automationTaskImportProvenanceSchema),
      })
      .strict(),
  })
  .strict();
export const automationCalendarImportApplyInputSchema = z
  .object({
    jobId: entityIdSchema,
    expectedInputHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export const automationCalendarImportApplyResponseSchema = z
  .object({ job: automationCalendarImportJobSchema, replayed: z.boolean() })
  .strict();

export const automationCalendarFeedSchema = calendarFeedCapabilitySchema
  .extend({ calendarName: z.string().nullable(), active: z.boolean() })
  .strict();
export const automationCalendarPublicationSchema = z
  .object({
    calendarId: entityIdSchema,
    displayName: z.string().min(1),
    providerKind: calendarProviderKindSchema,
    publishedEvents: z.number().int().nonnegative(),
    activeFeeds: z.number().int().nonnegative(),
  })
  .strict();
export const automationCalendarFeedResourceSchema = z
  .object({
    feeds: z.array(automationCalendarFeedSchema),
    calendars: z.array(automationCalendarPublicationSchema),
  })
  .strict();
export const automationCalendarFeedRevokeInputSchema = z
  .object({ feedId: entityIdSchema })
  .strict();
export const automationCalendarFeedRevocationResponseSchema = z
  .object({ feed: automationCalendarFeedSchema })
  .strict();

export const automationTokenScopeSchema = z.enum([
  "notifications:test",
  "notifications:read",
  "notifications:write",
  "planning:write",
  // Application preferences and shortcuts (ADR 0030).
  "application:read",
  "application:write",
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
  "metrics:read",
  "metrics:write",
  // Imported plugin data (ADR 0026): listing only, never the data itself.
  "plugin_data:read",
  // Import, publication and connector recovery (ADR 0038). Reads never
  // return a secret; recover retries with the stored grant only.
  "connectors:read",
  "connectors:recover",
  "imports:read",
  "imports:write",
  "publication:read",
  "publication:write",
  // Calendar bridge review (ADR 0044): status reads, deletion decisions and
  // conflict resolution. Mapping creation, pause, removal and passes stay
  // owner-only.
  "calendar_bridge:read",
  "calendar_bridge:review",
]);

/**
 * ADR 0035: the owner chooses at issuance whether a token may apply an
 * ordinary edit in the preview call (`execute_ordinary`) or must always call
 * `automation.confirm` (`confirm_all`). Consequential operations always need
 * the separate confirmation whatever the token policy. Like scopes, the policy
 * is immutable; changing it is revoke-and-reissue.
 */
export const automationTokenConfirmationPolicySchema = z.enum([
  "confirm_all",
  "execute_ordinary",
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
    confirmationPolicy: automationTokenConfirmationPolicySchema,
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
    confirmationPolicy:
      automationTokenConfirmationPolicySchema.default("confirm_all"),
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
  "application.update_preferences",
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
  "tasks.create_many",
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
  "counters.mutate",
  "counters.record",
  "evaluations.write",
  "day_order.reorder",
  "boards.mutate",
  "sections.mutate",
  "task_views.set",
  "menu_folders.mutate",
  // Read-only iCal subscriptions (ADR 0032): add/remove stay owner-only.
  "calendar_subscriptions.refresh",
  "calendar_subscriptions.convert_event",
  "calendar_subscriptions.hide_event",
  // ADR 0038: apply an owner-previewed import, revoke a feed, retry a sync.
  "imports.apply",
  "calendar_feeds.revoke",
  "connectors.resync",
  // ADR 0044: revision-bound bridge review decisions.
  "calendar_bridge.decide_deletion",
  "calendar_bridge.resolve_conflict",
  "schedule.create_time_block",
  // ADR 0037: move and remove an existing block with the task revision.
  "schedule.move_time_block",
  "schedule.remove_time_block",
  "focus.start",
  "focus.pause",
  "focus.resume",
  "focus.start_break",
  "focus.end_break",
  "focus.complete",
  "focus.takeover",
  // ADR 0029: revision-bound preferences and idle disposition.
  "focus.update_preferences",
  "focus.idle_disposition",
  "templates.instantiate",
  "template_sets.instantiate",
  "placeholders.resolve",
  // ADR 0036: authoring of the reusable work library and choice pools.
  "templates.mutate",
  "template_sets.create",
  "pools.mutate",
  "placeholders.create",
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
      operation: z.literal("application.update_preferences"),
      input: applicationPreferenceMutationInputSchema,
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
      operation: z.literal("counters.mutate"),
      input: automationCounterMutationInputSchema,
    }),
    z.object({
      operation: z.literal("counters.record"),
      input: automationCounterRecordInputSchema,
    }),
    z.object({
      operation: z.literal("evaluations.write"),
      input: automationEvaluationWriteInputSchema,
    }),
    z.object({
      operation: z.literal("day_order.reorder"),
      input: automationDayOrderReorderInputSchema,
    }),
    z.object({
      operation: z.literal("boards.mutate"),
      input: automationBoardMutationInputSchema,
    }),
    z.object({
      operation: z.literal("sections.mutate"),
      input: automationSectionMutationInputSchema,
    }),
    z.object({
      operation: z.literal("task_views.set"),
      input: taskViewSetRequestSchema,
    }),
    z.object({
      operation: z.literal("menu_folders.mutate"),
      input: automationMenuFolderMutationInputSchema,
    }),
    z.object({
      operation: z.literal("focus.update_preferences"),
      input: focusPreferenceMutationInputSchema,
    }),
    z.object({
      operation: z.literal("focus.idle_disposition"),
      input: focusIdleDispositionInputSchema,
    }),
    z.object({
      operation: z.literal("calendar_subscriptions.refresh"),
      input: automationCalendarSubscriptionRefreshInputSchema,
    }),
    z.object({
      operation: z.literal("calendar_subscriptions.convert_event"),
      input: automationCalendarSubscriptionEventInputSchema,
    }),
    z.object({
      operation: z.literal("calendar_subscriptions.hide_event"),
      input: automationCalendarSubscriptionHideInputSchema,
    }),
    z.object({
      operation: z.literal("imports.apply"),
      input: automationCalendarImportApplyInputSchema,
    }),
    z.object({
      operation: z.literal("calendar_feeds.revoke"),
      input: automationCalendarFeedRevokeInputSchema,
    }),
    z.object({
      operation: z.literal("connectors.resync"),
      input: automationConnectorResyncInputSchema,
    }),
    z.object({
      operation: z.literal("calendar_bridge.decide_deletion"),
      input: automationCalendarBridgeDeletionInputSchema,
    }),
    z.object({
      operation: z.literal("calendar_bridge.resolve_conflict"),
      input: automationCalendarBridgeResolveInputSchema,
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
      operation: z.literal("tasks.create_many"),
      input: taskBatchCreateRequestSchema,
    }),
    z.object({
      operation: z.literal("schedule.create_time_block"),
      input: z
        .object({ taskId: entityIdSchema })
        .extend(createTaskTimeBlockRequestSchema.shape),
    }),
    z.object({
      operation: z.literal("schedule.move_time_block"),
      input: automationTimeBlockMoveInputSchema,
    }),
    z.object({
      operation: z.literal("schedule.remove_time_block"),
      input: automationTimeBlockRemoveInputSchema,
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
    z.object({
      operation: z.literal("templates.mutate"),
      input: automationTemplateMutationInputSchema,
    }),
    z.object({
      operation: z.literal("template_sets.create"),
      input: automationTemplateSetCreateInputSchema,
    }),
    z.object({
      operation: z.literal("pools.mutate"),
      input: automationChoicePoolMutationInputSchema,
    }),
    z.object({
      operation: z.literal("placeholders.create"),
      input: automationPlaceholderCreateInputSchema,
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

const automationToolCommandSchema = (
  operation: z.infer<typeof automationOperationSchema>,
): z.ZodObject => {
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
  if (operation === "application.update_preferences")
    return z.object({
      operation: z.literal(operation),
      input: applicationPreferenceMutationInputSchema,
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
  if (operation === "counters.mutate")
    return z.object({
      operation: z.literal(operation),
      input: automationCounterMutationInputSchema,
    });
  if (operation === "counters.record")
    return z.object({
      operation: z.literal(operation),
      input: automationCounterRecordInputSchema,
    });
  if (operation === "evaluations.write")
    return z.object({
      operation: z.literal(operation),
      input: automationEvaluationWriteInputSchema,
    });
  if (operation === "day_order.reorder")
    return z.object({
      operation: z.literal(operation),
      input: automationDayOrderReorderInputSchema,
    });
  if (operation === "boards.mutate")
    return z.object({
      operation: z.literal(operation),
      input: automationBoardMutationInputSchema,
    });
  if (operation === "sections.mutate")
    return z.object({
      operation: z.literal(operation),
      input: automationSectionMutationInputSchema,
    });
  if (operation === "task_views.set")
    return z.object({
      operation: z.literal(operation),
      input: taskViewSetRequestSchema,
    });
  if (operation === "menu_folders.mutate")
    return z.object({
      operation: z.literal(operation),
      input: automationMenuFolderMutationInputSchema,
    });
  if (operation === "focus.update_preferences")
    return z.object({
      operation: z.literal(operation),
      input: focusPreferenceMutationInputSchema,
    });
  if (operation === "focus.idle_disposition")
    return z.object({
      operation: z.literal(operation),
      input: focusIdleDispositionInputSchema,
    });
  if (operation === "calendar_subscriptions.refresh")
    return z.object({
      operation: z.literal(operation),
      input: automationCalendarSubscriptionRefreshInputSchema,
    });
  if (operation === "calendar_subscriptions.convert_event")
    return z.object({
      operation: z.literal(operation),
      input: automationCalendarSubscriptionEventInputSchema,
    });
  if (operation === "calendar_subscriptions.hide_event")
    return z.object({
      operation: z.literal(operation),
      input: automationCalendarSubscriptionHideInputSchema,
    });
  if (operation === "imports.apply")
    return z.object({
      operation: z.literal(operation),
      input: automationCalendarImportApplyInputSchema,
    });
  if (operation === "calendar_feeds.revoke")
    return z.object({
      operation: z.literal(operation),
      input: automationCalendarFeedRevokeInputSchema,
    });
  if (operation === "connectors.resync")
    return z.object({
      operation: z.literal(operation),
      input: automationConnectorResyncInputSchema,
    });
  if (operation === "calendar_bridge.decide_deletion")
    return z.object({
      operation: z.literal(operation),
      input: automationCalendarBridgeDeletionInputSchema,
    });
  if (operation === "calendar_bridge.resolve_conflict")
    return z.object({
      operation: z.literal(operation),
      input: automationCalendarBridgeResolveInputSchema,
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
  if (operation === "tasks.create_many")
    return z.object({
      operation: z.literal("tasks.create_many"),
      input: taskBatchCreateRequestSchema,
    });
  if (operation === "schedule.create_time_block")
    return z.object({
      operation: z.literal("schedule.create_time_block"),
      input: z
        .object({ taskId: entityIdSchema })
        .extend(createTaskTimeBlockRequestSchema.shape),
    });
  if (operation === "schedule.move_time_block")
    return z.object({
      operation: z.literal("schedule.move_time_block"),
      input: automationTimeBlockMoveInputSchema,
    });
  if (operation === "schedule.remove_time_block")
    return z.object({
      operation: z.literal("schedule.remove_time_block"),
      input: automationTimeBlockRemoveInputSchema,
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
  if (operation === "templates.mutate")
    return z.object({
      operation: z.literal("templates.mutate"),
      input: automationTemplateMutationInputSchema,
    });
  if (operation === "template_sets.create")
    return z.object({
      operation: z.literal("template_sets.create"),
      input: automationTemplateSetCreateInputSchema,
    });
  if (operation === "pools.mutate")
    return z.object({
      operation: z.literal("pools.mutate"),
      input: automationChoicePoolMutationInputSchema,
    });
  if (operation === "placeholders.create")
    return z.object({
      operation: z.literal("placeholders.create"),
      input: automationPlaceholderCreateInputSchema,
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

// ADR 0035: the confirmation policy is declared here, per operation, and
// evaluated against the exact command. Servers, adapters and skills read it;
// none keeps a second list.
export const automationConfirmationPolicySchema = z.enum([
  "ordinary",
  "consequential",
]);
export const automationConsequenceCategorySchema = z.enum([
  "bulk",
  "deletion",
  "destructive_replacement",
  "takeover",
  "external_effect",
  "irreversible",
]);
export type AutomationConsequenceCategory = z.infer<
  typeof automationConsequenceCategorySchema
>;

export type AutomationOperationConfirmationRule =
  | { readonly kind: "ordinary" }
  | {
      readonly kind: "consequential";
      readonly category: AutomationConsequenceCategory;
    }
  | {
      readonly kind: "by_action";
      /** Path of the action discriminator inside the operation input. */
      readonly path: readonly string[];
      /** Actions that need explicit approval; every other action is ordinary. */
      readonly consequential: Readonly<
        Record<string, AutomationConsequenceCategory>
      >;
    };
export type AutomationConfirmationRule =
  { readonly kind: "none" } | AutomationOperationConfirmationRule;

/** A preview is the approval artifact; it expires this long after issue. */
export const automationApprovalExpiryMinutes = 5;
/** Declared batch bounds for one previewed action. */
export const automationBatchBounds = {
  createManyTasks: captureBatchMaxTasks,
  affectedRecords: 201,
} as const;

const ordinaryRule = { kind: "ordinary" } as const;
const consequentialRule = (category: AutomationConsequenceCategory) =>
  ({ kind: "consequential", category }) as const;
const byActionRule = (
  path: readonly string[],
  consequential: Readonly<Record<string, AutomationConsequenceCategory>>,
) => ({ kind: "by_action", path, consequential }) as const;
const deleteAction = { delete: "deletion" } as const;

export const automationConfirmationRules: Readonly<
  Record<
    z.infer<typeof automationOperationSchema>,
    AutomationOperationConfirmationRule
  >
> = {
  "planning.update_preferences": ordinaryRule,
  "application.update_preferences": ordinaryRule,
  "notifications.send_test": consequentialRule("external_effect"),
  "notifications.update_preferences": ordinaryRule,
  "subtasks.mutate": byActionRule(["command", "action"], deleteAction),
  "projects.mutate": ordinaryRule,
  "projects.reorder": ordinaryRule,
  "projects.set_backlog": ordinaryRule,
  "tags.mutate": ordinaryRule,
  "tags.reorder": ordinaryRule,
  "notes.mutate": byActionRule(["action"], deleteAction),
  "task_links.mutate": byActionRule(["action"], {
    remove_attachment: "deletion",
    remove_issue_link: "deletion",
  }),
  "tasks.assign_project": ordinaryRule,
  "tasks.set_tags": consequentialRule("destructive_replacement"),
  "tasks.hierarchy": ordinaryRule,
  "tasks.create": ordinaryRule,
  "tasks.create_many": consequentialRule("bulk"),
  "tasks.update": ordinaryRule,
  "tasks.set_completed": ordinaryRule,
  "tasks.delete": consequentialRule("deletion"),
  "tasks.restore": ordinaryRule,
  "tasks.archive": ordinaryRule,
  "tasks.unarchive": ordinaryRule,
  "recurrence.create": ordinaryRule,
  "recurrence.update": ordinaryRule,
  "recurrence.set_state": byActionRule(["action"], { end: "irreversible" }),
  "recurrence.occurrence": byActionRule(["action"], {
    delete_instance: "deletion",
  }),
  "time_entries.mutate": byActionRule(["action"], deleteAction),
  "counters.mutate": byActionRule(["action"], deleteAction),
  "counters.record": ordinaryRule,
  "evaluations.write": ordinaryRule,
  "day_order.reorder": ordinaryRule,
  "boards.mutate": byActionRule(["action"], deleteAction),
  "sections.mutate": byActionRule(["action"], deleteAction),
  "task_views.set": ordinaryRule,
  "menu_folders.mutate": byActionRule(["action"], deleteAction),
  "calendar_subscriptions.refresh": ordinaryRule,
  "calendar_subscriptions.convert_event": ordinaryRule,
  "calendar_subscriptions.hide_event": ordinaryRule,
  "schedule.create_time_block": ordinaryRule,
  // #58: moving a block is one revision-checked edit, like creating it;
  // removing it deletes the calendar event.
  "schedule.move_time_block": ordinaryRule,
  "schedule.remove_time_block": consequentialRule("deletion"),
  // #60: an import writes many events; revoking a feed breaks every
  // subscriber's address and cannot be undone. A resync only reads.
  "imports.apply": consequentialRule("bulk"),
  "calendar_feeds.revoke": consequentialRule("irreversible"),
  "connectors.resync": ordinaryRule,
  // #48: approving lets the next pass delete the other copy; keeping writes
  // nothing. A resolution overwrites or deletes the other side's version.
  "calendar_bridge.decide_deletion": byActionRule(["decision"], {
    approve: "deletion",
  }),
  "calendar_bridge.resolve_conflict": consequentialRule(
    "destructive_replacement",
  ),
  // #57: an update replaces the pool's whole item list, like tasks.set_tags.
  "templates.mutate": ordinaryRule,
  "template_sets.create": ordinaryRule,
  "pools.mutate": byActionRule(["action"], {
    update: "destructive_replacement",
  }),
  "placeholders.create": ordinaryRule,
  "focus.start": ordinaryRule,
  "focus.pause": ordinaryRule,
  "focus.resume": ordinaryRule,
  "focus.start_break": ordinaryRule,
  "focus.end_break": ordinaryRule,
  "focus.complete": ordinaryRule,
  "focus.takeover": consequentialRule("takeover"),
  "focus.update_preferences": ordinaryRule,
  "focus.idle_disposition": ordinaryRule,
  "templates.instantiate": ordinaryRule,
  "template_sets.instantiate": consequentialRule("bulk"),
  "placeholders.resolve": ordinaryRule,
  "habits.mutate": ordinaryRule,
};

export const automationCommandClassificationSchema = z
  .object({
    policy: automationConfirmationPolicySchema,
    category: automationConsequenceCategorySchema.nullable(),
    action: z.string().max(64).nullable(),
  })
  .strict();
export type AutomationCommandClassification = z.infer<
  typeof automationCommandClassificationSchema
>;

const actionAt = (input: unknown, path: readonly string[]): string | null => {
  let current: unknown = input;
  for (const key of path) {
    if (typeof current !== "object" || current === null) return null;
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === "string" ? current : null;
};

/** The only classifier: the policy the exact command falls under. */
export const classifyAutomationCommand = (command: {
  readonly operation: z.infer<typeof automationOperationSchema>;
  readonly input: unknown;
}): AutomationCommandClassification => {
  const rule = automationConfirmationRules[command.operation];
  switch (rule.kind) {
    case "ordinary":
      return { policy: "ordinary", category: null, action: null };
    case "consequential":
      return { policy: "consequential", category: rule.category, action: null };
    case "by_action": {
      const action = actionAt(command.input, rule.path);
      const category = action === null ? undefined : rule.consequential[action];
      return category === undefined
        ? { policy: "ordinary", category: null, action }
        : { policy: "consequential", category, action };
    }
  }
};

/**
 * ADR 0035: a preview request may ask the server to apply an ordinary command
 * in the same call. It is honoured only when the command classifies as
 * ordinary and the token policy is `execute_ordinary`; otherwise the server
 * answers AUTOMATION_CONFIRMATION_REQUIRED and the preview stays confirmable.
 */
export const automationPreviewExecuteSchema = z
  .object({ idempotencyKey: idempotencyKeySchema })
  .strict();

const automationToolInputSchema = (
  operation: z.infer<typeof automationOperationSchema>,
): z.ZodType => {
  const command = automationToolCommandSchema(operation);
  // A consequential tool rejects `execute` outright instead of stripping it.
  return automationConfirmationRules[operation].kind === "consequential"
    ? command.strict()
    : command.extend({ execute: automationPreviewExecuteSchema.optional() });
};

export const automationAffectedEntitySchema = z
  .object({
    entityKind: z.enum([
      "planning_preferences",
      "notification_preferences",
      "focus_preferences",
      "application_preferences",
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
      "counter",
      "daily_evaluation",
      "board",
      "section",
      "task_view",
      "menu_folder",
      // ADR 0038: unrevisioned records; confirmation repeats the state check.
      "calendar_import",
      "calendar_feed",
      "connector",
      // ADR 0044: confirmation repeats the link revision check in the store.
      "calendar_bridge_mapping",
      "calendar_bridge_link",
      "calendar_bridge_conflict",
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
      "counter",
      "daily_evaluation",
      "board",
      "section",
      "menu_folder",
    ]),
    entityId: entityIdSchema,
    revision: revisionSchema,
  })
  .strict();

export const automationBaseRevisionSchema = z.union([
  existingAutomationBaseRevisionSchema,
  z
    .object({
      entityKind: z.enum([
        "planning_preferences",
        "notification_preferences",
        "focus_preferences",
        "application_preferences",
      ]),
      entityId: entityIdSchema,
      revision: z.number().int().nonnegative(),
    })
    .strict(),
]);

/** ADR 0035: what the preview needs before it may be applied. */
export const automationPreviewConfirmationSchema = z
  .object({
    policy: automationConfirmationPolicySchema,
    category: automationConsequenceCategorySchema.nullable(),
    tokenPolicy: automationTokenConfirmationPolicySchema,
  })
  .strict();

export const automationPreviewSchema = z
  .object({
    id: entityIdSchema,
    operation: automationOperationSchema,
    inputHash: z.string().regex(/^[a-f0-9]{64}$/),
    summary: z.string().trim().min(1).max(1_000),
    affected: z
      .array(automationAffectedEntitySchema)
      .max(automationBatchBounds.affectedRecords),
    baseRevisions: z
      .array(automationBaseRevisionSchema)
      .max(automationBatchBounds.affectedRecords),
    expiresAt: z.iso.datetime(),
    confirmation: automationPreviewConfirmationSchema,
    // False only when the same request already applied the command.
    requiresConfirmation: z.boolean(),
  })
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

/** ADR 0032: the task made from a subscribed event; replayed when it existed. */
export const calendarSubscriptionConversionResponseSchema = z
  .object({
    task: taskSchema,
    event: calendarSubscriptionEventSchema,
    replayed: z.boolean(),
  })
  .strict();

export const automationExecutionResultSchema = z.union([
  notificationTestQueuedSchema,
  automationCalendarImportApplyResponseSchema,
  automationCalendarFeedRevocationResponseSchema,
  automationConnectorResyncResponseSchema,
  // ADR 0044: the decided link, or the enqueued resolution write.
  z.object({ link: calendarBridgeLinkSchema }).strict(),
  z.object({ operation: calendarBridgeOperationSchema }).strict(),
  calendarSubscriptionRefreshResponseSchema,
  calendarSubscriptionEventMutationResponseSchema,
  calendarSubscriptionConversionResponseSchema,
  z.object({ planningPreferences: planningPreferenceSnapshotSchema }).strict(),
  z
    .object({ applicationPreferences: applicationPreferenceSnapshotSchema })
    .strict(),
  z
    .object({ notificationPreferences: notificationPreferenceSnapshotSchema })
    .strict(),
  checklistMutationResponseSchema,
  taskHierarchyMutationResponseSchema,
  taskArchiveMutationResponseSchema,
  recurringSeriesMutationResponseSchema,
  timeEntryMutationResponseSchema,
  counterMutationResponseSchema,
  evaluationMutationResponseSchema,
  dayOrderResponseSchema,
  boardMutationResponseSchema,
  sectionMutationResponseSchema,
  taskViewResponseSchema,
  menuFolderMutationResponseSchema,
  z.object({ focusPreferences: focusPreferenceSnapshotSchema }).strict(),
  focusIdleResponseSchema,
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
  taskBatchMutationResponseSchema,
  templateInstantiationResponseSchema,
  templateMutationResponseSchema,
  templateSetMutationResponseSchema,
  choicePoolMutationResponseSchema,
  planningPlaceholderMutationResponseSchema,
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

export const automationPreviewResponseSchema = z
  .object({
    preview: automationPreviewSchema,
    // Present only when an ordinary command was applied in the preview call.
    executed: automationConfirmationResponseSchema.optional(),
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
  /** ADR 0035: the declared confirmation rule; `none` for reads and confirm. */
  readonly confirmation: AutomationConfirmationRule;
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
    confirmation: { kind: "none" },
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
    confirmation: { kind: "none" },
    apiPath: "/api/automation/v1/resources/planning-preferences",
    mcpName: "suite.planning.preferences",
    mcpUri: "suite://v1/planning-preferences",
    inputSchema: z.object({}).strict(),
    outputSchema: planningPreferenceSnapshotSchema,
  },
  {
    id: "application.preferences",
    kind: "resource",
    scopes: ["application:read"],
    confirmationRequired: false,
    confirmation: { kind: "none" },
    apiPath: "/api/automation/v1/resources/application-preferences",
    mcpName: "suite.application.preferences",
    mcpUri: "suite://v1/application-preferences",
    inputSchema: z.object({}).strict(),
    outputSchema: applicationPreferenceSnapshotSchema,
  },
  {
    id: "notifications.preferences",
    kind: "resource",
    scopes: ["notifications:read"],
    confirmationRequired: false,
    confirmation: { kind: "none" },
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
    confirmation: { kind: "none" },
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
    confirmation: { kind: "none" },
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
    confirmation: { kind: "none" },
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
    confirmation: { kind: "none" },
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
    confirmation: { kind: "none" },
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
    confirmation: { kind: "none" },
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
    confirmation: { kind: "none" },
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
    confirmation: { kind: "none" },
    apiPath: "/api/automation/v1/resources/recurrence",
    mcpName: "suite.recurrence.list",
    mcpUri: "suite://v1/recurrence",
    inputSchema: z.object({}).strict(),
    outputSchema: recurringSeriesListResponseSchema,
  },
  {
    id: "time.report",
    kind: "resource",
    scopes: ["tasks:read"],
    confirmationRequired: false,
    confirmation: { kind: "none" },
    apiPath: "/api/automation/v1/resources/time-report",
    mcpName: "suite.time.report",
    mcpUri: "suite://v1/time-report{?from,to}",
    inputSchema: timeReportQuerySchema,
    outputSchema: timeReportResponseSchema,
  },
  {
    id: "counters.history",
    kind: "resource",
    scopes: ["metrics:read"],
    confirmationRequired: false,
    confirmation: { kind: "none" },
    apiPath: "/api/automation/v1/resources/counters",
    mcpName: "suite.counters.history",
    mcpUri: "suite://v1/counters{?from,to}",
    inputSchema: counterHistoryQuerySchema,
    outputSchema: counterHistoryResponseSchema,
  },
  {
    id: "evaluations.list",
    kind: "resource",
    scopes: ["metrics:read"],
    confirmationRequired: false,
    confirmation: { kind: "none" },
    apiPath: "/api/automation/v1/resources/evaluations",
    mcpName: "suite.evaluations.list",
    mcpUri: "suite://v1/evaluations{?from,to}",
    inputSchema: evaluationListQuerySchema,
    outputSchema: evaluationListResponseSchema,
  },
  {
    id: "day_order.get",
    kind: "resource",
    scopes: ["tasks:read"],
    confirmationRequired: false,
    confirmation: { kind: "none" },
    apiPath: "/api/automation/v1/resources/day-order",
    mcpName: "suite.day_order.get",
    mcpUri: "suite://v1/day-order{?date}",
    inputSchema: dayOrderResourceInputSchema,
    outputSchema: dayOrderResponseSchema,
  },
  {
    id: "boards.list",
    kind: "resource",
    scopes: ["tasks:read"],
    confirmationRequired: false,
    confirmation: { kind: "none" },
    apiPath: "/api/automation/v1/resources/boards",
    mcpName: "suite.boards.list",
    mcpUri: "suite://v1/boards{?boardId}",
    inputSchema: automationBoardsResourceInputSchema,
    outputSchema: automationBoardsResourceSchema,
  },
  {
    id: "sections.list",
    kind: "resource",
    scopes: ["tasks:read"],
    confirmationRequired: false,
    confirmation: { kind: "none" },
    apiPath: "/api/automation/v1/resources/sections",
    mcpName: "suite.sections.list",
    mcpUri: "suite://v1/sections{?contextKind,contextId}",
    inputSchema: automationSectionsResourceInputSchema,
    outputSchema: sectionListResponseSchema,
  },
  {
    id: "task_views.list",
    kind: "resource",
    scopes: ["tasks:read"],
    confirmationRequired: false,
    confirmation: { kind: "none" },
    apiPath: "/api/automation/v1/resources/task-views",
    mcpName: "suite.task_views.list",
    mcpUri: "suite://v1/task-views",
    inputSchema: z.object({}).strict(),
    outputSchema: taskViewListResponseSchema,
  },
  {
    id: "menu_folders.list",
    kind: "resource",
    scopes: ["tasks:read"],
    confirmationRequired: false,
    confirmation: { kind: "none" },
    apiPath: "/api/automation/v1/resources/menu-folders",
    mcpName: "suite.menu_folders.list",
    mcpUri: "suite://v1/menu-folders",
    inputSchema: z.object({}).strict(),
    outputSchema: menuFolderListResponseSchema,
  },
  {
    id: "focus.preferences",
    kind: "resource",
    scopes: ["focus:read"],
    confirmationRequired: false,
    confirmation: { kind: "none" },
    apiPath: "/api/automation/v1/resources/focus-preferences",
    mcpName: "suite.focus.preferences",
    mcpUri: "suite://v1/focus-preferences",
    inputSchema: z.object({}).strict(),
    outputSchema: focusPreferenceSnapshotSchema,
  },
  {
    id: "calendar_subscriptions.list",
    kind: "resource",
    scopes: ["schedule:read"],
    confirmationRequired: false,
    confirmation: { kind: "none" },
    apiPath: "/api/automation/v1/resources/calendar-subscriptions",
    mcpName: "suite.calendar_subscriptions.list",
    mcpUri: "suite://v1/calendar-subscriptions{?from,to}",
    inputSchema: calendarSubscriptionResourceInputSchema,
    outputSchema: calendarSubscriptionResourceSchema,
  },
  {
    id: "connectors.status",
    kind: "resource",
    scopes: ["connectors:read"],
    confirmationRequired: false,
    confirmation: { kind: "none" },
    apiPath: "/api/automation/v1/resources/connectors",
    mcpName: "suite.connectors.status",
    mcpUri: "suite://v1/connectors",
    inputSchema: z.object({}).strict(),
    outputSchema: automationConnectorStatusResourceSchema,
  },
  {
    id: "imports.list",
    kind: "resource",
    scopes: ["imports:read"],
    confirmationRequired: false,
    confirmation: { kind: "none" },
    apiPath: "/api/automation/v1/resources/imports",
    mcpName: "suite.imports.list",
    mcpUri: "suite://v1/imports{?jobId}",
    inputSchema: automationCalendarImportResourceInputSchema,
    outputSchema: automationCalendarImportResourceSchema,
  },
  {
    id: "calendar_bridge.status",
    kind: "resource",
    scopes: ["calendar_bridge:read"],
    confirmationRequired: false,
    confirmation: { kind: "none" },
    apiPath: "/api/automation/v1/resources/calendar-bridge",
    mcpName: "suite.calendar_bridge.status",
    mcpUri: "suite://v1/calendar-bridge{?mappingId}",
    inputSchema: automationCalendarBridgeResourceInputSchema,
    outputSchema: automationCalendarBridgeResourceSchema,
  },
  {
    id: "calendar_feeds.list",
    kind: "resource",
    scopes: ["publication:read"],
    confirmationRequired: false,
    confirmation: { kind: "none" },
    apiPath: "/api/automation/v1/resources/calendar-feeds",
    mcpName: "suite.calendar_feeds.list",
    mcpUri: "suite://v1/calendar-feeds",
    inputSchema: z.object({}).strict(),
    outputSchema: automationCalendarFeedResourceSchema,
  },
  {
    id: "schedule.get",
    kind: "resource",
    scopes: ["schedule:read"],
    confirmationRequired: false,
    confirmation: { kind: "none" },
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
    confirmation: { kind: "none" },
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
    confirmation: { kind: "none" },
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
    confirmation: { kind: "none" },
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
    confirmation: { kind: "none" },
    apiPath: "/api/automation/v1/resources/task-links",
    mcpName: "suite.task_links.get",
    mcpUri: "suite://v1/task-links{?taskId}",
    inputSchema: taskLinksResourceInputSchema,
    outputSchema: taskLinksResponseSchema,
  },
  {
    id: "plugin_data.list",
    kind: "resource",
    scopes: ["plugin_data:read"],
    confirmationRequired: false,
    confirmation: { kind: "none" },
    apiPath: "/api/automation/v1/resources/plugin-data",
    mcpName: "suite.plugin_data.list",
    mcpUri: "suite://v1/plugin-data",
    inputSchema: z.object({}).strict(),
    outputSchema: pluginDataListResponseSchema,
  },
  {
    id: "active-session.get",
    kind: "resource",
    scopes: ["focus:read"],
    confirmationRequired: false,
    confirmation: { kind: "none" },
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
    confirmation: { kind: "none" },
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
    confirmation: { kind: "none" },
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
    confirmation: { kind: "none" },
    apiPath: "/api/automation/v1/resources/pools",
    mcpName: "suite.pools.list",
    mcpUri: "suite://v1/pools",
    inputSchema: z.object({}).strict(),
    outputSchema: automationChoicePoolResourceSchema,
  },
  {
    // ADR 0036: pool policy evaluated for one placeholder at a logical time.
    id: "placeholders.suggestion",
    kind: "resource",
    scopes: ["pools:read"],
    confirmationRequired: false,
    confirmation: { kind: "none" },
    apiPath: "/api/automation/v1/resources/placeholder-suggestion",
    mcpName: "suite.placeholders.suggestion",
    mcpUri: "suite://v1/placeholder-suggestion",
    inputSchema: automationPlaceholderSuggestionInputSchema,
    outputSchema: choicePoolSuggestionResponseSchema,
  },
  ...automationOperationSchema.options.map((id) => ({
    id,
    kind: "tool" as const,
    scopes: [
      id.startsWith("calendar_bridge.")
        ? "calendar_bridge:review"
        : id === "imports.apply"
          ? "imports:write"
          : id === "calendar_feeds.revoke"
            ? "publication:write"
            : id === "connectors.resync"
              ? "connectors:recover"
              : id === "notifications.send_test"
                ? "notifications:test"
                : id === "planning.update_preferences"
                  ? "planning:write"
                  : id === "application.update_preferences"
                    ? "application:write"
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
                                : id.startsWith("counters.") ||
                                    id === "evaluations.write"
                                  ? "metrics:write"
                                  : id.startsWith("tasks.") ||
                                      id.startsWith("recurrence.") ||
                                      id === "subtasks.mutate" ||
                                      id === "time_entries.mutate" ||
                                      id === "day_order.reorder" ||
                                      id === "boards.mutate" ||
                                      id === "sections.mutate" ||
                                      id === "task_views.set" ||
                                      id === "menu_folders.mutate" ||
                                      id ===
                                        "calendar_subscriptions.convert_event"
                                    ? "tasks:write"
                                    : id.startsWith("schedule.") ||
                                        id ===
                                          "calendar_subscriptions.refresh" ||
                                        id ===
                                          "calendar_subscriptions.hide_event"
                                      ? "schedule:write"
                                      : id.startsWith("templates.") ||
                                          id.startsWith("template_sets.")
                                        ? "templates:write"
                                        : id.startsWith("placeholders.") ||
                                            id.startsWith("pools.")
                                          ? "pools:write"
                                          : "focus:write",
    ] as const,
    confirmationRequired: true,
    confirmation: automationConfirmationRules[id],
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
      "application:write",
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
      "metrics:write",
      "imports:write",
      "publication:write",
      "connectors:recover",
      "calendar_bridge:review",
    ],
    confirmationRequired: false,
    confirmation: { kind: "none" },
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
export type BaikalProbeResponse = z.infer<typeof baikalProbeResponseSchema>;
export type CalendarEventIdentity = z.infer<typeof calendarEventIdentitySchema>;
export type Task = z.infer<typeof taskSchema>;
export type CreateTaskRequest = z.infer<typeof createTaskRequestSchema>;
export type TaskBatchCreateRequest = z.input<
  typeof taskBatchCreateRequestSchema
>;
export type TaskBatchMutationResponse = z.infer<
  typeof taskBatchMutationResponseSchema
>;
export type TaskMutationResponse = z.infer<typeof taskMutationResponseSchema>;
export type CalendarSubscriptionConversionResponse = z.infer<
  typeof calendarSubscriptionConversionResponseSchema
>;
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
export type GoogleWriteStatus = z.infer<typeof googleWriteStatusSchema>;
export type GoogleCalendarCapability = z.infer<
  typeof googleCalendarCapabilitySchema
>;
export type GoogleWriteRefusal = z.infer<typeof googleWriteRefusalSchema>;
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
export type AutomationTemplateMutationInput = z.infer<
  typeof automationTemplateMutationInputSchema
>;
export type AutomationChoicePoolMutationInput = z.infer<
  typeof automationChoicePoolMutationInputSchema
>;
export type TemplateMutationResponse = z.infer<
  typeof templateMutationResponseSchema
>;
export type ChoicePoolMutationResponse = z.infer<
  typeof choicePoolMutationResponseSchema
>;
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
export type AutomationTokenConfirmationPolicy = z.infer<
  typeof automationTokenConfirmationPolicySchema
>;
export type AutomationPreviewExecute = z.infer<
  typeof automationPreviewExecuteSchema
>;
export type CreateAutomationTokenRequest = z.infer<
  typeof createAutomationTokenRequestSchema
>;
export type CreateAutomationTokenResponse = z.infer<
  typeof createAutomationTokenResponseSchema
>;
export type AutomationOperation = z.infer<typeof automationOperationSchema>;
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

export type SyncEntityKind = z.infer<typeof syncEntityKindSchema>;

/** The cached record an operation writes (ADR 0033, 0046); habits are separate. */
export const syncOperationEntity = (
  operation: SyncOperation,
): {
  readonly entityKind: SyncEntityKind;
  readonly entityId: string;
} | null => {
  switch (operation.kind) {
    case "task.create":
      return { entityKind: "task", entityId: operation.task.id };
    case "task.patch":
    case "task.complete":
    case "task.reopen":
    case "task.delete":
    case "task.restore":
    case "task.move":
      return { entityKind: "task", entityId: operation.taskId };
    case "project.create":
      return { entityKind: "project", entityId: operation.project.id };
    case "project.patch":
      return { entityKind: "project", entityId: operation.projectId };
    case "tag.create":
      return { entityKind: "tag", entityId: operation.tag.id };
    case "tag.patch":
      return { entityKind: "tag", entityId: operation.tagId };
    case "subtask.create":
      return { entityKind: "subtask", entityId: operation.subtask.id };
    case "subtask.patch":
    case "subtask.delete":
      return { entityKind: "subtask", entityId: operation.subtaskId };
    case "note.create":
      return { entityKind: "note", entityId: operation.note.id };
    case "note.patch":
    case "note.delete":
      return { entityKind: "note", entityId: operation.noteId };
    default:
      return null;
  }
};

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
    /** Counters and daily evaluations (ADR 0025). */
    counters: z
      .object({
        definitions: z.number().int().nonnegative(),
        dayValues: z.number().int().nonnegative(),
        clickCount: z.number().int().nonnegative(),
        stopwatchMs: z.number().int().nonnegative(),
        evaluations: z.number().int().nonnegative(),
        focusSessions: z.number().int().nonnegative(),
        focusSessionMs: z.number().int().nonnegative(),
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
    /** ADR 0025: counters, their day values and daily evaluations. */
    counters: z
      .object({
        created: z.number().int().nonnegative(),
        existing: z.number().int().nonnegative(),
        dayValuesCreated: z.number().int().nonnegative(),
        dayValuesExisting: z.number().int().nonnegative(),
        evaluationsCreated: z.number().int().nonnegative(),
        evaluationsExisting: z.number().int().nonnegative(),
      })
      .strict()
      .optional(),
    /** ADR 0026: opaque plugin data entries and plugin metadata records. */
    pluginData: z
      .object({
        created: z.number().int().nonnegative(),
        existing: z.number().int().nonnegative(),
      })
      .strict()
      .optional(),
    /** ADR 0027: dates whose Today or planner-day order was saved. */
    dayOrders: z.number().int().nonnegative().optional(),
    /** ADR 0028: boards, sections and sidebar folders. */
    boards: z
      .object({
        boards: z.number().int().nonnegative(),
        sections: z.number().int().nonnegative(),
        folders: z.number().int().nonnegative(),
        existing: z.number().int().nonnegative(),
      })
      .strict()
      .optional(),
    /** ADR 0029: focus settings applied on first import, or skipped. */
    focusPreferences: z.enum(["applied", "skipped"]).optional(),
    /** ADR 0030: application and planning settings applied from globalConfig. */
    applicationPreferences: z.number().int().nonnegative().optional(),
  })
  .strict();

export type AutomationConnectorStatusResource = z.infer<
  typeof automationConnectorStatusResourceSchema
>;
export type AutomationRecoveryStep = z.infer<
  typeof automationRecoveryStepSchema
>;
export type AutomationCalendarImportSummary = z.infer<
  typeof automationCalendarImportSummarySchema
>;
export type AutomationCalendarImportJob = z.infer<
  typeof automationCalendarImportJobSchema
>;
export type AutomationCalendarImportResource = z.infer<
  typeof automationCalendarImportResourceSchema
>;
export type AutomationCalendarFeed = z.infer<
  typeof automationCalendarFeedSchema
>;
export type AutomationCalendarFeedResource = z.infer<
  typeof automationCalendarFeedResourceSchema
>;
