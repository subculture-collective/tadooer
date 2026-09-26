import type { FocusMode, FocusTimer } from "@suite/contracts";

/**
 * Browser-side view of the server focus timer (ADR 0029). The server states
 * elapsed and remaining time at `timer.at`; the browser only advances that by
 * the local time since the response arrived while the session is running.
 */

export interface LocalCountdown {
  readonly phase: "focus" | "break";
  readonly elapsedMs: number;
  readonly targetMs: number | null;
  readonly remainingMs: number | null;
  readonly done: boolean;
  readonly cycle: number;
  readonly isLongBreak: boolean;
}

export const localCountdown = (
  timer: FocusTimer,
  receivedAtLocal: number,
  nowLocal: number,
): LocalCountdown | null => {
  const countdown = timer.countdown;
  if (countdown === null) return null;
  const running = timer.session?.state === "running";
  const advance = running ? Math.max(0, nowLocal - receivedAtLocal) : 0;
  const elapsedMs = countdown.elapsedMs + advance;
  const remainingMs =
    countdown.targetMs === null ? null : countdown.targetMs - elapsedMs;
  return {
    phase: countdown.phase,
    elapsedMs,
    targetMs: countdown.targetMs,
    remainingMs,
    done: countdown.done || (remainingMs !== null && remainingMs <= 0),
    cycle: countdown.cycle,
    isLongBreak: countdown.isLongBreak,
  };
};

/** `m:ss`, or `h:mm:ss` from one hour; negative values show as overtime. */
export const formatCountdown = (milliseconds: number): string => {
  const total = Math.floor(Math.abs(milliseconds) / 1_000);
  const hours = Math.floor(total / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  const seconds = total % 60;
  const body =
    hours > 0
      ? `${String(hours)}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
      : `${String(minutes)}:${String(seconds).padStart(2, "0")}`;
  return milliseconds < 0 ? `+${body}` : body;
};

export const modeLabel: Readonly<Record<FocusMode, string>> = {
  pomodoro: "Pomodoro",
  flowtime: "Flowtime",
  countdown: "Countdown",
};
