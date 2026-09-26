import type { ServerResponse } from "node:http";
import {
  calendarSubscriptionCreateRequestSchema,
  calendarSubscriptionEventHiddenRequestSchema,
  calendarSubscriptionEventKeySchema,
  calendarSubscriptionEventQuerySchema,
  calendarSubscriptionPatchRequestSchema,
} from "@suite/contracts";
import {
  expectedRevision,
  readJson,
  sameOrigin,
  sendError,
  sendJson,
} from "../http-utils.ts";
import type {
  EventConversionResult,
  EventStateResult,
  SubscriptionWriteResult,
} from "../calendar-subscriptions.ts";
import { sendEmpty, type RouteHandler } from "./shared.ts";

/**
 * Read-only iCal subscriptions (issue #91, ADR 0032). Owner-only, online-only
 * routes. The feed address is accepted on create and patch and never
 * returned; every response carries the host alone.
 *
 *   GET    /api/calendar-subscriptions
 *   POST   /api/calendar-subscriptions                      create and fetch
 *   PATCH  /api/calendar-subscriptions/:id                  If-Match revision
 *   DELETE /api/calendar-subscriptions/:id                  If-Match revision
 *   POST   /api/calendar-subscriptions/:id/refresh
 *   GET    /api/calendar-subscriptions/events?from&to       with hidden ones
 *   PUT    /api/calendar-subscriptions/:id/events/hidden
 *   POST   /api/calendar-subscriptions/:id/events/convert   task, no duplicate
 *   POST   /api/calendar-subscriptions/:id/events/dismiss   auto-import tombstone
 */

const sendWriteFailure = (
  response: ServerResponse,
  result: Exclude<SubscriptionWriteResult, { kind: "ok" }>,
): void => {
  switch (result.kind) {
    case "limit":
      sendError(
        response,
        409,
        "SUBSCRIPTION_LIMIT",
        "Remove a subscription before adding another",
      );
      return;
    case "invalid_url":
      sendError(
        response,
        400,
        "INVALID_SUBSCRIPTION_URL",
        result.reason === "blocked_address"
          ? "That address cannot be fetched from this server"
          : result.reason === "credentials_in_url"
            ? "Remove the user name and password from the address"
            : "Enter an http(s) or webcal calendar address",
      );
      return;
    case "invalid_filter":
      sendError(
        response,
        400,
        "INVALID_SUBSCRIPTION_FILTER",
        "A title filter is not a safe regular expression",
      );
      return;
    case "not_found":
      sendError(
        response,
        404,
        "SUBSCRIPTION_NOT_FOUND",
        "Calendar subscription not found",
      );
      return;
    case "conflict":
      sendError(
        response,
        412,
        "SUBSCRIPTION_REVISION_CONFLICT",
        "The subscription changed; reload before trying again",
      );
  }
};

const sendEventState = (
  response: ServerResponse,
  result: EventStateResult | EventConversionResult,
  status = 200,
): void => {
  if (result.kind === "not_found")
    sendError(
      response,
      404,
      "SUBSCRIPTION_EVENT_NOT_FOUND",
      "Calendar event not found in the saved feed",
    );
  else if (result.kind === "reference_only")
    sendError(
      response,
      409,
      "SUBSCRIPTION_REFERENCE_ONLY",
      "Events of a reference calendar are context only",
    );
  else
    sendJson(
      response,
      status,
      Object.fromEntries(
        Object.entries(result).filter(([key]) => key !== "kind"),
      ),
    );
};

