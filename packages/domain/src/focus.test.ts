import { describe, expect, it } from "vitest";
import {
  ManualSessionClock,
  createActiveSession,
  transitionActiveSession,
  type ActiveSession,
} from "./active-session.ts";
import {
  applyIdleDisposition,
  breakReminderMessage,
  breakTarget,
  computeFocusCountdown,
  focusCycle,
  planFromPreferences,
  untrackedSince,
  workingWithoutBreak,
  type FocusPlan,
} from "./focus.ts";

const ids = { intervalId: (ordinal: number) => `interval-${String(ordinal)}` };
const minute = 60_000;

const preferences = {
  pomodoro: {
    workMinutes: 25,
    shortBreakMinutes: 5,
    longBreakMinutes: 15,
    cyclesBeforeLongBreak: 4,
  },
  flowtime: {
    breakEnabled: true,
    breakMode: "ratio" as const,
    breakPercentage: 20,
    breakRules: [
      { minMinutes: 0, maxMinutes: 30, breakMinutes: 5 },
      { minMinutes: 30, maxMinutes: null, breakMinutes: 10 },
    ],
  },
  countdownMinutes: 40,
};

const start = (clock: ManualSessionClock): ActiveSession =>
  createActiveSession(
    { ownerId: "owner", controllerClientId: "client", taskId: "task" },
    clock,
    { sessionId: "session", intervalId: ids.intervalId },
  );

const apply = (
  session: ActiveSession,
  type: "pause" | "resume" | "start-break" | "end-break" | "heartbeat",
  clock: ManualSessionClock,
): ActiveSession => {
  const result = transitionActiveSession(
    session,
    { type, actorClientId: "client", expectedRevision: session.revision },
    clock,
    ids,
  );
  if (!result.ok) throw new Error(result.reason);
  return result.session;
};

/** Advances the clock in one-minute steps, heartbeating a running session. */
const advance = (
  session: ActiveSession,
  minutes: number,
  clock: ManualSessionClock,
): ActiveSession => {
  let current = session;
  for (let step = 0; step < minutes; step++) {
    clock.advanceSeconds(60);
    if (current.state === "running")
      current = apply(current, "heartbeat", clock);
  }
  return current;
};

