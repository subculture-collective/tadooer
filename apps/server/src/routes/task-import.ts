import { previewSuperProductivity } from "@suite/import-export";
import { superProductivityPreviewSchema } from "@suite/contracts";
import { readJson, sameOrigin, sendError, sendJson } from "../http-utils.ts";
import type { RouteHandler } from "./shared.ts";

export const handleTaskImport: RouteHandler = async (
  request,
  response,
  url,
  { auth },
) => {
  if (
    request.method !== "POST" ||
    url.pathname !== "/api/imports/super-productivity/preview"
  )
    return false;
  const session = auth.authenticate(request, true);
  if (session === undefined) {
    sendError(response, 401, "AUTH_REQUIRED", "Authentication required");
    return true;
  }
  if (!sameOrigin(request)) {
    sendError(response, 403, "ORIGIN_REQUIRED", "Same-origin request required");
    return true;
  }
  if (
    !auth.csrfMatches(
      session,
      request.headers["x-csrf-token"] as string | undefined,
    )
  ) {
    sendError(response, 403, "CSRF_INVALID", "Valid CSRF token required");
    return true;
  }
  const input = await readJson(request);
  try {
    const report = previewSuperProductivity(JSON.stringify(input));
    sendJson(response, 200, superProductivityPreviewSchema.parse(report));
  } catch {
    sendError(
      response,
      400,
      "INVALID_IMPORT",
      "Expected a valid Super Productivity JSON export, up to 4 MiB. No data was changed.",
    );
  }
  return true;
};
