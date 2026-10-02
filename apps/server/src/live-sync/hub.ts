import {
  encodeLiveSyncEvent,
  liveSyncEventNames,
  liveSyncHeartbeatSeconds,
  liveSyncResourceFamilies,
  type LiveSyncByeEvent,
  type LiveSyncEvent,
  type LiveSyncEventName,
  type LiveSyncResourceFamily,
} from "@suite/contracts";

/**
 * In-process hub of the live sync hint stream (ADR 0045). It keeps the open
 * streams of each owner and writes `hello`, `changes`, `resources` and `bye`
 * frames. It never reads the database and never sees record content: callers
 * hand it feed positions and resource family names only.
 */

export type LiveSyncByeReason = LiveSyncByeEvent["reason"];

/** Time source and timers; tests replace them with a manual clock. */
export interface LiveSyncTimers {
  now(): number;
  setTimeout(callback: () => void, milliseconds: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(callback: () => void, milliseconds: number): unknown;
  clearInterval(handle: unknown): void;
}

export const systemLiveSyncTimers: LiveSyncTimers = {
  now: () => Date.now(),
  setTimeout: (callback, milliseconds) => {
    const handle = setTimeout(callback, milliseconds);
    handle.unref();
    return handle;
  },
  clearTimeout: (handle) => {
    clearTimeout(handle as NodeJS.Timeout);
  },
  setInterval: (callback, milliseconds) => {
    const handle = setInterval(callback, milliseconds);
    handle.unref();
    return handle;
  },
  clearInterval: (handle) => {
    clearInterval(handle as NodeJS.Timeout);
  },
};

/** The response side of one stream. */
export interface LiveSyncSink {
  /** Returns false when the socket buffer is full (backpressure). */
  write(chunk: string): boolean;
  /** Writes a last chunk and ends the response. */
  end(chunk: string): void;
  /** Drops the connection without a final frame. */
  destroy(): void;
}

/** Feed position of one owner, as `SuiteDatabase.getSyncState` returns it. */
export interface LiveSyncHead {
  readonly epoch: string;
  readonly cursor: number;
}

export interface LiveSyncStreamInput {
  readonly ownerId: string;
  /** Registered sync client; one stream per client. */
  readonly clientId: string;
  readonly head: LiveSyncHead;
  readonly sink: LiveSyncSink;
  /**
   * Returns a reason when the stream must end: the session expired or was
   * revoked, or the client was revoked. Called on every sweep.
   */
  readonly check: () => "session-ended" | "client-revoked" | undefined;
}

export interface LiveSyncStreamHandle {
  /** The socket accepted buffered data again. */
  readonly drained: () => void;
  /** The peer closed the connection. */
  readonly closed: () => void;
}

export interface LiveSyncHubOptions {
  readonly timers?: LiveSyncTimers;
  /** Runs every `tickMs` while at least one stream is open. */
  readonly onTick?: () => void;
  readonly heartbeatSeconds?: number;
  readonly coalesceMs?: number;
  readonly tickMs?: number;
  readonly maxStreamsPerOwner?: number;
  readonly writeTimeoutMs?: number;
}

export interface LiveSyncMetrics {
  readonly openStreams: number;
  readonly hints: Readonly<Record<LiveSyncEventName, number>>;
  readonly dropped: number;
}

interface Stream {
  readonly ownerId: string;
  readonly clientId: string;
  readonly sink: LiveSyncSink;
  readonly check: LiveSyncStreamInput["check"];
  /** Last feed head this stream was told about. */
  lastHead: string;
  /** Set while the socket reports backpressure. */
  blockedTimer: unknown;
  open: boolean;
}

interface OwnerState {
  readonly streams: Map<string, Stream>;
  epoch: string;
  cursor: number;
  headPending: boolean;
  /** Families waiting for the flush, by source client (`null` key included). */
  readonly resources: Map<string | null, Set<LiveSyncResourceFamily>>;
  flushTimer: unknown;
}

const headCursor = (head: LiveSyncHead): string =>
  `${head.epoch}.${String(head.cursor)}`;

const heartbeatFrame = ": hb\n\n";

export class LiveSyncHub {
  readonly #timers: LiveSyncTimers;
  readonly #onTick: (() => void) | undefined;
  readonly #heartbeatSeconds: number;
  readonly #coalesceMs: number;
  readonly #tickMs: number;
  readonly #maxStreamsPerOwner: number;
  readonly #writeTimeoutMs: number;
  readonly #owners = new Map<string, OwnerState>();
  readonly #hints: Record<LiveSyncEventName, number> = Object.fromEntries(
    liveSyncEventNames.map((name) => [name, 0]),
  ) as Record<LiveSyncEventName, number>;
  #dropped = 0;
  #openStreams = 0;
  #heartbeatTimer: unknown;
  #tickTimer: unknown;
  #closed = false;

