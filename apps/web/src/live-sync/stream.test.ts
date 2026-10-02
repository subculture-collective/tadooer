import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  encodeLiveSyncEvent,
  liveSyncPath,
  type LiveSyncEvent,
} from "@suite/contracts";
import { openLiveSyncStream, syncRound } from "../api.ts";
import {
  createFrameSplitter,
  LiveSyncConnection,
  liveSyncBackoffMs,
  readLiveSyncStream,
  type LiveSyncConnectionState,
  type LiveSyncStopReason,
} from "./stream.ts";
import { FakeStream, hello } from "./test-fakes.ts";

const client = {
  installationId: "installation",
  clientId: "d1054acd-c04d-4bd8-a814-254b007154ba",
  clientCredential: "A".repeat(43),
  cursor: "epoch.4",
};

const changes: LiveSyncEvent = { event: "changes", data: { head: "epoch.5" } };
const resources: LiveSyncEvent = {
  event: "resources",
  data: { families: ["notes", "boards"], sourceClientId: null },
};

const flush = (): Promise<unknown> => vi.advanceTimersByTimeAsync(0);

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("live sync requests", () => {
  it("opens the stream with the session cookie and the client proof", async () => {
    const fetcher = vi.fn<
      (path: string, init: RequestInit) => Promise<Response>
    >(() => Promise.resolve(new FakeStream().response));
    vi.stubGlobal("fetch", fetcher);
    const abort = new AbortController();
    await openLiveSyncStream(client, abort.signal);
    const [path, init] = fetcher.mock.calls[0] ?? [];
    expect(path).toBe(liveSyncPath);
    expect(init?.credentials).toBe("same-origin");
    expect(init?.signal).toBe(abort.signal);
    expect(init?.method).toBeUndefined();
    const headers = new Headers(init?.headers);
    expect(headers.get("x-suite-client-id")).toBe(client.clientId);
    expect(headers.get("x-suite-client-credential")).toBe(
      client.clientCredential,
    );
    expect(headers.get("x-suite-sync-version")).toBe("2");
    expect(headers.get("accept")).toBe("text/event-stream");
  });

  it("marks a hint-driven round with the push trigger header only when asked", async () => {
    const fetcher = vi.fn<
      (path: string, init: RequestInit) => Promise<Response>
    >(() =>
      Promise.resolve(
        Response.json({
          outcomes: [],
          changes: [],
          nextCursor: "epoch.5",
          hasMore: false,
          protocolVersion: 2,
          serverTimestamp: "2026-10-02T12:00:00.000Z",
        }),
      ),
    );
    vi.stubGlobal("fetch", fetcher);
    const request = { cursor: "epoch.4", operations: [], pullLimit: 100 };
    await syncRound(client, "csrf", request, "push");
    await syncRound(client, "csrf", request);
    const trigger = (call: number): string | null =>
      new Headers(fetcher.mock.calls[call]?.[1].headers).get(
        "x-suite-sync-trigger",
      );
    expect(trigger(0)).toBe("push");
    expect(trigger(1)).toBeNull();
  });
});

