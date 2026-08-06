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
} from "@suite/contracts";
import { z } from "zod";
import type { LocalClientIdentity } from "./local-store.ts";
import { SyncCursorResetRequired, type SyncTransport } from "./sync-engine.ts";

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

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
      headers: clientProofHeaders(client),
    },
  );

export const getSyncSnapshot = async (
  client: LocalClientIdentity,
): Promise<SyncSnapshotResponse> => {
  const snapshots: SyncEntitySnapshot[] = [];
  let offset = 0;
  let page: SyncSnapshotResponse;
  do {
    page = await getSyncSnapshotPage(client, offset);
    snapshots.push(...page.snapshots);
    offset += page.snapshots.length;
    if (page.hasMore && page.snapshots.length === 0) {
      throw new Error("Sync snapshot page was empty before completion");
    }
  } while (page.hasMore);
  return {
    snapshots,
    nextCursor: page.nextCursor,
    hasMore: false,
    serverTimestamp: page.serverTimestamp,
  };
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

export const deleteSubtask = (
  subtaskId: string,
  revision: number,
  csrfToken: string,
): Promise<void> =>
  requestEmpty(`/api/subtasks/${subtaskId}`, {
    method: "DELETE",
    headers: conditionalHeaders(revision, csrfToken),
  });
