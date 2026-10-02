import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveSyncResourceFamily } from "@suite/contracts";
import type { SyncRoundTrigger } from "../sync-engine.ts";
import { LiveSyncController } from "./controller.ts";
import { liveSyncLeaderLockName } from "./locks.ts";
import type { LiveSyncStatus } from "./status.ts";
import {
  FakeChannelHub,
  FakeLocks,
  FakePage,
  FakeStream,
  hello,
} from "./test-fakes.ts";
import { LiveViewRegistry } from "./views.ts";

const ownClientId = "d1054acd-c04d-4bd8-a814-254b007154ba";
const otherClientId = "7c0a4a3e-8d0b-4b53-9a53-0a7f0c7f5a11";

const flush = (): Promise<unknown> => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

/** One browser profile: shared locks, tab channel and local sync cursor. */
const profile = () => {
  const locks = new FakeLocks();
  const hub = new FakeChannelHub();
  const shared = { cursor: "epoch.4", serverHead: "epoch.4" };
  const opened: { readonly tab: string; readonly stream: FakeStream }[] = [];
  let respond: (() => Response) | undefined;

  const tab = (
    name: string,
    features: { readonly locks?: boolean; readonly streaming?: boolean } = {},
  ) => {
    const page = new FakePage();
    const tabLocks = locks.tab();
    const registry = new LiveViewRegistry();
    const rounds: (SyncRoundTrigger | undefined)[] = [];
    const statuses: LiveSyncStatus[] = [];
    const signals: AbortSignal[] = [];
    let reloads = 0;
    let failSync = false;
    const controller = new LiveSyncController(
      page.environment({
        locks: features.locks === false ? undefined : tabLocks,
        hub,
        streaming: features.streaming ?? true,
      }),
    );
    const start = (): void => {
      controller.start({
        identity: () =>
          Promise.resolve({
            installationId: "installation",
            clientId: ownClientId,
            clientCredential: "A".repeat(43),
            cursor: shared.cursor,
          }),
        openStream: (_client, signal) => {
          signals.push(signal);
          if (respond !== undefined) return Promise.resolve(respond());
          const stream = new FakeStream();
          opened.push({ tab: name, stream });
          return Promise.resolve(stream.response);
        },
        sync: (trigger) => {
          rounds.push(trigger);
          if (failSync) return Promise.reject(new Error("round failed"));
          // Rounds until hasMore is false leave the cursor at the head.
          shared.cursor = shared.serverHead;
          return Promise.resolve();
        },
        reloadLocal: () => {
          reloads += 1;
          return Promise.resolve();
        },
        refetch: (families, source) => {
          registry.refetch(families, source);
        },
        onStatus: (status) => statuses.push(status),
      });
    };
    return {
      name,
      page,
      controller,
      registry,
      rounds,
      statuses,
      signals,
      start,
      closeTab: () => tabLocks.close(),
      reloads: () => reloads,
      failSync: (fail: boolean) => {
        failSync = fail;
      },
    };
  };

  return {
    locks,
    hub,
    shared,
    opened,
    tab,
    respondWith: (next: (() => Response) | undefined) => {
      respond = next;
    },
    stream: (): FakeStream => {
      const latest = opened.at(-1);
      if (latest === undefined) throw new Error("no stream opened");
      return latest.stream;
    },
    /** Lets time pass while the server keeps the open stream alive. */
    advanceWithHeartbeats: async (ms: number): Promise<void> => {
      for (let elapsed = 0; elapsed < ms; elapsed += 20_000) {
        opened.at(-1)?.stream.heartbeat();
        await vi.advanceTimersByTimeAsync(Math.min(20_000, ms - elapsed));
      }
    },
    posted: (type: string): unknown[] =>
      hub.posted.filter(
        (message) => (message as { readonly type: string }).type === type,
      ),
  };
};

