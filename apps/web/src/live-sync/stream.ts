import {
  decodeLiveSyncEvent,
  liveSyncHeartbeatSeconds,
  type LiveSyncEvent,
} from "@suite/contracts";

/** A frame larger than this is not a live sync event; the stream is dropped. */
const maxFrameLength = 64 * 1024;

/**
 * Splits `text/event-stream` text into frames (the text between blank
 * lines). Chunks may end anywhere, including inside a line ending.
 */
export const createFrameSplitter = (
  onFrame: (frame: string) => void,
): ((text: string) => void) => {
  let buffer = "";
  return (text) => {
    buffer += text;
    for (;;) {
      const boundary = /\r?\n\r?\n/.exec(buffer);
      if (boundary === null) break;
      const frame = buffer.slice(0, boundary.index);
      buffer = buffer.slice(boundary.index + boundary[0].length);
      if (frame !== "") onFrame(frame);
    }
    if (buffer.length > maxFrameLength)
      throw new Error("Live sync frame exceeded the size limit");
  };
};

export interface LiveSyncStreamHandlers {
  readonly onEvent: (event: LiveSyncEvent) => void;
  /** Called for every chunk, including heartbeat comments. */
  readonly onActivity?: () => void;
}

/**
 * Reads a live sync response body until it ends or `signal` aborts.
 * Comments, unknown events and malformed frames are ignored.
 */
export const readLiveSyncStream = async (
  body: ReadableStream<Uint8Array>,
  handlers: LiveSyncStreamHandlers,
  signal?: AbortSignal,
): Promise<void> => {
  const reader = body.getReader();
  const cancel = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  if (signal?.aborted === true) cancel();
  signal?.addEventListener("abort", cancel, { once: true });
  const decoder = new TextDecoder();
  const push = createFrameSplitter((frame) => {
    const event = decodeLiveSyncEvent(frame);
    if (event !== undefined) handlers.onEvent(event);
  });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      handlers.onActivity?.();
      push(decoder.decode(value, { stream: true }));
    }
  } finally {
    signal?.removeEventListener("abort", cancel);
    cancel();
  }
};

export const liveSyncBackoffMinMs = 1_000;
export const liveSyncBackoffMaxMs = 60_000;
/** A stream with no bytes for this many heartbeat intervals is dead. */
export const liveSyncHeartbeatTolerance = 2.5;

/**
 * Jittered exponential delay before reconnect `attempt` (0 for the first
 * retry): one second doubling to one minute, spread by half either way and
 * kept inside the one second to one minute range.
 */
export const liveSyncBackoffMs = (
  attempt: number,
  random: () => number = Math.random,
): number => {
  const base = Math.min(
    liveSyncBackoffMaxMs,
    liveSyncBackoffMinMs * 2 ** Math.min(attempt, 16),
  );
  return Math.round(
    Math.min(
      liveSyncBackoffMaxMs,
      Math.max(liveSyncBackoffMinMs, base * (0.5 + random())),
    ),
  );
};

export type LiveSyncConnectionState =
  "connecting" | "live" | "reconnecting" | "stopped";

/**
 * Why a connection stopped for good. `session-ended` covers a 401 or 403
 * response and `bye: session-ended`; `client-revoked` is `bye:
 * client-revoked`; `closed` is a local `stop()`.
 */
export type LiveSyncStopReason = "session-ended" | "client-revoked" | "closed";

export interface LiveSyncConnectionOptions {
  /** Opens the stream; see `openLiveSyncStream`. */
  readonly open: (signal: AbortSignal) => Promise<Response>;
  readonly onEvent: (event: LiveSyncEvent) => void;
  readonly onState: (
    state: LiveSyncConnectionState,
    reason?: LiveSyncStopReason,
  ) => void;
  readonly random?: () => number;
}

type AttemptOutcome = "retry" | "replaced" | "session-ended" | "client-revoked";

/**
 * Keeps one live sync stream open: reconnects with backoff, treats a silent
 * stream as dead, and stops for good when the session ended or the client
 * was revoked. A new sign-in creates a new connection.
 */
export class LiveSyncConnection {
  readonly #options: LiveSyncConnectionOptions;
  #started = false;
  #stopped = false;
  #attempt = 0;
  #request: AbortController | undefined;
  #wake: (() => void) | undefined;

  constructor(options: LiveSyncConnectionOptions) {
    this.#options = options;
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    void this.#run();
  }

  /** Closes the stream and stops reconnecting. */
  stop(): void {
    this.#finish("closed");
  }

  /** Skips a pending backoff delay, for example when the network returns. */
  retryNow(): void {
    this.#attempt = 0;
    this.#wake?.();
  }

  #isStopped(): boolean {
    return this.#stopped;
  }

  #finish(reason: LiveSyncStopReason): void {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#request?.abort();
    this.#wake?.();
    this.#options.onState("stopped", reason);
  }

  async #run(): Promise<void> {
    this.#options.onState("connecting");
    while (!this.#isStopped()) {
      const outcome = await this.#attemptOnce();
      // stop() may have been called while the attempt was open.
      if (this.#isStopped()) return;
      if (outcome === "session-ended" || outcome === "client-revoked") {
        this.#finish(outcome);
        return;
      }
      this.#options.onState("reconnecting");
      // Another stream of this client replaced this one. Reconnecting at once
      // would replace it in turn, so wait the longest delay instead.
      const delay =
        outcome === "replaced"
          ? liveSyncBackoffMs(16, this.#options.random)
          : liveSyncBackoffMs(this.#attempt, this.#options.random);
      this.#attempt += 1;
      await this.#wait(delay);
    }
  }

  async #attemptOnce(): Promise<AttemptOutcome> {
    const request = new AbortController();
    this.#request = request;
    let heartbeatMs = liveSyncHeartbeatSeconds * 1_000;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const arm = (): void => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        request.abort();
      }, heartbeatMs * liveSyncHeartbeatTolerance);
    };
    let outcome: AttemptOutcome = "retry";
    try {
      // Armed before the response arrives so a hung connect is also retried.
      arm();
      const response = await this.#options.open(request.signal);
      if (response.status === 401 || response.status === 403) {
        void response.body?.cancel().catch(() => undefined);
        return "session-ended";
      }
      const contentType = response.headers.get("content-type") ?? "";
      if (
        !response.ok ||
        response.body === null ||
        !contentType.includes("text/event-stream")
      ) {
        void response.body?.cancel().catch(() => undefined);
        return "retry";
      }
      await readLiveSyncStream(
        response.body,
        {
          onActivity: arm,
          onEvent: (event) => {
            if (this.#stopped) return;
            if (event.event === "hello") {
              heartbeatMs = event.data.heartbeatSeconds * 1_000;
              arm();
              this.#attempt = 0;
              this.#options.onState("live");
            } else if (event.event === "bye") {
              const { reason } = event.data;
              if (
                reason === "session-ended" ||
                reason === "client-revoked" ||
                reason === "replaced"
              )
                outcome = reason;
              request.abort();
            }
            this.#options.onEvent(event);
          },
        },
        request.signal,
      );
    } catch {
      // A network error, an abort or a heartbeat timeout: reconnect.
    } finally {
      clearTimeout(watchdog);
      request.abort();
    }
    return outcome;
  }

  #wait(delayMs: number): Promise<void> {
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        this.#wake = undefined;
        resolve();
      };
      const timer = setTimeout(done, delayMs);
      this.#wake = done;
    });
  }
}
