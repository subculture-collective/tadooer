import {
  applicationPreferenceMutationInputSchema,
  type ApplicationPreferenceSnapshot,
} from "@suite/contracts";
import type {
  ApplicationPreferencesRecord,
  SuiteDatabase,
} from "@suite/persistence";
import { readJson, sameOrigin, sendError, sendJson } from "../http-utils.ts";
import type { RouteHandler } from "./shared.ts";

/**
 * Application preferences and shortcut bindings (issue #67, ADR 0030).
 * Online-only: the record is not in the sync change feed or the offline
 * cache; the browser mirrors only the theme in localStorage for first paint.
 *
 * - GET /api/application/preferences  the record with its revision (0 = defaults)
 * - PUT /api/application/preferences  { expectedRevision, preferences }
 */

export const applicationPreferencesResponse = (
  record: ApplicationPreferencesRecord,
): ApplicationPreferenceSnapshot => ({
  revision: record.revision,
  preferences: record.preferences,
});

export const applicationPreferencesConflictMessage =
  "Application preferences changed elsewhere; reload them before saving";

export const readApplicationPreferences = (
  database: SuiteDatabase,
  ownerId: string,
): ApplicationPreferenceSnapshot =>
  applicationPreferencesResponse(database.applicationPreferences.get(ownerId));

export const handleApplicationPreferences: RouteHandler = async (
  request,
  response,
  url,
  { auth, stores },
) => {
  if (url.pathname !== "/api/application/preferences") return false;
  const method = request.method ?? "GET";
  if (method !== "GET" && method !== "PUT") return false;
  const session = auth.authenticate(request, method === "PUT");
  if (session === undefined) {
    sendError(response, 401, "AUTH_REQUIRED", "Authentication required");
    return true;
  }
  const ownerId = session.owner.id;
  if (method === "GET") {
    sendJson(response, 200, readApplicationPreferences(stores, ownerId));
    return true;
  }
  if (
    !sameOrigin(request) ||
    !auth.csrfMatches(
      session,
      request.headers["x-csrf-token"] as string | undefined,
    )
  ) {
    sendError(
      response,
      403,
      "CSRF_REQUIRED",
      "Same-origin session and CSRF token required",
    );
    return true;
  }
  const parsed = applicationPreferenceMutationInputSchema.safeParse(
    await readJson(request),
  );
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    sendError(
      response,
      400,
      "INVALID_APPLICATION_PREFERENCES",
      issue === undefined
        ? "Application preferences are invalid"
        : `${issue.path.join(".") || "preferences"}: ${issue.message}`,
    );
    return true;
  }
  const result = stores.applicationPreferences.mutate({
    ownerId,
    expectedRevision: parsed.data.expectedRevision,
    preferences: parsed.data.preferences,
    now: new Date().toISOString(),
  });
  if (result.kind === "invalid")
    sendError(response, 400, "INVALID_APPLICATION_PREFERENCES", result.message);
  else if (result.kind === "conflict")
    sendError(
      response,
      412,
      "REVISION_CONFLICT",
      applicationPreferencesConflictMessage,
    );
  else sendJson(response, 200, applicationPreferencesResponse(result.record));
  return true;
};