describe("focus plans and cycle math (ADR 0029)", () => {
  it("freezes preferences into millisecond targets per mode", () => {
    const pomodoro = planFromPreferences(preferences, "pomodoro");
    expect(pomodoro).toMatchObject({
      mode: "pomodoro",
      workMs: 25 * minute,
      shortBreakMs: 5 * minute,
      longBreakMs: 15 * minute,
      cyclesBeforeLongBreak: 4,
    });
    expect(planFromPreferences(preferences, "countdown").workMs).toBe(
      40 * minute,
    );
    expect(
      planFromPreferences(preferences, "flowtime").flowtime.breakRules,
    ).toEqual([
      { minMs: 0, maxMs: 30 * minute, breakMs: 5 * minute },
      { minMs: 30 * minute, maxMs: null, breakMs: 10 * minute },
    ]);
  });

  it("makes every fourth break long and counts cycles from ended breaks", () => {
    const plan = planFromPreferences(preferences, "pomodoro");
    expect(breakTarget(plan, 1, 0)).toEqual({ ms: 5 * minute, isLong: false });
    expect(breakTarget(plan, 4, 0)).toEqual({ ms: 15 * minute, isLong: true });
    expect(breakTarget(plan, 8, 0)?.isLong).toBe(true);
    expect(
      focusCycle([
        { type: "started" },
        { type: "break-started" },
        { type: "break-ended" },
        { type: "idle-break" },
      ]),
    ).toBe(2);
  });

  it("derives flowtime breaks from the stretch by ratio or half-open rules", () => {
    const ratio = planFromPreferences(preferences, "flowtime");
    expect(breakTarget(ratio, 1, 50 * minute)).toEqual({
      ms: 10 * minute,
      isLong: false,
    });
    // Never below one minute, as in the source.
    expect(breakTarget(ratio, 1, 2 * minute)?.ms).toBe(minute);
    const rules: FocusPlan = {
      ...ratio,
      flowtime: { ...ratio.flowtime, breakMode: "rule" },
    };
    expect(breakTarget(rules, 1, 29 * minute)?.ms).toBe(5 * minute);
    expect(breakTarget(rules, 1, 30 * minute)?.ms).toBe(10 * minute);
    expect(
      breakTarget(
        { ...rules, flowtime: { ...rules.flowtime, breakEnabled: false } },
        1,
        minute,
      ),
    ).toBeNull();
    expect(
      breakTarget(planFromPreferences(preferences, "countdown"), 1, 0),
    ).toBeNull();
  });

  it("counts elapsed phase time across pauses and reports the instant a target was reached", () => {
    const clock = new ManualSessionClock("2026-09-24T15:00:00.000Z");
    const plan = planFromPreferences(preferences, "pomodoro");
    let session = start(clock);
    session = advance(session, 10, clock);
    session = apply(session, "pause", clock);
    session = advance(session, 30, clock);
    expect(computeFocusCountdown(session, plan, clock.now())).toMatchObject({
      phase: "focus",
      elapsedMs: 10 * minute,
      remainingMs: 15 * minute,
      done: false,
      cycle: 1,
      reachedAt: null,
    });
    session = apply(session, "resume", clock);
    session = advance(session, 20, clock);
    expect(computeFocusCountdown(session, plan, clock.now())).toMatchObject({
      elapsedMs: 30 * minute,
      remainingMs: -5 * minute,
      done: true,
      // 10 minutes before the pause plus 15 minutes after the resume.
      reachedAt: "2026-09-24T15:55:00.000Z",
    });
    session = apply(session, "start-break", clock);
    session = advance(session, 2, clock);
    expect(computeFocusCountdown(session, plan, clock.now())).toMatchObject({
      phase: "break",
      elapsedMs: 2 * minute,
      targetMs: 5 * minute,
      isLongBreak: false,
      done: false,
    });
    session = apply(session, "end-break", clock);
    expect(computeFocusCountdown(session, plan, clock.now()).cycle).toBe(2);
  });

  it("keeps a 25-minute stretch 25 minutes across the Chicago fall-back hour", () => {
    // 01:50 CDT on November 1, 2026; clocks fall back at 02:00 CDT.
    const clock = new ManualSessionClock("2026-11-01T06:50:00.000Z");
    const plan = planFromPreferences(preferences, "pomodoro");
    const session = advance(start(clock), 25, clock);
    const countdown = computeFocusCountdown(session, plan, clock.now());
    expect(countdown.elapsedMs).toBe(25 * minute);
    expect(countdown.done).toBe(true);
    expect(countdown.reachedAt).toBe("2026-11-01T07:15:00.000Z");
    // Flowtime focus has no target; a flowtime break sizes from the stretch.
    const flow = planFromPreferences(preferences, "flowtime");
    expect(computeFocusCountdown(session, flow, clock.now())).toMatchObject({
      targetMs: null,
      remainingMs: null,
      done: false,
    });
    const onBreak = apply(session, "start-break", clock);
    expect(computeFocusCountdown(onBreak, flow, clock.now()).targetMs).toBe(
      5 * minute,
    );
  });
});

