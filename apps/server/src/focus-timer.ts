import { createHash } from "node:crypto";
import type { FocusTimer } from "@suite/contracts";
import {
  buildCalmDay,
  computeFocusCountdown,
  observeActiveSession,
  untrackedSince,
  workingWithoutBreak,
  zonedDayWindow,
  type ActiveSession,
  type SessionClock,
} from "@suite/domain";
import type { SuiteDatabase } from "@suite/persistence";
import {
  activeFromRecord,
  activeResponse,
  eventsFromActive,
  intervalsFromActive,
  recordFromActive,
} from "./routes/shared.ts";

/**
 * Focus timer state derived from the active session (issue #65, ADR 0029).
 * The server computes elapsed, remaining, cycle and reminder state at its own
 * clock; the browser only counts down from the returned instant. The same
 * function feeds the HTTP timer endpoint and the reminder tick, so a banner
 * in the app and a ledger row never disagree.
 */

const minute = 60_000;

/** Reads the owner's session and persists an expiry the clock has reached. */
export const observeOwnerSession = (
  database: SuiteDatabase,
  sessionClock: SessionClock,
  ownerId: string,
): ActiveSession | undefined => {
  const stored = database.getActiveSession(ownerId);
  if (stored === undefined) return undefined;
  const observed = observeActiveSession(
    activeFromRecord(stored, database),
    sessionClock,
  );
  if (observed.revision !== stored.revision)
    database.applyActiveSessionTransition({
      session: recordFromActive(observed),
      expectedRevision: stored.revision,
      clientId: stored.controllerClientId ?? "system",
      idempotencyKey: `expiry-${stored.id}-${String(stored.revision)}`,
      requestHash: createHash("sha256")
        .update(`expiry:${stored.id}:${String(stored.revision)}`)
        .digest("base64url"),
      intervals: intervalsFromActive(observed),
      events: eventsFromActive(observed),
      now: observed.updatedAt,
    });
  return observed;
};

const nonterminal = (session: ActiveSession | undefined) =>
  session !== undefined &&
  session.state !== "completed" &&
  session.state !== "expired"
    ? session
    : undefined;

export const trackingReminderState = (
  database: SuiteDatabase,
  ownerId: string,
  now: Date,
  session: ActiveSession | undefined,
): FocusTimer["trackingReminder"] => {
  const preferences = database.focus.getPreferences(ownerId).preferences;
  const thresholdMs = preferences.trackingReminder.minMinutes * minute;
  const idle = {
    enabled: preferences.trackingReminder.enabled,
    untrackedMs: null,
    thresholdMs,
    due: false,
    suppressedReason: null,
  };
  if (!preferences.trackingReminder.enabled) return idle;
  const live = nonterminal(session);
  if (live?.state === "running" && live.phase === "focus")
    return { ...idle, suppressedReason: "tracking" };
  const planning = database.getPlanningPreferences(ownerId);
  const window = zonedDayWindow(now.toISOString(), planning.timeZone);
  const untracked = untrackedSince(
    database.focus.lastFocusEnd(ownerId),
    window.from,
    now,
    thresholdMs,
  );
  const calm = buildCalmDay({
    at: now.toISOString(),
    tasks: database.listTasks(ownerId).map((task) => ({
      id: task.id,
      status: task.status,
      plannedStart: task.plannedStart,
    })),
    busy: database
      .listCalendarEvents(ownerId, window.from, window.to)
      .map(({ startsAt, endsAt }) => ({ startsAt, endsAt })),
    preferences: planning,
    // Stored events decide busy time; staleness only suppresses task reminders.
    calendarFresh: true,
  });
  const suppressedReason =
    calm.state === "finished_for_today"
      ? "finished_for_today"
      : calm.state === "scheduled_break"
        ? "scheduled_break"
        : calm.state === "unavailable"
          ? calm.reminder.reason === "calendar_busy"
            ? "calendar_busy"
            : "outside_working_hours"
          : calm.orderedTaskIds.length === 0
            ? "finished_for_today"
            : null;
  return {
    enabled: true,
    untrackedMs: untracked.ms,
    thresholdMs,
    due: untracked.ms >= thresholdMs && suppressedReason === null,
    suppressedReason,
  };
};

/** Instant a due tracking reminder became due, for ledger identity. */
export const trackingReminderOccurrence = (
  database: SuiteDatabase,
  ownerId: string,
  now: Date,
  thresholdMs: number,
): string => {
  const planning = database.getPlanningPreferences(ownerId);
  return untrackedSince(
    database.focus.lastFocusEnd(ownerId),
    zonedDayWindow(now.toISOString(), planning.timeZone).from,
    now,
    thresholdMs,
  ).reachedAt;
};

export const breakReminderState = (
  database: SuiteDatabase,
  ownerId: string,
  now: Date,
  session: ActiveSession | undefined,
): FocusTimer["breakReminder"] & { readonly reachedAt: string | null } => {
  const preferences = database.focus.getPreferences(ownerId).preferences;
  const thresholdMs = preferences.takeABreak.minWorkingMinutes * minute;
  const at = now.toISOString();
  const stretch = workingWithoutBreak(
    database.focus.listOwnerIntervals(
      ownerId,
      new Date(now.getTime() - 24 * 60 * minute).toISOString(),
      at,
    ),
    at,
    thresholdMs,
  );
  const snoozedUntil = database.focus.getBreakSnoozedUntil(ownerId);
  const live = nonterminal(session);
  const snoozed = snoozedUntil !== null && snoozedUntil > at;
  return {
    enabled: preferences.takeABreak.enabled,
    workingWithoutBreakMs: stretch.ms,
    thresholdMs,
    due:
      preferences.takeABreak.enabled &&
      live?.state === "running" &&
      live.phase === "focus" &&
      stretch.ms >= thresholdMs &&
      !snoozed,
    snoozedUntil: snoozed ? snoozedUntil : null,
    reachedAt: stretch.reachedAt,
  };
};

export const focusTimerBody = (
  database: SuiteDatabase,
  sessionClock: SessionClock,
  ownerId: string,
): FocusTimer => {
  const now = sessionClock.now();
  const session = observeOwnerSession(database, sessionClock, ownerId);
  const live = nonterminal(session);
  const plan =
    live === undefined ? undefined : database.focus.getPlan(ownerId, live.id);
  const preferences = database.focus.getPreferences(ownerId).preferences;
  const countdown =
    live === undefined || plan === undefined
      ? null
      : computeFocusCountdown(live, plan, now);
  const { reachedAt, ...breakReminder } = breakReminderState(
    database,
    ownerId,
    now,
    session,
  );
  void reachedAt;
  return {
    at: now.toISOString(),
    session: session === undefined ? null : activeResponse(session),
    plan: plan ?? null,
    countdown,
    breakReminder,
    trackingReminder: trackingReminderState(database, ownerId, now, session),
    idle: {
      enabled: preferences.idle.enabled,
      minIdleMs: preferences.idle.minIdleMinutes * minute,
      onlyWithTask: preferences.idle.onlyWithTask,
      suppressed:
        preferences.idle.suppressInFocus &&
        live?.state === "running" &&
        plan !== undefined &&
        plan.mode !== "flowtime",
    },
  };
};
