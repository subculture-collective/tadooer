import type { FocusTimer } from "@suite/contracts";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { formatCountdown } from "./focus-timer.ts";

export interface FocusRemindersProps {
  readonly timer: FocusTimer | null;
  readonly busy: boolean;
  readonly online: boolean;
  /** Owner dismissed the tracking reminder for this occurrence. */
  readonly trackingDismissed: boolean;
  readonly onStartBreak: () => void;
  readonly onSnoozeBreak: () => void;
  readonly onDismissTracking: () => void;
  readonly onGoToToday: () => void;
}

/**
 * In-app take-a-break and tracking reminders (ADR 0029). The server decides
 * when each is due; the banner mirrors that state and offers the actions.
 * The ntfy copy goes through the notification ledger separately.
 */
export const FocusReminders = ({
  timer,
  busy,
  online,
  trackingDismissed,
  onStartBreak,
  onSnoozeBreak,
  onDismissTracking,
  onGoToToday,
}: FocusRemindersProps) => {
  if (timer === null) return null;
  const breakDue = timer.breakReminder.due;
  const trackingDue = timer.trackingReminder.due && !trackingDismissed;
  if (!breakDue && !trackingDue) return null;
  return (
    <section aria-label="Focus reminders" className="grid gap-2">
      {breakDue ? (
        <Alert variant="warning" role="status">
          <AlertTitle>Time for a break</AlertTitle>
          <AlertDescription>
            You have been working for{" "}
            {formatCountdown(timer.breakReminder.workingWithoutBreakMs)} without
            a break.
            <span className="mt-2 flex flex-wrap gap-2">
              <Button
                type="button"
                size="xs"
                disabled={busy || !online}
                onClick={onStartBreak}
              >
                Start break
              </Button>
              <Button
                type="button"
                size="xs"
                variant="outline"
                disabled={busy || !online}
                onClick={onSnoozeBreak}
              >
                Snooze
              </Button>
            </span>
          </AlertDescription>
        </Alert>
      ) : null}
      {trackingDue ? (
        <Alert variant="info" role="status">
          <AlertTitle>Nothing is being tracked</AlertTitle>
          <AlertDescription>
            No focus time for{" "}
            {formatCountdown(timer.trackingReminder.untrackedMs ?? 0)} during
            working hours.
            <span className="mt-2 flex flex-wrap gap-2">
              <Button type="button" size="xs" onClick={onGoToToday}>
                Start focus
              </Button>
              <Button
                type="button"
                size="xs"
                variant="outline"
                onClick={onDismissTracking}
              >
                Dismiss
              </Button>
            </span>
          </AlertDescription>
        </Alert>
      ) : null}
    </section>
  );
};