describe("idle disposition (ADR 0029)", () => {
  const running = () => {
    const clock = new ManualSessionClock("2026-09-24T15:00:00.000Z");
    const session = advance(start(clock), 30, clock);
    return { clock, session };
  };
  const command = (
    disposition: "assign" | "break" | "discard",
    idleStartedAt = "2026-09-24T15:20:00.000Z",
    actorClientId = "client",
    expectedRevision = 31,
  ) => ({ actorClientId, expectedRevision, idleStartedAt, disposition });

  it("keeps assigned time, records the decision and renews the lease", () => {
    const { clock, session } = running();
    const result = applyIdleDisposition(session, command("assign"), clock, ids);
    expect(result.ok && result.session.intervals).toEqual(session.intervals);
    expect(result.ok && result.correction).toEqual({
      disposition: "assign",
      idleStartedAt: "2026-09-24T15:20:00.000Z",
      idleEndedAt: "2026-09-24T15:30:00.000Z",
      trimmedMs: 0,
    });
    expect(result.ok && result.session).toMatchObject({
      revision: 32,
      leaseExpiresAt: "2026-09-24T15:31:30.000Z",
    });
    expect(result.ok && result.session.events.at(-1)?.type).toBe(
      "idle-assigned",
    );
  });

  it("converts the span into a break interval and reopens focus without adding time", () => {
    const { clock, session } = running();
    const result = applyIdleDisposition(session, command("break"), clock, ids);
    if (!result.ok) throw new Error(result.reason);
    expect(result.session.intervals).toEqual([
      expect.objectContaining({
        ordinal: 1,
        kind: "focus",
        endedAt: "2026-09-24T15:20:00.000Z",
        closedBy: "idle",
      }),
      expect.objectContaining({
        ordinal: 2,
        kind: "break",
        startedAt: "2026-09-24T15:20:00.000Z",
        endedAt: "2026-09-24T15:30:00.000Z",
        closedBy: "idle",
      }),
      expect.objectContaining({
        ordinal: 3,
        kind: "focus",
        startedAt: "2026-09-24T15:30:00.000Z",
        endedAt: null,
      }),
    ]);
    expect(result.session.phase).toBe("focus");
    expect(result.correction.trimmedMs).toBe(10 * minute);
    expect(focusCycle(result.session.events)).toBe(1);
  });

  it("discards the span so it belongs to no interval, and clamps to the open interval", () => {
    const { clock, session } = running();
    // Before the open interval started: clamped, so nothing before is rewritten.
    const result = applyIdleDisposition(
      session,
      command("discard", "2026-09-24T14:00:00.000Z"),
      clock,
      ids,
    );
    if (!result.ok) throw new Error(result.reason);
    expect(result.correction).toMatchObject({
      idleStartedAt: "2026-09-24T15:00:00.000Z",
      trimmedMs: 30 * minute,
    });
    expect(result.session.intervals).toEqual([
      expect.objectContaining({
        ordinal: 1,
        endedAt: "2026-09-24T15:00:00.000Z",
        closedBy: "idle",
      }),
      expect.objectContaining({
        ordinal: 2,
        kind: "focus",
        startedAt: "2026-09-24T15:30:00.000Z",
        endedAt: null,
      }),
    ]);
  });

  it("treats a break during a break as keeping it, and trims a break when discarded", () => {
    const { clock, session } = running();
    const onBreak = advance(apply(session, "start-break", clock), 10, clock);
    const kept = applyIdleDisposition(
      onBreak,
      command("break", "2026-09-24T15:35:00.000Z", "client", onBreak.revision),
      clock,
      ids,
    );
    expect(kept.ok && kept.correction.disposition).toBe("assign");
    const trimmed = applyIdleDisposition(
      onBreak,
      command(
        "discard",
        "2026-09-24T15:35:00.000Z",
        "client",
        onBreak.revision,
      ),
      clock,
      ids,
    );
    expect(trimmed.ok && trimmed.correction.trimmedMs).toBe(0);
    expect(trimmed.ok && trimmed.session.intervals.at(-1)).toMatchObject({
      kind: "break",
      startedAt: "2026-09-24T15:40:00.000Z",
    });
  });

  it("rejects stale revisions, followers, paused sessions and empty spans", () => {
    const { clock, session } = running();
    expect(
      applyIdleDisposition(
        session,
        command("assign", undefined, "client", 3),
        clock,
        ids,
      ),
    ).toEqual({ ok: false, reason: "stale-revision" });
    expect(
      applyIdleDisposition(
        session,
        command("assign", undefined, "other"),
        clock,
        ids,
      ),
    ).toEqual({ ok: false, reason: "owned-by-another" });
    const paused = apply(session, "pause", clock);
    expect(
      applyIdleDisposition(
        paused,
        command("assign", undefined, "client", paused.revision),
        clock,
        ids,
      ),
    ).toEqual({ ok: false, reason: "not-running" });
    expect(
      applyIdleDisposition(
        session,
        command("assign", "2026-09-24T15:30:00.000Z"),
        clock,
        ids,
      ),
    ).toEqual({ ok: false, reason: "invalid-idle-span" });
    expect(
      applyIdleDisposition(
        session,
        command("assign", "not a date"),
        clock,
        ids,
      ),
    ).toEqual({ ok: false, reason: "invalid-idle-span" });
  });
});

