/**
 * Live sync state of this device (ADR 0045), shown beside the task sync
 * status.
 *
 * - `live`: the hint stream is open; changes from other devices arrive
 *   within a second or two.
 * - `reconnecting`: the stream is down and is being retried; the fallback
 *   triggers keep the device converging meanwhile.
 * - `offline`: the browser reports no network.
 * - `paused`: no stream until the next sign-in (session ended, client
 *   revoked) or in a browser without the needed features. Sync still runs
 *   on load, on return to the page, on an interval and on request.
 */
export type LiveSyncStatus = "live" | "reconnecting" | "offline" | "paused";

/** Short text for the status row. */
export const liveSyncStatusLabel = (status: LiveSyncStatus): string =>
  ({
    live: "live",
    reconnecting: "reconnecting",
    offline: "offline",
    paused: "paused",
  })[status];

/** One sentence for assistive technology and the hover title. */
export const liveSyncStatusDescription = (status: LiveSyncStatus): string =>
  ({
    live: "Changes from your other devices appear here as they happen.",
    reconnecting:
      "Reconnecting to live updates. Changes from other devices arrive at the next sync.",
    offline:
      "This device is offline. Changes from other devices arrive after it reconnects.",
    paused:
      "Live updates are paused. Changes from other devices arrive at the next sync.",
  })[status];

/** Dot colour class shared with the task sync row. */
export const liveSyncStatusDot = (status: LiveSyncStatus): string =>
  status === "live"
    ? "online"
    : status === "reconnecting"
      ? "syncing"
      : "offline";
