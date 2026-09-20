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
  Subtask,
  TemplateInstantiationResponse,
  ActiveSession as ContractActiveSession,
} from "@suite/contracts";
import { automationCatalog } from "@suite/contracts";
import type {
  SuiteDatabase,
  TaskRecord,
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
import type { NtfyPublisher } from "../notifications.ts";
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
  readonly ntfy: NtfyPublisher | undefined;
  readonly sessionClock: SessionClock;
  readonly requestCounts: Map<number, number>;
  readonly triggerNotifications?: () => Promise<void>;
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
}) => ({
  id: token.id,
  ownerId: token.ownerId,
  label: token.label,
  scopes: token.scopes,
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
  deadline:
    task.deadlineDate == null
      ? task.deadlineAt == null
        ? null
        : { kind: "instant", value: task.deadlineAt }
      : { kind: "date", value: task.deadlineDate },
  estimateMinutes: task.estimateMinutes,
  projectId: task.projectId ?? null,
  tagIds: [...(task.tagIds ?? [])],
});

export const calendarEventResponse = (
  event: CalendarEventProjectionRecord,
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

export const projectResponse = (project: {
  readonly id: string;
  readonly ownerId: string;
  readonly title: string;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
}): Project => ({ ...project });

export const tagResponse = (tag: {
  readonly id: string;
  readonly ownerId: string;
  readonly title: string;
  readonly normalizedName: string;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
}): Tag => ({
  id: tag.id,
  ownerId: tag.ownerId,
  displayName: tag.title,
  normalizedName: tag.normalizedName,
  revision: tag.revision,
  createdAt: tag.createdAt,
  updatedAt: tag.updatedAt,
  archivedAt: tag.archivedAt,
});

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
      "pause" | "break" | "complete" | "takeover" | "expiry" | null,
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
