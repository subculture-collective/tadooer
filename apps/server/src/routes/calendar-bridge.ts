import type { ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import {
  calendarBridgeConflictResolveRequestSchema,
  calendarBridgeMappingCreateRequestSchema,
  calendarBridgeMappingPatchRequestSchema,
} from "@suite/contracts";
import type {
  CalendarBridgeConflictRecord,
  CalendarBridgeLinkRecord,
  CalendarBridgeMappingRecord,
  CalendarBridgeOperationRecord,
} from "@suite/persistence";
import {
  expectedRevision,
  readJson,
  sameOrigin,
  sendError,
  sendJson,
} from "../http-utils.ts";
import { sendEmpty, type RouteHandler } from "./shared.ts";

/**
 * Google-Baikal calendar bridge (issue #40, ADR 0041). Owner session and
 * CSRF; online-only. No route deletes provider events or returns secrets.
 *
 *   GET    /api/calendar-bridge/mappings
 *   POST   /api/calendar-bridge/mappings
 *   PATCH  /api/calendar-bridge/mappings/:id                  If-Match, { enabled }
 *   DELETE /api/calendar-bridge/mappings/:id[?pendingWork=cancel]  If-Match
 *   POST   /api/calendar-bridge/mappings/:id/run              one pass
 *   GET    /api/calendar-bridge/mappings/:id/links
 *   POST   /api/calendar-bridge/mappings/:id/links/:linkId/approve-deletion  If-Match
 *   POST   /api/calendar-bridge/mappings/:id/conflicts/:conflictId/resolve   { keep }
 */

const mappingResponse = (mapping: CalendarBridgeMappingRecord) => ({
  id: mapping.id,
  revision: mapping.revision,
  googleCalendarId: mapping.googleCalendarId,
  googleCalendarRef: mapping.googleCalendarRef,
  baikalCalendarId: mapping.baikalCalendarId,
  baikalCalendarRef: mapping.baikalCalendarRef,
  direction: mapping.direction,
  initialSync: mapping.initialSync,
  enabled: mapping.enabled,
  firstPassAt: mapping.firstPassAt,
  lastRunAt: mapping.lastRunAt,
  lastSuccessAt: mapping.lastSuccessAt,
  lastErrorCode: mapping.lastErrorCode,
  createdAt: mapping.createdAt,
  updatedAt: mapping.updatedAt,
});

const linkResponse = (link: CalendarBridgeLinkRecord) => ({
  id: link.id,
  revision: link.revision,
  origin: link.origin,
  googleEventId: link.googleEventId,
  googleIcalUid: link.googleIcalUid,
  baikalHref: link.baikalHref,
  baikalUid: link.baikalUid,
  google: {
    kind: link.google.kind,
    revision: link.google.revision,
    digest: link.google.digest,
  },
  baikal: {
    kind: link.baikal.kind,
    revision: link.baikal.revision,
    digest: link.baikal.digest,
  },
  acceptedKind: link.acceptedKind,
  acceptedDigest: link.acceptedDigest,
  status: link.status,
  statusReason: link.statusReason,
  deletionApproval: link.deletionApproval,
  updatedAt: link.updatedAt,
});

const conflictResponse = (conflict: CalendarBridgeConflictRecord) => ({
  id: conflict.id,
  linkId: conflict.linkId,
  reason: conflict.reason,
  google: {
    kind: conflict.google.kind,
    revision: conflict.google.revision,
    digest: conflict.google.digest,
  },
  baikal: {
    kind: conflict.baikal.kind,
    revision: conflict.baikal.revision,
    digest: conflict.baikal.digest,
  },
  createdAt: conflict.createdAt,
});

const operationResponse = (operation: CalendarBridgeOperationRecord) => ({
  id: operation.id,
  linkId: operation.linkId,
  sequence: operation.sequence,
  target: operation.target,
  action: operation.action,
  reason: operation.reason,
  state: operation.state,
  attempts: operation.attempts,
  lastError: operation.lastError,
  updatedAt: operation.updatedAt,
});

const notFound = (response: ServerResponse): void =>
  sendError(
    response,
    404,
    "BRIDGE_MAPPING_NOT_FOUND",
    "Calendar mapping not found",
  );

const revisionConflict = (response: ServerResponse): void =>
  sendError(
    response,
    412,
    "BRIDGE_REVISION_CONFLICT",
    "The calendar mapping changed; reload before trying again",
  );

export const handleCalendarBridge: RouteHandler = async (
  request,
  response,
  url,
  ctx,
) => {
  const { auth, calendarBridge: service, sessionClock, stores } = ctx;
  const method = request.method ?? "GET";
  const collection = url.pathname === "/api/calendar-bridge/mappings";
  const item =
    /^\/api\/calendar-bridge\/mappings\/([0-9a-f-]{36})(?:\/(run|links)|\/links\/([0-9a-f-]{36})\/approve-deletion|\/conflicts\/([0-9a-f-]{36})\/resolve)?$/.exec(
      url.pathname,
    );
  if (!collection && item === null) return false;
  const reading = method === "GET";
  const session = auth.authenticate(request, !reading);
  if (session === undefined) {
    sendError(response, 401, "AUTH_REQUIRED", "Authentication required");
    return true;
  }
  const ownerId = session.owner.id;
  const store = stores.calendarBridge;
  const now = sessionClock.now();

  if (
    !reading &&
    (!sameOrigin(request) ||
      !auth.csrfMatches(
        session,
        request.headers["x-csrf-token"] as string | undefined,
      ))
  ) {
    sendError(
      response,
      403,
      "CSRF_REQUIRED",
      "Same-origin session and CSRF token required",
    );
    return true;
  }

  if (collection) {
    if (method === "GET") {
      sendJson(response, 200, {
        mappings: store.listMappings(ownerId).map(mappingResponse),
      });
      return true;
    }
    if (method !== "POST") {
      sendError(response, 405, "METHOD_NOT_ALLOWED", "Method not allowed");
      return true;
    }
    const parsed = calendarBridgeMappingCreateRequestSchema.safeParse(
      await readJson(request),
    );
    if (!parsed.success) {
      sendError(
        response,
        400,
        "INVALID_BRIDGE_MAPPING",
        "Calendar mapping input is invalid",
      );
      return true;
    }
    const created = service.createMapping(
      ownerId,
      parsed.data,
      now.toISOString(),
    );
    if (created.kind === "consent-required")
      sendError(
        response,
        409,
        "BRIDGE_WRITE_CONSENT_REQUIRED",
        "Reconnect Google with calendar event write access first",
      );
    else if (created.kind === "invalid-calendar")
      sendError(
        response,
        400,
        "BRIDGE_INVALID_CALENDAR",
        "Choose one connected Google calendar and one Baikal calendar",
      );
    else if (created.kind === "calendar-in-use")
      sendError(
        response,
        409,
        "BRIDGE_CALENDAR_IN_USE",
        "A calendar can belong to only one mapping",
      );
    else
      sendJson(
        response,
        201,
        { mapping: mappingResponse(created.mapping) },
        { ETag: `"${String(created.mapping.revision)}"` },
      );
    return true;
  }

  const mappingId = item?.[1] ?? "";
  const action = item?.[2];
  const linkId = item?.[3];
  const conflictId = item?.[4];
  const mapping = store.getMapping(ownerId, mappingId);
  if (mapping === undefined) {
    notFound(response);
    return true;
  }

  if (action === "links" && method === "GET") {
    sendJson(response, 200, {
      links: store.listLinks(mapping.id).map(linkResponse),
      conflicts: store.listOpenConflicts(mapping.id).map(conflictResponse),
      operations: store
        .listUnfinishedOperations(mapping.id)
        .map(operationResponse),
    });
    return true;
  }

  if (action === "run" && method === "POST") {
    const outcome = await service.runOnce(ownerId, mapping.id, now);
    if (outcome.kind === "not-found") {
      notFound(response);
      return true;
    }
    if (outcome.kind === "busy") {
      sendError(
        response,
        409,
        "BRIDGE_RUN_IN_PROGRESS",
        "A synchronization pass for this mapping is already running",
      );
      return true;
    }
    const current = store.getMapping(ownerId, mapping.id) ?? mapping;
    sendJson(response, 200, {
      outcome: outcome.kind,
      reason:
        outcome.kind === "failed" || outcome.kind === "blocked"
          ? outcome.reason
          : null,
      counts:
        outcome.kind === "completed" || outcome.kind === "failed"
          ? outcome.counts
          : null,
      mapping: mappingResponse(current),
    });
    return true;
  }

  if (linkId !== undefined && method === "POST") {
    const revision = expectedRevision(request, response);
    if (revision === undefined) return true;
    const approved = store.approveDeletion({
      ownerId,
      mappingId: mapping.id,
      linkId,
      expectedRevision: revision,
      now: now.toISOString(),
    });
    if (approved.kind === "approved")
      sendJson(
        response,
        200,
        { link: linkResponse(approved.link) },
        { ETag: `"${String(approved.link.revision)}"` },
      );
    else if (approved.kind === "not-found")
      sendError(response, 404, "BRIDGE_LINK_NOT_FOUND", "Event link not found");
    else if (approved.kind === "conflict")
      sendError(
        response,
        412,
        "BRIDGE_REVISION_CONFLICT",
        "The event link changed; reload before trying again",
      );
    else
      sendError(
        response,
        409,
        "BRIDGE_NO_PENDING_DELETION",
        "This event has no deletion waiting for approval",
      );
    return true;
  }

  if (conflictId !== undefined && method === "POST") {
    const parsed = calendarBridgeConflictResolveRequestSchema.safeParse(
      await readJson(request),
    );
    if (!parsed.success) {
      sendError(
        response,
        400,
        "INVALID_BRIDGE_RESOLUTION",
        "Choose which side to keep",
      );
      return true;
    }
    const resolved = store.resolveConflict({
      ownerId,
      mappingId: mapping.id,
      conflictId,
      keep: parsed.data.keep,
      operationId: randomUUID(),
      now: now.toISOString(),
    });
    if (resolved.kind === "resolved")
      sendJson(response, 200, {
        operation: operationResponse(resolved.operation),
      });
    else if (resolved.kind === "not-found")
      sendError(
        response,
        404,
        "BRIDGE_CONFLICT_NOT_FOUND",
        "Open conflict not found",
      );
    else if (resolved.kind === "busy")
      sendError(
        response,
        409,
        "BRIDGE_WORK_PENDING",
        "Earlier work for this event has not finished",
      );
    else
      sendError(
        response,
        409,
        "BRIDGE_CONFLICT_UNRESOLVABLE",
        "This conflict cannot be resolved by keeping that side",
      );
    return true;
  }

  if (
    action === undefined &&
    linkId === undefined &&
    conflictId === undefined
  ) {
    if (method === "PATCH") {
      const revision = expectedRevision(request, response);
      if (revision === undefined) return true;
      const parsed = calendarBridgeMappingPatchRequestSchema.safeParse(
        await readJson(request),
      );
      if (!parsed.success) {
        sendError(
          response,
          400,
          "INVALID_BRIDGE_MAPPING",
          "Calendar mapping input is invalid",
        );
        return true;
      }
      const updated = store.setMappingEnabled({
        ownerId,
        mappingId: mapping.id,
        expectedRevision: revision,
        enabled: parsed.data.enabled,
        now: now.toISOString(),
      });
      if (updated.kind === "not-found") notFound(response);
      else if (updated.kind === "conflict") revisionConflict(response);
      else
        sendJson(
          response,
          200,
          { mapping: mappingResponse(updated.mapping) },
          { ETag: `"${String(updated.mapping.revision)}"` },
        );
      return true;
    }
    if (method === "DELETE") {
      const revision = expectedRevision(request, response);
      if (revision === undefined) return true;
      const removed = store.removeMapping({
        ownerId,
        mappingId: mapping.id,
        expectedRevision: revision,
        cancelPending: url.searchParams.get("pendingWork") === "cancel",
        now: now.toISOString(),
      });
      if (removed === "removed") sendEmpty(response, 204);
      else if (removed === "not-found") notFound(response);
      else if (removed === "conflict") revisionConflict(response);
      else if (removed === "in-flight")
        sendError(
          response,
          409,
          "BRIDGE_WORK_IN_FLIGHT",
          "A write's outcome is still being confirmed; run a pass first",
        );
      else
        sendError(
          response,
          409,
          "BRIDGE_PENDING_WORK",
          "Pending writes exist; remove with pendingWork=cancel to discard them",
        );
      return true;
    }
  }

  sendError(response, 405, "METHOD_NOT_ALLOWED", "Method not allowed");
  return true;
};
