import { createReadStream } from "node:fs";
import { extname, sep } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  Task,
  PlannerResponse,
  TaskTemplate,
  TemplateSubtaskBlueprint,
  TemplateSet,
  ChoicePool,
  ChoicePoolItem,
  ChoicePoolHistoryEvent,
  PlanningPlaceholder,
  PlanningPlaceholderResolutionResponse,
  AutomationPreviewCommand,
  AutomationTokenScope,
  Project,
  Tag,
  Note,
  Subtask,
  TemplateInstantiationResponse,
  ActiveSession as ContractActiveSession,
  GoogleWriteRefusal,
} from "@suite/contracts";
import {
  automationCatalog,
  automationTokenConfirmationPolicySchema,
} from "@suite/contracts";
import type {
  SuiteDatabase,
  TaskRecord,
  ProjectRecord,
  TagRecord,
  NoteRecord,
  TemplateInstantiationResult,
  PlanningPlaceholderResolutionResult,
  PlanningPlaceholderResolutionRecord,
  CalendarEventProjectionRecord,
  ActiveSessionRecord,
  ActiveSessionIntervalRecord,
  ActiveSessionEventRecord,
} from "@suite/persistence";
import {
  suggestChoicePool,
  type ActiveSession,
  type SessionClock,
} from "@suite/domain";
import type { AuthService } from "../auth.ts";
import type { ServerConfig } from "../config.ts";
import type { BaikalConnectorService, ConnectorFailure } from "../connector.ts";
import type { GoogleConnectorService } from "../google-connector.ts";
import type { CalendarSubscriptionService } from "../calendar-subscriptions.ts";
import type { CalendarBridgeService } from "../calendar-bridge/service.ts";
import type { CalendarBridgeWorker } from "../calendar-bridge/worker.ts";
import type { ProviderThrottle } from "../calendar-bridge/throttle.ts";
import type { NtfyPublisher } from "../notifications.ts";
import type { LiveSyncService } from "../live-sync/service.ts";
import { mimeTypes, securityHeaders } from "../http-utils.ts";

export type RouteHandler = (
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  ctx: RouteContext,
) => Promise<boolean>;

export interface RouteContext {
  readonly stores: SuiteDatabase;
  readonly auth: AuthService;
  readonly config: ServerConfig;
  readonly baikal: BaikalConnectorService;
  readonly google: GoogleConnectorService;
  /** Read-only iCal subscriptions (ADR 0032). */
  readonly calendarSubscriptions: CalendarSubscriptionService;
  /** Google-Baikal bridge (ADR 0041); passes run only when called. */
  readonly calendarBridge: CalendarBridgeService;
  /** ADR 0043 background worker; undefined when not configured. */
  readonly calendarBridgeWorker?: CalendarBridgeWorker | undefined;
  /** ADR 0043 Google cooldown shared by routes and the worker. */
  readonly googleThrottle?: ProviderThrottle;
  readonly ntfy: NtfyPublisher | undefined;
  readonly sessionClock: SessionClock;
  readonly requestCounts: Map<number, number>;
  readonly triggerNotifications?: () => Promise<void>;
  /** Live sync hint streams (ADR 0045). */
  readonly liveSync: LiveSyncService;
}

export const automationTokenResponse = (token: {
  readonly id: string;
  readonly ownerId: string;
  readonly label: string;
  readonly scopes: readonly string[];
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
  readonly expiresAt: string | null;
  readonly revokedAt: string | null;
  readonly confirmationPolicy: string;
}) => ({
  id: token.id,
  ownerId: token.ownerId,
  label: token.label,
  scopes: token.scopes,
  confirmationPolicy: automationTokenConfirmationPolicySchema.parse(
    token.confirmationPolicy,
  ),
  createdAt: token.createdAt,
  lastUsedAt: token.lastUsedAt,
  expiresAt: token.expiresAt ?? token.createdAt,
  revokedAt: token.revokedAt,
});

export const automationScopeFor = (
  operation: AutomationPreviewCommand["operation"],
): AutomationTokenScope => {
  const entry = automationCatalog.find(({ id }) => id === operation);
  const scope = entry?.scopes[0];
  if (scope === undefined)
    throw new Error(`Automation catalog scope is missing for ${operation}`);
  return scope;
};

