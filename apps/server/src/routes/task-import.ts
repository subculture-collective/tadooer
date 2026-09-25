import { prepareSuperProductivityImport } from "@suite/import-export";
import {
  superProductivityPreviewSchema,
  superProductivityImportLimits as limits,
} from "@suite/contracts";
import { readJson, sameOrigin, sendError, sendJson } from "../http-utils.ts";
import type { RouteHandler } from "./shared.ts";

export const handleTaskImport: RouteHandler = async (
  request,
  response,
  url,
  { auth, stores },
) => {
  if (
    request.method !== "POST" ||
    ![
      "/api/imports/super-productivity/preview",
      "/api/imports/super-productivity/apply",
    ].includes(url.pathname)
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
  try {
    const input = await readJson(request, limits.bytes);
    const { report, records, recurrence, workContexts } =
      prepareSuperProductivityImport(JSON.stringify(input), {
        timeZone: stores.getPlanningPreferences(session.owner.id).timeZone,
      });
    if (url.pathname.endsWith("/preview")) {
      sendJson(response, 200, superProductivityPreviewSchema.parse(report));
    } else if (request.headers["x-import-hash"] !== report.inputHash) {
      sendError(
        response,
        409,
        "IMPORT_PREVIEW_CHANGED",
        "Preview this exact export before importing. No data was changed.",
      );
    } else if (!report.canApply) {
      sendError(
        response,
        422,
        "IMPORT_NOT_READY",
        "Resolve the preview issues before importing. No data was changed.",
      );
    } else {
      try {
        const outcome = stores.importTaskRecords(
          session.owner.id,
          records,
          new Date().toISOString(),
          recurrence,
          { workContexts },
        );
        sendJson(response, 200, outcome);
      } catch {
        sendError(
          response,
          409,
          "IMPORT_CONFLICT",
          "Source records changed or conflict with existing data. No records were imported; existing Tadooer edits were preserved.",
        );
      }
    }
  } catch (error: unknown) {
    const tooLarge =
      error instanceof Error && error.message === "BODY_TOO_LARGE";
    sendError(
      response,
      tooLarge ? 413 : 400,
      tooLarge ? "BODY_TOO_LARGE" : "INVALID_IMPORT",
      `Expected a valid Super Productivity JSON export, up to ${limits.label} and ${String(limits.records)} records. No data was changed.`,
    );
  }
  return true;
};