  constructor(options: LiveSyncHubOptions = {}) {
    this.#timers = options.timers ?? systemLiveSyncTimers;
    this.#onTick = options.onTick;
    this.#heartbeatSeconds =
      options.heartbeatSeconds ?? liveSyncHeartbeatSeconds;
    this.#coalesceMs = options.coalesceMs ?? 100;
    this.#tickMs = options.tickMs ?? 2000;
    this.#maxStreamsPerOwner = options.maxStreamsPerOwner ?? 8;
    this.#writeTimeoutMs = options.writeTimeoutMs ?? 30_000;
  }

  get openStreams(): number {
    return this.#openStreams;
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** Owners with at least one open stream. */
  owners(): readonly string[] {
    return [...this.#owners.keys()];
  }

  metrics(): LiveSyncMetrics {
    return {
      openStreams: this.#openStreams,
      hints: { ...this.#hints },
      dropped: this.#dropped,
    };
  }

  /**
   * Whether `open` would accept this client. A client that already holds a
   * stream is always accepted, because the new stream replaces the old one.
   */
  accepts(ownerId: string, clientId: string): boolean {
    if (this.#closed) return false;
    const owner = this.#owners.get(ownerId);
    return (
      owner === undefined ||
      owner.streams.has(clientId) ||
      owner.streams.size < this.#maxStreamsPerOwner
    );
  }

  /**
   * Registers a stream and writes `hello`. Returns undefined when the hub is
   * closed or the owner already has the maximum number of streams; the caller
   * checks `accepts` before it sends response headers.
   */
  open(input: LiveSyncStreamInput): LiveSyncStreamHandle | undefined {
    if (!this.accepts(input.ownerId, input.clientId)) return undefined;
    // Streams that are already open learn about a head they have not seen,
    // and end if the epoch changed, before the new stream joins.
    this.publishHead(input.ownerId, input.head);
    const previous = this.#owners
      .get(input.ownerId)
      ?.streams.get(input.clientId);
    if (previous !== undefined) this.#bye(previous, "replaced");
    let owner = this.#owners.get(input.ownerId);
    if (owner === undefined) {
      owner = {
        streams: new Map(),
        epoch: input.head.epoch,
        cursor: input.head.cursor,
        headPending: false,
        resources: new Map(),
        flushTimer: undefined,
      };
      this.#owners.set(input.ownerId, owner);
    }
    const stream: Stream = {
      ownerId: input.ownerId,
      clientId: input.clientId,
      sink: input.sink,
      check: input.check,
      lastHead: headCursor(input.head),
      blockedTimer: undefined,
      open: true,
    };
    owner.streams.set(input.clientId, stream);
    this.#openStreams += 1;
    this.#startTimers();
    this.#send(stream, {
      event: "hello",
      data: {
        protocolVersion: 2,
        head: stream.lastHead,
        heartbeatSeconds: this.#heartbeatSeconds,
        serverTimestamp: new Date(this.#timers.now()).toISOString(),
      },
    });
    return {
      drained: () => {
        if (stream.blockedTimer === undefined) return;
        this.#timers.clearTimeout(stream.blockedTimer);
        stream.blockedTimer = undefined;
      },
      closed: () => {
        this.#remove(stream);
      },
    };
  }

  /**
   * Reports the owner's current feed position. A moved cursor schedules a
   * `changes` hint; a different epoch ends the owner's streams with
   * `bye: epoch-reset`, so each client reconnects and reads the new head.
   */
  publishHead(ownerId: string, head: LiveSyncHead): void {
    const owner = this.#owners.get(ownerId);
    if (owner === undefined) return;
    if (owner.epoch !== head.epoch) {
      this.#flush(ownerId);
      for (const stream of [...owner.streams.values()])
        this.#bye(stream, "epoch-reset");
      return;
    }
    if (owner.cursor === head.cursor) return;
    owner.cursor = head.cursor;
    owner.headPending = true;
    this.#schedule(ownerId, owner);
  }

  /**
   * Schedules a `resources` hint. `sourceClientId` is the registered client
   * whose request changed the records, or null.
   */
  publishResources(
    ownerId: string,
    families: readonly LiveSyncResourceFamily[],
    sourceClientId: string | null,
  ): void {
    const owner = this.#owners.get(ownerId);
    if (owner === undefined || families.length === 0) return;
    let pending = owner.resources.get(sourceClientId);
    if (pending === undefined) {
      pending = new Set();
      owner.resources.set(sourceClientId, pending);
    }
    for (const family of families) pending.add(family);
    this.#schedule(ownerId, owner);
  }

  /** Ends every stream whose session or client is no longer valid. */
  sweep(): void {
    for (const owner of [...this.#owners.values()])
      for (const stream of [...owner.streams.values()]) {
        let reason: ReturnType<Stream["check"]>;
        try {
          reason = stream.check();
        } catch {
          // A failed check (for example a closed database) says nothing
          // about the session; the next sweep asks again.
          continue;
        }
        if (reason !== undefined) this.#bye(stream, reason);
      }
  }

  /** Sends `bye: shutdown` to every stream and refuses new ones. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const owner of [...this.#owners.values()])
      for (const stream of [...owner.streams.values()])
        this.#bye(stream, "shutdown");
    this.#stopTimers();
  }

  #schedule(ownerId: string, owner: OwnerState): void {
    if (owner.flushTimer !== undefined) return;
    owner.flushTimer = this.#timers.setTimeout(() => {
      owner.flushTimer = undefined;
      this.#flush(ownerId);
    }, this.#coalesceMs);
  }

  /** Writes the merged hints of one owner. */
  #flush(ownerId: string): void {
    const owner = this.#owners.get(ownerId);
    if (owner === undefined) return;
    if (owner.flushTimer !== undefined) {
      this.#timers.clearTimeout(owner.flushTimer);
      owner.flushTimer = undefined;
    }
    if (owner.headPending) {
      owner.headPending = false;
      const head = headCursor(owner);
      for (const stream of [...owner.streams.values()]) {
        if (stream.lastHead === head) continue;
        stream.lastHead = head;
        this.#send(stream, { event: "changes", data: { head } });
      }
    }
    const resources = [...owner.resources.entries()];
    owner.resources.clear();
    for (const [sourceClientId, pending] of resources) {
      const families = pending.has("all")
        ? (["all"] as const)
        : liveSyncResourceFamilies.filter((family) => pending.has(family));
      for (const stream of [...owner.streams.values()])
        this.#send(stream, {
          event: "resources",
          data: { families: [...families], sourceClientId },
        });
    }
  }

  #send(stream: Stream, event: LiveSyncEvent): void {
    if (this.#write(stream, encodeLiveSyncEvent(event)))
      this.#hints[event.event] += 1;
  }

  /** Returns false when the stream was dropped instead. */
  #write(stream: Stream, chunk: string): boolean {
    if (!stream.open) return false;
    let accepted: boolean;
    try {
      accepted = stream.sink.write(chunk);
    } catch {
      this.#drop(stream);
      return false;
    }
    if (!accepted && stream.blockedTimer === undefined)
      stream.blockedTimer = this.#timers.setTimeout(() => {
        stream.blockedTimer = undefined;
        this.#drop(stream);
      }, this.#writeTimeoutMs);
    return true;
  }

