import {
  capturePreferencesResponseSchema,
  capturePreviewResponseSchema,
  taskBatchMutationResponseSchema,
  type CapturePreferences,
  type CapturePreferencesResponse,
  type CapturePreviewRequest,
  type CapturePreviewResponse,
  type TaskBatchCreateRequest,
  type TaskBatchMutationResponse,
  taskImportApplyResponseSchema,
  automationTokenListResponseSchema,
  createAutomationTokenRequestSchema,
  createAutomationTokenResponseSchema,
  type CreateAutomationTokenRequest,
  superProductivityPreviewSchema,
  dataRestoreApplyResponseSchema,
  dataRestorePreviewSchema,
  type DataRestoreMode,
} from "@suite/contracts";
import {
  apiErrorSchema,
  activeSessionCommandResponseSchema,
  activeSessionCommandSchema,
  activeSessionSchema,
  baikalProbeResponseSchema,
  baikalStatusResponseSchema,
  clientRegistrationResponseSchema,
  projectSchema,
  subtaskSchema,
  syncRoundResponseSchema,
  syncSnapshotResponseSchema,
  tagSchema,
  taskTemplateLibraryResponseSchema,
  taskTemplateSchema,
  templateSetLibraryResponseSchema,
  templateSetSchema,
  createTemplateSetRequestSchema,
  templateInstantiationResponseSchema,
  createTaskTemplateRequestSchema,
  taskTemplatePatchRequestSchema,
  instantiateTemplateRequestSchema,
  choicePoolLibraryResponseSchema,
  choicePoolSuggestionResponseSchema,
  createChoicePoolRequestSchema,
  createPlanningPlaceholderRequestSchema,
  planningPlaceholderResolutionResponseSchema,
  planningPlaceholderSchema,
  resolvePlanningPlaceholderRequestSchema,
  updateChoicePoolRequestSchema,
  choicePoolSchema,
  createTemplatePoolSlotRequestSchema,
  templatePoolSlotSchema,
  completeChoicePoolItemRequestSchema,
  calendarImportPreviewRequestSchema,
  calendarImportMutationResponseSchema,
  calendarFeedCreateRequestSchema,
  calendarFeedCreateResponseSchema,
  calendarFeedListResponseSchema,
  googleAuthorizationResponseSchema,
  googleConnectorStatusResponseSchema,
  googleSyncResponseSchema,
  planningPreferencesSchema,
  applicationPreferenceMutationInputSchema,
  applicationPreferenceSnapshotSchema,
  type ApplicationPreferenceMutationInput,
  type ApplicationPreferenceSnapshot,
  dayPlanResponseSchema,
  notificationPreferencesSchema,
  notificationStatusResponseSchema,
  notificationTestResponseSchema,
  choicePoolHistoryEventSchema,
  taskListResponseSchema,
  taskMutationResponseSchema,
  conditionalTaskMutationResponseSchema,
  plannerResponseSchema,
  taskTimeBlockMutationResponseSchema,
  sessionResponseSchema,
  setupStatusResponseSchema,
  type BaikalConnectRequest,
  type BaikalProbeResponse,
  type BaikalStatusResponse,
  type ActiveSession,
  type ActiveSessionCommand,
  type ActiveSessionCommandResponse,
  type ClientRegistrationResponse,
  type CreateTaskRequest,
  type LoginRequest,
  type OwnerSetupRequest,
  type SessionResponse,
  type SetupStatusResponse,
  type TaskListResponse,
  type TaskMutationResponse,
  type TaskPatchRequest,
  type ConditionalTaskMutationResponse,
  type PlannerResponse,
  type CreateTaskTimeBlockRequest,
  type TaskTimeBlockMutationResponse,
  type Project,
  type Subtask,
  type SyncRoundRequest,
  type SyncRoundResponse,
  type SyncEntitySnapshot,
  type SyncSnapshotResponse,
  type Tag,
  type GoogleConnectorStatusResponse,
  type GoogleSyncResponse,
  type PlanningPreferences,
  type DayPlanResponse,
  type NotificationPreferences,
  type NotificationStatusResponse,
  type NotificationTestResponse,
} from "@suite/contracts";
import {
  ApiRequestError,
  liveSyncPushTrigger,
  liveSyncTriggerHeader,
} from "@suite/contracts";
import {
  noteCreateRequestSchema,
  noteListResponseSchema,
  notePatchRequestSchema,
  noteResponseSchema,
  organizationOrderRequestSchema,
  projectBacklogRequestSchema,
  projectPatchRequestSchema,
  tagPatchRequestSchema,
  type Note,
  type NoteCreateRequest,
  type NotePatchRequest,
  type OrganizationOrderItem,
} from "@suite/contracts";
import {
  taskAttachmentCreateRequestSchema,
  taskAttachmentPatchRequestSchema,
  taskLinksResponseSchema,
  type TaskAttachmentPatchRequest,
  type TaskLinksResponse,
  taskArchiveMutationResponseSchema,
  taskHistoryResponseSchema,
  type TaskArchiveMutationResponse,
  type TaskHistoryResponse,
} from "@suite/contracts";
import {
  recurrenceOccurrenceRequestSchema,
  recurringSeriesCreateRequestSchema,
  recurringSeriesListResponseSchema,
  recurringSeriesMutationResponseSchema,
  recurringSeriesPatchRequestSchema,
  type RecurringSeriesCreateRequest,
  type RecurringSeriesListResponse,
  type RecurringSeriesMutationResponse,
  type RecurringSeriesPatchRequest,
  timeEntryMutationResponseSchema,
  timeReportResponseSchema,
  type TimeEntryCreateRequest,
  type TimeEntryMutationResponse,
  type TimeEntryPatchRequest,
  type TimeReport,
  pluginDataContentResponseSchema,
  pluginDataListResponseSchema,
  type PluginDataContentResponse,
  type PluginDataListResponse,
} from "@suite/contracts";
import {
  counterHistoryResponseSchema,
  counterMutationResponseSchema,
  evaluationListResponseSchema,
  evaluationMutationResponseSchema,
  type CounterCreateRequest,
  type CounterDayWriteRequest,
  type CounterHistory,
  type CounterMutationResponse,
  type CounterPatchRequest,
  type EvaluationList,
  type EvaluationMutationResponse,
  type EvaluationWriteRequest,
} from "@suite/contracts";
import {
  dayOrderListResponseSchema,
  dayOrderPlanRequestSchema,
  dayOrderPlanResponseSchema,
  dayOrderReorderRequestSchema,
  dayOrderResponseSchema,
  type DayOrder,
  type DayOrderPlanRequest,
  type Task as DayOrderPlannedTask,
  boardCreateRequestSchema,
  boardListResponseSchema,
  boardMoveRequestSchema,
  boardMoveResponseSchema,
  boardOrderRequestSchema,
  boardPanelOrderRequestSchema,
  boardResponseSchema,
  boardUpdateRequestSchema,
  boardViewResponseSchema,
  menuFolderCreateRequestSchema,
  menuFolderListResponseSchema,
  menuFolderOrderRequestSchema,
  menuFolderUpdateRequestSchema,
  sectionCreateRequestSchema,
  sectionListResponseSchema,
  sectionOrderRequestSchema,
  sectionUpdateRequestSchema,
  taskViewListResponseSchema,
  taskViewResponseSchema,
  taskViewSetRequestSchema,
  type Board,
  type BoardMoveResponse,
  type BoardView,
  type MenuFolder,
  type MenuFolderUpdateRequest,
  type Section,
  type SectionContextKind,
  type SectionCreateRequest,
  type SectionUpdateRequest,
  type TaskView,
} from "@suite/contracts";
import {
  focusBreakSnoozeResponseSchema,
  focusIdleRequestSchema,
  focusIdleResponseSchema,
  focusPlanRequestSchema,
  focusPreferencesResponseSchema,
  focusPreferencesSchema,
  focusTimerSchema,
  type FocusIdleRequest,
  type FocusIdleResponse,
  type FocusPlanRequest,
  type FocusPreferences,
  type FocusPreferencesResponse,
  type FocusTimer,
} from "@suite/contracts";
import {
  calendarSubscriptionConversionResponseSchema,
  calendarSubscriptionCreateRequestSchema,
  calendarSubscriptionEventListResponseSchema,
  calendarSubscriptionEventMutationResponseSchema,
  calendarSubscriptionListResponseSchema,
  calendarSubscriptionMutationResponseSchema,
  calendarSubscriptionPatchRequestSchema,
  calendarSubscriptionRefreshResponseSchema,
  type CalendarSubscriptionConversionResponse,
  type CalendarSubscriptionCreateRequest,
  type CalendarSubscriptionEventListResponse,
  type CalendarSubscriptionEventMutationResponse,
  type CalendarSubscriptionListResponse,
  type CalendarSubscriptionMutationResponse,
  type CalendarSubscriptionPatchRequest,
  type CalendarSubscriptionRefreshResponse,
} from "@suite/contracts";
import {
  calendarBridgeLinkSchema,
  calendarBridgeMappingCreateRequestSchema,
  calendarBridgeMappingPreviewResponseSchema,
  calendarBridgeMappingSchema,
  calendarBridgeOperationSchema,
  calendarBridgeOverviewResponseSchema,
  calendarBridgeReviewResponseSchema,
  calendarBridgeRunResponseSchema,
  type CalendarBridgeLink,
  type CalendarBridgeMapping,
  type CalendarBridgeMappingCreateRequest,
  type CalendarBridgeMappingPreviewResponse,
  type CalendarBridgeOperation,
  type CalendarBridgeOverviewResponse,
  type CalendarBridgeReviewResponse,
  type CalendarBridgeRunResponse,
  type CalendarBridgeSide,
} from "@suite/contracts";
import { z } from "zod";
import { liveSyncPath } from "@suite/contracts";
import { reportSessionFailure } from "./session-recovery.ts";
import type { LocalClientIdentity } from "./local-store.ts";
import {
  SyncCursorResetRequired,
  type SyncRoundTrigger,
  type SyncTransport,
} from "./sync-engine.ts";

