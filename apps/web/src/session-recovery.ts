import type { ApiRequestError } from "@suite/contracts";

export type SessionFailure = "expired" | "csrf";
const listeners = new Set<(failure: SessionFailure) => void>();

export const subscribeSessionFailure = (
  listener: (failure: SessionFailure) => void,
): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const reportSessionFailure = (error: ApiRequestError): void => {
  const failure =
    (error.status === 401 || error.status === 403) &&
    error.code === "AUTH_REQUIRED"
      ? "expired"
      : error.status === 403 &&
          (error.code === "CSRF_INVALID" || error.code === "CSRF_REQUIRED")
        ? "csrf"
        : null;
  if (failure !== null) for (const listener of listeners) listener(failure);
};