describe("break and tracking reminders (ADR 0029)", () => {
  it("accumulates focus across sessions until a break or a five-minute gap", () => {
    const at = "2026-09-24T17:00:00.000Z";
    const intervals = [
      {
        kind: "focus" as const,
        startedAt: "2026-09-24T14:00:00.000Z",
        endedAt: "2026-09-24T14:30:00.000Z",
      },
      // Two-minute gap: still the same stretch.
      {
        kind: "focus" as const,
        startedAt: "2026-09-24T14:32:00.000Z",
        endedAt: "2026-09-24T15:00:00.000Z",
      },
      // Six-minute gap ends the stretch.
      {
        kind: "focus" as const,
        startedAt: "2026-09-24T15:06:00.000Z",
        endedAt: "2026-09-24T16:00:00.000Z",
      },
      {
        kind: "focus" as const,
        startedAt: "2026-09-24T16:00:00.000Z",
        endedAt: null,
      },
    ];
    const stretch = workingWithoutBreak(intervals, at, 60 * minute);
    expect(stretch.ms).toBe(114 * minute);
    expect(stretch.reachedAt).toBe("2026-09-24T16:06:00.000Z");
    const withBreak = workingWithoutBreak(
      [
        ...intervals,
        {
          kind: "break" as const,
          startedAt: "2026-09-24T16:30:00.000Z",
          endedAt: "2026-09-24T16:35:00.000Z",
        },
        {
          kind: "focus" as const,
          startedAt: "2026-09-24T16:35:00.000Z",
          endedAt: null,
        },
      ].map((interval) =>
        interval.startedAt === "2026-09-24T16:00:00.000Z"
          ? { ...interval, endedAt: "2026-09-24T16:30:00.000Z" }
          : interval,
      ),
      at,
      60 * minute,
    );
    expect(withBreak).toEqual({ ms: 25 * minute, reachedAt: null });
  });

  it("measures untracked time from the later of the last focus end and the day start", () => {
    expect(
      untrackedSince(
        "2026-09-24T13:00:00.000Z",
        "2026-09-24T05:00:00.000Z",
        "2026-09-24T13:20:00.000Z",
        5 * minute,
      ),
    ).toEqual({ ms: 20 * minute, reachedAt: "2026-09-24T13:05:00.000Z" });
    expect(
      untrackedSince(
        null,
        "2026-09-24T05:00:00.000Z",
        "2026-09-24T05:03:00.000Z",
        5 * minute,
      ),
    ).toEqual({ ms: 3 * minute, reachedAt: "2026-09-24T05:05:00.000Z" });
  });

  it("substitutes the working time into the owner's break message", () => {
    expect(
      breakReminderMessage("Working for ${duration}. Stretch!", 95 * minute),
    ).toBe("Working for 1:35. Stretch!");
    expect(breakReminderMessage("   ", 30 * minute)).toBe(
      "You have been working for 0:30 without a break.",
    );
  });
});