let backgroundReadsUntil = 0;

/**
 * Marks reads for the next few seconds as caused by a live sync hint rather
 * than by the owner (ADR 0045). They carry the push trigger header, so the
 * server does not count them as activity and an unattended device still
 * reaches its idle limit. Writes are never marked.
 */
export const noteBackgroundReads = (
  now: number = Date.now(),
  windowMs = 3000,
): void => {
  backgroundReadsUntil = Math.max(backgroundReadsUntil, now + windowMs);
};

/** Owner activity ends the window: what follows is the owner's own request. */
export const endBackgroundReads = (): void => {
  backgroundReadsUntil = 0;
};

const request = async <T>(
  path: string,
  schema: z.ZodType<T>,
  init?: RequestInit,
): Promise<T> => {
  const headers = new Headers(init?.headers);
  headers.set("Accept", "application/json");
  if (
    (init?.method ?? "GET") === "GET" &&
    Date.now() < backgroundReadsUntil &&
    !headers.has(liveSyncTriggerHeader)
  )
    headers.set(liveSyncTriggerHeader, liveSyncPushTrigger);
  if (init?.body !== undefined) headers.set("Content-Type", "application/json");
  const response = await fetch(path, {
    ...init,
    headers,
  });
  const body: unknown = await response.json();
  if (!response.ok) {
    const error = apiErrorSchema.safeParse(body);
    const failure = new ApiRequestError(
      response.status,
      error.success ? error.data.code : "INVALID_RESPONSE",
      error.success
        ? error.data.message
        : "The server returned an invalid response",
    );
    reportSessionFailure(failure);
    throw failure;
  }
  return schema.parse(body);
};

const requestEmpty = async (
  path: string,
  init?: RequestInit,
): Promise<void> => {
  const headers = new Headers(init?.headers);
  headers.set("Accept", "application/json");
  const response = await fetch(path, { ...init, headers });
  if (response.ok) return;
  const body: unknown = await response.json().catch(() => undefined);
  const error = apiErrorSchema.safeParse(body);
  const failure = new ApiRequestError(
    response.status,
    error.success ? error.data.code : "INVALID_RESPONSE",
    error.success
      ? error.data.message
      : "The server returned an invalid response",
  );
  reportSessionFailure(failure);
  throw failure;
};

const clientProofHeaders = (
  client: LocalClientIdentity,
): Readonly<Record<string, string>> => ({
  "X-Suite-Client-Id": client.clientId,
  "X-Suite-Client-Credential": client.clientCredential,
});

const conditionalHeaders = (
  revision: number,
  csrfToken: string,
): HeadersInit => ({
  "X-CSRF-Token": csrfToken,
  "If-Match": `"${String(revision)}"`,
});

export const getSetupStatus = (): Promise<SetupStatusResponse> =>
  request("/api/setup/status", setupStatusResponseSchema);

export const setupOwner = (
  input: OwnerSetupRequest,
): Promise<SetupStatusResponse> =>
  request("/api/setup", setupStatusResponseSchema, {
    method: "POST",
    body: JSON.stringify(input),
  });

export const login = (input: LoginRequest): Promise<SessionResponse> =>
  request("/api/auth/login", sessionResponseSchema, {
    method: "POST",
    body: JSON.stringify(input),
  });

export const resumeSession = (): Promise<SessionResponse> =>
  request("/api/auth/session", sessionResponseSchema);

export const logout = async (csrfToken: string): Promise<void> => {
  await request("/api/auth/logout", z.object({ loggedOut: z.literal(true) }), {
    method: "POST",
    headers: { "X-CSRF-Token": csrfToken },
  });
};

export const getBaikalStatus = (): Promise<BaikalStatusResponse> =>
  request("/api/connectors/baikal", baikalStatusResponseSchema);

export const connectBaikal = (
  input: BaikalConnectRequest,
  csrfToken: string,
): Promise<BaikalStatusResponse> =>
  request("/api/connectors/baikal", baikalStatusResponseSchema, {
    method: "PUT",
    headers: { "X-CSRF-Token": csrfToken },
    body: JSON.stringify(input),
  });

/** Read-only setup check; stores nothing (ADR 0039). */
export const probeBaikal = (
  input: BaikalConnectRequest,
  csrfToken: string,
): Promise<BaikalProbeResponse> =>
  request("/api/connectors/baikal/probe", baikalProbeResponseSchema, {
    method: "POST",
    headers: { "X-CSRF-Token": csrfToken },
    body: JSON.stringify(input),
  });

export const getGoogleStatus = (): Promise<GoogleConnectorStatusResponse> =>
  request("/api/connectors/google", googleConnectorStatusResponseSchema);

/**
 * Read-only is the default. `write` is the separate explicit consent step of
 * ADR 0040 and is sent only from the owner's "Allow event changes" action.
 */
export const beginGoogleAuthorization = (
  csrfToken: string,
  access: "read" | "write" = "read",
): Promise<{ readonly authorizationUrl: string; readonly expiresAt: string }> =>
  request(
    "/api/connectors/google/authorize",
    googleAuthorizationResponseSchema,
    access === "read"
      ? {
          method: "POST",
          headers: { "X-CSRF-Token": csrfToken },
        }
      : {
          method: "POST",
          headers: { "X-CSRF-Token": csrfToken },
          body: JSON.stringify({ access }),
        },
  );

export const withdrawGoogleWriteConsent = (
  csrfToken: string,
): Promise<GoogleConnectorStatusResponse> =>
  request(
    "/api/connectors/google/write-consent",
    googleConnectorStatusResponseSchema,
    {
      method: "DELETE",
      headers: { "X-CSRF-Token": csrfToken },
    },
  );

export const synchronizeGoogle = (
  csrfToken: string,
  full = false,
): Promise<GoogleSyncResponse> =>
  request("/api/connectors/google/sync", googleSyncResponseSchema, {
    method: "POST",
    headers: { "X-CSRF-Token": csrfToken },
    body: JSON.stringify({ full }),
  });

export const disconnectGoogle = (
  csrfToken: string,
): Promise<{
  readonly disconnected: boolean;
  readonly remoteRevoked: boolean;
}> =>
  request(
    "/api/connectors/google",
    z.object({ disconnected: z.boolean(), remoteRevoked: z.boolean() }),
    {
      method: "DELETE",
      headers: { "X-CSRF-Token": csrfToken },
    },
  );

export const getPlanningPreferences = (): Promise<PlanningPreferences> =>
  request("/api/planning/preferences", planningPreferencesSchema);

export const updatePlanningPreferences = (
  input: PlanningPreferences,
  csrfToken: string,
): Promise<PlanningPreferences> =>
  request("/api/planning/preferences", planningPreferencesSchema, {
    method: "PUT",
    headers: { "X-CSRF-Token": csrfToken },
    body: JSON.stringify(planningPreferencesSchema.parse(input)),
  });

/** Application preferences and shortcuts (ADR 0030); online-only. */
export const getApplicationPreferences =
  (): Promise<ApplicationPreferenceSnapshot> =>
    request(
      "/api/application/preferences",
      applicationPreferenceSnapshotSchema,
    );

export const updateApplicationPreferences = (
  input: ApplicationPreferenceMutationInput,
  csrfToken: string,
): Promise<ApplicationPreferenceSnapshot> =>
  request("/api/application/preferences", applicationPreferenceSnapshotSchema, {
    method: "PUT",
    headers: { "X-CSRF-Token": csrfToken },
    body: JSON.stringify(applicationPreferenceMutationInputSchema.parse(input)),
  });

export const getDayPlan = (
  at = new Date().toISOString(),
): Promise<DayPlanResponse> =>
  request(`/api/day-plan?at=${encodeURIComponent(at)}`, dayPlanResponseSchema);

export const getNotificationPreferences =
  (): Promise<NotificationPreferences> =>
    request("/api/notifications/preferences", notificationPreferencesSchema);

export const updateNotificationPreferences = (
  input: NotificationPreferences,
  csrfToken: string,
): Promise<NotificationPreferences> =>
  request("/api/notifications/preferences", notificationPreferencesSchema, {
    method: "PUT",
    headers: { "X-CSRF-Token": csrfToken },
    body: JSON.stringify(notificationPreferencesSchema.parse(input)),
  });

export const getNotificationStatus = (): Promise<NotificationStatusResponse> =>
  request("/api/notifications/status", notificationStatusResponseSchema);

export const sendTestNotification = (
  csrfToken: string,
): Promise<NotificationTestResponse> =>
  request("/api/notifications/test", notificationTestResponseSchema, {
    method: "POST",
    headers: { "X-CSRF-Token": csrfToken },
  });

export const getTasks = (): Promise<TaskListResponse> =>
  request("/api/tasks", taskListResponseSchema);

