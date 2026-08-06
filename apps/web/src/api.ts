import {
  apiErrorSchema,
  baikalStatusResponseSchema,
  taskListResponseSchema,
  taskMutationResponseSchema,
  conditionalTaskMutationResponseSchema,
  plannerResponseSchema,
  taskTimeBlockMutationResponseSchema,
  sessionResponseSchema,
  setupStatusResponseSchema,
  type BaikalConnectRequest,
  type BaikalStatusResponse,
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
} from "@suite/contracts";
import { z } from "zod";

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