export const automationPreviewPath = automationCatalog.find(
  ({ id }) => id === "tasks.create",
)?.apiPath;
export const automationConfirmPath = automationCatalog.find(
  ({ id }) => id === "automation.confirm",
)?.apiPath;
export const automationResourceEntries = automationCatalog.filter(
  (entry) => entry.kind === "resource",
);
export const requiredAutomationResources = [
  "habits.list",
  "tasks.list",
  "schedule.get",
  "projects.list",
  "tags.list",
  "active-session.get",
  "templates.list",
  "template-sets.list",
  "pools.list",
] as const;

if (
  automationPreviewPath === undefined ||
  automationConfirmPath === undefined ||
  requiredAutomationResources.some(
    (id) => !automationResourceEntries.some((entry) => entry.id === id),
  )
)
  throw new Error(
    "Suite automation catalog and HTTP handlers are out of parity",
  );

export const taskResponse = (task: TaskRecord): Task => ({
  id: task.id,
  title: task.title,
  notes: task.notes,
  status: task.status,
  revision: task.revision,
  createdAt: task.createdAt,
  updatedAt: task.updatedAt,
  completedAt: task.completedAt,
  deletedAt: task.deletedAt,
  plannedStart: task.plannedStart,
  plannedDay: task.plannedDay ?? null,
  // The database CHECK limits stored offsets to the contract values.
  startReminder: (task.startReminder ?? { kind: "default" }) as NonNullable<
    Task["startReminder"]
  >,
  deadlineReminder:
    task.deadlineReminderMinutes == null
      ? null
      : {
          minutes: task.deadlineReminderMinutes as NonNullable<
            Task["deadlineReminder"]
          >["minutes"],
        },
  deadline:
    task.deadlineDate == null
      ? task.deadlineAt == null
        ? null
        : { kind: "instant", value: task.deadlineAt }
      : { kind: "date", value: task.deadlineDate },
  estimateMinutes: task.estimateMinutes,
  projectId: task.projectId ?? null,
  tagIds: [...(task.tagIds ?? [])],
  parentId: task.parentId ?? null,
  childPosition: task.childPosition ?? null,
  // ADR 0022: only archived history carries archivedAt.
  ...(task.archivedAt == null ? {} : { archivedAt: task.archivedAt }),
  // ADR 0023: recurring instances name their series and occurrence date.
  recurrence:
    task.recurrence == null
      ? null
      : {
          seriesId: task.recurrence.seriesId,
          occurrenceDate: task.recurrence.occurrenceDate,
        },
});

export const calendarEventResponse = (
  event: CalendarEventProjectionRecord,
  linkedTaskId?: string,
): PlannerResponse["events"][number] => ({
  identity: {
    providerId: event.providerId,
    calendarId: event.calendarId,
    eventId: event.href,
  },
  href: event.href,
  uid: event.uid,
  etag: event.etag,
  summary: event.summary,
  startsAt: event.startsAt,
  endsAt: event.endsAt,
  allDay: event.allDay,
  ...(linkedTaskId === undefined ? {} : { linkedTaskId }),
  recurrence: event.recurrence ?? "none",
  projectedAt: event.projectedAt,
  source: {
    providerKind: event.providerKind ?? "caldav",
    providerDisplayLabel: event.providerDisplayLabel ?? "CalDAV",
    calendarName: event.calendarName ?? "Calendar",
  },
});

export const templateResponse = (template: {
  readonly id: string;
  readonly ownerId: string;
  readonly title: string;
  readonly notes: string;
  readonly estimateMinutes: number | null;
  readonly suggestedProjectId: string | null;
  readonly tagIds: readonly string[];
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
}): TaskTemplate => ({ ...template, tagIds: [...template.tagIds] });

export const templateBlueprintResponse = (blueprint: {
  readonly id: string;
  readonly templateId: string;
  readonly title: string;
  readonly position: number;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}): TemplateSubtaskBlueprint => ({ ...blueprint });

export const templateSetResponse = (set: {
  readonly id: string;
  readonly ownerId: string;
  readonly title: string;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
}): TemplateSet => ({ ...set });

export const choicePoolResponse = (pool: ChoicePool): ChoicePool => ({
  ...pool,
});
export const choicePoolItemResponse = (
  item: ChoicePoolItem,
): ChoicePoolItem => ({
  ...item,
});
export const choicePoolHistoryResponse = (
  event: ChoicePoolHistoryEvent,
): ChoicePoolHistoryEvent => ({ ...event });
export const planningPlaceholderResponse = (
  placeholder: PlanningPlaceholder,
): PlanningPlaceholder => ({ ...placeholder });

