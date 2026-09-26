import type {
  ActiveSession,
  ActiveSessionEvent,
  ActiveSessionPhase,
  SessionClock,
  TrackedInterval,
} from "./active-session.ts";

/**
 * Focus presets, cycle math, idle disposition and break reminders
 * (issue #65, ADR 0029). Everything here derives from the server-authoritative
 * active session (ADR 0010): intervals supply the instants, events supply the
 * cycle count, and no timer state is stored beyond a session's plan.
 */

export type FocusMode = "pomodoro" | "flowtime" | "countdown";

export interface FlowtimeBreakRule {
  readonly minMs: number;
  readonly maxMs: number | null;
  readonly breakMs: number;
}

export interface FocusPlan {
  readonly mode: FocusMode;
  readonly workMs: number;
  readonly shortBreakMs: number;
  readonly longBreakMs: number;
  readonly cyclesBeforeLongBreak: number;
  readonly flowtime: {
    readonly breakEnabled: boolean;
    readonly breakMode: "ratio" | "rule";
    readonly breakPercentage: number;
    readonly breakRules: readonly FlowtimeBreakRule[];
  };
}

export interface FocusPlanPreferences {
  readonly pomodoro: {
    readonly workMinutes: number;
    readonly shortBreakMinutes: number;
    readonly longBreakMinutes: number;
    readonly cyclesBeforeLongBreak: number;
  };
  readonly flowtime: {
    readonly breakEnabled: boolean;
    readonly breakMode: "ratio" | "rule";
    readonly breakPercentage: number;
    readonly breakRules: readonly {
      readonly minMinutes: number;
      readonly maxMinutes: number | null;
      readonly breakMinutes: number;
    }[];
  };
  readonly countdownMinutes: number;
}

const minute = 60_000;
/** Shortest automatic flowtime break, as in the source. */
export const minimumFlowtimeBreakMs = minute;
/** A gap without focus at least this long ends a working stretch. */
export const workingStretchGapMs = 5 * minute;

/** Freezes the owner's preferences into millisecond targets for one session. */
export const planFromPreferences = (
  preferences: FocusPlanPreferences,
  mode: FocusMode,
): FocusPlan => ({
  mode,
  workMs:
    (mode === "countdown"
      ? preferences.countdownMinutes
      : preferences.pomodoro.workMinutes) * minute,
  shortBreakMs: preferences.pomodoro.shortBreakMinutes * minute,
  longBreakMs: preferences.pomodoro.longBreakMinutes * minute,
  cyclesBeforeLongBreak: preferences.pomodoro.cyclesBeforeLongBreak,
  flowtime: {
    breakEnabled: preferences.flowtime.breakEnabled,
    breakMode: preferences.flowtime.breakMode,
    breakPercentage: preferences.flowtime.breakPercentage,
    breakRules: preferences.flowtime.breakRules.map((rule) => ({
      minMs: rule.minMinutes * minute,
      maxMs: rule.maxMinutes === null ? null : rule.maxMinutes * minute,
      breakMs: rule.breakMinutes * minute,
    })),
  },
});

const time = (value: string): number => Date.parse(value);

/** 1 for the first focus stretch; every ended break starts the next cycle. */
export const focusCycle = (
  events: readonly Pick<ActiveSessionEvent, "type">[],
): number => 1 + events.filter((event) => event.type === "break-ended").length;

interface Stretch {
  readonly intervals: readonly TrackedInterval[];
  readonly elapsedMs: number;
}

const intervalMs = (interval: TrackedInterval, now: number): number =>
  Math.max(
    0,
    (interval.endedAt === null ? now : time(interval.endedAt)) -
      time(interval.startedAt),
  );

/** Trailing intervals of one kind, ending at the session's last interval. */
const trailingStretch = (
  intervals: readonly TrackedInterval[],
  kind: ActiveSessionPhase,
  now: number,
  before = intervals.length,
): Stretch => {
  const stretch: TrackedInterval[] = [];
  for (let index = before - 1; index >= 0; index--) {
    const interval = intervals[index];
    if (interval?.kind !== kind) break;
    stretch.unshift(interval);
  }
  return {
    intervals: stretch,
    elapsedMs: stretch.reduce((sum, item) => sum + intervalMs(item, now), 0),
  };
};

/** Instant at which the stretch's accumulated time reached `targetMs`. */
const reachedInstant = (
  stretch: readonly TrackedInterval[],
  targetMs: number,
  now: number,
): string | null => {
  let accumulated = 0;
  for (const interval of stretch) {
    const length = intervalMs(interval, now);
    if (accumulated + length >= targetMs)
      return new Date(
        time(interval.startedAt) + (targetMs - accumulated),
      ).toISOString();
    accumulated += length;
  }
  return null;
};

