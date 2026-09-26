import type { FocusReminderKind } from "@suite/contracts";
import {
  breakReminderMessage,
  computeFocusCountdown,
  formatClockDuration,
  type SessionClock,
} from "@suite/domain";
import type {
  NotificationDeliveryRecord,
  SuiteDatabase,
} from "@suite/persistence";
import {
  breakReminderState,
  observeOwnerSession,
  trackingReminderOccurrence,
  trackingReminderState,
} from "./focus-timer.ts";
import type { NtfyPublisher } from "./notifications.ts";

/**
 * Focus reminders through the durable ledger (issue #65, ADR 0029):
 * countdown complete, break over, take a break, nothing tracked.
 *
 * Each occurrence instant is derived from session intervals, so repeated
 * ticks queue the same row once (unique on owner, kind and occurrence). A row
 * is claimed before publication and re-evaluated at that moment: a reminder
 * whose cause has passed is suppressed, never sent late. Publication failures
 * follow the task-reminder policy: bounded retries on an explicit rejection,
 * a terminal failure on a lost response.
 */

const isFocusKind = (kind: string): kind is FocusReminderKind =>
  kind.startsWith("focus_");

export const isFocusReminder = (delivery: NotificationDeliveryRecord) =>
  isFocusKind(delivery.kind);

type Evaluation =
  | { readonly send: true; readonly message: string }
  | { readonly send: false; readonly reason: string };

const evaluate = (
  database: SuiteDatabase,
  sessionClock: SessionClock,
  ownerId: string,
  delivery: NotificationDeliveryRecord,
  detailed: boolean,
): Evaluation => {
  const now = sessionClock.now();
  const session = observeOwnerSession(database, sessionClock, ownerId);
  const live =
    session !== undefined &&
    session.state !== "completed" &&
    session.state !== "expired"
      ? session
      : undefined;
  const title = (): string => {
    const task =
      live?.taskId === null || live === undefined
        ? undefined
        : database.getTask(ownerId, live.taskId, true);
    return detailed && task !== undefined ? ` · ${task.title}` : "";
  };
  const kind = delivery.kind;
  if (kind === "focus_countdown" || kind === "focus_break_end") {
    const plan =
      live === undefined ? undefined : database.focus.getPlan(ownerId, live.id);
    if (live === undefined || plan === undefined)
      return { send: false, reason: "SESSION_ENDED" };
    const countdown = computeFocusCountdown(live, plan, now);
    const expectedPhase = kind === "focus_countdown" ? "focus" : "break";
    if (
      countdown.phase !== expectedPhase ||
      countdown.reachedAt !== delivery.occurrenceStart
    )
      return { send: false, reason: "PHASE_CHANGED" };
    return {
      send: true,
      message:
        kind === "focus_countdown"
          ? `Focus time complete · ${formatClockDuration(countdown.targetMs ?? 0)}${title()}`
          : `Break over${countdown.isLongBreak ? " (long break)" : ""}${title()}`,
    };
  }
  if (kind === "focus_break_reminder") {
    const state = breakReminderState(database, ownerId, now, session);
    if (!state.due) return { send: false, reason: "BREAK_TAKEN" };
    const template =
      database.focus.getPreferences(ownerId).preferences.takeABreak.message;
    return {
      send: true,
      message: breakReminderMessage(template, state.workingWithoutBreakMs),
    };
  }
  const state = trackingReminderState(database, ownerId, now, session);
  if (!state.due) return { send: false, reason: "TRACKING_RESUMED" };
  return {
    send: true,
    message: `Nothing is being tracked · ${formatClockDuration(state.untrackedMs ?? 0)} since the last focus time`,
  };
};

/** Queues due focus reminders and publishes the claimed ones. */
export const runFocusReminders = async (input: {
  readonly database: SuiteDatabase;
  readonly sessionClock: SessionClock;
  readonly ownerId: string;
  readonly publisher: NtfyPublisher;
  readonly detailedContentEnabled: boolean;
  readonly clickOrigin: string;
}): Promise<void> => {
  const { database, sessionClock, ownerId, publisher } = input;
  const now = sessionClock.now();
  const nowIso = now.toISOString();
  const session = observeOwnerSession(database, sessionClock, ownerId);
  const live =
    session !== undefined &&
    session.state !== "completed" &&
    session.state !== "expired"
      ? session
      : undefined;
  const preferences = database.focus.getPreferences(ownerId).preferences;
  const plan =
    live === undefined ? undefined : database.focus.getPlan(ownerId, live.id);
  if (live !== undefined && plan !== undefined) {
    const countdown = computeFocusCountdown(live, plan, now);
    if (countdown.reachedAt !== null)
      database.focus.queueReminder(
        ownerId,
        countdown.phase === "focus" ? "focus_countdown" : "focus_break_end",
        countdown.reachedAt,
        nowIso,
      );
  }
  const breakState = breakReminderState(database, ownerId, now, session);
  if (breakState.due && breakState.reachedAt !== null) {
    // After a snooze the next occurrence is the snooze end, not the original.
    const snoozedUntil = database.focus.getBreakSnoozedUntil(ownerId);
    database.focus.queueReminder(
      ownerId,
      "focus_break_reminder",
      snoozedUntil !== null && snoozedUntil > breakState.reachedAt
        ? snoozedUntil
        : breakState.reachedAt,
      nowIso,
    );
  }
  const tracking = trackingReminderState(database, ownerId, now, session);
  if (tracking.due)
    database.focus.queueReminder(
      ownerId,
      "focus_tracking_reminder",
      trackingReminderOccurrence(
        database,
        ownerId,
        now,
        preferences.trackingReminder.minMinutes * 60_000,
      ),
      nowIso,
    );

  for (const due of database.listDueNotificationDeliveries(nowIso)) {
    if (due.ownerId !== ownerId || !isFocusReminder(due)) continue;
    const claimed = database.claimNotificationDelivery(due.id, nowIso);
    if (claimed === undefined) continue;
    const decision = evaluate(
      database,
      sessionClock,
      ownerId,
      due,
      input.detailedContentEnabled,
    );
    if (!decision.send) {
      database.finishNotificationDelivery(
        due.id,
        "suppressed",
        decision.reason,
        nowIso,
      );
      continue;
    }
    const result = await publisher.publish({
      message: decision.message,
      click: `${input.clickOrigin}/today`,
    });
    if (result.kind === "delivered")
      database.finishNotificationDelivery(due.id, "delivered", null, nowIso);
    else if (result.kind === "retry" && claimed.attemptCount < 5) {
      const minutes = [1, 5, 15, 30][claimed.attemptCount - 1] ?? 30;
      database.deferNotificationDelivery(
        due.id,
        new Date(now.getTime() + minutes * 60_000).toISOString(),
        result.errorCode,
        nowIso,
      );
    } else
      database.finishNotificationDelivery(
        due.id,
        "failed",
        result.kind === "retry" ? "NTFY_RETRY_EXHAUSTED" : result.errorCode,
        nowIso,
      );
  }
};