export const planningResolutionResponse = (
  resolution: PlanningPlaceholderResolutionRecord,
) => ({
  ...resolution,
  selectedItemIds: [...resolution.selectedItemIds],
  subtaskIds: [...resolution.subtaskIds],
  historyIds: [...resolution.historyIds],
});

export const placeholderResolutionResponse = (
  result: PlanningPlaceholderResolutionResult,
): PlanningPlaceholderResolutionResponse => {
  if (
    result.placeholder === undefined ||
    result.resolution === undefined ||
    result.subtasks === undefined ||
    result.history === undefined
  )
    throw new Error("Resolved placeholder result is incomplete");
  return {
    placeholder: planningPlaceholderResponse(result.placeholder),
    resolution: planningResolutionResponse(result.resolution),
    subtasks: result.subtasks.map(subtaskResponse),
    history: result.history.map(choicePoolHistoryResponse),
    replayed: result.kind === "replayed",
  };
};

export const choiceSuggestion = (
  database: SuiteDatabase,
  ownerId: string,
  poolId: string,
  logicalTime: string,
) => {
  const pool = database.getChoicePool(ownerId, poolId);
  if (pool === undefined) return undefined;
  const items = database.listChoicePoolItems(poolId, true);
  const history = database
    .listChoicePoolHistory(poolId)
    .filter(({ kind }) => kind === "selected")
    .map(({ itemId, occurredAt, cycle }) => ({
      itemId,
      selectedAt: occurredAt,
      cycle,
    }));
  const suggestion = suggestChoicePool(
    {
      policy: pool.policy,
      pickCount: pool.pickCount,
      cooldownSeconds: pool.cooldownSeconds,
    },
    items.map(({ id, position, archivedAt }) => ({
      id,
      position,
      archived: archivedAt !== null,
    })),
    history,
    logicalTime,
  );
  return { pool, items, history, suggestion };
};

export const connectorStatus = (reason: ConnectorFailure): number =>
  reason === "authentication-required"
    ? 401
    : reason === "authorization-denied"
      ? 403
      : reason === "credential-unavailable"
        ? 409
        : 502;

/**
 * One actionable, credential-free message per connector failure (ADR 0039).
 * Messages name the next step and never echo the username, password,
 * request body or a remote response body.
 */
export const describeConnectorFailure = (
  reason: ConnectorFailure,
): {
  readonly status: number;
  readonly code: string;
  readonly message: string;
} => {
  const status = connectorStatus(reason);
  switch (reason) {
    case "authentication-required":
      return {
        status,
        code: "BAIKAL_AUTHENTICATION_FAILED",
        message:
          "Baïkal rejected the username or password. Check the DAV user under Users and resources in Baïkal's admin interface; the admin account cannot sign in to CalDAV.",
      };
    case "authorization-denied":
      return {
        status,
        code: "BAIKAL_PERMISSION_DENIED",
        message:
          "Baïkal accepted the sign-in but denied access to this account's calendars. Check the user's calendar permissions in Baïkal.",
      };
    case "not-found":
      return {
        status,
        code: "BAIKAL_ENDPOINT_NOT_FOUND",
        message:
          "The configured Baïkal endpoint has no CalDAV principal for this user. Set BAIKAL_ENDPOINT to Baïkal's /dav.php/ address.",
      };
    case "remote-unavailable":
      return {
        status,
        code: "BAIKAL_SERVER_ERROR",
        message:
          "Baïkal answered with a server error. Check that the Baïkal service is healthy, then try again.",
      };
    case "invalid-protocol":
      return {
        status,
        code: "BAIKAL_NOT_CALDAV",
        message:
          "The configured endpoint did not answer as a CalDAV server. Set BAIKAL_ENDPOINT to Baïkal's /dav.php/ address, not the admin interface or site root.",
      };
    case "caldav-unsupported":
      return {
        status,
        code: "BAIKAL_CALDAV_DISABLED",
        message:
          "The endpoint answered WebDAV requests but does not offer CalDAV calendars. Enable CalDAV in Baïkal's settings and check that BAIKAL_ENDPOINT ends in /dav.php/.",
      };
    case "unsafe-remote-url":
      return {
        status,
        code: "BAIKAL_UNSAFE_URL",
        message:
          "Baïkal advertised an address outside the configured endpoint origin. Make Baïkal's public host and port match BAIKAL_ENDPOINT; Tadooer does not contact other hosts.",
      };
    case "redirected":
      return {
        status,
        code: "BAIKAL_REDIRECTED",
        message:
          "The endpoint answered with a redirect, which Tadooer does not follow. Set BAIKAL_ENDPOINT to the final /dav.php/ address, including https:// when Baïkal requires TLS.",
      };
    case "transport-failed":
      return {
        status,
        code: "BAIKAL_UNREACHABLE",
        message:
          "Tadooer could not reach the configured Baïkal endpoint. Check the hostname, port, network and TLS certificate; install a private certificate authority with NODE_EXTRA_CA_CERTS.",
      };
    case "credential-unavailable":
      return {
        status,
        code: "BAIKAL_RECONNECT_REQUIRED",
        message:
          "The saved Baïkal credential no longer matches the configured endpoint or credential key. Connect again with the Baïkal username and password.",
      };
  }
};