  /** Ends a stream on purpose with a final `bye`. */
  #bye(stream: Stream, reason: LiveSyncByeReason): void {
    if (!stream.open) return;
    const blocked = stream.blockedTimer !== undefined;
    this.#remove(stream);
    try {
      // A socket that is not being read cannot deliver the frame; ending it
      // would leave the connection open until the peer reads.
      if (blocked) stream.sink.destroy();
      else {
        stream.sink.end(
          encodeLiveSyncEvent({ event: "bye", data: { reason } }),
        );
        this.#hints.bye += 1;
      }
    } catch {
      // The connection is already gone.
    }
  }

  /** Drops a stream that cannot be written to. */
  #drop(stream: Stream): void {
    if (!stream.open) return;
    this.#remove(stream);
    this.#dropped += 1;
    try {
      stream.sink.destroy();
    } catch {
      // The connection is already gone.
    }
  }

  #remove(stream: Stream): void {
    if (!stream.open) return;
    stream.open = false;
    if (stream.blockedTimer !== undefined) {
      this.#timers.clearTimeout(stream.blockedTimer);
      stream.blockedTimer = undefined;
    }
    const owner = this.#owners.get(stream.ownerId);
    if (owner?.streams.get(stream.clientId) === stream) {
      owner.streams.delete(stream.clientId);
      if (owner.streams.size === 0) {
        if (owner.flushTimer !== undefined)
          this.#timers.clearTimeout(owner.flushTimer);
        this.#owners.delete(stream.ownerId);
      }
    }
    this.#openStreams -= 1;
    if (this.#openStreams === 0) this.#stopTimers();
  }

  #startTimers(): void {
    this.#heartbeatTimer ??= this.#timers.setInterval(() => {
      for (const owner of [...this.#owners.values()])
        for (const stream of [...owner.streams.values()])
          // A blocked socket already has unread data keeping it busy.
          if (stream.blockedTimer === undefined)
            this.#write(stream, heartbeatFrame);
    }, this.#heartbeatSeconds * 1000);
    if (this.#onTick !== undefined)
      this.#tickTimer ??= this.#timers.setInterval(() => {
        this.#onTick?.();
      }, this.#tickMs);
  }

  #stopTimers(): void {
    if (this.#heartbeatTimer !== undefined)
      this.#timers.clearInterval(this.#heartbeatTimer);
    if (this.#tickTimer !== undefined)
      this.#timers.clearInterval(this.#tickTimer);
    this.#heartbeatTimer = undefined;
    this.#tickTimer = undefined;
  }
}
