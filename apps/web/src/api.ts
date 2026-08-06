import {
  apiErrorSchema,
  baikalStatusResponseSchema,
  sessionResponseSchema,
  setupStatusResponseSchema,
  type BaikalConnectRequest,
  type BaikalStatusResponse,
  type LoginRequest,
  type OwnerSetupRequest,
  type SessionResponse,
  type SetupStatusResponse,
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
