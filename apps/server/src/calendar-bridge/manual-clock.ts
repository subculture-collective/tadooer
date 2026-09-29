import type { SchedulerClock } from "./scheduler-clock.ts";

/** Flushes pending promise callbacks and I/O-free microtasks. */
export const settle = async (rounds = 20): Promise<void> => {
  for (let index = 0; index < rounds; index += 1)
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
};

/**
 * Test clock for the bridge worker (ADR 0043): time moves only through
 * `advance` or `set`, and timers fire in due order.
 */
export class ManualClock implements SchedulerClock {
  #now: number;
  #sequence = 0;
  readonly #timers = new Map<
    number,
    { readonly at: number; readonly callback: () => void }
  >();

  constructor(start: string | number) {
    this.#now = typeof start === "number" ? start : Date.parse(start);
  }

  now(): Date {
    return new Date(this.#now);
  }

  setTimeout(callback: () => void, ms: number): { cancel(): void } {
    this.#sequence += 1;
    const id = this.#sequence;
    this.#timers.set(id, { at: this.#now + Math.max(0, ms), callback });
    return {
      cancel: () => {
        this.#timers.delete(id);
      },
    };
  }

  pendingTimers(): number {
    return this.#timers.size;
  }

  /** Jumps the wall clock without firing timers (a clock change). */
  set(time: string | number): void {
    this.#now = typeof time === "number" ? time : Date.parse(time);
  }

  /** Moves time forward, firing every timer due on the way. */
  async advance(ms: number): Promise<void> {
    const target = this.#now + ms;
    for (;;) {
      let next: [number, { at: number; callback: () => void }] | undefined;
      for (const entry of this.#timers)
        if (
          entry[1].at <= target &&
          (next === undefined || entry[1].at < next[1].at)
        )
          next = entry;
      if (next === undefined) break;
      this.#timers.delete(next[0]);
      this.#now = Math.max(this.#now, next[1].at);
      next[1].callback();
      await settle();
    }
    this.#now = target;
    await settle();
  }
}
