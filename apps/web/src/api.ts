import {
  apiErrorSchema,
  activeSessionCommandResponseSchema,
  activeSessionCommandSchema,
  activeSessionSchema,
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
import { ApiRequestError } from "@suite/contracts";
import { z } from "zod";
import type { LocalClientIdentity } from "./local-store.ts";
import { SyncCursorResetRequired, type SyncTransport } from "./sync-engine.ts";

const request = async <T>(
  path: string,
  schema: z.ZodType<T>,
  init?: RequestInit,
): Promise<T> => {
  const headers = new Headers(init?.headers);
  headers.set("Accept", "application/json");
  if (init?.body !== undefined) headers.set("Content-Type", "application/json");
  const response = await fetch(path, {
    ...init,
    headers,
  });
  const body: unknown = await response.json();
  if (!response.ok) {
    const error = apiErrorSchema.safeParse(body);
    throw new ApiRequestError(
      response.status,
      error.success ? error.data.code : "INVALID_RESPONSE",
      error.success
        ? error.data.message
        : "The server returned an invalid response",
    );
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
  throw new ApiRequestError(
    response.status,
    error.success ? error.data.code : "INVALID_RESPONSE",
    error.success
      ? error.data.message
      : "The server returned an invalid response",
  );
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

export const getGoogleStatus = (): Promise<GoogleConnectorStatusResponse> =>
  request("/api/connectors/google", googleConnectorStatusResponseSchema);

export const beginGoogleAuthorization = (
  csrfToken: string,
): Promise<{ readonly authorizationUrl: string; readonly expiresAt: string }> =>
  request(
    "/api/connectors/google/authorize",
    googleAuthorizationResponseSchema,
    {
      method: "POST",
      headers: { "X-CSRF-Token": csrfToken },
    },
  );

export const synchronizeGoogle = (
  csrfToken: string,
): Promise<GoogleSyncResponse> =>
  request("/api/connectors/google/sync", googleSyncResponseSchema, {
    method: "POST",
    headers: { "X-CSRF-Token": csrfToken },
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
): Promise<SyncRoundResponse> => {
  try {
    return await request("/api/sync/round", syncRoundResponseSchema, {
      method: "POST",
      headers: {
        ...clientProofHeaders(client),
        "X-CSRF-Token": csrfToken,
        "X-Suite-Sync-Version": "2",
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
      serverTimestamp: page.serverTimestamp,
    };
  }
  throw new Error("Sync snapshot kept changing during pagination");
};

export const createSyncTransport = (csrfToken: string): SyncTransport => ({
  registerClient: () => registerSyncClient(csrfToken),
  snapshot: getSyncSnapshot,
  syncRound: (client, input) => syncRound(client, csrfToken, input),
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
const organizationPatchSchema = z
  .object({
    title: z.string().trim().min(1).max(240).optional(),
    archived: z.literal(true).optional(),
  })
  .refine(({ title, archived }) => title !== undefined || archived === true, {
    message: "Provide an organization title or archive it",
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

export type OrganizationPatch = z.infer<typeof organizationPatchSchema>;
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
  input: OrganizationPatch,
  csrfToken: string,
): Promise<T> =>
  request(path, schema, {
    method: "PATCH",
    headers: conditionalHeaders(revision, csrfToken),
    body: JSON.stringify(organizationPatchSchema.parse(input)),
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
    input,
    csrfToken,
  ).then(({ project }) => project);

export const patchTag = (
  tagId: string,
  revision: number,
  input: OrganizationPatch,
  csrfToken: string,
): Promise<Tag> =>
  patchOrganization(
    `/api/tags/${tagId}`,
    tagResponseSchema,
    revision,
    input,
    csrfToken,
  ).then(({ tag }) => tag);

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
