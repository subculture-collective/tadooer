import { describe, expect, it } from "vitest";
import {
  ManualSessionClock,
  createActiveSession,
  observeActiveSession,
  transitionActiveSession,
  type ActiveSession,
} from "./active-session.ts";

const owner = "owner-1";
const clientA = "client-a";
const clientB = "client-b";
const task = "task-1";

const start = (clock: ManualSessionClock): ActiveSession =>
  createActiveSession(
    { ownerId: owner, controllerClientId: clientA, taskId: task },
    clock,
    {
      sessionId: "session-1",
      intervalId: (ordinal) => `interval-${ordinal}`,
    },
  );

describe("authoritative active-session state machine", () => {
  it("creates one running focus interval and closes/opens it exactly once", () => {
    const clock = new ManualSessionClock("2026-08-06T12:00:00.000Z");
    const created = start(clock);
    expect(created).toMatchObject({
      state: "running",
      phase: "focus",
      revision: 1,
    });
    expect(created.intervals).toEqual([
      expect.objectContaining({ ordinal: 1, kind: "focus", endedAt: null }),
    ]);
    clock.advanceSeconds(20);
    const paused = transitionActiveSession(
      created,
      { type: "pause", actorClientId: clientA, expectedRevision: 1 },
      clock,
      { intervalId: (ordinal) => `interval-${ordinal}` },
    );
    expect(paused.ok && paused.session).toMatchObject({
      state: "paused",
      revision: 2,
    });
    expect(paused.ok && paused.session.intervals[0]).toMatchObject({
      endedAt: "2026-08-06T12:00:20.000Z",
      closedBy: "pause",
    });
    const resumed = transitionActiveSession(
      paused.ok ? paused.session : created,
      { type: "resume", actorClientId: clientA, expectedRevision: 2 },
      clock,
      { intervalId: (ordinal) => `interval-${ordinal}` },
    );
    expect(resumed.ok && resumed.session.intervals).toEqual([
      expect.objectContaining({
        ordinal: 1,
        endedAt: "2026-08-06T12:00:20.000Z",
      }),
      expect.objectContaining({ ordinal: 2, kind: "focus", endedAt: null }),
    ]);
  });

  it("keeps followers read-only, serializes stale commands, and makes takeover contiguous", () => {
    const clock = new ManualSessionClock("2026-08-06T12:00:00.000Z");
    const created = start(clock);
    expect(
      transitionActiveSession(
        created,
        { type: "pause", actorClientId: clientB, expectedRevision: 1 },
        clock,
        { intervalId: () => "unused" },
      ),
    ).toEqual({ ok: false, reason: "owned-by-another" });
    clock.advanceSeconds(10);
    const taken = transitionActiveSession(
      created,
      { type: "takeover", actorClientId: clientB, expectedRevision: 1 },
      clock,
      { intervalId: (ordinal) => `interval-${ordinal}` },
    );
    expect(taken.ok && taken.session).toMatchObject({
      controllerClientId: clientB,
      revision: 2,
      state: "running",
    });
    expect(taken.ok && taken.session.intervals).toEqual([
      expect.objectContaining({
        ordinal: 1,
        endedAt: "2026-08-06T12:00:10.000Z",
        closedBy: "takeover",
        controllerClientId: clientA,
      }),
      expect.objectContaining({
        ordinal: 2,
        startedAt: "2026-08-06T12:00:10.000Z",
        controllerClientId: clientB,
        endedAt: null,
      }),
    ]);
    expect(
      transitionActiveSession(
        taken.ok ? taken.session : created,
        { type: "heartbeat", actorClientId: clientA, expectedRevision: 2 },
        clock,
        { intervalId: () => "unused" },
      ),
    ).toEqual({ ok: false, reason: "owned-by-another" });
    expect(
      transitionActiveSession(
        taken.ok ? taken.session : created,
        { type: "pause", actorClientId: clientB, expectedRevision: 1 },
        clock,
        { intervalId: () => "unused" },
      ),
    ).toEqual({ ok: false, reason: "stale-revision" });
  });

  it("moves focus through a break without counting a duplicate open interval", () => {
    const clock = new ManualSessionClock("2026-08-06T12:00:00.000Z");
    const created = start(clock);
    const breaking = transitionActiveSession(
      created,
      { type: "start-break", actorClientId: clientA, expectedRevision: 1 },
      clock,
      { intervalId: (ordinal) => `interval-${ordinal}` },
    );
    expect(breaking.ok && breaking.session.intervals).toEqual([
      expect.objectContaining({
        ordinal: 1,
        kind: "focus",
        endedAt: "2026-08-06T12:00:00.000Z",
        closedBy: "break",
      }),
      expect.objectContaining({ ordinal: 2, kind: "break", endedAt: null }),
    ]);
    const focused = transitionActiveSession(
      breaking.ok ? breaking.session : created,
      { type: "end-break", actorClientId: clientA, expectedRevision: 2 },
      clock,
      { intervalId: (ordinal) => `interval-${ordinal}` },
    );
    expect(
      focused.ok &&
        focused.session.intervals.filter(
          (interval) => interval.endedAt === null,
        ),
    ).toHaveLength(1);
    expect(focused.ok && focused.session.intervals.at(-1)).toMatchObject({
      ordinal: 3,
      kind: "focus",
    });
  });

  it("expires at the persisted lease boundary and never resurrects elapsed time", () => {
    const clock = new ManualSessionClock("2026-08-06T12:00:00.000Z");
    const created = start(clock);
    clock.advanceSeconds(91);
    const expired = transitionActiveSession(
      created,
      { type: "heartbeat", actorClientId: clientA, expectedRevision: 1 },
      clock,
      { intervalId: () => "unused" },
    );
    expect(expired.ok && expired.session).toMatchObject({
      state: "expired",
      terminalReason: "expired",
      revision: 2,
      controllerClientId: null,
    });
    expect(expired.ok && expired.session.intervals[0]).toMatchObject({
      endedAt: "2026-08-06T12:01:30.000Z",
      closedBy: "expiry",
    });
    expect(
      transitionActiveSession(
        expired.ok ? expired.session : created,
        { type: "recover", actorClientId: clientA, expectedRevision: 2 },
        clock,
        { intervalId: () => "unused" },
      ),
    ).toEqual({ ok: false, reason: "recovery-requires-new-session" });
  });

  it("expires on a read without renewing the controller lease", () => {
    const clock = new ManualSessionClock("2026-08-06T12:00:00.000Z");
    const created = start(clock);
    clock.advanceSeconds(91);

    const observed = observeActiveSession(created, clock);

    expect(observed).toMatchObject({
      state: "expired",
      revision: 2,
      leaseExpiresAt: null,
      terminalReason: "expired",
    });
    expect(observed.intervals[0]).toMatchObject({
      endedAt: "2026-08-06T12:01:30.000Z",
      closedBy: "expiry",
    });
  });

  it("renews only the lease on heartbeat and completes without completing the task", () => {
    const clock = new ManualSessionClock("2026-08-06T12:00:00.000Z");
    const created = start(clock);
    clock.advanceSeconds(30);
    const heart = transitionActiveSession(
      created,
      { type: "heartbeat", actorClientId: clientA, expectedRevision: 1 },
      clock,
      { intervalId: () => "unused" },
    );
    expect(heart.ok && heart.session).toMatchObject({
      revision: 2,
      leaseExpiresAt: "2026-08-06T12:02:00.000Z",
    });
    expect(heart.ok && heart.session.intervals).toHaveLength(1);
    const completed = transitionActiveSession(
      heart.ok ? heart.session : created,
      { type: "complete", actorClientId: clientA, expectedRevision: 2 },
      clock,
      { intervalId: () => "unused" },
    );
    expect(completed.ok && completed.session).toMatchObject({
      state: "completed",
      terminalReason: "completed",
      taskId: task,
    });
    expect(
      completed.ok &&
        completed.session.intervals.filter(
          (interval) => interval.endedAt === null,
        ),
    ).toHaveLength(0);
  });

  it("keeps one open interval through a controlled transition matrix", () => {
    const clock = new ManualSessionClock("2026-08-06T12:00:00.000Z");
    let session = start(clock);
    const apply = (command: Parameters<typeof transitionActiveSession>[1]) => {
      const result = transitionActiveSession(session, command, clock, {
        intervalId: (ordinal) => `interval-${ordinal}`,
      });
      expect(result.ok).toBe(true);
      if (result.ok) session = result.session;
      expect(
        session.intervals.filter((interval) => interval.endedAt === null),
      ).toHaveLength(session.state === "running" ? 1 : 0);
      expect(
        new Set(session.intervals.map((interval) => interval.ordinal)).size,
      ).toBe(session.intervals.length);
    };
    apply({ type: "pause", actorClientId: clientA, expectedRevision: 1 });
    apply({ type: "start-break", actorClientId: clientA, expectedRevision: 2 });
    apply({ type: "resume", actorClientId: clientA, expectedRevision: 3 });
    apply({ type: "end-break", actorClientId: clientA, expectedRevision: 4 });
    apply({ type: "complete", actorClientId: clientA, expectedRevision: 5 });
  });

  it("expires paused sessions at their hard boundary without a new interval", () => {
    const clock = new ManualSessionClock("2026-08-06T12:00:00.000Z");
    const created = start(clock);
    const paused = transitionActiveSession(
      created,
      { type: "pause", actorClientId: clientA, expectedRevision: 1 },
      clock,
      { intervalId: () => "unused" },
    );
    clock.advanceSeconds(24 * 60 * 60 + 1);
    const expired = transitionActiveSession(
      paused.ok ? paused.session : created,
      { type: "takeover", actorClientId: clientB, expectedRevision: 2 },
      clock,
      { intervalId: () => "unused" },
    );
    expect(expired.ok && expired.session).toMatchObject({
      state: "expired",
      revision: 3,
      terminalReason: "expired",
    });
    expect(expired.ok && expired.session.intervals).toHaveLength(1);
  });
});
