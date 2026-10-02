import type { ServerResponse } from "node:http";
import { reauthenticationRequiredCode } from "@suite/contracts";
import type { AuthenticatedSession, AuthService } from "./auth.ts";
import { sendError } from "./http-utils.ts";

/**
 * The recent-password gate of ADR 0048. A sensitive route calls this after
 * its session and CSRF checks and before it reads the body. On a trusted
 * device whose last password entry is older than
 * `sessionPolicy.recentPasswordMs` it answers 403
 * `REAUTHENTICATION_REQUIRED` and returns true; the client confirms the
 * password at `POST /api/auth/confirm-password` and repeats the request.
 * Ordinary browser sessions always pass.
 */
export const reauthenticationRequired = (
  auth: AuthService,
  session: AuthenticatedSession,
  response: ServerResponse,
): boolean => {
  if (auth.passwordRecentlyConfirmed(session)) return false;
  sendError(
    response,
    403,
    reauthenticationRequiredCode,
    "Confirm your password to continue",
  );
  return true;
};
