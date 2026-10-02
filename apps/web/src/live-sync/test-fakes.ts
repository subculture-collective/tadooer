import { encodeLiveSyncEvent, type LiveSyncEvent } from "@suite/contracts";
import type { LiveSyncChannel, LiveSyncEnvironment } from "./controller.ts";
import type { LockManagerLike } from "./locks.ts";

/** Fakes for the live sync tests: locks, tab channels, streams and a page. */

interface Waiter {
  readonly owner: object;
  readonly grant: () => void;
}

/**
 * Web Locks shared by several fake tabs. `tab()` returns one tab's lock
 * manager; `close()` on it releases what the tab holds and drops its queued
 * requests, as closing a browser tab does.
 */
export class FakeLocks {
  readonly #held = new Map<string, object>();
  readonly #queues = new Map<string, Waiter[]>();
  readonly #releases = new Map<object, Set<() => void>>();

  holder(name: string): object | undefined {
    return this.#held.get(name);
  }

  tab(): LockManagerLike & { readonly close: () => void } {
    const owner = {};
    const releases = new Set<() => void>();
    this.#releases.set(owner, releases);
    const request = <T>(
      name: string,
      options: { readonly signal?: AbortSignal },
      callback: () => Promise<T>,
    ): Promise<T> =>
      new Promise<T>((resolve, reject) => {
        const queue = this.#queues.get(name) ?? [];
        this.#queues.set(name, queue);
        const waiter: Waiter = {
          owner,
          grant: () => {
            this.#held.set(name, owner);
            let released = false;
            const release = (): void => {
              if (released) return;
              released = true;
              releases.delete(release);
              this.#held.delete(name);
              this.#next(name);
            };
            releases.add(release);
            void Promise.resolve()
              .then(callback)
              .then(resolve, reject)
              .finally(release);
          },
        };
        options.signal?.addEventListener("abort", () => {
          const index = queue.indexOf(waiter);
          if (index === -1) return;
          queue.splice(index, 1);
          reject(new DOMException("The request was aborted", "AbortError"));
        });
        queue.push(waiter);
        this.#next(name);
      });
    return {
      request,
      close: () => {
        for (const queue of this.#queues.values())
          for (let index = queue.length - 1; index >= 0; index -= 1)
            if (queue[index]?.owner === owner) queue.splice(index, 1);
        for (const release of [...releases]) release();
      },
    };
  }

  #next(name: string): void {
    if (this.#held.has(name)) return;
    this.#queues.get(name)?.shift()?.grant();
  }
}

/** A `BroadcastChannel` name shared by fake tabs; a tab never hears itself. */
export class FakeChannelHub {
  readonly #listeners = new Map<object, ((message: unknown) => void)[]>();
  readonly posted: unknown[] = [];

  channel(): LiveSyncChannel {
    const key = {};
    this.#listeners.set(key, []);
    return {
      post: (message) => {
        this.posted.push(message);
        for (const [other, listeners] of this.#listeners)
          if (other !== key)
            for (const listener of listeners)
              listener(structuredClone(message));
      },
      listen: (listener) => {
        this.#listeners.get(key)?.push(listener);
      },
      close: () => {
        this.#listeners.delete(key);
      },
    };
  }
}

const encoder = new TextEncoder();

/** A live sync response whose body the test writes to. */
export class FakeStream {
  #controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  cancelled = false;
  readonly response: Response;

  constructor(
    init: { readonly status?: number; readonly contentType?: string } = {},
  ) {
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.#controller = controller;
      },
      cancel: () => {
        this.cancelled = true;
      },
    });
    this.response = new Response(body, {
      status: init.status ?? 200,
      headers: { "content-type": init.contentType ?? "text/event-stream" },
    });
  }

  write(text: string): void {
    this.#controller?.enqueue(encoder.encode(text));
  }

  send(event: LiveSyncEvent): void {
    this.write(encodeLiveSyncEvent(event));
  }

  heartbeat(): void {
    this.write(": hb\n\n");
  }

  /** The server closes the connection. */
  end(): void {
    try {
      this.#controller?.close();
    } catch {
      // Already closed or cancelled by the reader.
    }
  }
}

export const hello = (head: string, heartbeatSeconds = 25): LiveSyncEvent => ({
  event: "hello",
  data: {
    protocolVersion: 2,
    head,
    heartbeatSeconds,
    serverTimestamp: "2026-10-02T12:00:00.000Z",
  },
});

class FakeEventTarget {
  readonly #listeners = new Map<string, Set<() => void>>();

  addEventListener = (type: string, listener: () => void): void => {
    const listeners = this.#listeners.get(type) ?? new Set();
    this.#listeners.set(type, listeners);
    listeners.add(listener);
  };

  removeEventListener = (type: string, listener: () => void): void => {
    this.#listeners.get(type)?.delete(listener);
  };

  dispatch(type: string): void {
    for (const listener of [...(this.#listeners.get(type) ?? [])]) listener();
  }

  listenerCount(): number {
    let count = 0;
    for (const listeners of this.#listeners.values()) count += listeners.size;
    return count;
  }
}

/** One tab's page: window and document events, visibility and network. */
export class FakePage {
  readonly window = new FakeEventTarget();
  readonly document = Object.assign(new FakeEventTarget(), {
    visibilityState: "visible",
  });
  isOnline = true;

  show(): void {
    this.document.visibilityState = "visible";
    this.document.dispatch("visibilitychange");
  }

  hide(): void {
    this.document.visibilityState = "hidden";
    this.document.dispatch("visibilitychange");
  }

  focus(): void {
    this.window.dispatch("focus");
  }

  setOnline(online: boolean): void {
    this.isOnline = online;
    this.window.dispatch(online ? "online" : "offline");
  }

  environment(
    features: {
      readonly locks?: LockManagerLike | undefined;
      readonly hub?: FakeChannelHub | undefined;
      readonly streaming?: boolean;
    } = {},
  ): LiveSyncEnvironment {
    const { hub } = features;
    return {
      window: this.window,
      document: this.document,
      locks: features.locks,
      createChannel: hub === undefined ? undefined : () => hub.channel(),
      streaming: features.streaming ?? true,
      online: () => this.isOnline,
      // The middle of the jitter range: delays equal the exponential base.
      random: () => 0.5,
    };
  }
}