describe("live sync reactions", () => {
  it("runs push rounds when hello or changes report a different head and tells the other tabs", async () => {
    const browser = profile();
    const leader = browser.tab("a");
    const follower = browser.tab("b");
    leader.start();
    follower.start();
    await flush();
    expect(browser.opened.map(({ tab }) => tab)).toEqual(["a"]);

    // hello with the head this client already has: no round.
    browser.stream().send(hello("epoch.4"));
    await flush();
    expect(leader.rounds).toEqual([]);
    expect(leader.statuses.at(-1)).toBe("live");
    expect(follower.statuses.at(-1)).toBe("live");

    browser.shared.serverHead = "epoch.5";
    browser.stream().send({ event: "changes", data: { head: "epoch.5" } });
    await flush();
    expect(leader.rounds).toEqual(["push"]);
    expect(browser.posted("round-applied")).toHaveLength(1);
    expect(follower.reloads()).toBe(1);
    expect(follower.rounds).toEqual([]);
    expect(leader.reloads()).toBe(0);

    // A duplicate hint for a head that is already applied costs nothing.
    browser.stream().send({ event: "changes", data: { head: "epoch.5" } });
    await flush();
    expect(leader.rounds).toEqual(["push"]);

    // After a reconnect, hello carries the head and catches the client up.
    browser.shared.serverHead = "epoch.9";
    browser.stream().end();
    await vi.advanceTimersByTimeAsync(1_000);
    browser.stream().send(hello("epoch.9"));
    await flush();
    expect(leader.rounds).toEqual(["push", "push"]);
    expect(follower.reloads()).toBe(2);
  });

  it("runs one more round for hints that arrive while a round is in flight", async () => {
    const browser = profile();
    const leader = browser.tab("a");
    leader.start();
    await flush();
    browser.stream().send(hello("epoch.4"));
    browser.shared.serverHead = "epoch.7";
    for (const head of ["epoch.5", "epoch.6", "epoch.7"])
      browser.stream().send({ event: "changes", data: { head } });
    await flush();
    expect(leader.rounds).toEqual(["push"]);
  });

  it("keeps going after a failed hint round and retries on the next hint", async () => {
    const browser = profile();
    const leader = browser.tab("a");
    leader.start();
    await flush();
    browser.shared.serverHead = "epoch.5";
    leader.failSync(true);
    browser.stream().send(hello("epoch.5"));
    await flush();
    expect(leader.rounds).toEqual(["push"]);
    expect(browser.posted("round-applied")).toHaveLength(0);
    leader.failSync(false);
    browser.stream().send({ event: "changes", data: { head: "epoch.5" } });
    await flush();
    expect(leader.rounds).toEqual(["push", "push"]);
    expect(browser.posted("round-applied")).toHaveLength(1);
  });

  it("refetches loaded views in every tab on resources and skips its own writes", async () => {
    const browser = profile();
    const leader = browser.tab("a");
    const follower = browser.tab("b");
    const leaderLinks = vi.fn();
    const followerLinks = vi.fn();
    const followerBoards = vi.fn();
    leader.registry.register("taskLinks", leaderLinks);
    follower.registry.register("taskLinks", followerLinks);
    follower.registry.register("boards", followerBoards);
    leader.start();
    follower.start();
    await flush();
    browser.stream().send(hello("epoch.4"));

    const resources = (
      families: LiveSyncResourceFamily[],
      sourceClientId: string | null,
    ): void => {
      browser
        .stream()
        .send({ event: "resources", data: { families, sourceClientId } });
    };
    resources(["task_links"], otherClientId);
    await flush();
    expect(leaderLinks).toHaveBeenCalledTimes(1);
    expect(followerLinks).toHaveBeenCalledTimes(1);
    expect(followerBoards).not.toHaveBeenCalled();

    // This browser profile wrote the link: nothing to refetch.
    resources(["task_links"], ownClientId);
    await flush();
    expect(leaderLinks).toHaveBeenCalledTimes(1);
    expect(followerLinks).toHaveBeenCalledTimes(1);

    // A restore: everything that is loaded, from a server-side source.
    resources(["all"], null);
    await flush();
    expect(leaderLinks).toHaveBeenCalledTimes(2);
    expect(followerLinks).toHaveBeenCalledTimes(2);
    expect(followerBoards).toHaveBeenCalledTimes(1);
    // Hints never start a sync round for records outside the feed.
    expect(leader.rounds).toEqual([]);
  });

  it("refetches every loaded view after a reconnect, not after the first hello", async () => {
    const browser = profile();
    const leader = browser.tab("a");
    const follower = browser.tab("b");
    const leaderLinks = vi.fn();
    const followerBoards = vi.fn();
    leader.registry.register("taskLinks", leaderLinks);
    follower.registry.register("boards", followerBoards);
    leader.start();
    follower.start();
    await flush();

    // The first hello follows a page load: the views were just fetched.
    browser.stream().send(hello("epoch.4"));
    await flush();
    expect(leaderLinks).not.toHaveBeenCalled();
    expect(followerBoards).not.toHaveBeenCalled();

    // A second hello means the stream was down in between, and hints for
    // records outside the feed may have been missed.
    browser.stream().send(hello("epoch.4"));
    await flush();
    expect(leaderLinks).toHaveBeenCalledTimes(1);
    expect(followerBoards).toHaveBeenCalledTimes(1);
  });

  it("reloads the other tabs when a tab announces rounds of its own", async () => {
    const browser = profile();
    const leader = browser.tab("a");
    const follower = browser.tab("b");
    leader.start();
    follower.start();
    await flush();
    follower.controller.announceRound();
    await flush();
    expect(leader.reloads()).toBe(1);
    expect(follower.reloads()).toBe(0);
  });
});