describe("live sync frames", () => {
  it("reassembles events split at every chunk boundary", () => {
    const text =
      ": hb\n\n" +
      encodeLiveSyncEvent(hello("epoch.4")) +
      encodeLiveSyncEvent(changes).replaceAll("\n", "\r\n") +
      ": hb\r\n\r\n" +
      encodeLiveSyncEvent(resources);
    for (let cut = 1; cut < text.length; cut += 1) {
      const frames: string[] = [];
      const push = createFrameSplitter((frame) => frames.push(frame));
      push(text.slice(0, cut));
      push(text.slice(cut));
      expect(frames, `cut at ${String(cut)}`).toHaveLength(5);
    }
    const frames: string[] = [];
    const push = createFrameSplitter((frame) => frames.push(frame));
    for (const character of text) push(character);
    expect(frames).toHaveLength(5);
  });

  it("refuses a frame that never ends", () => {
    const push = createFrameSplitter(() => undefined);
    expect(() => {
      push("data: ".padEnd(70_000, "x"));
    }).toThrow("size limit");
  });

  it("decodes events from a byte stream and ignores comments and unknown events", async () => {
    const stream = new FakeStream();
    const events: LiveSyncEvent[] = [];
    let activity = 0;
    const body = stream.response.body;
    if (body === null) throw new Error("missing body");
    const reading = readLiveSyncStream(body, {
      onEvent: (event) => events.push(event),
      onActivity: () => {
        activity += 1;
      },
    });
    const encoded = encodeLiveSyncEvent(hello("epoch.4"));
    stream.write(encoded.slice(0, 11));
    stream.write(encoded.slice(11));
    stream.heartbeat();
    stream.write('event: later\ndata: {"anything":1}\n\n');
    stream.write("event: changes\ndata: not json\n\n");
    stream.send(changes);
    stream.end();
    await reading;
    expect(events).toEqual([hello("epoch.4"), changes]);
    expect(activity).toBe(6);
  });

  it("stops reading when aborted", async () => {
    const stream = new FakeStream();
    const abort = new AbortController();
    const body = stream.response.body;
    if (body === null) throw new Error("missing body");
    const reading = readLiveSyncStream(
      body,
      { onEvent: () => undefined },
      abort.signal,
    );
    abort.abort();
    await reading;
    expect(stream.cancelled).toBe(true);
  });
});

describe("live sync backoff", () => {
  it("doubles from one second to one minute with jitter inside that range", () => {
    const middle = (attempt: number): number =>
      liveSyncBackoffMs(attempt, () => 0.5);
    expect([0, 1, 2, 3, 4, 5, 6, 7, 30].map(middle)).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000, 60_000,
    ]);
    for (const random of [0, 0.25, 0.999]) {
      for (let attempt = 0; attempt < 12; attempt += 1) {
        const delay = liveSyncBackoffMs(attempt, () => random);
        expect(delay).toBeGreaterThanOrEqual(1_000);
        expect(delay).toBeLessThanOrEqual(60_000);
      }
    }
    expect(liveSyncBackoffMs(3, () => 0)).toBe(4_000);
    expect(liveSyncBackoffMs(3, () => 0.999)).toBe(11_992);
  });
});

