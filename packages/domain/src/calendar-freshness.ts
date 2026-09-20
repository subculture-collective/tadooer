/** A successful projection is recent for fifteen minutes, not indefinitely. */
export const GOOGLE_FRESHNESS_MS = 15 * 60 * 1000;

export const googleProjectionFreshness = (
  storedState: "fresh" | "stale" | "unavailable",
  lastSuccessfulSyncAt: string | null,
  now = new Date(),
): {
  readonly state: "fresh" | "stale" | "unavailable";
  readonly message: string;
} => {
  const timestamp =
    lastSuccessfulSyncAt === null ? NaN : Date.parse(lastSuccessfulSyncAt);
  if (!Number.isFinite(timestamp))
    return {
      state: "unavailable",
      message: "Awaiting the first successful Google sync",
    };
  const recent =
    now.getTime() >= timestamp &&
    now.getTime() - timestamp < GOOGLE_FRESHNESS_MS;
  if (storedState === "fresh" && recent)
    return { state: "fresh", message: "Google sync succeeded recently" };
  return {
    state: storedState === "unavailable" ? "unavailable" : "stale",
    message: "Showing saved Google events; refresh to check for changes",
  };
};