describe("live sync leader election", () => {
  it("opens one stream per browser profile and hands over when the leader tab closes", async () => {
    const browser = profile();
    const first = browser.tab("a");
    const second = browser.tab("b");
    const third = browser.tab("c");
    first.start();
    second.start();
    third.start();
    await flush();
    expect(browser.opened.map(({ tab }) => tab)).toEqual(["a"]);
    browser.stream().send(hello("epoch.4"));
    await flush();
    expect(second.statuses.at(-1)).toBe("live");

    // The browser releases a closed tab's locks.
    first.closeTab();
    await flush();
    expect(browser.opened.map(({ tab }) => tab)).toEqual(["a", "b"]);
    expect(third.statuses.at(-1)).toBe("reconnecting");
    browser.shared.serverHead = "epoch.6";
    browser.stream().send(hello("epoch.6"));
    await flush();
    expect(second.rounds).toEqual(["push"]);
    expect(third.reloads()).toBe(1);
    expect(third.statuses.at(-1)).toBe("live");
  });

  it("stops the stream and releases leadership on sign-out", async () => {
    const browser = profile();
    const first = browser.tab("a");
    const second = browser.tab("b");
    first.start();
    second.start();
    await flush();
    browser.stream().send(hello("epoch.4"));
    await flush();
    const firstStream = browser.stream();

    first.controller.stop();
    await flush();
    expect(first.signals[0]?.aborted).toBe(true);
    expect(firstStream.cancelled).toBe(true);
    expect(first.page.window.listenerCount()).toBe(0);
    expect(first.page.document.listenerCount()).toBe(0);
    expect(first.controller.status()).toBe("paused");
    expect(browser.opened.map(({ tab }) => tab)).toEqual(["a", "b"]);

    // Stopped means stopped: no fallback sync and no reaction to messages.
    first.page.focus();
    second.controller.announceRound();
    await browser.advanceWithHeartbeats(600_000);
    expect(first.rounds).toEqual([]);
    expect(first.reloads()).toBe(0);

    // Sign-in starts it again; the other tab still leads.
    first.start();
    await flush();
    expect(browser.opened.map(({ tab }) => tab)).toEqual(["a", "b"]);
    second.controller.stop();
    await flush();
    expect(browser.opened.map(({ tab }) => tab)).toEqual(["a", "b", "a"]);
  });

  it("pauses when the session ended and does not reconnect until restarted", async () => {
    const browser = profile();
    const first = browser.tab("a");
    const second = browser.tab("b");
    first.start();
    second.start();
    await flush();
    browser.stream().send(hello("epoch.4"));
    await flush();

    browser.respondWith(() => new FakeStream({ status: 401 }).response);
    browser.stream().send({ event: "bye", data: { reason: "session-ended" } });
    await flush();
    // The first tab gave up leadership; the second tried once and got 401.
    expect(first.statuses.at(-1)).toBe("paused");
    expect(second.statuses.at(-1)).toBe("paused");
    expect(second.signals).toHaveLength(1);
    expect(browser.locks.holder(liveSyncLeaderLockName)).toBeUndefined();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(first.signals).toHaveLength(1);
    expect(second.signals).toHaveLength(1);

    // The next sign-in restarts live sync in the tab that signed in.
    browser.respondWith(undefined);
    first.controller.stop();
    first.start();
    await flush();
    browser.stream().send(hello("epoch.4"));
    await flush();
    expect(first.statuses.at(-1)).toBe("live");
    expect(second.statuses.at(-1)).toBe("live");
  });

  it("pauses after bye: client-revoked", async () => {
    const browser = profile();
    const only = browser.tab("a");
    only.start();
    await flush();
    browser.stream().send(hello("epoch.4"));
    browser.stream().send({ event: "bye", data: { reason: "client-revoked" } });
    await flush();
    expect(only.statuses.at(-1)).toBe("paused");
    await vi.advanceTimersByTimeAsync(600_000);
    expect(only.signals).toHaveLength(1);
  });
});

