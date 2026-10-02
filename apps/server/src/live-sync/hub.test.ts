import { describe, expect, it } from "vitest";
import {
  decodeLiveSyncEvent,
  liveSyncHeartbeatSeconds,
  type LiveSyncEvent,
} from "@suite/contracts";
import {
  LiveSyncHub,
  type LiveSyncHubOptions,
  type LiveSyncStreamHandle,
  type LiveSyncStreamInput,
} from "./hub.ts";
import { ManualLiveSyncTimers } from "./manual-timers.ts";

const owner = "owner-1";
const epoch = "epoch-a";
/** `resources` names its source client by UUID. */
const sourceClient = "6f1c2c3e-4f0a-4d53-9d6e-0c3b2f6f8a10";

/** A sink that records frames and can simulate a socket that stops reading. */
class FakeSink {
  readonly chunks: string[] = [];
  ended = false;
  destroyed = false;
  blocked = false;

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return !this.blocked;
  }

  end(chunk: string): void {
    this.chunks.push(chunk);
    this.ended = true;
  }

  destroy(): void {
    this.destroyed = true;
  }

  events(): LiveSyncEvent[] {
    return this.chunks
      .map((chunk) => decodeLiveSyncEvent(chunk.trimEnd()))
      .filter((event): event is LiveSyncEvent => event !== undefined);
  }

  names(): string[] {
    return this.events().map(({ event }) => event);
  }
}

const setup = (options: Partial<LiveSyncHubOptions> = {}) => {
  const timers = new ManualLiveSyncTimers();
  let ticks = 0;
  const hub = new LiveSyncHub({
    timers,
    onTick: () => {
      ticks += 1;
    },
    ...options,
  });
  const open = (
    clientId: string,
    input: Partial<LiveSyncStreamInput> = {},
  ): { sink: FakeSink; handle: LiveSyncStreamHandle | undefined } => {
    const sink = new FakeSink();
    const handle = hub.open({
      ownerId: owner,
      clientId,
      head: { epoch, cursor: 4 },
      sink,
      check: () => undefined,
      ...input,
    });
    return { sink, handle };
  };
  return { timers, hub, open, ticks: () => ticks };
};

