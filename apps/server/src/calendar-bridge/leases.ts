import { randomUUID } from "node:crypto";
import type { SqliteCalendarBridgeWorkerStore } from "@suite/persistence";
import {
  systemSchedulerClock,
  type SchedulerClock,
} from "./scheduler-clock.ts";

export const defaultLeaseMs = 10 * 60_000;

/**
 * Cross-process leases for bridge work (ADR 0043). A lease row in the shared
 * SQLite file names one holder per key; the holder renews it every third of
 * the lease while work runs and deletes it afterwards. A crashed holder's
 * lease expires.
 */
export class BridgeLeaseManager {
  readonly holder: string;
  readonly #leaseMs: number;
  readonly #clock: SchedulerClock;
  #lost = 0;

  constructor(
    private readonly store: SqliteCalendarBridgeWorkerStore,
    options: {
      readonly holder?: string;
      readonly leaseMs?: number;
      readonly clock?: SchedulerClock;
    } = {},
  ) {
    this.holder = options.holder ?? randomUUID();
    this.#leaseMs = options.leaseMs ?? defaultLeaseMs;
    this.#clock = options.clock ?? systemSchedulerClock;
  }

  /** Renewals that found the lease taken by another holder. */
  lostLeases(): number {
    return this.#lost;
  }

  /**
   * Runs `work` while holding `key`. Returns `acquired: false` without
   * running it when another holder has an unexpired lease.
   */
  async withLease<T>(
    key: string,
    now: Date,
    work: () => Promise<T>,
  ): Promise<
    | { readonly acquired: true; readonly value: T }
    | { readonly acquired: false }
  > {
    const acquired = this.store.acquireLease({
      key,
      holder: this.holder,
      now: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.#leaseMs).toISOString(),
    });
    if (!acquired) return { acquired: false };
    let finished = false;
    const renewal: { timer: { cancel(): void } } = {
      timer: { cancel: () => undefined },
    };
    const renew = (): void => {
      if (finished) return;
      try {
        const renewed = this.store.renewLease(
          key,
          this.holder,
          new Date(this.#clock.now().getTime() + this.#leaseMs).toISOString(),
        );
        if (!renewed) {
          this.#lost += 1;
          console.error("calendar_bridge.lease_lost");
          return;
        }
      } catch {
        return;
      }
      renewal.timer = this.#clock.setTimeout(
        renew,
        Math.floor(this.#leaseMs / 3),
      );
    };
    renewal.timer = this.#clock.setTimeout(
      renew,
      Math.floor(this.#leaseMs / 3),
    );
    try {
      return { acquired: true, value: await work() };
    } finally {
      finished = true;
      renewal.timer.cancel();
      try {
        this.store.releaseLease(key, this.holder);
      } catch {
        // The database may already be closed during shutdown; the lease expires.
      }
    }
  }
}