describe("live sync status and fallback", () => {
  it("reports reconnecting, live and offline, and reconnects when the network returns", async () => {
    const browser = profile();
    const only = browser.tab("a");
    only.start();
    await flush();
    expect(only.statuses).toEqual(["reconnecting"]);
    browser.stream().send(hello("epoch.4"));
    await flush();
    only.page.setOnline(false);
    browser.respondWith(() => {
      throw new TypeError("network");
    });
    browser.stream().end();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(only.statuses).toEqual(["reconnecting", "live", "offline"]);
    const attempts = only.signals.length;

    browser.respondWith(undefined);
    only.page.setOnline(true);
    await flush();
    expect(only.signals).toHaveLength(attempts + 1);
    expect(only.statuses.at(-1)).toBe("reconnecting");
    browser.stream().send(hello("epoch.4"));
    await flush();
    expect(only.statuses.at(-1)).toBe("live");
  });

  it("syncs on focus without the push trigger and on the interval with it", async () => {
    const browser = profile();
    const only = browser.tab("a");
    only.start();
    await flush();
    browser.stream().send(hello("epoch.4"));
    await flush();

    only.page.focus();
    await flush();
    expect(only.rounds).toEqual([undefined]);
    expect(browser.posted("round-applied")).toHaveLength(1);

    // Live: the interval is five minutes from the last sync.
    await browser.advanceWithHeartbeats(299_000);
    expect(only.rounds).toEqual([undefined]);
    await browser.advanceWithHeartbeats(60_000);
    expect(only.rounds).toEqual([undefined, "push"]);

    // Offline: no rounds are attempted.
    only.page.setOnline(false);
    await vi.advanceTimersByTimeAsync(600_000);
    only.page.focus();
    expect(only.rounds).toEqual([undefined, "push"]);
  });

  it.each([
    ["Web Locks", { locks: false }],
    ["streaming fetch", { streaming: false }],
  ] as const)(
    "falls back to the triggers alone without %s",
    async (_feature, features) => {
      const browser = profile();
      const only = browser.tab("a", features);
      only.start();
      await flush();
      expect(only.signals).toHaveLength(0);
      expect(only.statuses).toEqual(["paused"]);
      expect(browser.locks.holder(liveSyncLeaderLockName)).toBeUndefined();

      only.page.hide();
      only.page.show();
      await flush();
      expect(only.rounds).toEqual([undefined]);
      // No stream: the one-minute interval applies.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(only.rounds).toEqual([undefined, "push"]);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(only.rounds).toEqual([undefined, "push", "push"]);
      expect(only.signals).toHaveLength(0);
    },
  );
});
