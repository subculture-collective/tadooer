import type { SuiteDatabase } from "@suite/persistence";

const hourMs = 3_600_000;
const dayMs = 86_400_000;

/**
 * ADR 0045 feed retention for the server tick. The returned function prunes
 * the owner's sync feed at most once per hour and logs only a count. It
 * never throws: a failed prune is retried an hour later.
 */
export const createSyncFeedPruner = (
  database: Pick<SuiteDatabase, "pruneSyncChanges">,
  retentionDays: number | undefined,
): ((ownerId: string, now: string) => void) => {
  let lastRunMs: number | undefined;
  return (ownerId, now) => {
    if (retentionDays === undefined || retentionDays <= 0) return;
    const nowMs = Date.parse(now);
    if (Number.isNaN(nowMs)) return;
    // A clock that moved backwards does not hold pruning off.
    if (
      lastRunMs !== undefined &&
      nowMs >= lastRunMs &&
      nowMs - lastRunMs < hourMs
    )
      return;
    lastRunMs = nowMs;
    try {
      const { deleted } = database.pruneSyncChanges(
        ownerId,
        new Date(nowMs - retentionDays * dayMs).toISOString(),
        now,
      );
      if (deleted > 0) console.info("sync.feed.pruned", { deleted });
    } catch {
      console.error("sync.feed.prune_failed");
    }
  };
};

/**
 * Content-free feed retention metrics: how many changes were pruned in the
 * current epoch (the retained floor) and how old the oldest retained change
 * is. Both are 0 before setup and for an empty feed.
 */
export const syncFeedMetricLines = (
  database: Pick<SuiteDatabase, "getActiveOwnerId" | "getSyncRetention">,
  nowMs: number,
): readonly string[] => {
  const ownerId = database.getActiveOwnerId();
  const retention =
    ownerId === undefined
      ? { floor: 0, oldestRetainedAt: null }
      : database.getSyncRetention(ownerId);
  const oldestMs =
    retention.oldestRetainedAt === null
      ? Number.NaN
      : Date.parse(retention.oldestRetainedAt);
  const ageSeconds = Number.isNaN(oldestMs)
    ? 0
    : Math.max(0, Math.floor((nowMs - oldestMs) / 1000));
  return [
    "# HELP suite_sync_feed_pruned_changes Sync feed changes pruned in the current epoch (the retained floor).",
    "# TYPE suite_sync_feed_pruned_changes gauge",
    `suite_sync_feed_pruned_changes ${String(retention.floor)}`,
    "# HELP suite_sync_feed_oldest_change_age_seconds Age of the oldest retained sync feed change.",
    "# TYPE suite_sync_feed_oldest_change_age_seconds gauge",
    `suite_sync_feed_oldest_change_age_seconds ${String(ageSeconds)}`,
  ];
};
