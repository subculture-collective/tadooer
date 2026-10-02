import type { LiveSyncTimers } from "./hub.ts";

/**
 * Test timers for the live sync hub: time moves only through `advance`, and
 * due timeouts and intervals fire in order.
 */
export class ManualLiveSyncTimers implements LiveSyncTimers {
  #now: number;
  #sequence = 0;
  readonly #timers = new Map<
    number,
    { at: number; readonly every: number | undefined; callback: () => void }
  >();

  constructor(start = Date.parse("2026-10-02T12:00:00.000Z")) {
    this.#now = start;
  }

  now(): number {
    return this.#now;
  }

  /** Timers waiting to fire; zero when the hub has no open stream. */
  get pending(): number {
    return this.#timers.size;
  }

  setTimeout(callback: () => void, milliseconds: number): unknown {
    return this.#add(callback, milliseconds, undefined);
  }

  setInterval(callback: () => void, milliseconds: number): unknown {
    return this.#add(callback, milliseconds, milliseconds);
  }

  clearTimeout(handle: unknown): void {
    this.#timers.delete(handle as number);
  }

  clearInterval(handle: unknown): void {
    this.#timers.delete(handle as number);
  }

  advance(milliseconds: number): void {
    const target = this.#now + milliseconds;
    for (;;) {
      let next: [number, { at: number; every: number | undefined }] | undefined;
      for (const entry of this.#timers)
        if (
          entry[1].at <= target &&
          (next === undefined || entry[1].at < next[1].at)
        )
          next = entry;
      if (next === undefined) break;
      const [id] = next;
      const timer = this.#timers.get(id);
      if (timer === undefined) break;
      this.#now = timer.at;
      if (timer.every === undefined) this.#timers.delete(id);
      else timer.at += timer.every;
      timer.callback();
    }
    this.#now = target;
  }

  #add(
    callback: () => void,
    milliseconds: number,
    every: number | undefined,
  ): number {
    this.#sequence += 1;
    this.#timers.set(this.#sequence, {
      at: this.#now + Math.max(0, milliseconds),
      every,
      callback,
    });
    return this.#sequence;
  }
}