describe("LiveSyncConnection", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  const harness = () => {
    const streams: FakeStream[] = [];
    const signals: AbortSignal[] = [];
    const states: [LiveSyncConnectionState, LiveSyncStopReason?][] = [];
    const events: LiveSyncEvent[] = [];
    let next: (() => Promise<Response>) | undefined;
    const connection = new LiveSyncConnection({
      open: (signal) => {
        signals.push(signal);
        if (next !== undefined) return next();
        const stream = new FakeStream();
        streams.push(stream);
        return Promise.resolve(stream.response);
      },
      onEvent: (event) => events.push(event),
      onState: (state, reason) =>
        states.push(reason === undefined ? [state] : [state, reason]),
      random: () => 0.5,
    });
    return {
      connection,
      streams,
      signals,
      states,
      events,
      failWith: (open: (() => Promise<Response>) | undefined) => {
        next = open;
      },
      latest: (): FakeStream => {
        const stream = streams.at(-1);
        if (stream === undefined) throw new Error("no stream opened");
        return stream;
      },
    };
  };

  it("backs off exponentially while the server is unreachable and resets after hello", async () => {
    const test = harness();
    test.failWith(() => Promise.reject(new TypeError("network")));
    test.connection.start();
    await flush();
    expect(test.signals).toHaveLength(1);
    expect(test.states).toEqual([["connecting"], ["reconnecting"]]);
    // Delays with the jitter fixed at its midpoint: 1 s, 2 s, 4 s.
    await vi.advanceTimersByTimeAsync(999);
    expect(test.signals).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(test.signals).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(test.signals).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(test.signals).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(3_999);
    expect(test.signals).toHaveLength(3);

    test.failWith(undefined);
    await vi.advanceTimersByTimeAsync(1);
    expect(test.signals).toHaveLength(4);
    test.latest().send(hello("epoch.4"));
    await flush();
    expect(test.states.at(-1)).toEqual(["live"]);
    expect(test.events).toEqual([hello("epoch.4")]);

    // The server drops the stream: the next retry is back at one second.
    test.latest().end();
    await flush();
    expect(test.states.at(-1)).toEqual(["reconnecting"]);
    await vi.advanceTimersByTimeAsync(999);
    expect(test.signals).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(1);
    expect(test.signals).toHaveLength(5);
    test.connection.stop();
  });

  it("treats a stream without a heartbeat for 2.5 intervals as dead", async () => {
    const test = harness();
    test.connection.start();
    await flush();
    test.latest().send(hello("epoch.4", 10));
    await flush();
    // Heartbeats keep it alive well past 25 s.
    for (let beat = 0; beat < 4; beat += 1) {
      await vi.advanceTimersByTimeAsync(20_000);
      test.latest().heartbeat();
      await flush();
    }
    expect(test.signals).toHaveLength(1);
    expect(test.signals[0]?.aborted).toBe(false);
    // Silence: 2.5 x 10 s after the last byte the connection is abandoned.
    await vi.advanceTimersByTimeAsync(24_999);
    expect(test.signals[0]?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(test.signals[0]?.aborted).toBe(true);
    expect(test.states.at(-1)).toEqual(["reconnecting"]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(test.signals).toHaveLength(2);
    test.connection.stop();
  });

  it("abandons a connect that never answers", async () => {
    const test = harness();
    test.failWith(() => new Promise<Response>(() => undefined));
    test.connection.start();
    await flush();
    // Before hello the contract's default 25 s heartbeat applies.
    await vi.advanceTimersByTimeAsync(62_499);
    expect(test.signals[0]?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(test.signals[0]?.aborted).toBe(true);
    test.connection.stop();
  });

  it.each([401, 403])(
    "stops retrying after a %i response until a new connection is made",
    async (status) => {
      const test = harness();
      test.failWith(() => Promise.resolve(new FakeStream({ status }).response));
      test.connection.start();
      await flush();
      expect(test.states).toEqual([
        ["connecting"],
        ["stopped", "session-ended"],
      ]);
      await vi.advanceTimersByTimeAsync(600_000);
      expect(test.signals).toHaveLength(1);
    },
  );

  it.each(["session-ended", "client-revoked"] as const)(
    "stops retrying after bye: %s",
    async (reason) => {
      const test = harness();
      test.connection.start();
      await flush();
      test.latest().send(hello("epoch.4"));
      test.latest().send({ event: "bye", data: { reason } });
      await flush();
      expect(test.states.at(-1)).toEqual(["stopped", reason]);
      await vi.advanceTimersByTimeAsync(600_000);
      expect(test.signals).toHaveLength(1);
    },
  );

  it("reconnects after bye: shutdown and waits the longest delay after bye: replaced", async () => {
    const test = harness();
    test.connection.start();
    await flush();
    test.latest().send(hello("epoch.4"));
    test.latest().send({ event: "bye", data: { reason: "shutdown" } });
    test.latest().end();
    await flush();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(test.signals).toHaveLength(2);

    test.latest().send(hello("epoch.4"));
    test.latest().send({ event: "bye", data: { reason: "replaced" } });
    await flush();
    await vi.advanceTimersByTimeAsync(59_999);
    expect(test.signals).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(test.signals).toHaveLength(3);
    test.connection.stop();
  });

  it("retries a response that is not an event stream", async () => {
    const test = harness();
    test.failWith(() =>
      Promise.resolve(new FakeStream({ contentType: "text/html" }).response),
    );
    test.connection.start();
    await flush();
    expect(test.states.at(-1)).toEqual(["reconnecting"]);
    test.connection.stop();
  });

  it("aborts the request on stop and skips the backoff on retryNow", async () => {
    const test = harness();
    test.failWith(() => Promise.reject(new TypeError("network")));
    test.connection.start();
    await flush();
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(test.signals).toHaveLength(3);
    // Waiting four seconds; the network returns.
    test.failWith(undefined);
    test.connection.retryNow();
    await flush();
    expect(test.signals).toHaveLength(4);
    test.latest().send(hello("epoch.4"));
    await flush();
    test.connection.stop();
    await flush();
    expect(test.signals[3]?.aborted).toBe(true);
    expect(test.latest().cancelled).toBe(true);
    expect(test.states.at(-1)).toEqual(["stopped", "closed"]);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(test.signals).toHaveLength(4);
  });
});