export const sendEmpty = (response: ServerResponse, status: number): void => {
  response.writeHead(status, securityHeaders);
  response.end();
};

export const isInside = (root: string, candidate: string): boolean =>
  candidate === root || candidate.startsWith(`${root}${sep}`);

export const serveFile = (response: ServerResponse, path: string): void => {
  response.writeHead(200, {
    ...securityHeaders,
    "Cache-Control": path.endsWith(".html")
      ? "no-cache"
      : "public, max-age=31536000, immutable",
    "Content-Type": mimeTypes[extname(path)] ?? "application/octet-stream",
  });
  createReadStream(path).pipe(response);
};

export const cursorFor = (state: {
  readonly epoch: string;
  readonly cursor: number;
}): string => `${state.epoch}.${String(state.cursor)}`;

export const parseCursor = (
  cursor: string,
): { readonly epoch: string; readonly sequence: number } | undefined => {
  const index = cursor.lastIndexOf(".");
  if (index < 1) return undefined;
  const sequence = Number(cursor.slice(index + 1));
  return Number.isInteger(sequence) && sequence >= 0
    ? { epoch: cursor.slice(0, index), sequence }
    : undefined;
};

export const projectResponse = (project: ProjectRecord): Project => ({
  id: project.id,
  ownerId: project.ownerId,
  title: project.title,
  revision: project.revision,
  createdAt: project.createdAt,
  updatedAt: project.updatedAt,
  archivedAt: project.archivedAt,
  color: project.color,
  icon: project.icon,
  position: project.position,
  hiddenFromMenu: project.hiddenFromMenu,
  completedAt: project.completedAt,
  backlogEnabled: project.backlogEnabled,
  backlogTaskIds: [...project.backlogTaskIds],
});

export const tagResponse = (tag: TagRecord): Tag => ({
  id: tag.id,
  ownerId: tag.ownerId,
  displayName: tag.title,
  normalizedName: tag.normalizedName,
  revision: tag.revision,
  createdAt: tag.createdAt,
  updatedAt: tag.updatedAt,
  archivedAt: tag.archivedAt,
  color: tag.color,
  icon: tag.icon,
  position: tag.position,
});

export const noteResponse = (note: NoteRecord): Note => ({ ...note });

export const subtaskResponse = (subtask: {
  readonly id: string;
  readonly taskId: string;
  readonly title: string;
  readonly completed: boolean;
  readonly position: number;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}): Subtask => ({ ...subtask });

export const templateInstantiationResponse = (
  result: TemplateInstantiationResult,
): TemplateInstantiationResponse => {
  if (
    (result.kind !== "created" && result.kind !== "replayed") ||
    result.instantiationId === undefined ||
    result.tasks === undefined
  )
    throw new Error("Template instantiation result is incomplete");
  return {
    instantiationId: result.instantiationId,
    tasks: result.tasks.map((tree) => ({
      task: taskResponse(tree.task),
      subtasks: tree.subtasks.map(subtaskResponse),
      provenance: tree.provenance,
    })),
    replayed: result.kind === "replayed",
  };
};

export const activeFromRecord = (
  record: ActiveSessionRecord,
  database: SuiteDatabase,
): ActiveSession =>
  activeFromPersistence(
    record,
    database.listActiveSessionIntervals(record.id),
    database.listActiveSessionEvents(record.id),
  );

