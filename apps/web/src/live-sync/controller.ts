import {
  liveSyncResourceFamilySchema,
  type LiveSyncEvent,
  type LiveSyncResourceFamily,
} from "@suite/contracts";
import { z } from "zod";
import type { LocalClientIdentity } from "../local-store.ts";
import type { SyncRoundTrigger } from "../sync-engine.ts";
import {
  installFallbackTriggers,
  type FallbackEnvironment,
  type FallbackReason,
  type FallbackTriggers,
} from "./fallback.ts";
import {
  browserLocks,
  holdLock,
  liveSyncLeaderLockName,
  type LockManagerLike,
} from "./locks.ts";
import { LiveSyncConnection, type LiveSyncConnectionState } from "./stream.ts";
import type { LiveSyncStatus } from "./status.ts";

export const liveSyncChannelName = "tadooer-live-sync";

/** A `BroadcastChannel` reduced to what live sync needs; tests use a fake. */
export interface LiveSyncChannel {
  post(message: LiveSyncTabMessage): void;
  listen(listener: (message: unknown) => void): void;
  close(): void;
}

const statusSchema = z.enum(["live", "reconnecting", "offline", "paused"]);

/**
 * Messages between the tabs of one browser profile. Like the stream they
 * carry no content: a tab reads the change from IndexedDB or refetches it.
 */
const tabMessageSchema = z.discriminatedUnion("type", [
  /** A tab finished sync rounds; the others reload from IndexedDB. */
  z.object({ type: z.literal("round-applied") }).strict(),
  /** The leader relays a `resources` hint. */
  z
    .object({
      type: z.literal("resources"),
      families: z.array(liveSyncResourceFamilySchema).min(1),
      sourceClientId: z.string().nullable(),
    })
    .strict(),
  /** The leader reports the stream state so followers can show it. */
  z.object({ type: z.literal("status"), status: statusSchema }).strict(),
  /** A new tab asks the leader for the current state. */
  z.object({ type: z.literal("status-request") }).strict(),
]);
export type LiveSyncTabMessage = z.infer<typeof tabMessageSchema>;

export interface LiveSyncEnvironment extends FallbackEnvironment {
  readonly locks: LockManagerLike | undefined;
  readonly createChannel: (() => LiveSyncChannel) | undefined;
  /** Whether `fetch` exposes the response body as a readable stream. */
  readonly streaming: boolean;
  readonly online: () => boolean;
  readonly random?: () => number;
}

export const browserLiveSyncEnvironment = (): LiveSyncEnvironment => ({
  window,
  document,
  locks: browserLocks(),
  createChannel:
    typeof BroadcastChannel === "function"
      ? () => {
          const channel = new BroadcastChannel(liveSyncChannelName);
          return {
            post: (message) => {
              channel.postMessage(message);
            },
            listen: (listener) => {
              channel.addEventListener("message", (event) => {
                listener(event.data);
              });
            },
            close: () => {
              channel.close();
            },
          };
        }
      : undefined,
  streaming:
    typeof ReadableStream === "function" &&
    typeof TextDecoder === "function" &&
    typeof Response === "function" &&
    "body" in Response.prototype,
  online: () => navigator.onLine,
});

export interface LiveSyncHandlers {
  /** The registered client and its cursor, read from the local store. */
  readonly identity: () => Promise<LocalClientIdentity | undefined>;
  readonly openStream: (
    client: LocalClientIdentity,
    signal: AbortSignal,
  ) => Promise<Response>;
  /**
   * Runs sync rounds until `hasMore` is false and shows the result in this
   * tab. Rejects when a round fails.
   */
  readonly sync: (trigger: SyncRoundTrigger | undefined) => Promise<void>;
  /** Reloads this tab's state from IndexedDB after another tab synced. */
  readonly reloadLocal: () => Promise<void>;
  /** Refetches the loaded views of the families; see `LiveViewRegistry`. */
  readonly refetch: (
    families: readonly LiveSyncResourceFamily[],
    source: {
      readonly sourceClientId: string | null;
      readonly ownClientId: string | undefined;
    },
  ) => void;
  readonly onStatus: (status: LiveSyncStatus) => void;
}

