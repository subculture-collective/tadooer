import type { NotificationStatusResponse } from "@suite/contracts";
import type { RouteContext } from "./routes/shared.ts";

export const readNotificationStatus = (
  ctx: RouteContext,
  ownerId: string,
): NotificationStatusResponse => {
  const { stores: database, ntfy: notificationPublisher } = ctx;
  const preferences = database.getNotificationPreferences(ownerId);
  const status = database.getNotificationDeliveryStatus(ownerId);
  const last = status.lastDelivery;
  return {
    configured: notificationPublisher !== undefined,
    enabled: preferences.enabled,
    state:
      notificationPublisher === undefined
        ? "unavailable"
        : status.failedCount > 0
          ? "degraded"
          : "ready",
    pendingCount: status.pendingCount,
    failedCount: status.failedCount,
    lastDelivery:
      last === null
        ? null
        : {
            state:
              last.state === "sending" || last.state === "retry"
                ? "pending"
                : last.state,
            kind: last.kind,
            occurredAt: last.updatedAt,
            errorCode: last.errorCode,
          },
  };
};
