/**
 * Web Locks used by live sync (ADR 0045). Locks are scoped to the origin and
 * shared by every tab of one browser profile, which is also the scope of the
 * IndexedDB cache and the registered sync client.
 */

/** The part of `LockManager` this app uses; tests supply a fake. */
export interface LockManagerLike {
  request<T>(
    name: string,
    options: { readonly signal?: AbortSignal },
    callback: () => Promise<T>,
  ): Promise<T>;
}

/** Held for the duration of one sync round. */
export const syncRoundLockName = "tadooer-sync-round";
/** Held by the tab that owns the live sync stream, for as long as it is open. */
export const liveSyncLeaderLockName = "tadooer-live-sync-leader";

/** The browser's lock manager, or undefined where Web Locks are missing. */
export const browserLocks = (): LockManagerLike | undefined => {
  const locks = (globalThis.navigator as Partial<Navigator> | undefined)?.locks;
  if (locks === undefined) return undefined;
  return {
    request: <T>(
      name: string,
      options: { readonly signal?: AbortSignal },
      callback: () => Promise<T>,
    ): Promise<T> =>
      locks.request(
        name,
        options.signal === undefined ? {} : { signal: options.signal },
        () => callback(),
      ) as Promise<T>,
  };
};

export type RunExclusive = <T>(work: () => Promise<T>) => Promise<T>;

/**
 * Runs sync rounds one at a time across tabs. Without Web Locks the work
 * runs directly, which is the behaviour before live sync.
 */
export const syncRoundExclusive = (
  locks: LockManagerLike | undefined,
): RunExclusive =>
  locks === undefined
    ? (work) => work()
    : (work) => locks.request(syncRoundLockName, {}, work);

/**
 * Requests a lock and keeps it until the returned function is called or the
 * tab closes. `onAcquired` runs once, when the lock is granted; another
 * holder may keep this request waiting indefinitely.
 */
export const holdLock = (
  locks: LockManagerLike,
  name: string,
  onAcquired: () => void,
): (() => void) => {
  const waiting = new AbortController();
  let cancelled = false;
  let release: (() => void) | undefined;
  locks
    .request(name, { signal: waiting.signal }, () => {
      if (cancelled) return Promise.resolve();
      return new Promise<void>((resolve) => {
        release = resolve;
        onAcquired();
      });
    })
    // Cancelling a queued request rejects it with an AbortError.
    .catch(() => undefined);
  return () => {
    if (cancelled) return;
    cancelled = true;
    waiting.abort();
    release?.();
  };
};
