import { readNotificationStatus } from "../notification-status.ts";
import { notificationPreferencesSchema } from "@suite/contracts";
import { sendJson, sendError, readJson, sameOrigin } from "../http-utils.ts";
import type { RouteHandler } from "./shared.ts";

export const handleNotifications: RouteHandler = async (
  request,
  response,
  url,
  ctx,
) => {
  const {
    stores: database,
    auth,
    config,
    ntfy: notificationPublisher,
    triggerNotifications,
  } = ctx;
  const method = request.method ?? "GET";

  if (method === "GET" && url.pathname === "/api/notifications/preferences") {
    const session = auth.authenticate(request, false);
    if (session === undefined) {
      sendError(response, 401, "AUTH_REQUIRED", "Authentication required");
      return true;
    }
    sendJson(
      response,
      200,
      database.getNotificationPreferences(session.owner.id),
    );
    return true;
  }

  if (method === "PUT" && url.pathname === "/api/notifications/preferences") {
    if (!sameOrigin(request)) {
      sendError(
        response,
        403,
        "ORIGIN_REQUIRED",
        "Same-origin request required",
      );
      return true;
    }
    const session = auth.authenticate(request, true);
    if (session === undefined) {
      sendError(response, 401, "AUTH_REQUIRED", "Authentication required");
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
    const parsed = notificationPreferencesSchema.safeParse(
      await readJson(request),
    );
    if (!parsed.success) {
      sendError(
        response,
        400,
        "INVALID_NOTIFICATION_PREFERENCES",
        "Notification preferences are invalid",
      );
      return true;
    }
    const stored = database.putNotificationPreferences(
      session.owner.id,
      parsed.data,
      new Date().toISOString(),
    );
    // Notification delivery will be triggered by the server's periodic timer
    await triggerNotifications?.();
    sendJson(response, 200, stored);
    return true;
  }

  if (method === "GET" && url.pathname === "/api/notifications/status") {
    const session = auth.authenticate(request, false);
    if (session === undefined) {
      sendError(response, 401, "AUTH_REQUIRED", "Authentication required");
      return true;
    }
    sendJson(response, 200, readNotificationStatus(ctx, session.owner.id));
    return true;
  }

  if (method === "POST" && url.pathname === "/api/notifications/test") {
    if (!sameOrigin(request)) {
      sendError(
        response,
        403,
        "ORIGIN_REQUIRED",
        "Same-origin request required",
      );
      return true;
    }
    const session = auth.authenticate(request, true);
    if (session === undefined) {
      sendError(response, 401, "AUTH_REQUIRED", "Authentication required");
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
    if (notificationPublisher === undefined) {
      sendJson(response, 503, {
        accepted: false,
        state: "unavailable",
        errorCode: "NTFY_NOT_CONFIGURED",
      });
      return true;
    }
    const now = new Date().toISOString();
    const result = await notificationPublisher.publish({
      message: "Tadooer test reminder",
      click: `${config.publicOrigin ?? "http://localhost"}/settings`,
    });
    const delivered = result.kind === "delivered";
    const errorCode = delivered ? null : result.errorCode;
    database.recordNotificationTest(
      session.owner.id,
      delivered,
      errorCode,
      now,
    );
    sendJson(response, delivered ? 200 : 502, {
      accepted: delivered,
      state: delivered ? "delivered" : "failed",
      errorCode,
    });
    return true;
  }

  return false;
};
