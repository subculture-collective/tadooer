import { describe, expect, it } from "vitest";
import {
  decodeLiveSyncEvent,
  encodeLiveSyncEvent,
  type LiveSyncEvent,
} from "./live-sync.ts";

describe("live sync event framing (ADR 0045)", () => {
  it("round-trips every event through its SSE frame", () => {
    const events: LiveSyncEvent[] = [
      {
        event: "hello",
        data: {
          protocolVersion: 2,
          head: "epoch.12",
          heartbeatSeconds: 25,
          serverTimestamp: "2026-10-02T12:00:00.000Z",
        },
      },
      { event: "changes", data: { head: "epoch.13" } },
      {
        event: "resources",
        data: {
          families: ["notes", "boards"],
          sourceClientId: "6f1c2c3e-4f0a-4d53-9d6e-0c3b2f6f8a10",
        },
      },
      { event: "resources", data: { families: ["all"], sourceClientId: null } },
      { event: "bye", data: { reason: "shutdown" } },
    ];
    for (const event of events) {
      const frame = encodeLiveSyncEvent(event);
      expect(frame.endsWith("\n\n")).toBe(true);
      expect(decodeLiveSyncEvent(frame.trimEnd())).toEqual(event);
    }
  });

  it("ignores comments, unknown events and malformed or unreviewed data", () => {
    expect(decodeLiveSyncEvent(": hb")).toBeUndefined();
    expect(decodeLiveSyncEvent("event: future\ndata: {}")).toBeUndefined();
    expect(decodeLiveSyncEvent("event: changes\ndata: {")).toBeUndefined();
    expect(decodeLiveSyncEvent("event: changes")).toBeUndefined();
    expect(
      decodeLiveSyncEvent('event: changes\ndata: {"head":"e.1","title":"x"}'),
    ).toBeUndefined();
    expect(
      decodeLiveSyncEvent(
        'event: resources\ndata: {"families":["unknown"],"sourceClientId":null}',
      ),
    ).toBeUndefined();
  });

  it("accepts CRLF line endings and a comment before the event", () => {
    expect(
      decodeLiveSyncEvent(': hb\r\nevent: changes\r\ndata: {"head":"e.2"}'),
    ).toEqual({ event: "changes", data: { head: "e.2" } });
  });
});