export const createTask = (
  input: CreateTaskRequest,
  csrfToken: string,
  idempotencyKey: string,
): Promise<TaskMutationResponse> =>
  request("/api/tasks", taskMutationResponseSchema, {
    method: "POST",
    headers: {
      "X-CSRF-Token": csrfToken,
      "Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify(input),
  });

export const getRecoveryTasks = (): Promise<TaskListResponse> =>
  request("/api/tasks/recovery", taskListResponseSchema);

export const getPlanner = (
  from: string,
  to: string,
): Promise<PlannerResponse> =>
  request(
    `/api/planner?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    plannerResponseSchema,
  );

const conditionalTask = (
  path: string,
  method: "PATCH" | "POST" | "DELETE",
  revision: number,
  csrfToken: string,
  body: unknown = {},
): Promise<ConditionalTaskMutationResponse> =>
  request(path, conditionalTaskMutationResponseSchema, {
    method,
    headers: {
      "X-CSRF-Token": csrfToken,
      "If-Match": `"${String(revision)}"`,
    },
    body: JSON.stringify(body),
  });

export const patchTask = (
  taskId: string,
  revision: number,
  input: TaskPatchRequest,
  csrfToken: string,
): Promise<ConditionalTaskMutationResponse> =>
  conditionalTask(`/api/tasks/${taskId}`, "PATCH", revision, csrfToken, input);

export const transitionTask = (
  taskId: string,
  revision: number,
  action: "complete" | "reopen",
  csrfToken: string,
): Promise<ConditionalTaskMutationResponse> =>
  conditionalTask(
    `/api/tasks/${taskId}/${action}`,
    "POST",
    revision,
    csrfToken,
  );

export const deleteTask = (
  taskId: string,
  revision: number,
  csrfToken: string,
): Promise<ConditionalTaskMutationResponse> =>
  conditionalTask(`/api/tasks/${taskId}`, "DELETE", revision, csrfToken);

export const restoreTask = (
  taskId: string,
  revision: number,
  csrfToken: string,
): Promise<ConditionalTaskMutationResponse> =>
  conditionalTask(`/api/tasks/${taskId}/restore`, "POST", revision, csrfToken);

export const putTaskTimeBlock = (
  taskId: string,
  revision: number,
  input: CreateTaskTimeBlockRequest,
  csrfToken: string,
  idempotencyKey: string,
): Promise<TaskTimeBlockMutationResponse> =>
  request(
    `/api/tasks/${taskId}/time-block`,
    taskTimeBlockMutationResponseSchema,
    {
      method: "POST",
      headers: {
        "X-CSRF-Token": csrfToken,
        "If-Match": `"${String(revision)}"`,
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify(input),
    },
  );

export const removeTaskTimeBlock = (
  taskId: string,
  revision: number,
  csrfToken: string,
): Promise<ConditionalTaskMutationResponse> =>
  conditionalTask(
    `/api/tasks/${taskId}/time-block`,
    "DELETE",
    revision,
    csrfToken,
  );

export const registerSyncClient = (
  csrfToken: string,
  label = "This browser",
): Promise<ClientRegistrationResponse> =>
  request("/api/clients", clientRegistrationResponseSchema, {
    method: "POST",
    headers: { "X-CSRF-Token": csrfToken },
    body: JSON.stringify({ label }),
  });

export const syncRound = async (
  client: LocalClientIdentity,
  csrfToken: string,
  input: SyncRoundRequest,
  /**
   * `push` marks a round the app started without the owner acting (a live
   * sync hint or the fallback interval), so the server does not refresh the
   * session idle timer for it (ADR 0045).
   */
  trigger?: SyncRoundTrigger,
): Promise<SyncRoundResponse> => {
  try {
    return await request("/api/sync/round", syncRoundResponseSchema, {
      method: "POST",
      headers: {
        ...clientProofHeaders(client),
        "X-CSRF-Token": csrfToken,
        "X-Suite-Sync-Version": "2",
        ...(trigger === undefined ? {} : { "X-Suite-Sync-Trigger": trigger }),
      },
      body: JSON.stringify(input),
    });
  } catch (error: unknown) {
    if (
      error instanceof ApiRequestError &&
      error.status === 409 &&
      error.code === "SYNC_CURSOR_EXPIRED"
    ) {
      throw new SyncCursorResetRequired();
    }
    throw error;
  }
};

const getSyncSnapshotPage = (
  client: LocalClientIdentity,
  offset: number,
): Promise<SyncSnapshotResponse> =>
  request(
    `/api/sync/snapshot?offset=${String(offset)}`,
    syncSnapshotResponseSchema,
    {
      headers: { ...clientProofHeaders(client), "X-Suite-Sync-Version": "2" },
    },
  );

export const getSyncSnapshot = async (
  client: LocalClientIdentity,
): Promise<SyncSnapshotResponse> => {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const snapshots: SyncEntitySnapshot[] = [];
    let offset = 0;
    let expectedCursor: string | undefined;
    let page: SyncSnapshotResponse;
    let changed = false;
    do {
      page = await getSyncSnapshotPage(client, offset);
      expectedCursor ??= page.nextCursor;
      if (page.nextCursor !== expectedCursor) {
        changed = true;
        break;
      }
      snapshots.push(...page.snapshots);
      offset += page.snapshots.length;
      if (page.hasMore && page.snapshots.length === 0)
        throw new Error("Sync snapshot page was empty before completion");
    } while (page.hasMore);
    if (changed) continue;
    return {
      snapshots,
      nextCursor: page.nextCursor,
      hasMore: false,
      protocolVersion: 2 as const,
      serverTimestamp: page.serverTimestamp,
    };
  }
  throw new Error("Sync snapshot kept changing during pagination");
};

export const createSyncTransport = (csrfToken: string): SyncTransport => ({
  registerClient: () => registerSyncClient(csrfToken),
  snapshot: getSyncSnapshot,
  syncRound: (client, input, trigger) =>
    syncRound(client, csrfToken, input, trigger),
});

/**
 * Opens the live sync hint stream (ADR 0045). The request carries the same
 * proof as a sync round: the session cookie and the registered client
 * headers. The caller reads the `text/event-stream` body and owns the retry
 * policy, so a failed response is returned rather than thrown and does not
 * raise the session recovery prompt.
 */
export const openLiveSyncStream = (
  client: LocalClientIdentity,
  signal: AbortSignal,
): Promise<Response> =>
  fetch(liveSyncPath, {
    credentials: "same-origin",
    cache: "no-store",
    headers: {
      ...clientProofHeaders(client),
      "X-Suite-Sync-Version": "2",
      Accept: "text/event-stream",
    },
    signal,
  });

const activeSessionResponseSchema = z.object({
  session: activeSessionSchema.nullable(),
});

export const getActiveSession = (
  client: LocalClientIdentity,
): Promise<ActiveSession | null> =>
  request("/api/active-session", activeSessionResponseSchema, {
    headers: clientProofHeaders(client),
  }).then(({ session }) => session);

export const commandActiveSession = (
  client: LocalClientIdentity,
  csrfToken: string,
  command: ActiveSessionCommand,
): Promise<ActiveSessionCommandResponse> =>
  request("/api/active-session/command", activeSessionCommandResponseSchema, {
    method: "POST",
    headers: {
      ...clientProofHeaders(client),
      "X-CSRF-Token": csrfToken,
    },
    body: JSON.stringify(activeSessionCommandSchema.parse(command)),
  });

const projectListResponseSchema = z.object({
  projects: z.array(projectSchema),
});
const tagListResponseSchema = z.object({ tags: z.array(tagSchema) });
const subtaskListResponseSchema = z.object({
  subtasks: z.array(subtaskSchema),
});
const projectResponseSchema = z.object({ project: projectSchema });
const tagResponseSchema = z.object({ tag: tagSchema });
const subtaskResponseSchema = z.object({ subtask: subtaskSchema });

const organizationCreateSchema = z.object({
  title: z.string().trim().min(1).max(240),
});
const taskProjectAssignmentSchema = z.object({
  projectId: z.uuid().nullable(),
});
const taskTagAssignmentSchema = z.object({
  tagIds: z
    .array(z.uuid())
    .max(25)
    .refine((tagIds) => new Set(tagIds).size === tagIds.length),
});
const subtaskCreateSchema = z.object({
  title: z.string().trim().min(1).max(240),
  position: z.number().int().nonnegative(),
});
const subtaskPatchSchema = z
  .object({
    title: z.string().trim().min(1).max(240).optional(),
    completed: z.boolean().optional(),
    position: z.number().int().nonnegative().optional(),
  })
  .refine((input) => Object.keys(input).length > 0, {
    message: "At least one subtask field is required",
  });
const subtaskOrderSchema = z.object({
  items: z
    .array(
      z.object({
        id: z.uuid(),
        revision: z.number().int().positive(),
      }),
    )
    .min(1)
    .max(200)
    .refine(
      (items) => new Set(items.map(({ id }) => id)).size === items.length,
      { message: "Checklist order cannot contain duplicate items" },
    ),
});

export type OrganizationPatch = z.input<typeof projectPatchRequestSchema>;
export type TagPatch = z.input<typeof tagPatchRequestSchema>;
export type SubtaskCreate = z.infer<typeof subtaskCreateSchema>;
export type SubtaskPatch = z.infer<typeof subtaskPatchSchema>;

export const getProjects = (): Promise<readonly Project[]> =>
  request("/api/projects", projectListResponseSchema).then(
    ({ projects }) => projects,
  );

export const getTags = (): Promise<readonly Tag[]> =>
  request("/api/tags", tagListResponseSchema).then(({ tags }) => tags);

export const createProject = (
  title: string,
  csrfToken: string,
): Promise<Project> =>
  request("/api/projects", projectResponseSchema, {
    method: "POST",
    headers: { "X-CSRF-Token": csrfToken },
    body: JSON.stringify(organizationCreateSchema.parse({ title })),
  }).then(({ project }) => project);

export const createTag = (title: string, csrfToken: string): Promise<Tag> =>
  request("/api/tags", tagResponseSchema, {
    method: "POST",
    headers: { "X-CSRF-Token": csrfToken },
    body: JSON.stringify(organizationCreateSchema.parse({ title })),
  }).then(({ tag }) => tag);

const patchOrganization = <T>(
  path: string,
  schema: z.ZodType<T>,
  revision: number,
  body: unknown,
  csrfToken: string,
): Promise<T> =>
  request(path, schema, {
    method: "PATCH",
    headers: conditionalHeaders(revision, csrfToken),
    body: JSON.stringify(body),
  });

export const patchProject = (
  projectId: string,
  revision: number,
  input: OrganizationPatch,
  csrfToken: string,
): Promise<Project> =>
  patchOrganization(
    `/api/projects/${projectId}`,
    projectResponseSchema,
    revision,
    projectPatchRequestSchema.parse(input),
    csrfToken,
  ).then(({ project }) => project);

export const patchTag = (
  tagId: string,
  revision: number,
  input: TagPatch,
  csrfToken: string,
): Promise<Tag> =>
  patchOrganization(
    `/api/tags/${tagId}`,
    tagResponseSchema,
    revision,
    tagPatchRequestSchema.parse(input),
    csrfToken,
  ).then(({ tag }) => tag);

/** Sends the complete order with each record's current revision. */
export const reorderProjects = (
  items: readonly OrganizationOrderItem[],
  csrfToken: string,
): Promise<readonly Project[]> =>
  request("/api/projects/order", projectListResponseSchema, {
    method: "PUT",
    headers: { "X-CSRF-Token": csrfToken },
    body: JSON.stringify(organizationOrderRequestSchema.parse({ items })),
  }).then(({ projects }) => projects);

export const reorderTags = (
  items: readonly OrganizationOrderItem[],
  csrfToken: string,
): Promise<readonly Tag[]> =>
  request("/api/tags/order", tagListResponseSchema, {
    method: "PUT",
    headers: { "X-CSRF-Token": csrfToken },
    body: JSON.stringify(organizationOrderRequestSchema.parse({ items })),
  }).then(({ tags }) => tags);

export const setProjectBacklog = (
  projectId: string,
  revision: number,
  taskId: string,
  inBacklog: boolean,
  csrfToken: string,
): Promise<Project> =>
  request(`/api/projects/${projectId}/backlog`, projectResponseSchema, {
    method: "PUT",
    headers: conditionalHeaders(revision, csrfToken),
    body: JSON.stringify(
      projectBacklogRequestSchema.parse({ taskId, inBacklog }),
    ),
  }).then(({ project }) => project);

/** Notes are online-only: they are not cached or queued offline (ADR 0019). */
export const getNotes = (): Promise<readonly Note[]> =>
  request("/api/notes", noteListResponseSchema).then(({ notes }) => notes);

export const createNote = (
  input: z.input<typeof noteCreateRequestSchema>,
  csrfToken: string,
): Promise<Note> =>
  request("/api/notes", noteResponseSchema, {
    method: "POST",
    headers: { "X-CSRF-Token": csrfToken },
    body: JSON.stringify(
      noteCreateRequestSchema.parse(input) satisfies NoteCreateRequest,
    ),
  }).then(({ note }) => note);

export const patchNote = (
  noteId: string,
  revision: number,
  input: NotePatchRequest,
  csrfToken: string,
): Promise<Note> =>
  request(`/api/notes/${noteId}`, noteResponseSchema, {
    method: "PATCH",
    headers: conditionalHeaders(revision, csrfToken),
    body: JSON.stringify(notePatchRequestSchema.parse(input)),
  }).then(({ note }) => note);

export const deleteNote = (
  noteId: string,
  revision: number,
  csrfToken: string,
): Promise<void> =>
  requestEmpty(`/api/notes/${noteId}`, {
    method: "DELETE",
    headers: conditionalHeaders(revision, csrfToken),
  });

export const reorderNotes = (
  items: readonly OrganizationOrderItem[],
  csrfToken: string,
): Promise<readonly Note[]> =>
  request("/api/notes/order", noteListResponseSchema, {
    method: "PUT",
    headers: { "X-CSRF-Token": csrfToken },
    body: JSON.stringify(organizationOrderRequestSchema.parse({ items })),
  }).then(({ notes }) => notes);

export const assignTaskProject = (
  taskId: string,
  revision: number,
  projectId: string | null,
  csrfToken: string,
): Promise<ConditionalTaskMutationResponse> =>
  request(
    `/api/tasks/${taskId}/project`,
    conditionalTaskMutationResponseSchema,
    {
      method: "PUT",
      headers: conditionalHeaders(revision, csrfToken),
      body: JSON.stringify(taskProjectAssignmentSchema.parse({ projectId })),
    },
  );

export const assignTaskTags = (
  taskId: string,
  revision: number,
  tagIds: readonly string[],
  csrfToken: string,
): Promise<ConditionalTaskMutationResponse> =>
  request(`/api/tasks/${taskId}/tags`, conditionalTaskMutationResponseSchema, {
    method: "PUT",
    headers: conditionalHeaders(revision, csrfToken),
    body: JSON.stringify(taskTagAssignmentSchema.parse({ tagIds })),
  });

export const getSubtasks = (taskId: string): Promise<readonly Subtask[]> =>
  request(`/api/tasks/${taskId}/subtasks`, subtaskListResponseSchema).then(
    ({ subtasks }) => subtasks,
  );

export const createSubtask = (
  taskId: string,
  input: SubtaskCreate,
  csrfToken: string,
): Promise<Subtask> =>
  request(`/api/tasks/${taskId}/subtasks`, subtaskResponseSchema, {
    method: "POST",
    headers: { "X-CSRF-Token": csrfToken },
    body: JSON.stringify(subtaskCreateSchema.parse(input)),
  }).then(({ subtask }) => subtask);

export const patchSubtask = (
  subtaskId: string,
  revision: number,
  input: SubtaskPatch,
  csrfToken: string,
): Promise<Subtask> =>
  request(`/api/subtasks/${subtaskId}`, subtaskResponseSchema, {
    method: "PATCH",
    headers: conditionalHeaders(revision, csrfToken),
    body: JSON.stringify(subtaskPatchSchema.parse(input)),
  }).then(({ subtask }) => subtask);

export const reorderSubtasks = (
  taskId: string,
  items: readonly { readonly id: string; readonly revision: number }[],
  csrfToken: string,
): Promise<readonly Subtask[]> =>
  request(`/api/tasks/${taskId}/subtasks`, subtaskListResponseSchema, {
    method: "PUT",
    headers: { "X-CSRF-Token": csrfToken },
    body: JSON.stringify(subtaskOrderSchema.parse({ items })),
  }).then(({ subtasks }) => subtasks);

export const deleteSubtask = (
  subtaskId: string,
  revision: number,
  csrfToken: string,
): Promise<void> =>
  requestEmpty(`/api/subtasks/${subtaskId}`, {
    method: "DELETE",
    headers: conditionalHeaders(revision, csrfToken),
  });

export interface TemplateDraft {
  readonly title: string;
  readonly notes: string;
  readonly estimateMinutes: number | null;
  readonly suggestedProjectId: string | null;
  readonly tagIds: readonly string[];
  readonly subtasks: readonly { readonly title: string }[];
}

export const getTemplateLibrary = (query = "", includeArchived = false) =>
  request(
    `/api/templates?query=${encodeURIComponent(query)}&includeArchived=${String(includeArchived)}`,
    taskTemplateLibraryResponseSchema,
  );

export const createTemplate = (input: TemplateDraft, csrfToken: string) =>
  request("/api/templates", taskTemplateSchema, {
    method: "POST",
    headers: { "X-CSRF-Token": csrfToken },
    body: JSON.stringify(createTaskTemplateRequestSchema.parse(input)),
  });

export const createTemplateFromTask = (taskId: string, csrfToken: string) =>
  request(`/api/templates/from-task/${taskId}`, taskTemplateSchema, {
    method: "POST",
    headers: { "X-CSRF-Token": csrfToken },
    body: JSON.stringify({ taskId }),
  });

export const patchTemplate = (
  templateId: string,
  revision: number,
  input: Partial<TemplateDraft> & { readonly archived?: boolean },
  csrfToken: string,
) =>
  request(`/api/templates/${templateId}`, taskTemplateSchema, {
    method: "PATCH",
    headers: conditionalHeaders(revision, csrfToken),
    body: JSON.stringify(taskTemplatePatchRequestSchema.parse(input)),
  });

export const archiveTemplate = (
  templateId: string,
  revision: number,
  csrfToken: string,
) =>
  request(`/api/templates/${templateId}/archive`, taskTemplateSchema, {
    method: "POST",
    headers: conditionalHeaders(revision, csrfToken),
  });

export const getTemplateSets = () =>
  request("/api/template-sets", templateSetLibraryResponseSchema);

export const createTemplateSet = (
  title: string,
  templateIds: readonly string[],
  csrfToken: string,
) =>
  request("/api/template-sets", templateSetSchema, {
    method: "POST",
    headers: { "X-CSRF-Token": csrfToken },
    body: JSON.stringify(
      createTemplateSetRequestSchema.parse({ title, templateIds }),
    ),
  });

export const instantiateTemplate = (
  templateId: string,
  destinationProjectId: string,
  csrfToken: string,
  idempotencyKey: string,
) =>
  request(
    `/api/templates/${templateId}/instantiate`,
    templateInstantiationResponseSchema,
    {
      method: "POST",
      headers: { "X-CSRF-Token": csrfToken, "Idempotency-Key": idempotencyKey },
      body: JSON.stringify(
        instantiateTemplateRequestSchema.parse({
          destinationProjectId,
          idempotencyKey,
        }),
      ),
    },
  );

export const instantiateTemplateSet = (
  setId: string,
  destinationProjectId: string,
  csrfToken: string,
  idempotencyKey: string,
) =>
  request(
    `/api/template-sets/${setId}/instantiate`,
    templateInstantiationResponseSchema,
    {
      method: "POST",
      headers: { "X-CSRF-Token": csrfToken, "Idempotency-Key": idempotencyKey },
      body: JSON.stringify(
        instantiateTemplateRequestSchema.parse({
          destinationProjectId,
          idempotencyKey,
        }),
      ),
    },
  );

export const getChoicePools = () =>
  request("/api/pools", choicePoolLibraryResponseSchema);

export const createChoicePool = (
  input: {
    readonly title: string;
    readonly policy: "none" | "cooldown" | "cycle" | "one_shot";
    readonly pickCount: number;
    readonly cooldownSeconds: number | null;
    readonly items: readonly { readonly title: string }[];
  },
  csrfToken: string,
) =>
  request(
    "/api/pools",
    z.object({
      pool: choicePoolLibraryResponseSchema.shape.pools.element,
      items: choicePoolLibraryResponseSchema.shape.items,
    }),
    {
      method: "POST",
      headers: { "X-CSRF-Token": csrfToken },
      body: JSON.stringify(createChoicePoolRequestSchema.parse(input)),
    },
  );

export const createPlanningPlaceholder = (
  taskId: string,
  poolId: string,
  csrfToken: string,
) =>
  request("/api/placeholders", planningPlaceholderSchema, {
    method: "POST",
    headers: { "X-CSRF-Token": csrfToken },
    body: JSON.stringify(
      createPlanningPlaceholderRequestSchema.parse({ taskId, poolId }),
    ),
  });

export const patchChoicePool = (
  poolId: string,
  revision: number,
  input: z.infer<typeof updateChoicePoolRequestSchema>,
  csrfToken: string,
) =>
  request(`/api/pools/${poolId}`, choicePoolSchema, {
    method: "PATCH",
    headers: conditionalHeaders(revision, csrfToken),
    body: JSON.stringify(updateChoicePoolRequestSchema.parse(input)),
  });

export const createTemplatePoolSlot = (
  templateId: string,
  input: z.infer<typeof createTemplatePoolSlotRequestSchema>,
  csrfToken: string,
) =>
  request(`/api/templates/${templateId}/pool-slots`, templatePoolSlotSchema, {
    method: "POST",
    headers: { "X-CSRF-Token": csrfToken },
    body: JSON.stringify(createTemplatePoolSlotRequestSchema.parse(input)),
  });

export const recordChoicePoolCompletion = (
  poolId: string,
  itemId: string,
  placeholderId: string | null,
  csrfToken: string,
) =>
  request(
    `/api/pools/${poolId}/items/${itemId}/completions`,
    choicePoolHistoryEventSchema,
    {
      method: "POST",
      headers: { "X-CSRF-Token": csrfToken },
      body: JSON.stringify(
        completeChoicePoolItemRequestSchema.parse({
          placeholderId,
          occurredAt: new Date().toISOString(),
        }),
      ),
    },
  );

export const suggestPlanningPlaceholder = (
  placeholderId: string,
  logicalTime = new Date().toISOString(),
) =>
  request(
    `/api/placeholders/${placeholderId}/suggestion?at=${encodeURIComponent(logicalTime)}`,
    choicePoolSuggestionResponseSchema,
  );

export const resolvePlanningPlaceholder = (
  placeholderId: string,
  input: {
    readonly selectedItemIds: readonly string[];
    readonly logicalTime: string;
    readonly override: boolean;
    readonly expectedRevision: number;
  },
  csrfToken: string,
  idempotencyKey: string,
) =>
  request(
    `/api/placeholders/${placeholderId}/resolve`,
    planningPlaceholderResolutionResponseSchema,
    {
      method: "POST",
      headers: { "X-CSRF-Token": csrfToken },
      body: JSON.stringify(
        resolvePlanningPlaceholderRequestSchema.parse({
          ...input,
          idempotencyKey,
        }),
      ),
    },
  );

export const previewCalendarImport = (
  input: z.infer<typeof calendarImportPreviewRequestSchema>,
  csrfToken: string,
) =>
  request("/api/imports/preview", calendarImportMutationResponseSchema, {
    method: "POST",
    headers: { "X-CSRF-Token": csrfToken },
    body: JSON.stringify(calendarImportPreviewRequestSchema.parse(input)),
  });

export const applyCalendarImport = (jobId: string, csrfToken: string) =>
  request(`/api/imports/${jobId}/apply`, calendarImportMutationResponseSchema, {
    method: "POST",
    headers: { "X-CSRF-Token": csrfToken },
  });

export const listCalendarFeeds = () =>
  request("/api/calendar-feeds", calendarFeedListResponseSchema);

export const createCalendarFeed = (
  calendarId: string,
  label: string,
  csrfToken: string,
) =>
  request("/api/calendar-feeds", calendarFeedCreateResponseSchema, {
    method: "POST",
    headers: { "X-CSRF-Token": csrfToken },
    body: JSON.stringify(
      calendarFeedCreateRequestSchema.parse({ calendarId, label }),
    ),
  });

export const revokeCalendarFeed = (id: string, csrfToken: string) =>
  requestEmpty(`/api/calendar-feeds/${id}`, {
    method: "DELETE",
    headers: { "X-CSRF-Token": csrfToken },
  });

export const previewTaskImport = (rawJson: string, csrfToken: string) =>
  request(
    "/api/imports/super-productivity/preview",
    superProductivityPreviewSchema,
    { method: "POST", headers: { "X-CSRF-Token": csrfToken }, body: rawJson },
  );

export const listAutomationTokens = () =>
  request("/api/automation/tokens", automationTokenListResponseSchema);
export const createAutomationToken = (
  input: CreateAutomationTokenRequest,
  csrfToken: string,
) =>
  request("/api/automation/tokens", createAutomationTokenResponseSchema, {
    method: "POST",
    headers: { "X-CSRF-Token": csrfToken },
    body: JSON.stringify(createAutomationTokenRequestSchema.parse(input)),
  });
export const revokeAutomationToken = (id: string, csrfToken: string) =>
  requestEmpty(`/api/automation/tokens/${id}`, {
    method: "DELETE",
    headers: { "X-CSRF-Token": csrfToken },
  });

export const applyTaskImport = (
  rawJson: string,
  inputHash: string,
  csrfToken: string,
) =>
  request(
    "/api/imports/super-productivity/apply",
    taskImportApplyResponseSchema,
    {
      method: "POST",
      headers: { "X-CSRF-Token": csrfToken, "X-Import-Hash": inputHash },
      body: rawJson,
    },
  );

/**
 * Task attachments and imported issue links are online-only (ADR 0021): they
 * are not cached or queued offline, and no call contacts an issue provider.
 */
export const getTaskLinks = (taskId: string): Promise<TaskLinksResponse> =>
  request(`/api/tasks/${taskId}/links`, taskLinksResponseSchema);

export const createTaskAttachment = (
  taskId: string,
  input: z.input<typeof taskAttachmentCreateRequestSchema>,
  csrfToken: string,
): Promise<TaskLinksResponse> =>
  request(`/api/tasks/${taskId}/attachments`, taskLinksResponseSchema, {
    method: "POST",
    headers: { "X-CSRF-Token": csrfToken },
    body: JSON.stringify(taskAttachmentCreateRequestSchema.parse(input)),
  });

export const patchTaskAttachment = (
  taskId: string,
  attachmentId: string,
  revision: number,
  input: TaskAttachmentPatchRequest,
  csrfToken: string,
): Promise<TaskLinksResponse> =>
  request(
    `/api/tasks/${taskId}/attachments/${attachmentId}`,
    taskLinksResponseSchema,
    {
      method: "PATCH",
      headers: conditionalHeaders(revision, csrfToken),
      body: JSON.stringify(taskAttachmentPatchRequestSchema.parse(input)),
    },
  );

export const deleteTaskAttachment = (
  taskId: string,
  attachmentId: string,
  revision: number,
  csrfToken: string,
): Promise<void> =>
  requestEmpty(`/api/tasks/${taskId}/attachments/${attachmentId}`, {
    method: "DELETE",
    headers: conditionalHeaders(revision, csrfToken),
  });

export const deleteTaskIssueLink = (
  taskId: string,
  linkId: string,
  revision: number,
  csrfToken: string,
): Promise<void> =>
  requestEmpty(`/api/tasks/${taskId}/issue-link/${linkId}`, {
    method: "DELETE",
    headers: conditionalHeaders(revision, csrfToken),
  });
// ADR 0022 archived history. Online-only: archive state is not a sync v2
// operation, so the browser never queues archive or restore offline.
export const getTaskHistory = (
  input: { readonly query?: string; readonly cursor?: string | null } = {},
): Promise<TaskHistoryResponse> => {
  const params = new URLSearchParams();
  if (input.query !== undefined && input.query.trim() !== "")
    params.set("query", input.query.trim());
  if (input.cursor != null) params.set("cursor", input.cursor);
  const query = params.toString();
  return request(
    `/api/tasks/history${query === "" ? "" : `?${query}`}`,
    taskHistoryResponseSchema,
  );
};

const taskArchiveRequest = (
  action: "archive" | "unarchive",
  taskId: string,
  revision: number,
  csrfToken: string,
): Promise<TaskArchiveMutationResponse> =>
  request(
    `/api/tasks/${encodeURIComponent(taskId)}/${action}`,
    taskArchiveMutationResponseSchema,
    {
      method: "POST",
      headers: {
        "X-CSRF-Token": csrfToken,
        "If-Match": `"${String(revision)}"`,
      },
      body: "{}",
    },
  );

export const archiveTask = (
  taskId: string,
  revision: number,
  csrfToken: string,
): Promise<TaskArchiveMutationResponse> =>
  taskArchiveRequest("archive", taskId, revision, csrfToken);

export const unarchiveTask = (
  taskId: string,
  revision: number,
  csrfToken: string,
): Promise<TaskArchiveMutationResponse> =>
  taskArchiveRequest("unarchive", taskId, revision, csrfToken);

// ADR 0023 recurring series. Series writes are online-only revisioned HTTP
// requests; generated instances arrive as ordinary tasks through sync.
export const getRecurringSeries = (): Promise<RecurringSeriesListResponse> =>
  request("/api/recurring-series", recurringSeriesListResponseSchema);

export const createRecurringSeries = (
  input: RecurringSeriesCreateRequest,
  csrfToken: string,
  idempotencyKey: string = crypto.randomUUID(),
): Promise<RecurringSeriesMutationResponse> =>
  request("/api/recurring-series", recurringSeriesMutationResponseSchema, {
    method: "POST",
    headers: { "X-CSRF-Token": csrfToken, "Idempotency-Key": idempotencyKey },
    body: JSON.stringify(recurringSeriesCreateRequestSchema.parse(input)),
  });

export const patchRecurringSeries = (
  seriesId: string,
  revision: number,
  patch: RecurringSeriesPatchRequest,
  csrfToken: string,
): Promise<RecurringSeriesMutationResponse> =>
  request(
    `/api/recurring-series/${encodeURIComponent(seriesId)}`,
    recurringSeriesMutationResponseSchema,
    {
      method: "PATCH",
      headers: conditionalHeaders(revision, csrfToken),
      body: JSON.stringify(recurringSeriesPatchRequestSchema.parse(patch)),
    },
  );

export const setRecurringSeriesState = (
  seriesId: string,
  revision: number,
  action: "pause" | "resume" | "end",
  csrfToken: string,
): Promise<RecurringSeriesMutationResponse> =>
  request(
    `/api/recurring-series/${encodeURIComponent(seriesId)}/state`,
    recurringSeriesMutationResponseSchema,
    {
      method: "POST",
      headers: conditionalHeaders(revision, csrfToken),
      body: JSON.stringify({ action }),
    },
  );

export const changeRecurrenceOccurrence = (
  seriesId: string,
  revision: number,
  date: string,
  action: "skip" | "unskip" | "delete_instance",
  csrfToken: string,
): Promise<RecurringSeriesMutationResponse> =>
  request(
    `/api/recurring-series/${encodeURIComponent(seriesId)}/occurrences/${encodeURIComponent(date)}`,
    recurringSeriesMutationResponseSchema,
    {
      method: "POST",
      headers: conditionalHeaders(revision, csrfToken),
      body: JSON.stringify(recurrenceOccurrenceRequestSchema.parse({ action })),
    },
  );

// Work history (ADR 0024) is online-only: reads and writes go to the server.
export const getTimeReport = (from: string, to: string): Promise<TimeReport> =>
  request(
    `/api/time/report?${new URLSearchParams({ from, to }).toString()}`,
    timeReportResponseSchema,
  );

export const createTimeEntry = (
  entry: TimeEntryCreateRequest,
  csrfToken: string,
): Promise<TimeEntryMutationResponse> =>
  request("/api/time/entries", timeEntryMutationResponseSchema, {
    method: "POST",
    headers: { "X-CSRF-Token": csrfToken },
    body: JSON.stringify(entry),
  });

export const updateTimeEntry = (
  id: string,
  revision: number,
  patch: TimeEntryPatchRequest,
  csrfToken: string,
): Promise<TimeEntryMutationResponse> =>
  request(
    `/api/time/entries/${encodeURIComponent(id)}`,
    timeEntryMutationResponseSchema,
    {
      method: "PATCH",
      headers: {
        "X-CSRF-Token": csrfToken,
        "If-Match": `"${String(revision)}"`,
      },
      body: JSON.stringify(patch),
    },
  );

export const deleteTimeEntry = (
  id: string,
  revision: number,
  csrfToken: string,
): Promise<TimeEntryMutationResponse> =>
  request(
    `/api/time/entries/${encodeURIComponent(id)}`,
    timeEntryMutationResponseSchema,
    {
      method: "DELETE",
      headers: {
        "X-CSRF-Token": csrfToken,
        "If-Match": `"${String(revision)}"`,
      },
    },
  );

// Counters and daily evaluations (ADR 0025) are online-only HTTP records.
export const getCounterHistory = (
  from: string,
  to: string,
): Promise<CounterHistory> =>
  request(
    `/api/counters?${new URLSearchParams({ from, to }).toString()}`,
    counterHistoryResponseSchema,
  );

export const createCounter = (
  counter: CounterCreateRequest,
  csrfToken: string,
): Promise<CounterMutationResponse> =>
  request("/api/counters", counterMutationResponseSchema, {
    method: "POST",
    headers: { "X-CSRF-Token": csrfToken },
    body: JSON.stringify(counter),
  });

export const updateCounter = (
  id: string,
  revision: number,
  patch: CounterPatchRequest,
  csrfToken: string,
): Promise<CounterMutationResponse> =>
  request(
    `/api/counters/${encodeURIComponent(id)}`,
    counterMutationResponseSchema,
    {
      method: "PATCH",
      headers: conditionalHeaders(revision, csrfToken),
      body: JSON.stringify(patch),
    },
  );

export const deleteCounter = (
  id: string,
  revision: number,
  csrfToken: string,
): Promise<CounterMutationResponse> =>
  request(
    `/api/counters/${encodeURIComponent(id)}`,
    counterMutationResponseSchema,
    { method: "DELETE", headers: conditionalHeaders(revision, csrfToken) },
  );

export const recordCounterDay = (
  id: string,
  day: string,
  write: CounterDayWriteRequest,
  csrfToken: string,
): Promise<CounterMutationResponse> =>
  request(
    `/api/counters/${encodeURIComponent(id)}/days/${encodeURIComponent(day)}`,
    counterMutationResponseSchema,
    {
      method: "POST",
      headers: { "X-CSRF-Token": csrfToken },
      body: JSON.stringify(write),
    },
  );

export const controlCounterStopwatch = (
  id: string,
  revision: number,
  action: "start" | "stop",
  csrfToken: string,
): Promise<CounterMutationResponse> =>
  request(
    `/api/counters/${encodeURIComponent(id)}/stopwatch`,
    counterMutationResponseSchema,
    {
      method: "POST",
      headers: conditionalHeaders(revision, csrfToken),
      body: JSON.stringify({ action }),
    },
  );

export const getEvaluations = (
  from: string,
  to: string,
): Promise<EvaluationList> =>
  request(
    `/api/evaluations?${new URLSearchParams({ from, to }).toString()}`,
    evaluationListResponseSchema,
  );

export const saveEvaluation = (
  day: string,
  write: EvaluationWriteRequest,
  csrfToken: string,
): Promise<EvaluationMutationResponse> =>
  request(
    `/api/evaluations/${encodeURIComponent(day)}`,
    evaluationMutationResponseSchema,
    {
      method: "PUT",
      headers: { "X-CSRF-Token": csrfToken },
      body: JSON.stringify(write),
    },
  );
// Imported plugin data (ADR 0026) is online-only. Listings carry sizes and
// flags; only an explicit download reads an entry's opaque data.
export const getPluginData = (): Promise<PluginDataListResponse> =>
  request("/api/plugin-data", pluginDataListResponseSchema);

export const getPluginDataContent = (
  id: string,
): Promise<PluginDataContentResponse> =>
  request(
    `/api/plugin-data/entries/${encodeURIComponent(id)}`,
    pluginDataContentResponseSchema,
  );

export const deletePluginDataEntry = (
  id: string,
  revision: number,
  csrfToken: string,
): Promise<void> =>
  requestEmpty(`/api/plugin-data/entries/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: conditionalHeaders(revision, csrfToken),
  });