/** Runs `work` one at a time; calls made meanwhile cause one more run. */
const coalesce = (work: () => Promise<void>): (() => void) => {
  let running = false;
  let requested = 0;
  const run = async (): Promise<void> => {
    requested += 1;
    if (running) return;
    running = true;
    try {
      while (requested > 0) {
        requested = 0;
        // A failure is retried by the next hint or fallback trigger.
        await work().catch(() => undefined);
      }
    } finally {
      running = false;
    }
  };
  return () => {
    void run();
  };
};

interface ActiveRun {
  readonly environment: LiveSyncEnvironment;
  readonly handlers: LiveSyncHandlers;
  readonly supported: boolean;
  stopped: boolean;
  channel: LiveSyncChannel | undefined;
  fallback: FallbackTriggers | undefined;
  releaseLeadership: (() => void) | undefined;
  connection: LiveSyncConnection | undefined;
  leader: boolean;
  connectionState: LiveSyncConnectionState;
  /** What the leader last reported, or `paused` after this tab gave up. */
  followerStatus: LiveSyncStatus;
  reported: LiveSyncStatus | undefined;
  head: string | undefined;
  /** `hello` events seen by this tab's stream; the first follows page load. */
  hellos: number;
  catchUp: () => void;
  reload: () => void;
  readonly dispose: (() => void)[];
}

/**
 * Live sync for one tab (ADR 0045). One tab per browser profile leads: it
 * holds the stream, runs a round when the feed head moves and relays hints
 * over a `BroadcastChannel`. Every tab reloads after a round, refetches open
 * views on `resources`, and keeps the fallback triggers. Where Web Locks,
 * `BroadcastChannel` or streaming `fetch` are missing, only the fallback
 * triggers run.
 */
export class LiveSyncController {
  readonly #environment: LiveSyncEnvironment | undefined;
  #active: ActiveRun | undefined;

  constructor(environment?: LiveSyncEnvironment) {
    this.#environment = environment;
  }

  /** Starts live sync for a signed-in session. */
  start(handlers: LiveSyncHandlers): void {
    this.stop();
    const environment = this.#environment ?? browserLiveSyncEnvironment();
    const { locks, createChannel } = environment;
    const run: ActiveRun = {
      environment,
      handlers,
      supported:
        locks !== undefined &&
        createChannel !== undefined &&
        environment.streaming,
      stopped: false,
      channel: undefined,
      fallback: undefined,
      releaseLeadership: undefined,
      connection: undefined,
      leader: false,
      connectionState: "connecting",
      followerStatus: "reconnecting",
      reported: undefined,
      head: undefined,
      hellos: 0,
      catchUp: () => undefined,
      reload: () => undefined,
      dispose: [],
    };
    this.#active = run;
    run.catchUp = coalesce(async () => {
      if (run.stopped || run.head === undefined) return;
      const identity = await handlers.identity();
      if (identity?.cursor === run.head) return;
      await handlers.sync("push");
      this.#afterSync(run);
    });
    run.reload = coalesce(async () => {
      if (!run.stopped) await handlers.reloadLocal();
    });

    const onNetwork = (): void => {
      if (environment.online()) run.connection?.retryNow();
      this.#report(run);
    };
    environment.window.addEventListener("online", onNetwork);
    environment.window.addEventListener("offline", onNetwork);
    run.dispose.push(() => {
      environment.window.removeEventListener("online", onNetwork);
      environment.window.removeEventListener("offline", onNetwork);
    });

    run.fallback = installFallbackTriggers({
      environment,
      isLive: () => this.#status(run) === "live",
      sync: (reason) => {
        void this.#fallbackSync(run, reason);
      },
    });

    if (locks !== undefined && createChannel !== undefined && run.supported) {
      const channel = createChannel();
      run.channel = channel;
      channel.listen((message) => {
        this.#onMessage(run, message);
      });
      channel.post({ type: "status-request" });
      run.releaseLeadership = holdLock(locks, liveSyncLeaderLockName, () => {
        this.#lead(run);
      });
    }
    this.#report(run);
  }

  /** Closes the stream, leaves the election and removes the triggers. */
  stop(): void {
    const run = this.#active;
    if (run === undefined) return;
    this.#active = undefined;
    run.stopped = true;
    run.connection?.stop();
    run.releaseLeadership?.();
    run.fallback?.dispose();
    for (const dispose of run.dispose) dispose();
    run.channel?.close();
  }