export const breakTarget = (
  plan: FocusPlan,
  cycle: number,
  focusStretchMs: number,
): { readonly ms: number; readonly isLong: boolean } | null => {
  if (plan.mode === "pomodoro") {
    const isLong = cycle % plan.cyclesBeforeLongBreak === 0;
    return { ms: isLong ? plan.longBreakMs : plan.shortBreakMs, isLong };
  }
  if (plan.mode !== "flowtime" || !plan.flowtime.breakEnabled) return null;
  if (plan.flowtime.breakMode === "ratio")
    return {
      ms: Math.max(
        minimumFlowtimeBreakMs,
        Math.round((focusStretchMs * plan.flowtime.breakPercentage) / 100),
      ),
      isLong: false,
    };
  // Half-open ranges, as in the source, so adjacent rules never overlap.
  const rule = plan.flowtime.breakRules.find(
    (candidate) =>
      focusStretchMs >= candidate.minMs &&
      (candidate.maxMs === null || focusStretchMs < candidate.maxMs),
  );
  return rule === undefined ? null : { ms: rule.breakMs, isLong: false };
};

export interface FocusCountdown {
  readonly phase: ActiveSessionPhase;
  readonly elapsedMs: number;
  readonly targetMs: number | null;
  readonly remainingMs: number | null;
  readonly done: boolean;
  readonly cycle: number;
  readonly isLongBreak: boolean;
  readonly reachedAt: string | null;
}

/**
 * Elapsed and remaining time in the current phase across pauses. Durations
 * are differences of server instants, so a change of clocks in the owner's
 * zone does not lengthen or shorten a stretch.
 */
export const computeFocusCountdown = (
  session: Pick<ActiveSession, "phase" | "intervals" | "events">,
  plan: FocusPlan,
  at: string | Date,
): FocusCountdown => {
  const now = typeof at === "string" ? time(at) : at.getTime();
  const cycle = focusCycle(session.events);
  const current = trailingStretch(session.intervals, session.phase, now);
  let target: { readonly ms: number; readonly isLong: boolean } | null;
  if (session.phase === "focus")
    target =
      plan.mode === "flowtime" ? null : { ms: plan.workMs, isLong: false };
  else {
    const focusBefore = trailingStretch(
      session.intervals,
      "focus",
      now,
      session.intervals.length - current.intervals.length,
    );
    target = breakTarget(plan, cycle, focusBefore.elapsedMs);
  }
  const reachedAt =
    target === null ? null : reachedInstant(current.intervals, target.ms, now);
  return {
    phase: session.phase,
    elapsedMs: current.elapsedMs,
    targetMs: target?.ms ?? null,
    remainingMs: target === null ? null : target.ms - current.elapsedMs,
    done: reachedAt !== null,
    cycle,
    isLongBreak: session.phase === "break" && (target?.isLong ?? false),
    reachedAt,
  };
};

export interface OwnerInterval {
  readonly kind: ActiveSessionPhase;
  readonly startedAt: string;
  /** Effective end: null while open; callers bound a running interval by its lease. */
  readonly endedAt: string | null;
}

export interface WorkingStretch {
  /** Focus time since the last break or long gap. */
  readonly ms: number;
  /** Instant at which `thresholdMs` of focus was reached, if it was. */
  readonly reachedAt: string | null;
}

/**
 * Focus time without a break across sessions: a break interval or a gap of
 * `workingStretchGapMs` without focus ends the stretch. Intervals may belong to
 * several sessions and must be sorted by start.
 */
export const workingWithoutBreak = (
  intervals: readonly OwnerInterval[],
  at: string | Date,
  thresholdMs: number,
  gapMs = workingStretchGapMs,
): WorkingStretch => {
  const now = typeof at === "string" ? time(at) : at.getTime();
  const sorted = intervals.toSorted(
    (left, right) => time(left.startedAt) - time(right.startedAt),
  );
  let start = 0;
  let previousEnd: number | null = null;
  for (const [index, interval] of sorted.entries()) {
    if (interval.kind === "break") {
      start = index + 1;
      previousEnd = null;
      continue;
    }
    const begins = time(interval.startedAt);
    if (previousEnd !== null && begins - previousEnd >= gapMs) start = index;
    previousEnd = interval.endedAt === null ? now : time(interval.endedAt);
  }
  const stretch = sorted.slice(start).filter(({ kind }) => kind === "focus");
  const tracked: TrackedInterval[] = stretch.map((interval, ordinal) => ({
    id: String(ordinal),
    ordinal: ordinal + 1,
    kind: "focus",
    taskId: null,
    controllerClientId: "",
    startedAt: interval.startedAt,
    endedAt: interval.endedAt,
    closedBy: null,
  }));
  return {
    ms: tracked.reduce((sum, interval) => sum + intervalMs(interval, now), 0),
    reachedAt: reachedInstant(tracked, thresholdMs, now),
  };
};

/**
 * Time since focus was last tracked, counted from the later of the last
 * focus interval's end and `windowStart` (the working window's start).
 */
export const untrackedSince = (
  lastFocusEndedAt: string | null,
  windowStart: string,
  at: string | Date,
  thresholdMs: number,
): { readonly ms: number; readonly reachedAt: string } => {
  const now = typeof at === "string" ? time(at) : at.getTime();
  const reference = Math.max(
    lastFocusEndedAt === null ? 0 : time(lastFocusEndedAt),
    time(windowStart),
  );
  return {
    ms: Math.max(0, now - reference),
    reachedAt: new Date(reference + thresholdMs).toISOString(),
  };
};

