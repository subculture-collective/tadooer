/**
 * Time source for the bridge worker, leases and throttle (ADR 0043). Tests
 * substitute a manual clock so scheduling, backoff and shutdown are exact.
 */
export interface SchedulerClock {
  now(): Date;
  /** Runs `callback` once after `ms`; real timers never keep the process alive. */
  setTimeout(callback: () => void, ms: number): { cancel(): void };
}

export const systemSchedulerClock: SchedulerClock = {
  now: () => new Date(),
  setTimeout: (callback, ms) => {
    const handle = setTimeout(callback, ms);
    handle.unref();
    return { cancel: () => clearTimeout(handle) };
  },
};

/** Resolves after `ms` on the given clock. */
export const sleep = (clock: SchedulerClock, ms: number): Promise<void> =>
  new Promise((resolve) => {
    clock.setTimeout(resolve, ms);
  });