export const deletePluginMetadata = (
  id: string,
  revision: number,
  csrfToken: string,
): Promise<void> =>
  requestEmpty(`/api/plugin-data/plugins/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: conditionalHeaders(revision, csrfToken),
  });
// Saved Today and planner-day order (ADR 0027). Online-only.
export const getDayOrders = (
  from: string,
  to: string,
): Promise<readonly DayOrder[]> =>
  request(
    `/api/day-orders?${new URLSearchParams({ from, to }).toString()}`,
    dayOrderListResponseSchema,
  ).then(({ dayOrders }) => dayOrders);

export const reorderDayOrder = (
  date: string,
  expectedRevision: number,
  taskIds: readonly string[],
  csrfToken: string,
): Promise<DayOrder> =>
  request(
    `/api/day-orders/${encodeURIComponent(date)}`,
    dayOrderResponseSchema,
    {
      method: "PUT",
      headers: { "X-CSRF-Token": csrfToken },
      body: JSON.stringify(
        dayOrderReorderRequestSchema.parse({ expectedRevision, taskIds }),
      ),
    },
  ).then(({ dayOrder }) => dayOrder);

export const planTasksForDay = (
  date: string,
  plan: DayOrderPlanRequest,
  csrfToken: string,
): Promise<{
  readonly dayOrder: DayOrder;
  readonly tasks: readonly DayOrderPlannedTask[];
}> =>
  request(
    `/api/day-orders/${encodeURIComponent(date)}/tasks`,
    dayOrderPlanResponseSchema,
    {
      method: "POST",
      headers: { "X-CSRF-Token": csrfToken },
      body: JSON.stringify(dayOrderPlanRequestSchema.parse(plan)),
    },
  );

// Boards, sections, saved task views and sidebar folders (issue #63, ADR
// 0028). Online-only HTTP records with revisions; nothing here is cached.

export const getBoards = (): Promise<readonly Board[]> =>
  request("/api/boards", boardListResponseSchema).then(({ boards }) => boards);

export const getBoardView = (boardId: string): Promise<BoardView> =>
  request(
    `/api/boards/${encodeURIComponent(boardId)}`,
    boardViewResponseSchema,
  ).then(({ view }) => view);

export const createBoard = (
  input: z.input<typeof boardCreateRequestSchema>,
  csrfToken: string,
): Promise<Board> =>
  request("/api/boards", boardResponseSchema, {
    method: "POST",
    headers: { "X-CSRF-Token": csrfToken },
    body: JSON.stringify(boardCreateRequestSchema.parse(input)),
  }).then(({ board }) => board);

export const updateBoard = (
  boardId: string,
  input: z.input<typeof boardUpdateRequestSchema>,
  csrfToken: string,
): Promise<Board> =>
  request(`/api/boards/${encodeURIComponent(boardId)}`, boardResponseSchema, {
    method: "PUT",
    headers: { "X-CSRF-Token": csrfToken },
    body: JSON.stringify(boardUpdateRequestSchema.parse(input)),
  }).then(({ board }) => board);

export const reorderBoards = (
  items: readonly { readonly id: string; readonly revision: number }[],
  csrfToken: string,
): Promise<readonly Board[]> =>
  request("/api/boards/order", boardListResponseSchema, {
    method: "PUT",
    headers: { "X-CSRF-Token": csrfToken },
    body: JSON.stringify(boardOrderRequestSchema.parse({ items })),
  }).then(({ boards }) => boards);

export const deleteBoard = (
  boardId: string,
  revision: number,
  csrfToken: string,
): Promise<void> =>
  requestEmpty(`/api/boards/${encodeURIComponent(boardId)}`, {
    method: "DELETE",
    headers: conditionalHeaders(revision, csrfToken),
  });

export const reorderBoardPanel = (
  boardId: string,
  panelId: string,
  input: z.input<typeof boardPanelOrderRequestSchema>,
  csrfToken: string,
): Promise<BoardView> =>
  request(
    `/api/boards/${encodeURIComponent(boardId)}/panels/${encodeURIComponent(panelId)}/order`,
    boardViewResponseSchema,
    {
      method: "PUT",
      headers: { "X-CSRF-Token": csrfToken },
      body: JSON.stringify(boardPanelOrderRequestSchema.parse(input)),
    },
  ).then(({ view }) => view);

/** With `dryRun`, returns the change list without applying it. */
export const moveTaskToPanel = (
  boardId: string,
  panelId: string,
  input: z.input<typeof boardMoveRequestSchema>,
  csrfToken: string,
): Promise<BoardMoveResponse> =>
  request(
    `/api/boards/${encodeURIComponent(boardId)}/panels/${encodeURIComponent(panelId)}/tasks`,
    boardMoveResponseSchema,
    {
      method: "POST",
      headers: { "X-CSRF-Token": csrfToken },
      body: JSON.stringify(boardMoveRequestSchema.parse(input)),
    },
  );

export const getSections = (
  contextKind: SectionContextKind,
  contextId: string,
): Promise<readonly Section[]> =>
  request(
    `/api/sections?${new URLSearchParams({ contextKind, contextId }).toString()}`,
    sectionListResponseSchema,
  ).then(({ sections }) => sections);

export const createSection = (
  input: SectionCreateRequest,
  csrfToken: string,
): Promise<readonly Section[]> =>
  request("/api/sections", sectionListResponseSchema, {
    method: "POST",
    headers: { "X-CSRF-Token": csrfToken },
    body: JSON.stringify(sectionCreateRequestSchema.parse(input)),
  }).then(({ sections }) => sections);

export const updateSection = (
  sectionId: string,
  input: SectionUpdateRequest,
  csrfToken: string,
): Promise<readonly Section[]> =>
  request(
    `/api/sections/${encodeURIComponent(sectionId)}`,
    sectionListResponseSchema,
    {
      method: "PUT",
      headers: { "X-CSRF-Token": csrfToken },
      body: JSON.stringify(sectionUpdateRequestSchema.parse(input)),
    },
  ).then(({ sections }) => sections);

export const reorderSections = (
  input: z.input<typeof sectionOrderRequestSchema>,
  csrfToken: string,
): Promise<readonly Section[]> =>
  request("/api/sections/order", sectionListResponseSchema, {
    method: "PUT",
    headers: { "X-CSRF-Token": csrfToken },
    body: JSON.stringify(sectionOrderRequestSchema.parse(input)),
  }).then(({ sections }) => sections);

export const deleteSection = (
  sectionId: string,
  revision: number,
  csrfToken: string,
): Promise<readonly Section[]> =>
  request(
    `/api/sections/${encodeURIComponent(sectionId)}`,
    sectionListResponseSchema,
    { method: "DELETE", headers: conditionalHeaders(revision, csrfToken) },
  ).then(({ sections }) => sections);

export const getTaskViews = (): Promise<readonly TaskView[]> =>
  request("/api/task-views", taskViewListResponseSchema).then(
    ({ views }) => views,
  );

export const setTaskView = (
  input: z.input<typeof taskViewSetRequestSchema>,
  csrfToken: string,
): Promise<TaskView> =>
  request("/api/task-views", taskViewResponseSchema, {
    method: "PUT",
    headers: { "X-CSRF-Token": csrfToken },
    body: JSON.stringify(taskViewSetRequestSchema.parse(input)),
  }).then(({ view }) => view);

export const getMenuFolders = (): Promise<readonly MenuFolder[]> =>
  request("/api/menu-folders", menuFolderListResponseSchema).then(
    ({ folders }) => folders,
  );

export const createMenuFolder = (
  input: z.input<typeof menuFolderCreateRequestSchema>,
  csrfToken: string,
): Promise<readonly MenuFolder[]> =>
  request("/api/menu-folders", menuFolderListResponseSchema, {
    method: "POST",
    headers: { "X-CSRF-Token": csrfToken },
    body: JSON.stringify(menuFolderCreateRequestSchema.parse(input)),
  }).then(({ folders }) => folders);

export const updateMenuFolder = (
  folderId: string,
  input: MenuFolderUpdateRequest,
  csrfToken: string,
): Promise<readonly MenuFolder[]> =>
  request(
    `/api/menu-folders/${encodeURIComponent(folderId)}`,
    menuFolderListResponseSchema,
    {
      method: "PUT",
      headers: { "X-CSRF-Token": csrfToken },
      body: JSON.stringify(menuFolderUpdateRequestSchema.parse(input)),
    },
  ).then(({ folders }) => folders);

export const reorderMenuFolders = (
  input: z.input<typeof menuFolderOrderRequestSchema>,
  csrfToken: string,
): Promise<readonly MenuFolder[]> =>
  request("/api/menu-folders/order", menuFolderListResponseSchema, {
    method: "PUT",
    headers: { "X-CSRF-Token": csrfToken },
    body: JSON.stringify(menuFolderOrderRequestSchema.parse(input)),
  }).then(({ folders }) => folders);

export const deleteMenuFolder = (
  folderId: string,
  revision: number,
  csrfToken: string,
): Promise<readonly MenuFolder[]> =>
  request(
    `/api/menu-folders/${encodeURIComponent(folderId)}`,
    menuFolderListResponseSchema,
    { method: "DELETE", headers: conditionalHeaders(revision, csrfToken) },
  ).then(({ folders }) => folders);
// Focus presets, idle disposition and break reminders (issue #65, ADR 0029).
// Online-only: nothing here is cached or queued offline.

export const getFocusPreferences = (): Promise<FocusPreferencesResponse> =>
  request("/api/focus/preferences", focusPreferencesResponseSchema);

export const updateFocusPreferences = (
  preferences: FocusPreferences,
  revision: number,
  csrfToken: string,
): Promise<FocusPreferencesResponse> =>
  request("/api/focus/preferences", focusPreferencesResponseSchema, {
    method: "PUT",
    headers: {
      "X-CSRF-Token": csrfToken,
      "If-Match": `"${String(revision)}"`,
    },
    body: JSON.stringify(focusPreferencesSchema.parse(preferences)),
  });

export const getFocusTimer = (
  client: LocalClientIdentity,
): Promise<FocusTimer> =>
  request("/api/focus/timer", focusTimerSchema, {
    headers: clientProofHeaders(client),
  });

export const setFocusPlan = (
  client: LocalClientIdentity,
  csrfToken: string,
  plan: FocusPlanRequest,
): Promise<FocusTimer> =>
  request("/api/focus/plan", focusTimerSchema, {
    method: "PUT",
    headers: { ...clientProofHeaders(client), "X-CSRF-Token": csrfToken },
    body: JSON.stringify(focusPlanRequestSchema.parse(plan)),
  });

export const applyIdleDisposition = (
  client: LocalClientIdentity,
  csrfToken: string,
  input: FocusIdleRequest,
): Promise<FocusIdleResponse> =>
  request("/api/focus/idle", focusIdleResponseSchema, {
    method: "POST",
    headers: { ...clientProofHeaders(client), "X-CSRF-Token": csrfToken },
    body: JSON.stringify(focusIdleRequestSchema.parse(input)),
  });

export const snoozeBreakReminder = (
  csrfToken: string,
): Promise<{ readonly snoozedUntil: string }> =>
  request("/api/focus/break-reminder/snooze", focusBreakSnoozeResponseSchema, {
    method: "POST",
    headers: { "X-CSRF-Token": csrfToken },
    body: "{}",
  });

// Capture syntax (issue #90, ADR 0031): online-only preview, batch and settings.
export const previewTaskCapture = (
  input: CapturePreviewRequest,
  csrfToken: string,
): Promise<CapturePreviewResponse> =>
  request("/api/tasks/capture-preview", capturePreviewResponseSchema, {
    method: "POST",
    headers: { "X-CSRF-Token": csrfToken },
    body: JSON.stringify(input),
  });

export const createTaskBatch = (
  input: TaskBatchCreateRequest,
  csrfToken: string,
  idempotencyKey: string,
): Promise<TaskBatchMutationResponse> =>
  request("/api/tasks/batch", taskBatchMutationResponseSchema, {
    method: "POST",
    headers: { "X-CSRF-Token": csrfToken, "Idempotency-Key": idempotencyKey },
    body: JSON.stringify(input),
  });

export const getCapturePreferences = (): Promise<CapturePreferencesResponse> =>
  request("/api/capture-preferences", capturePreferencesResponseSchema);

export const updateCapturePreferences = (
  preferences: CapturePreferences,
  expectedRevision: number,
  csrfToken: string,
): Promise<CapturePreferencesResponse> =>
  request("/api/capture-preferences", capturePreferencesResponseSchema, {
    method: "PUT",
    headers: { "X-CSRF-Token": csrfToken },
    body: JSON.stringify({ preferences, expectedRevision }),
  });
// Read-only iCal subscriptions (ADR 0032). Online-only and owner-only: the
// feed address is sent once on create or change and never read back.
export const listCalendarSubscriptions =
  (): Promise<CalendarSubscriptionListResponse> =>
    request(
      "/api/calendar-subscriptions",
      calendarSubscriptionListResponseSchema,
    );

export const createCalendarSubscription = (
  input: CalendarSubscriptionCreateRequest,
  csrfToken: string,
): Promise<CalendarSubscriptionRefreshResponse> =>
  request(
    "/api/calendar-subscriptions",
    calendarSubscriptionRefreshResponseSchema,
    {
      method: "POST",
      headers: { "X-CSRF-Token": csrfToken },
      body: JSON.stringify(
        calendarSubscriptionCreateRequestSchema.parse(input),
      ),
    },
  );

export const updateCalendarSubscription = (
  id: string,
  revision: number,
  input: CalendarSubscriptionPatchRequest,
  csrfToken: string,
): Promise<CalendarSubscriptionMutationResponse> =>
  request(
    `/api/calendar-subscriptions/${encodeURIComponent(id)}`,
    calendarSubscriptionMutationResponseSchema,
    {
      method: "PATCH",
      headers: conditionalHeaders(revision, csrfToken),
      body: JSON.stringify(calendarSubscriptionPatchRequestSchema.parse(input)),
    },
  );

export const deleteCalendarSubscription = (
  id: string,
  revision: number,
  csrfToken: string,
): Promise<void> =>
  requestEmpty(`/api/calendar-subscriptions/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: conditionalHeaders(revision, csrfToken),
  });