describe("live sync hub (ADR 0045)", () => {
  it("greets a stream with the feed head and the heartbeat interval", () => {
    const { open, timers } = setup();
    const { sink } = open("client-a");
    expect(sink.events()).toEqual([
      {
        event: "hello",
        data: {
          protocolVersion: 2,
          head: "epoch-a.4",
          heartbeatSeconds: liveSyncHeartbeatSeconds,
          serverTimestamp: new Date(timers.now()).toISOString(),
        },
      },
    ]);
  });

  it("merges the hints of one owner within 100 ms", () => {
    const { hub, open, timers } = setup();
    const a = open("client-a").sink;
    const b = open("client-b").sink;
    hub.publishHead(owner, { epoch, cursor: 5 });
    hub.publishResources(owner, ["notes"], sourceClient);
    timers.advance(60);
    hub.publishHead(owner, { epoch, cursor: 6 });
    hub.publishResources(owner, ["boards", "notes"], sourceClient);
    hub.publishResources(owner, ["counters"], null);
    timers.advance(39);
    expect(a.names()).toEqual(["hello"]);
    timers.advance(1);
    const expected = [
      { event: "changes", data: { head: "epoch-a.6" } },
      {
        event: "resources",
        data: { families: ["notes", "boards"], sourceClientId: sourceClient },
      },
      {
        event: "resources",
        data: { families: ["counters"], sourceClientId: null },
      },
    ];
    expect(a.events().slice(1)).toEqual(expected);
    expect(b.events().slice(1)).toEqual(expected);
    // Nothing is repeated once the window has been flushed.
    hub.publishHead(owner, { epoch, cursor: 6 });
    timers.advance(1000);
    expect(a.events()).toHaveLength(4);
  });

  it("collapses a merged hint that contains all into all", () => {
    const { hub, open, timers } = setup();
    const { sink } = open("client-a");
    hub.publishResources(owner, ["notes"], null);
    hub.publishResources(owner, ["all"], null);
    timers.advance(100);
    expect(sink.events().at(-1)).toEqual({
      event: "resources",
      data: { families: ["all"], sourceClientId: null },
    });
  });

  it("does not repeat the head a stream received in hello", () => {
    const { hub, open, timers } = setup();
    const a = open("client-a").sink;
    hub.publishHead(owner, { epoch, cursor: 9 });
    // A stream that connects inside the window reads cursor 9 in hello.
    const b = open("client-b", { head: { epoch, cursor: 9 } }).sink;
    timers.advance(100);
    expect(a.events().at(-1)).toEqual({
      event: "changes",
      data: { head: "epoch-a.9" },
    });
    expect(b.names()).toEqual(["hello"]);
  });

  it("announces a head that a connecting stream brings", () => {
    const { open, timers } = setup();
    const a = open("client-a").sink;
    open("client-b", { head: { epoch, cursor: 7 } });
    timers.advance(100);
    expect(a.events().at(-1)).toEqual({
      event: "changes",
      data: { head: "epoch-a.7" },
    });
  });

  it("replaces the stream of a client that connects again", () => {
    const { hub, open } = setup();
    const first = open("client-a").sink;
    const second = open("client-a").sink;
    expect(first.events().at(-1)).toEqual({
      event: "bye",
      data: { reason: "replaced" },
    });
    expect(first.ended).toBe(true);
    expect(second.names()).toEqual(["hello"]);
    expect(hub.openStreams).toBe(1);
  });

  it("refuses a ninth stream for one owner but still replaces an existing client", () => {
    const { hub, open } = setup();
    for (let index = 0; index < 8; index += 1)
      expect(open(`client-${String(index)}`).handle).toBeDefined();
    expect(hub.accepts(owner, "client-8")).toBe(false);
    const refused = open("client-8");
    expect(refused.handle).toBeUndefined();
    expect(refused.sink.chunks).toEqual([]);
    expect(hub.accepts(owner, "client-3")).toBe(true);
    expect(open("client-3").handle).toBeDefined();
    expect(hub.accepts("owner-2", "client-8")).toBe(true);
    expect(hub.openStreams).toBe(8);
  });

  it("writes a heartbeat comment at the heartbeat interval", () => {
    const { open, timers } = setup();
    const { sink } = open("client-a");
    timers.advance(liveSyncHeartbeatSeconds * 1000 - 1);
    expect(sink.chunks).toHaveLength(1);
    timers.advance(1);
    expect(sink.chunks.at(-1)).toBe(": hb\n\n");
    timers.advance(liveSyncHeartbeatSeconds * 1000);
    expect(sink.chunks.filter((chunk) => chunk === ": hb\n\n")).toHaveLength(2);
  });

  it("drops a stream whose socket cannot be written for 30 seconds", () => {
    const { hub, open, timers } = setup();
    const stalled = open("client-a");
    const healthy = open("client-b");
    stalled.sink.blocked = true;
    hub.publishHead(owner, { epoch, cursor: 5 });
    timers.advance(100);
    timers.advance(29_999);
    expect(stalled.sink.destroyed).toBe(false);
    timers.advance(1);
    expect(stalled.sink.destroyed).toBe(true);
    expect(stalled.sink.ended).toBe(false);
    expect(healthy.sink.destroyed).toBe(false);
    expect(hub.metrics()).toMatchObject({ openStreams: 1, dropped: 1 });
  });

  it("keeps a stream that drains before the write timeout", () => {
    const { hub, open, timers } = setup();
    const { sink, handle } = open("client-a");
    sink.blocked = true;
    hub.publishHead(owner, { epoch, cursor: 5 });
    timers.advance(100);
    timers.advance(20_000);
    sink.blocked = false;
    handle?.drained();
    timers.advance(60_000);
    expect(sink.destroyed).toBe(false);
    expect(hub.metrics()).toMatchObject({ openStreams: 1, dropped: 0 });
  });

  it("ends streams whose session ended or whose client was revoked", () => {
    const { hub, open } = setup();
    let sessionEnded = false;
    let revoked = false;
    const a = open("client-a", {
      check: () => (sessionEnded ? "session-ended" : undefined),
    }).sink;
    const b = open("client-b", {
      check: () => (revoked ? "client-revoked" : undefined),
    }).sink;
    const c = open("client-c", {
      check: () => {
        throw new Error("database closed");
      },
    }).sink;
    hub.sweep();
    expect(hub.openStreams).toBe(3);
    sessionEnded = true;
    revoked = true;
    hub.sweep();
    expect(a.events().at(-1)).toEqual({
      event: "bye",
      data: { reason: "session-ended" },
    });
    expect(b.events().at(-1)).toEqual({
      event: "bye",
      data: { reason: "client-revoked" },
    });
    expect(c.ended).toBe(false);
    expect(hub.openStreams).toBe(1);
  });

  it("ends every stream of an owner when the feed epoch changes", () => {
    const { hub, open, timers } = setup();
    const a = open("client-a").sink;
    const b = open("client-b").sink;
    hub.publishResources(owner, ["all"], null);
    hub.publishHead(owner, { epoch: "epoch-b", cursor: 0 });
    // The pending hint is written before the stream ends.
    expect(a.names()).toEqual(["hello", "resources", "bye"]);
    expect(b.events().at(-1)).toEqual({
      event: "bye",
      data: { reason: "epoch-reset" },
    });
    expect(hub.openStreams).toBe(0);
    expect(timers.pending).toBe(0);
    // A client that reconnects reads the new epoch in hello.
    const again = open("client-a", { head: { epoch: "epoch-b", cursor: 0 } });
    expect(again.sink.events()[0]).toMatchObject({
      event: "hello",
      data: { head: "epoch-b.0" },
    });
  });

  it("says bye: shutdown on close and refuses new streams", () => {
    const { hub, open, timers } = setup();
    const a = open("client-a").sink;
    const stalled = open("client-b").sink;
    stalled.blocked = true;
    hub.publishHead(owner, { epoch, cursor: 5 });
    timers.advance(100);
    hub.close();
    expect(a.events().at(-1)).toEqual({
      event: "bye",
      data: { reason: "shutdown" },
    });
    expect(a.ended).toBe(true);
    // A socket that is not being read is destroyed rather than ended.
    expect(stalled.destroyed).toBe(true);
    expect(hub.openStreams).toBe(0);
    expect(timers.pending).toBe(0);
    expect(hub.accepts(owner, "client-c")).toBe(false);
    expect(open("client-c").handle).toBeUndefined();
  });

  it("ticks only while a stream is open and forgets a closed peer", () => {
    const { hub, open, timers, ticks } = setup();
    timers.advance(10_000);
    expect(ticks()).toBe(0);
    const { handle, sink } = open("client-a");
    timers.advance(6000);
    expect(ticks()).toBe(3);
    handle?.closed();
    expect(hub.openStreams).toBe(0);
    expect(hub.owners()).toEqual([]);
    timers.advance(10_000);
    expect(ticks()).toBe(3);
    expect(timers.pending).toBe(0);
    hub.publishHead(owner, { epoch, cursor: 9 });
    timers.advance(100);
    expect(sink.names()).toEqual(["hello"]);
  });

  it("counts events by name without identifiers", () => {
    const { hub, open, timers } = setup();
    open("client-a");
    open("client-b");
    hub.publishHead(owner, { epoch, cursor: 5 });
    hub.publishResources(owner, ["notes"], "client-a");
    timers.advance(100);
    open("client-a");
    expect(hub.metrics()).toEqual({
      openStreams: 2,
      hints: { hello: 3, changes: 2, resources: 2, bye: 1 },
      dropped: 0,
    });
  });
});
