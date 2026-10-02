/**
 * Sync triggers that do not depend on the live stream (ADR 0045): the page
 * becoming visible or focused, and an interval while it is visible. A
 * client that receives no hints still converges through these.
 */

/** Visibility and focus trigger at most one sync in this window. */
export const attentionMinGapMs = 5_000;
/** Interval while the stream is down. */
export const fallbackDownIntervalMs = 60_000;
/** Interval while the stream is live. */
export const fallbackLiveIntervalMs = 5 * 60_000;

type Listen = (type: string, listener: () => void) => void;

export interface FallbackEnvironment {
  readonly window: {
    readonly addEventListener: Listen;
    readonly removeEventListener: Listen;
  };
  readonly document: {
    readonly visibilityState: string;
    readonly addEventListener: Listen;
    readonly removeEventListener: Listen;
  };
}

/**
 * `attention` follows the owner returning to the page; `interval` runs with
 * nobody acting, so its rounds must not extend the session.
 */
export type FallbackReason = "attention" | "interval";

export interface FallbackTriggers {
  /** Records that a sync just ran for another reason, delaying the interval. */
  readonly noteSync: () => void;
  readonly dispose: () => void;
}

export const installFallbackTriggers = (options: {
  readonly environment: FallbackEnvironment;
  readonly sync: (reason: FallbackReason) => void;
  readonly isLive: () => boolean;
  readonly now?: () => number;
}): FallbackTriggers => {
  const { environment, sync, isLive } = options;
  const now = options.now ?? Date.now;
  const visible = (): boolean =>
    environment.document.visibilityState === "visible";
  let lastAttention = Number.NEGATIVE_INFINITY;
  let lastSync = now();

  const onAttention = (): void => {
    if (!visible()) return;
    const at = now();
    if (at - lastAttention < attentionMinGapMs) return;
    lastAttention = at;
    lastSync = at;
    sync("attention");
  };
  const onTick = (): void => {
    if (!visible()) return;
    const at = now();
    const interval = isLive() ? fallbackLiveIntervalMs : fallbackDownIntervalMs;
    if (at - lastSync < interval) return;
    lastSync = at;
    sync("interval");
  };

  environment.document.addEventListener("visibilitychange", onAttention);
  environment.window.addEventListener("focus", onAttention);
  const timer = setInterval(onTick, fallbackDownIntervalMs);
  return {
    noteSync: () => {
      lastSync = now();
    },
    dispose: () => {
      clearInterval(timer);
      environment.document.removeEventListener("visibilitychange", onAttention);
      environment.window.removeEventListener("focus", onAttention);
    },
  };
};