export const refreshCalendarSubscription = (
  id: string,
  csrfToken: string,
): Promise<CalendarSubscriptionRefreshResponse> =>
  request(
    `/api/calendar-subscriptions/${encodeURIComponent(id)}/refresh`,
    calendarSubscriptionRefreshResponseSchema,
    { method: "POST", headers: { "X-CSRF-Token": csrfToken } },
  );

export const listCalendarSubscriptionEvents = (
  from: string,
  to: string,
): Promise<CalendarSubscriptionEventListResponse> =>
  request(
    `/api/calendar-subscriptions/events?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    calendarSubscriptionEventListResponseSchema,
  );

export const setCalendarSubscriptionEventHidden = (
  subscriptionId: string,
  event: { readonly uid: string; readonly occurrenceStart: string },
  hidden: boolean,
  csrfToken: string,
): Promise<CalendarSubscriptionEventMutationResponse> =>
  request(
    `/api/calendar-subscriptions/${encodeURIComponent(subscriptionId)}/events/hidden`,
    calendarSubscriptionEventMutationResponseSchema,
    {
      method: "PUT",
      headers: { "X-CSRF-Token": csrfToken },
      body: JSON.stringify({ ...event, hidden }),
    },
  );

export const convertCalendarSubscriptionEvent = (
  subscriptionId: string,
  event: { readonly uid: string; readonly occurrenceStart: string },
  csrfToken: string,
): Promise<CalendarSubscriptionConversionResponse> =>
  request(
    `/api/calendar-subscriptions/${encodeURIComponent(subscriptionId)}/events/convert`,
    calendarSubscriptionConversionResponseSchema,
    {
      method: "POST",
      headers: { "X-CSRF-Token": csrfToken },
      body: JSON.stringify(event),
    },
  );

export const dismissCalendarSubscriptionEvent = (
  subscriptionId: string,
  event: { readonly uid: string; readonly occurrenceStart: string },
  csrfToken: string,
): Promise<CalendarSubscriptionEventMutationResponse> =>
  request(
    `/api/calendar-subscriptions/${encodeURIComponent(subscriptionId)}/events/dismiss`,
    calendarSubscriptionEventMutationResponseSchema,
    {
      method: "POST",
      headers: { "X-CSRF-Token": csrfToken },
      body: JSON.stringify(event),
    },
  );

// Google-Baikal calendar bridge controls (ADR 0041, ADR 0044). Online-only
// and owner-only; no response carries a credential or raw iCalendar.
const bridgePath = "/api/calendar-bridge";
const bridgeMappingPath = (id: string): string =>
  `${bridgePath}/mappings/${encodeURIComponent(id)}`;

export const getCalendarBridgeOverview =
  (): Promise<CalendarBridgeOverviewResponse> =>
    request(`${bridgePath}/overview`, calendarBridgeOverviewResponseSchema);

export const previewCalendarBridgeMapping = (
  input: CalendarBridgeMappingCreateRequest,
  csrfToken: string,
): Promise<CalendarBridgeMappingPreviewResponse> =>
  request(
    `${bridgePath}/mappings/preview`,
    calendarBridgeMappingPreviewResponseSchema,
    {
      method: "POST",
      headers: { "X-CSRF-Token": csrfToken },
      body: JSON.stringify(
        calendarBridgeMappingCreateRequestSchema.parse(input),
      ),
    },
  );

export const createCalendarBridgeMapping = async (
  input: CalendarBridgeMappingCreateRequest,
  csrfToken: string,
): Promise<CalendarBridgeMapping> =>
  (
    await request(
      `${bridgePath}/mappings`,
      z.object({ mapping: calendarBridgeMappingSchema }),
      {
        method: "POST",
        headers: { "X-CSRF-Token": csrfToken },
        body: JSON.stringify(
          calendarBridgeMappingCreateRequestSchema.parse(input),
        ),
      },
    )
  ).mapping;

export const setCalendarBridgeMappingEnabled = async (
  id: string,
  revision: number,
  enabled: boolean,
  csrfToken: string,
): Promise<CalendarBridgeMapping> =>
  (
    await request(
      bridgeMappingPath(id),
      z.object({ mapping: calendarBridgeMappingSchema }),
      {
        method: "PATCH",
        headers: conditionalHeaders(revision, csrfToken),
        body: JSON.stringify({ enabled }),
      },
    )
  ).mapping;

/** Never deletes events; pending writes are discarded only when asked. */
export const removeCalendarBridgeMapping = (
  id: string,
  revision: number,
  cancelPendingWork: boolean,
  csrfToken: string,
): Promise<void> =>
  requestEmpty(
    `${bridgeMappingPath(id)}${cancelPendingWork ? "?pendingWork=cancel" : ""}`,
    { method: "DELETE", headers: conditionalHeaders(revision, csrfToken) },
  );

export const runCalendarBridgeMapping = (
  id: string,
  csrfToken: string,
): Promise<CalendarBridgeRunResponse> =>
  request(`${bridgeMappingPath(id)}/run`, calendarBridgeRunResponseSchema, {
    method: "POST",
    headers: { "X-CSRF-Token": csrfToken },
  });

export const getCalendarBridgeReview = (
  id: string,
): Promise<CalendarBridgeReviewResponse> =>
  request(
    `${bridgeMappingPath(id)}/review`,
    calendarBridgeReviewResponseSchema,
  );

/** `approve` lets the next pass delete the other copy; `keep` unlinks it. */
export const decideCalendarBridgeDeletion = async (
  mappingId: string,
  linkId: string,
  linkRevision: number,
  decision: "approve" | "decline",
  csrfToken: string,
): Promise<CalendarBridgeLink> =>
  (
    await request(
      `${bridgeMappingPath(mappingId)}/links/${encodeURIComponent(linkId)}/${decision}-deletion`,
      z.object({ link: calendarBridgeLinkSchema }),
      { method: "POST", headers: conditionalHeaders(linkRevision, csrfToken) },
    )
  ).link;

export const resolveCalendarBridgeConflict = async (
  mappingId: string,
  conflictId: string,
  linkRevision: number,
  keep: CalendarBridgeSide,
  csrfToken: string,
): Promise<CalendarBridgeOperation> =>
  (
    await request(
      `${bridgeMappingPath(mappingId)}/conflicts/${encodeURIComponent(conflictId)}/resolve`,
      z.object({ operation: calendarBridgeOperationSchema }),
      {
        method: "POST",
        headers: conditionalHeaders(linkRevision, csrfToken),
        body: JSON.stringify({ keep }),
      },
    )
  ).operation;

/**
 * Owner data export and restore (issue #93, ADR 0034). Owner session only;
 * the export is returned as text so the browser saves the exact bytes.
 */
export const downloadDataExport = async (): Promise<{
  readonly filename: string;
  readonly text: string;
}> => {
  const response = await fetch("/api/data/export", {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => undefined);
    const error = apiErrorSchema.safeParse(body);
    const failure = new ApiRequestError(
      response.status,
      error.success ? error.data.code : "INVALID_RESPONSE",
      error.success
        ? error.data.message
        : "The server returned an invalid response",
    );
    reportSessionFailure(failure);
    throw failure;
  }
  const disposition = response.headers.get("content-disposition") ?? "";
  const filename =
    /filename="([^"]+)"/.exec(disposition)?.[1] ?? "tadooer-export.json";
  return { filename, text: await response.text() };
};

export const previewDataRestore = (rawJson: string, csrfToken: string) =>
  request("/api/data/restore/preview", dataRestorePreviewSchema, {
    method: "POST",
    headers: { "X-CSRF-Token": csrfToken },
    body: rawJson,
  });

export const applyDataRestore = (
  rawJson: string,
  inputHash: string,
  mode: DataRestoreMode,
  csrfToken: string,
) =>
  request("/api/data/restore/apply", dataRestoreApplyResponseSchema, {
    method: "POST",
    headers: {
      "X-CSRF-Token": csrfToken,
      "X-Restore-Hash": inputHash,
      "X-Restore-Mode": mode,
    },
    body: rawJson,
  });
