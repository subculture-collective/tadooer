import { useEffect, useRef } from "react";

/**
 * Browser idle detection (ADR 0029). The web has no operating-system idle
 * API, so "idle" means no pointer, keyboard, scroll or touch input in this
 * window for the configured time, or the tab being hidden for that long. The
 * owner decides on return what the span was; the detector never changes any
 * time by itself.
 */

export type IdleEvent =
  | { readonly kind: "idle"; readonly idleStartedAt: number }
  | {
      readonly kind: "returned";
      readonly idleStartedAt: number;
      readonly returnedAt: number;
    };

export interface IdleTracker {
  /** Records input at `now`; returns a return event when idle ended. */
  activity(now: number): IdleEvent | null;
  /** Evaluates the elapsed time at `now`; returns an idle event once. */
  check(now: number, minIdleMs: number): IdleEvent | null;
  /** Forgets the current idle span without reporting it. */
  reset(now: number): void;
  readonly idleSince: number | null;
}

export const createIdleTracker = (startedAt: number): IdleTracker => {
  let lastActivityAt = startedAt;
  let idleSince: number | null = null;
  return {
    get idleSince() {
      return idleSince;
    },
    activity(now) {
      const since = idleSince;
      lastActivityAt = now;
      if (since === null) return null;
      idleSince = null;
      return { kind: "returned", idleStartedAt: since, returnedAt: now };
    },
    check(now, minIdleMs) {
      if (idleSince !== null) return null;
      if (now - lastActivityAt < minIdleMs) return null;
      idleSince = lastActivityAt;
      return { kind: "idle", idleStartedAt: lastActivityAt };
    },
    reset(now) {
      idleSince = null;
      lastActivityAt = now;
    },
  };
};

const activityEvents = [
  "pointerdown",
  "pointermove",
  "keydown",
  "wheel",
  "touchstart",
] as const;

export interface UseIdleDetectionOptions {
  /** False disables detection and clears any pending span. */
  readonly enabled: boolean;
  readonly minIdleMs: number;
  readonly onReturn: (idleStartedAt: string, returnedAt: string) => void;
  readonly pollMs?: number;
}

/**
 * Runs the tracker against window input while `enabled`. A hidden document
 * counts as no input; becoming visible again is the return.
 */
export const useIdleDetection = ({
  enabled,
  minIdleMs,
  onReturn,
  pollMs = 15_000,
}: UseIdleDetectionOptions): void => {
  const callback = useRef(onReturn);
  callback.current = onReturn;
  useEffect(() => {
    if (!enabled || typeof window === "undefined") return;
    const tracker = createIdleTracker(Date.now());
    const report = (event: IdleEvent | null) => {
      if (event?.kind === "returned")
        callback.current(
          new Date(event.idleStartedAt).toISOString(),
          new Date(event.returnedAt).toISOString(),
        );
    };
    const onActivity = () => {
      if (document.hidden) return;
      // Input after a long hidden stretch is the return; check first so the
      // span is detected before it is closed.
      tracker.check(Date.now(), minIdleMs);
      report(tracker.activity(Date.now()));
    };
    const onVisibility = () => {
      if (!document.hidden) onActivity();
    };
    const timer = window.setInterval(() => {
      tracker.check(Date.now(), minIdleMs);
    }, pollMs);
    for (const name of activityEvents)
      window.addEventListener(name, onActivity, { passive: true });
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(timer);
      for (const name of activityEvents)
        window.removeEventListener(name, onActivity);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [enabled, minIdleMs, pollMs]);
};