export const activeFromPersistence = (
  record: ActiveSessionRecord,
  intervals: readonly ActiveSessionIntervalRecord[],
  events: readonly ActiveSessionEventRecord[],
): ActiveSession => ({
  id: record.id,
  ownerId: record.ownerId,
  controllerClientId: record.controllerClientId,
  taskId: record.taskId,
  state: record.state,
  phase: record.phase,
  revision: record.revision,
  startedAt: record.startedAt,
  updatedAt: record.updatedAt,
  leaseExpiresAt: record.leaseExpiresAt,
  hardExpiresAt: record.hardExpiresAt,
  terminalReason:
    record.state === "completed" || record.state === "expired"
      ? record.state
      : null,
  intervals: intervals.map((interval) => ({
    id: interval.id,
    ordinal: interval.ordinal,
    kind: interval.phase,
    taskId: interval.taskId,
    controllerClientId: interval.controllerClientId,
    startedAt: interval.startedAt,
    endedAt: interval.endedAt,
    closedBy: interval.closedBy as
      "pause" | "break" | "complete" | "takeover" | "expiry" | "idle" | null,
  })),
  events: events.map((event) => ({
    revision: event.revision,
    type: event.kind,
    actorClientId: event.actorClientId,
    occurredAt: event.createdAt,
  })),
});

export const recordFromActive = (
  session: ActiveSession,
): ActiveSessionRecord => ({
  id: session.id,
  ownerId: session.ownerId,
  taskId: session.taskId ?? "",
  controllerClientId: session.controllerClientId,
  state: session.state,
  phase: session.phase,
  revision: session.revision,
  startedAt: session.startedAt,
  leaseExpiresAt: session.leaseExpiresAt,
  hardExpiresAt: session.hardExpiresAt,
  createdAt: session.startedAt,
  updatedAt: session.updatedAt,
  endedAt:
    session.state === "completed" || session.state === "expired"
      ? session.updatedAt
      : null,
});

export const intervalsFromActive = (
  session: ActiveSession,
): readonly ActiveSessionIntervalRecord[] =>
  session.intervals.map((interval) => ({
    id: interval.id,
    ordinal: interval.ordinal,
    phase: interval.kind,
    taskId: interval.taskId,
    controllerClientId: interval.controllerClientId,
    startedAt: interval.startedAt,
    endedAt: interval.endedAt,
    closedBy: interval.closedBy,
  }));

export const eventsFromActive = (
  session: ActiveSession,
): readonly ActiveSessionEventRecord[] =>
  session.events.map((event) => ({
    kind: event.type,
    revision: event.revision,
    actorClientId: event.actorClientId,
    createdAt: event.occurredAt,
  }));

export const activeResponse = (
  session: ActiveSession,
): ContractActiveSession => ({
  id: session.id,
  ownerId: session.ownerId,
  taskId: session.taskId ?? "",
  controllerClientId: session.controllerClientId,
  state: session.state,
  phase: session.phase,
  revision: session.revision,
  startedAt: session.startedAt,
  updatedAt: session.updatedAt,
  leaseExpiresAt: session.leaseExpiresAt,
  hardExpiresAt: session.hardExpiresAt,
  currentIntervalId:
    session.intervals.find((interval) => interval.endedAt === null)?.id ?? null,
});

const googleWriteRefusalMessages: Record<GoogleWriteRefusal, string> = {
  "not-connected": "Google Calendar is not connected",
  "reconnect-required":
    "Google authorization expired or was revoked; reconnect before changing events",
  "consent-required":
    "Allow event changes for Google Calendar before writing to it",
  "scope-missing":
    "Google no longer grants event changes; allow event changes again",
  "role-unknown":
    "This calendar's Google permissions are unknown; sync Google Calendar first",
  "read-only-calendar": "This Google calendar is read-only for your account",
};

/**
 * ADR 0040 write gate for route handlers. Returns the refusal to send for a
 * write aimed at a Google calendar, or undefined for other providers. A Google
 * calendar that passes the gate is still refused until the write adapter of
 * #40 exists, so no reservation or provider call is ever made for it here.
 */
export const googleCalendarWriteRefusal = (
  google: GoogleConnectorService,
  ownerId: string,
  calendar: { readonly id: string; readonly kind: string },
):
  | {
      readonly status: number;
      readonly code: string;
      readonly message: string;
    }
  | undefined => {
  if (calendar.kind !== "google") return undefined;
  const capability = google.writeCapability(ownerId, calendar.id);
  return capability.writable
    ? {
        status: 409,
        code: "GOOGLE_WRITE_NOT_AVAILABLE",
        message:
          "Writing to Google calendars is not available yet; choose a Baïkal calendar",
      }
    : {
        status: 403,
        code: "GOOGLE_CALENDAR_NOT_WRITABLE",
        message: googleWriteRefusalMessages[capability.reason],
      };
};
