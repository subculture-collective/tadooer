export type ActiveSessionState = "running" | "paused" | "completed" | "expired";
export type ActiveSessionPhase = "focus" | "break";
export type IntervalKind = ActiveSessionPhase;
export type IntervalCloseReason =
  "pause" | "break" | "complete" | "takeover" | "expiry";

export interface SessionClock {
  now(): Date;
}

/** Test-only deterministic clock; production supplies an ordinary SessionClock. */
export class ManualSessionClock implements SessionClock {
  #now: Date;

  constructor(initial: string) {
    this.#now = new Date(initial);
    if (!Number.isFinite(this.#now.getTime()))
      throw new Error("Invalid clock instant");
  }

  now(): Date {
    return new Date(this.#now);
  }

  advanceSeconds(seconds: number): void {
    this.#now = new Date(this.#now.getTime() + seconds * 1_000);
  }
}

export interface TrackedInterval {
  readonly id: string;
  readonly ordinal: number;
  readonly kind: IntervalKind;
  readonly taskId: string | null;
  readonly controllerClientId: string;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly closedBy: IntervalCloseReason | null;
}

export interface ActiveSessionEvent {
  readonly revision: number;
  readonly type: string;
  readonly actorClientId: string | null;
  readonly occurredAt: string;
}

export interface ActiveSession {
  readonly id: string;
  readonly ownerId: string;
  readonly controllerClientId: string | null;
  readonly taskId: string | null;
  readonly state: ActiveSessionState;
  readonly phase: ActiveSessionPhase;
  readonly revision: number;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly leaseExpiresAt: string | null;
  readonly hardExpiresAt: string | null;
  readonly terminalReason: "completed" | "expired" | null;
  readonly intervals: readonly TrackedInterval[];
  readonly events: readonly ActiveSessionEvent[];
}

export interface ActiveSessionIds {
  readonly sessionId: string;
  readonly intervalId: (ordinal: number) => string;
}

export interface ActiveSessionStartInput {
  readonly ownerId: string;
  readonly controllerClientId: string;
  readonly taskId: string;
}

export type ActiveSessionCommand =
  | {
      readonly type: "pause";
      readonly actorClientId: string;
      readonly expectedRevision: number;
    }
  | {
      readonly type: "resume";
      readonly actorClientId: string;
      readonly expectedRevision: number;
    }
  | {
      readonly type: "start-break";
      readonly actorClientId: string;
      readonly expectedRevision: number;
    }
  | {
      readonly type: "end-break";
      readonly actorClientId: string;
      readonly expectedRevision: number;
    }
  | {
      readonly type: "complete";
      readonly actorClientId: string;
      readonly expectedRevision: number;
    }
  | {
      readonly type: "takeover";
      readonly actorClientId: string;
      readonly expectedRevision: number;
    }
  | {
      readonly type: "heartbeat";
      readonly actorClientId: string;
      readonly expectedRevision: number;
    }
  | {
      readonly type: "recover";
      readonly actorClientId: string;
      readonly expectedRevision: number;
    };

export type ActiveSessionTransition =
  | { readonly ok: true; readonly session: ActiveSession }
  | {
      readonly ok: false;
      readonly reason:
        | "owned-by-another"
        | "stale-revision"
        | "invalid-transition"
        | "terminal"
        | "recovery-requires-new-session";
    };

const leaseMilliseconds = 90_000;
const hardLifetimeMilliseconds = 24 * 60 * 60 * 1_000;

const iso = (date: Date): string => date.toISOString();
const plus = (date: Date, milliseconds: number): string =>
  iso(new Date(date.getTime() + milliseconds));

const currentOpenInterval = (
  session: ActiveSession,
): TrackedInterval | undefined =>
  session.intervals.find((interval) => interval.endedAt === null);

const closeOpenInterval = (
  session: ActiveSession,
  endedAt: string,
  closedBy: IntervalCloseReason,
): readonly TrackedInterval[] =>
  session.intervals.map((interval) =>
    interval.endedAt === null ? { ...interval, endedAt, closedBy } : interval,
  );

const appendEvent = (
  session: ActiveSession,
  type: string,
  actorClientId: string | null,
  occurredAt: string,
  revision: number,
): readonly ActiveSessionEvent[] => [
  ...session.events,
  { revision, type, actorClientId, occurredAt },
];

const openInterval = (
  session: ActiveSession,
  controllerClientId: string,
  startedAt: string,
  ids: Pick<ActiveSessionIds, "intervalId">,
): TrackedInterval => ({
  id: ids.intervalId(session.intervals.length + 1),
  ordinal: session.intervals.length + 1,
  kind: session.phase,
  taskId: session.taskId,
  controllerClientId,
  startedAt,
  endedAt: null,
  closedBy: null,
});

const withChange = (
  session: ActiveSession,
  now: Date,
  type: string,
  actorClientId: string | null,
  change: Omit<Partial<ActiveSession>, "revision" | "updatedAt" | "events">,
): ActiveSession => {
  const revision = session.revision + 1;
  const occurredAt = iso(now);
  return {
    ...session,
    ...change,
    revision,
    updatedAt: occurredAt,
    events: appendEvent(session, type, actorClientId, occurredAt, revision),
  };
};

const expireIfRequired = (session: ActiveSession, now: Date): ActiveSession => {
  if (session.state === "completed" || session.state === "expired")
    return session;
  const nowTime = now.getTime();
  const leaseTime =
    session.leaseExpiresAt === null
      ? undefined
      : Date.parse(session.leaseExpiresAt);
  const hardTime =
    session.hardExpiresAt === null
      ? undefined
      : Date.parse(session.hardExpiresAt);
  const boundary =
    session.state === "running"
      ? Math.min(
          leaseTime ?? Number.POSITIVE_INFINITY,
          hardTime ?? Number.POSITIVE_INFINITY,
        )
      : (hardTime ?? Number.POSITIVE_INFINITY);
  if (nowTime < boundary) return session;
  const expiredAt = iso(new Date(boundary));
  return withChange(session, new Date(boundary), "expired", null, {
    state: "expired",
    controllerClientId: null,
    leaseExpiresAt: null,
    hardExpiresAt: null,
    terminalReason: "expired",
    intervals:
      currentOpenInterval(session) === undefined
        ? session.intervals
        : closeOpenInterval(session, expiredAt, "expiry"),
  });
};

export const createActiveSession = (
  input: ActiveSessionStartInput,
  clock: SessionClock,
  ids: ActiveSessionIds,
): ActiveSession => {
  const now = clock.now();
  const startedAt = iso(now);
  const first: TrackedInterval = {
    id: ids.intervalId(1),
    ordinal: 1,
    kind: "focus",
    taskId: input.taskId,
    controllerClientId: input.controllerClientId,
    startedAt,
    endedAt: null,
    closedBy: null,
  };
  return {
    id: ids.sessionId,
    ownerId: input.ownerId,
    controllerClientId: input.controllerClientId,
    taskId: input.taskId,
    state: "running",
    phase: "focus",
    revision: 1,
    startedAt,
    updatedAt: startedAt,
    leaseExpiresAt: plus(now, leaseMilliseconds),
    hardExpiresAt: plus(now, hardLifetimeMilliseconds),
    terminalReason: null,
    intervals: [first],
    events: [
      {
        revision: 1,
        type: "started",
        actorClientId: input.controllerClientId,
        occurredAt: startedAt,
      },
    ],
  };
};

/** Applies one optimistic-concurrency-checked command without touching storage or transport. */
export const transitionActiveSession = (
  input: ActiveSession,
  command: ActiveSessionCommand,
  clock: SessionClock,
  ids: Pick<ActiveSessionIds, "intervalId">,
): ActiveSessionTransition => {
  const now = clock.now();
  const session = expireIfRequired(input, now);
  if (session !== input) return { ok: true, session };
  if (command.expectedRevision !== session.revision)
    return { ok: false, reason: "stale-revision" };
  if (command.type === "recover")
    return session.state === "expired"
      ? { ok: false, reason: "recovery-requires-new-session" }
      : { ok: false, reason: "invalid-transition" };
  if (session.state === "completed" || session.state === "expired")
    return { ok: false, reason: "terminal" };
  if (
    command.type !== "takeover" &&
    command.actorClientId !== session.controllerClientId
  )
    return { ok: false, reason: "owned-by-another" };
  const timestamp = iso(now);

  if (command.type === "heartbeat") {
    if (session.state !== "running")
      return { ok: false, reason: "invalid-transition" };
    return {
      ok: true,
      session: withChange(session, now, "heartbeat", command.actorClientId, {
        leaseExpiresAt: plus(now, leaseMilliseconds),
      }),
    };
  }
  if (command.type === "pause") {
    if (session.state !== "running")
      return { ok: false, reason: "invalid-transition" };
    return {
      ok: true,
      session: withChange(session, now, "paused", command.actorClientId, {
        state: "paused",
        leaseExpiresAt: null,
        intervals: closeOpenInterval(session, timestamp, "pause"),
      }),
    };
  }
  if (command.type === "resume") {
    if (session.state !== "paused")
      return { ok: false, reason: "invalid-transition" };
    const interval = openInterval(
      session,
      command.actorClientId,
      timestamp,
      ids,
    );
    return {
      ok: true,
      session: withChange(session, now, "resumed", command.actorClientId, {
        state: "running",
        leaseExpiresAt: plus(now, leaseMilliseconds),
        intervals: [...session.intervals, interval],
      }),
    };
  }
  if (command.type === "start-break") {
    if (session.phase !== "focus")
      return { ok: false, reason: "invalid-transition" };
    const base: ActiveSession = { ...session, phase: "break" };
    const intervals =
      session.state === "running"
        ? [
            ...closeOpenInterval(base, timestamp, "break"),
            openInterval(base, command.actorClientId, timestamp, ids),
          ]
        : base.intervals;
    return {
      ok: true,
      session: withChange(
        session,
        now,
        "break-started",
        command.actorClientId,
        { phase: "break", intervals },
      ),
    };
  }
  if (command.type === "end-break") {
    if (session.phase !== "break")
      return { ok: false, reason: "invalid-transition" };
    const base: ActiveSession = { ...session, phase: "focus" };
    const intervals =
      session.state === "running"
        ? [
            ...closeOpenInterval(base, timestamp, "break"),
            openInterval(base, command.actorClientId, timestamp, ids),
          ]
        : base.intervals;
    return {
      ok: true,
      session: withChange(session, now, "break-ended", command.actorClientId, {
        phase: "focus",
        intervals,
      }),
    };
  }
  if (command.type === "complete") {
    return {
      ok: true,
      session: withChange(session, now, "completed", command.actorClientId, {
        state: "completed",
        controllerClientId: null,
        leaseExpiresAt: null,
        hardExpiresAt: null,
        terminalReason: "completed",
        intervals:
          currentOpenInterval(session) === undefined
            ? session.intervals
            : closeOpenInterval(session, timestamp, "complete"),
      }),
    };
  }
  if (command.type === "takeover") {
    if (command.actorClientId === session.controllerClientId)
      return { ok: false, reason: "invalid-transition" };
    if (session.state === "paused")
      return {
        ok: true,
        session: withChange(session, now, "taken-over", command.actorClientId, {
          controllerClientId: command.actorClientId,
        }),
      };
    const closed = closeOpenInterval(session, timestamp, "takeover");
    const base: ActiveSession = { ...session, intervals: closed };
    return {
      ok: true,
      session: withChange(session, now, "taken-over", command.actorClientId, {
        controllerClientId: command.actorClientId,
        leaseExpiresAt: plus(now, leaseMilliseconds),
        intervals: [
          ...closed,
          openInterval(base, command.actorClientId, timestamp, ids),
        ],
      }),
    };
  }
  return { ok: false, reason: "invalid-transition" };
};