  /**
   * Tells the other tabs that this tab applied sync rounds for a reason of
   * its own (load, "Sync now", a local write), so they reload.
   */
  announceRound(): void {
    const run = this.#active;
    if (run !== undefined) this.#afterSync(run);
  }

  status(): LiveSyncStatus {
    return this.#active === undefined ? "paused" : this.#status(this.#active);
  }

  #status(run: ActiveRun): LiveSyncStatus {
    if (!run.supported) return "paused";
    if (!run.environment.online()) return "offline";
    if (!run.leader) return run.followerStatus;
    return run.connectionState === "live" ? "live" : "reconnecting";
  }

  #report(run: ActiveRun): void {
    if (run.stopped) return;
    const status = this.#status(run);
    if (run.leader) run.channel?.post({ type: "status", status });
    if (status === run.reported) return;
    run.reported = status;
    run.handlers.onStatus(status);
  }

  #afterSync(run: ActiveRun): void {
    if (run.stopped) return;
    run.fallback?.noteSync();
    run.channel?.post({ type: "round-applied" });
  }

  #lead(run: ActiveRun): void {
    if (run.stopped) return;
    run.leader = true;
    run.connectionState = "connecting";
    const connection = new LiveSyncConnection({
      open: async (signal) => {
        const client = await run.handlers.identity();
        if (client === undefined)
          throw new Error("This browser is not registered for sync yet");
        return run.handlers.openStream(client, signal);
      },
      onEvent: (event) => {
        this.#onEvent(run, event);
      },
      onState: (state, reason) => {
        if (run.stopped) return;
        run.connectionState = state;
        if (state === "stopped" && reason !== "closed") {
          // The session ended or the client was revoked. Tell the followers,
          // give up leadership and stay out until the next sign-in.
          run.channel?.post({ type: "status", status: "paused" });
          run.leader = false;
          run.followerStatus = "paused";
          run.connection = undefined;
          run.releaseLeadership?.();
          run.releaseLeadership = undefined;
        }
        this.#report(run);
      },
      ...(run.environment.random === undefined
        ? {}
        : { random: run.environment.random }),
    });
    run.connection = connection;
    connection.start();
    this.#report(run);
  }

  #onEvent(run: ActiveRun, event: LiveSyncEvent): void {
    if (run.stopped) return;
    if (event.event === "hello" || event.event === "changes") {
      run.head = event.data.head;
      run.catchUp();
      // `hello` carries the feed head but nothing about records outside the
      // feed, so hints missed while the stream was down are recovered by
      // refetching every open view. The first `hello` follows a page load.
      if (event.event === "hello" && ++run.hellos > 1) {
        run.channel?.post({
          type: "resources",
          families: ["all"],
          sourceClientId: null,
        });
        this.#refetch(run, ["all"], null);
      }
    } else if (event.event === "resources") {
      const { families, sourceClientId } = event.data;
      run.channel?.post({ type: "resources", families, sourceClientId });
      this.#refetch(run, families, sourceClientId);
    }
  }

  #onMessage(run: ActiveRun, raw: unknown): void {
    if (run.stopped) return;
    const parsed = tabMessageSchema.safeParse(raw);
    if (!parsed.success) return;
    const message = parsed.data;
    switch (message.type) {
      case "round-applied":
        run.fallback?.noteSync();
        run.reload();
        return;
      case "resources":
        this.#refetch(run, message.families, message.sourceClientId);
        return;
      case "status":
        if (run.leader) return;
        run.followerStatus = message.status;
        this.#report(run);
        return;
      case "status-request":
        if (run.leader) this.#report(run);
        return;
    }
  }

  #refetch(
    run: ActiveRun,
    families: readonly LiveSyncResourceFamily[],
    sourceClientId: string | null,
  ): void {
    void run.handlers
      .identity()
      .then((identity) => {
        if (run.stopped) return;
        run.handlers.refetch(families, {
          sourceClientId,
          ownClientId: identity?.clientId,
        });
      })
      .catch(() => undefined);
  }

  async #fallbackSync(run: ActiveRun, reason: FallbackReason): Promise<void> {
    if (run.stopped || !run.environment.online()) return;
    try {
      // Nobody acted for an interval round, so it must not extend the
      // session; returning to the page is the owner's own activity.
      await run.handlers.sync(reason === "interval" ? "push" : undefined);
      this.#afterSync(run);
    } catch {
      // The next trigger tries again.
    }
  }
}
