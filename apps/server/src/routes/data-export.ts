import { createHash } from "node:crypto";
import {
  dataExportDocumentSchema,
  dataRestoreLimits as limits,
  dataRestoreModeSchema,
  type DataRestoreApplyResponse,
  type DataRestorePreview,
} from "@suite/contracts";
import { DataRestoreError } from "@suite/persistence";
import { readJson, sameOrigin, sendError, sendJson } from "../http-utils.ts";
import { reauthenticationRequired } from "../reauthentication.ts";
import type { RouteHandler } from "./shared.ts";

/**
 * Owner data export and restore (issue #93, ADR 0034). Every route needs the
 * owner's browser session; automation bearer tokens are never consulted.
 *
 * - GET  /api/data/export           the versioned JSON document as a download
 * - POST /api/data/restore/preview  validate a document; nothing changes
 * - POST /api/data/restore/apply    X-Restore-Hash from the preview and
 *                                   X-Restore-Mode `empty-only` | `replace`
 */

const exportPath = "/api/data/export";
const previewPath = "/api/data/restore/preview";
const applyPath = "/api/data/restore/apply";

const hashOf = (input: unknown): string =>
  createHash("sha256").update(JSON.stringify(input)).digest("hex");

export const handleDataExport: RouteHandler = async (
  request,
  response,
  url,
  { auth, stores, config },
) => {
  const method = request.method ?? "GET";
  const isExport = method === "GET" && url.pathname === exportPath;
  const isRestore =
    method === "POST" &&
    (url.pathname === previewPath || url.pathname === applyPath);
  if (!isExport && !isRestore) return false;
  const session = auth.authenticate(request, isRestore);
  if (session === undefined) {
    sendError(response, 401, "AUTH_REQUIRED", "Authentication required");
    return true;
  }
  const ownerId = session.owner.id;
  if (isExport) {
    if (reauthenticationRequired(auth, session, response)) return true;
    const now = new Date().toISOString();
    const document = stores.dataExport.export(ownerId, now, {
      appVersion: config.build.version,
      appRevision: config.build.revision,
    });
    sendJson(response, 200, document, {
      "Content-Disposition": `attachment; filename="tadooer-export-${now.slice(0, 10)}.json"`,
    });
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
  // ADR 0048: the preview changes nothing and is not gated.
  if (
    url.pathname === applyPath &&
    reauthenticationRequired(auth, session, response)
  )
    return true;
  let input: unknown;
  try {
    input = await readJson(request, limits.bytes);
  } catch (error: unknown) {
    const tooLarge =
      error instanceof Error && error.message === "BODY_TOO_LARGE";
    sendError(
      response,
      tooLarge ? 413 : 400,
      tooLarge ? "BODY_TOO_LARGE" : "INVALID_RESTORE",
      `Expected a Tadooer data export up to ${limits.label}. No data was changed.`,
    );
    return true;
  }
  const parsed = dataExportDocumentSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    sendError(
      response,
      400,
      "INVALID_RESTORE",
      `This file is not a Tadooer data export${issue === undefined ? "" : ` (${issue.path.join(".") || "document"}: ${issue.message})`}. No data was changed.`,
    );
    return true;
  }
  const inputHash = hashOf(input);
  if (url.pathname === previewPath) {
    const preview: DataRestorePreview = {
      inputHash,
      ...stores.dataExport.preview(ownerId, parsed.data),
    };
    sendJson(response, 200, preview);
    return true;
  }
  if (request.headers["x-restore-hash"] !== inputHash) {
    sendError(
      response,
      409,
      "RESTORE_PREVIEW_CHANGED",
      "Preview this exact file before restoring. No data was changed.",
    );
    return true;
  }
  const mode = dataRestoreModeSchema.safeParse(
    request.headers["x-restore-mode"],
  );
  if (!mode.success) {
    sendError(
      response,
      400,
      "RESTORE_MODE_REQUIRED",
      "Choose whether to restore into an empty account or replace existing data. No data was changed.",
    );
    return true;
  }
  try {
    const outcome = stores.dataExport.restore(
      ownerId,
      parsed.data,
      mode.data,
      new Date().toISOString(),
    );
    const body: DataRestoreApplyResponse = {
      mode: outcome.mode,
      restored: [...outcome.restored],
      totalRows: outcome.totalRows,
      deletedRows: outcome.deletedRows,
      restoredAt: outcome.restoredAt,
    };
    sendJson(response, 200, body);
  } catch (error: unknown) {
    if (error instanceof DataRestoreError) {
      sendError(
        response,
        error.code === "RESTORE_TARGET_NOT_EMPTY" ? 409 : 422,
        error.code,
        `${error.message} No data was changed.`,
      );
    } else {
      console.error("data_restore.failed");
      sendError(
        response,
        409,
        "RESTORE_CONFLICT",
        "The export could not be applied to this server. No data was changed.",
      );
    }
  }
  return true;
};