/** Replaces `${duration}` in the owner's break message with h:mm. */
export const breakReminderMessage = (
  template: string,
  workingMs: number,
): string => {
  const minutes = Math.round(workingMs / minute);
  const text = `${String(Math.floor(minutes / 60))}:${String(minutes % 60).padStart(2, "0")}`;
  const message = template.replaceAll("${duration}", text).trim();
  return message === ""
    ? `You have been working for ${text} without a break.`
    : message;
};

export type FocusIdleDisposition = "assign" | "break" | "discard";

export interface IdleDispositionCommand {
  readonly actorClientId: string;
  readonly expectedRevision: number;
  readonly idleStartedAt: string;
  readonly disposition: FocusIdleDisposition;
}

export interface IdleCorrection {
  readonly disposition: FocusIdleDisposition;
  readonly idleStartedAt: string;
  readonly idleEndedAt: string;
  readonly trimmedMs: number;
}

export type IdleDispositionResult =
  | {
      readonly ok: true;
      readonly session: ActiveSession;
      readonly correction: IdleCorrection;
    }
  | {
      readonly ok: false;
      readonly reason:
        | "owned-by-another"
        | "stale-revision"
        | "not-running"
        | "invalid-idle-span";
    };

const leaseMilliseconds = 90_000;

/**
 * Applies the owner's choice for an idle span that ended now. The session
 * must be running and observed (expired sessions are terminal before this
 * call). Time is only ever trimmed or relabelled, never added:
 *
 * - `assign` keeps the span as task time and records the decision;
 * - `break` closes the focus interval at the idle start, inserts a break
 *   interval for the span and reopens focus now;
 * - `discard` closes the open interval at the idle start and reopens the
 *   same phase now, so the span belongs to no interval.
 *
 * An idle start before the open interval is clamped to that interval's start,
 * so a takeover or resume during the span is never rewritten.
 */
export const applyIdleDisposition = (
  session: ActiveSession,
  command: IdleDispositionCommand,
  clock: SessionClock,
  ids: { readonly intervalId: (ordinal: number) => string },
): IdleDispositionResult => {
  if (command.expectedRevision !== session.revision)
    return { ok: false, reason: "stale-revision" };
  if (session.state !== "running") return { ok: false, reason: "not-running" };
  if (command.actorClientId !== session.controllerClientId)
    return { ok: false, reason: "owned-by-another" };
  const open = session.intervals.find((interval) => interval.endedAt === null);
  if (open === undefined) return { ok: false, reason: "not-running" };
  const now = clock.now();
  const nowMs = now.getTime();
  const requested = time(command.idleStartedAt);
  if (!Number.isFinite(requested) || requested >= nowMs)
    return { ok: false, reason: "invalid-idle-span" };
  const idleStart = Math.max(requested, time(open.startedAt));
  if (idleStart >= nowMs) return { ok: false, reason: "invalid-idle-span" };
  const idleStartedAt = new Date(idleStart).toISOString();
  const idleEndedAt = now.toISOString();
  const revision = session.revision + 1;
  const relabel =
    command.disposition === "break" && session.phase === "break"
      ? "assign"
      : command.disposition;
  const eventType =
    relabel === "assign"
      ? "idle-assigned"
      : relabel === "break"
        ? "idle-break"
        : "idle-discarded";
  const closed = session.intervals.map((interval) =>
    interval.endedAt === null
      ? { ...interval, endedAt: idleStartedAt, closedBy: "idle" as const }
      : interval,
  );
  const next = (
    ordinal: number,
    kind: ActiveSessionPhase,
    startedAt: string,
    endedAt: string | null,
  ): TrackedInterval => ({
    id: ids.intervalId(ordinal),
    ordinal,
    kind,
    taskId: session.taskId,
    controllerClientId: command.actorClientId,
    startedAt,
    endedAt,
    closedBy: endedAt === null ? null : "idle",
  });
  const intervals: readonly TrackedInterval[] =
    relabel === "assign"
      ? session.intervals
      : relabel === "break"
        ? [
            ...closed,
            next(closed.length + 1, "break", idleStartedAt, idleEndedAt),
            next(closed.length + 2, "focus", idleEndedAt, null),
          ]
        : [
            ...closed,
            next(closed.length + 1, session.phase, idleEndedAt, null),
          ];
  const trimmedMs =
    relabel === "assign" || open.kind !== "focus" ? 0 : nowMs - idleStart;
  return {
    ok: true,
    session: {
      ...session,
      revision,
      updatedAt: idleEndedAt,
      leaseExpiresAt: new Date(nowMs + leaseMilliseconds).toISOString(),
      intervals,
      events: [
        ...session.events,
        {
          revision,
          type: eventType,
          actorClientId: command.actorClientId,
          occurredAt: idleEndedAt,
        },
      ],
    },
    correction: {
      disposition: relabel,
      idleStartedAt,
      idleEndedAt,
      trimmedMs,
    },
  };
};