export const handleCalendarSubscriptions: RouteHandler = async (
  request,
  response,
  url,
  ctx,
) => {
  const { auth, calendarSubscriptions: service, sessionClock } = ctx;
  const method = request.method ?? "GET";
  const collection = url.pathname === "/api/calendar-subscriptions";
  const events = url.pathname === "/api/calendar-subscriptions/events";
  const item =
    /^\/api\/calendar-subscriptions\/([0-9a-f-]{36})(?:\/(refresh|events\/hidden|events\/convert|events\/dismiss))?$/.exec(
      url.pathname,
    );
  if (!collection && !events && item === null) return false;
  const reading = method === "GET" && (collection || events);
  const session = auth.authenticate(request, !reading);
  if (session === undefined) {
    sendError(response, 401, "AUTH_REQUIRED", "Authentication required");
    return true;
  }
  const ownerId = session.owner.id;
  const now = sessionClock.now().toISOString();

  if (reading) {
    if (collection) {
      sendJson(response, 200, { subscriptions: service.list(ownerId, now) });
      return true;
    }
    const window = calendarSubscriptionEventQuerySchema.safeParse(
      Object.fromEntries(url.searchParams.entries()),
    );
    if (!window.success) {
      sendError(
        response,
        400,
        "INVALID_WINDOW",
        "Provide from and to instants at most 31 days apart",
      );
      return true;
    }
    sendJson(response, 200, {
      events: service.events(ownerId, window.data.from, window.data.to),
    });
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

  if (collection && method === "POST") {
    const parsed = calendarSubscriptionCreateRequestSchema.safeParse(
      await readJson(request),
    );
    if (!parsed.success) {
      sendError(
        response,
        400,
        "INVALID_SUBSCRIPTION",
        "Calendar subscription input is invalid",
      );
      return true;
    }
    const created = service.create(ownerId, parsed.data, now);
    if (created.kind !== "ok") {
      sendWriteFailure(response, created);
      return true;
    }
    // The first fetch runs now so the owner sees the outcome at once.
    const refreshed = await service.refresh(
      ownerId,
      created.subscription.id,
      now,
    );
    sendJson(
      response,
      201,
      refreshed ?? {
        subscription: created.subscription,
        fetch: { kind: "failed", errorClass: "not_found" },
      },
    );
    return true;
  }

  if (item === null) {
    sendError(response, 405, "METHOD_NOT_ALLOWED", "Method not allowed");
    return true;
  }
  const id = item[1] ?? "";
  const action = item[2];

  if (action === undefined && method === "PATCH") {
    const revision = expectedRevision(request, response);
    if (revision === undefined) return true;
    const parsed = calendarSubscriptionPatchRequestSchema.safeParse(
      await readJson(request),
    );
    if (!parsed.success) {
      sendError(
        response,
        400,
        "INVALID_SUBSCRIPTION",
        "Calendar subscription input is invalid",
      );
      return true;
    }
    const updated = service.update(ownerId, id, revision, parsed.data, now);
    if (updated.kind !== "ok") {
      sendWriteFailure(response, updated);
      return true;
    }
    sendJson(
      response,
      200,
      { subscription: updated.subscription },
      { ETag: `"${String(updated.subscription.revision)}"` },
    );
    return true;
  }

  if (action === undefined && method === "DELETE") {
    const revision = expectedRevision(request, response);
    if (revision === undefined) return true;
    const result = service.remove(ownerId, id, revision);
    if (result === "deleted") sendEmpty(response, 204);
    else sendWriteFailure(response, { kind: result });
    return true;
  }

  if (action === "refresh" && method === "POST") {
    const refreshed = await service.refresh(ownerId, id, now);
    if (refreshed === undefined)
      sendWriteFailure(response, { kind: "not_found" });
    else sendJson(response, 200, refreshed);
    return true;
  }

  if (action === "events/hidden" && method === "PUT") {
    const parsed = calendarSubscriptionEventHiddenRequestSchema.safeParse(
      await readJson(request),
    );
    if (!parsed.success) {
      sendError(response, 400, "INVALID_EVENT", "Event identity is invalid");
      return true;
    }
    sendEventState(
      response,
      service.setEventHidden({
        ownerId,
        subscriptionId: id,
        ...parsed.data,
        now,
      }),
    );
    return true;
  }

  if (
    (action === "events/convert" || action === "events/dismiss") &&
    method === "POST"
  ) {
    const parsed = calendarSubscriptionEventKeySchema.safeParse(
      await readJson(request),
    );
    if (!parsed.success) {
      sendError(response, 400, "INVALID_EVENT", "Event identity is invalid");
      return true;
    }
    if (action === "events/dismiss") {
      sendEventState(
        response,
        service.dismissEvent({
          ownerId,
          subscriptionId: id,
          ...parsed.data,
          now,
        }),
      );
      return true;
    }
    const converted = service.convertEvent({
      ownerId,
      subscriptionId: id,
      ...parsed.data,
      kind: "manual",
      now,
    });
    sendEventState(
      response,
      converted,
      converted.kind === "ok" && !converted.replayed ? 201 : 200,
    );
    return true;
  }

  sendError(response, 405, "METHOD_NOT_ALLOWED", "Method not allowed");
  return true;
};
