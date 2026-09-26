import { useEffect, useState, type SyntheticEvent } from "react";
import type {
  ActiveSession,
  FocusMode,
  FocusTimer,
  Task,
} from "@suite/contracts";
import { formatCountdown, localCountdown, modeLabel } from "./focus-timer.ts";
import { Button } from "./components/ui/button.tsx";
import { Card, CardContent, CardHeader } from "./components/ui/card.tsx";
import { NativeSelect } from "./components/ui/native-select.tsx";
import { SectionHeading } from "./components/ui/section-heading.tsx";

export type FocusPanelCommand =
  | {
      readonly command: "start";
      readonly taskId: string;
    }
  | {
      readonly command:
        | "pause"
        | "resume"
        | "start_break"
        | "end_break"
        | "complete"
        | "takeover";
      readonly sessionId: string;
      readonly expectedRevision: number;
    };

/** Server timer state and the preset control (ADR 0029). */
export interface FocusPanelTimerProps {
  readonly timer: FocusTimer | null;
  /** Local `Date.now()` when `timer` was received. */
  readonly receivedAt: number;
  readonly onSelectMode: (mode: FocusMode | null) => void;
}

export interface FocusPanelProps {
  readonly tasks: readonly Task[];
  readonly activeSession: ActiveSession | null;
  readonly clientId: string | null;
  readonly busy: boolean;
  readonly online: boolean;
  readonly onCommand: (command: FocusPanelCommand) => void;
  readonly showStartForm?: boolean;
  readonly focus?: FocusPanelTimerProps | undefined;
}

const TimerDisplay = ({
  focus,
  session,
  owner,
  disabled,
}: {
  readonly focus: FocusPanelTimerProps;
  readonly session: ActiveSession;
  readonly owner: boolean;
  readonly disabled: boolean;
}) => {
  const [now, setNow] = useState(() => Date.now());
  const running = session.state === "running";
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [running, focus.receivedAt]);
  const timer = focus.timer;
  const plan = timer?.plan ?? null;
  const countdown =
    timer === null ? null : localCountdown(timer, focus.receivedAt, now);
  return (
    <div className="grid gap-2" aria-live="polite">
      {countdown === null ? null : (
        <p className="focus-timer text-2xl font-semibold tabular-nums">
          <span className="sr-only">
            {countdown.phase === "focus" ? "Focus" : "Break"}{" "}
            {countdown.remainingMs === null ? "elapsed" : "remaining"}:{" "}
          </span>
          {formatCountdown(countdown.remainingMs ?? countdown.elapsedMs)}
          <span className="ml-2 text-sm font-normal text-subtext-2">
            {countdown.remainingMs === null
              ? "elapsed"
              : countdown.done
                ? countdown.phase === "focus"
                  ? "focus time complete"
                  : "break over"
                : "left"}
            {plan?.mode === "pomodoro"
              ? ` · cycle ${String(countdown.cycle)} of ${String(plan.cyclesBeforeLongBreak)}${countdown.isLongBreak ? " · long break" : ""}`
              : ""}
          </span>
        </p>
      )}
      {owner ? (
        <label className="field">
          <span>Preset</span>
          <NativeSelect
            value={plan?.mode ?? ""}
            disabled={disabled}
            onChange={(event) =>
              focus.onSelectMode(
                event.target.value === ""
                  ? null
                  : (event.target.value as FocusMode),
              )
            }
          >
            <option value="">No timer</option>
            {(Object.keys(modeLabel) as FocusMode[]).map((mode) => (
              <option key={mode} value={mode}>
                {modeLabel[mode]}
              </option>
            ))}
          </NativeSelect>
        </label>
      ) : plan === null ? null : (
        <p className="hint">Preset: {modeLabel[plan.mode]}</p>
      )}
    </div>
  );
};

const startableTasks = (tasks: readonly Task[]): readonly Task[] =>
  tasks.filter((task) => task.status === "open" && task.deletedAt === null);

const terminal = (session: ActiveSession | null): boolean =>
  session === null ||
  session.state === "completed" ||
  session.state === "expired";

const StartSession = ({
  tasks,
  busy,
  online,
  onCommand,
}: Pick<FocusPanelProps, "tasks" | "busy" | "online" | "onCommand">) => {
  const availableTasks = startableTasks(tasks);
  const [taskId, setTaskId] = useState(availableTasks[0]?.id ?? "");

  useEffect(() => {
    if (availableTasks.some((task) => task.id === taskId)) return;
    setTaskId(availableTasks[0]?.id ?? "");
  }, [availableTasks, taskId]);

  const submit = (event: SyntheticEvent<HTMLFormElement, SubmitEvent>) => {
    event.preventDefault();
    if (taskId !== "" && online && !busy) {
      onCommand({ command: "start", taskId });
    }
  };

  if (availableTasks.length === 0) {
    return (
      <p className="hint">Create or reopen a task before starting focus.</p>
    );
  }

  return (
    <form className="task-actions" onSubmit={submit}>
      <label className="field">
        <span>Focus task</span>
        <NativeSelect
          value={taskId}
          onChange={(event) => setTaskId(event.target.value)}
          disabled={busy || !online}
        >
          {availableTasks.map((task) => (
            <option key={task.id} value={task.id}>
              {task.title}
            </option>
          ))}
        </NativeSelect>
      </label>
      <Button type="submit" disabled={busy || !online || taskId === ""}>
        Start focus
      </Button>
    </form>
  );
};

export const FocusPanel = ({
  tasks,
  activeSession,
  clientId,
  busy,
  online,
  onCommand,
  showStartForm = true,
  focus,
}: FocusPanelProps) => {
  const session = activeSession;
  const isTerminal = terminal(session);

  if (isTerminal) {
    const recoveryMessage =
      activeSession?.state === "expired"
        ? "This focus session expired. Start a new session to continue."
        : activeSession?.state === "completed"
          ? "The previous focus session is complete. Start a new session when ready."
          : null;
    return (
      <Card aria-labelledby="focus-panel-title">
        <CardHeader>
          <SectionHeading id="focus-panel-title" title="Focus session" />
        </CardHeader>
        <CardContent className="grid gap-3">
          {recoveryMessage === null ? null : (
            <p className="hint">{recoveryMessage}</p>
          )}
          {!online ? (
            <p className="hint">Reconnect to start a focus session.</p>
          ) : null}
          {showStartForm ? (
            <StartSession
              tasks={tasks}
              busy={busy}
              online={online}
              onCommand={onCommand}
            />
          ) : null}
        </CardContent>
      </Card>
    );
  }

  if (session === null) return null;

  const owner = session.controllerClientId === clientId;
  const controlsDisabled = busy || !online;
  const phaseLabel = session.phase === "focus" ? "Focus" : "Break";
  const stateLabel = session.state === "running" ? "Running" : "Paused";
  const command = (name: Exclude<FocusPanelCommand["command"], "start">) => {
    onCommand({
      command: name,
      sessionId: session.id,
      expectedRevision: session.revision,
    });
  };

  return (
    <Card aria-labelledby="focus-panel-title">
      <CardHeader>
        <SectionHeading id="focus-panel-title" title="Focus session" />
      </CardHeader>
      <CardContent className="grid gap-3">
        <p className="hint">
          {phaseLabel} · {stateLabel}
        </p>
        {focus === undefined ? null : (
          <TimerDisplay
            focus={focus}
            session={session}
            owner={owner}
            disabled={controlsDisabled}
          />
        )}
        {!online ? (
          <p className="hint">Reconnect to control this session.</p>
        ) : null}
        {owner ? (
          <div className="task-actions" aria-label="Focus session controls">
            <Button
              type="button"
              disabled={controlsDisabled}
              onClick={() =>
                command(session.state === "running" ? "pause" : "resume")
              }
            >
              {session.state === "running" ? "Pause" : "Resume"}
            </Button>
            <Button
              type="button"
              disabled={controlsDisabled}
              onClick={() =>
                command(session.phase === "focus" ? "start_break" : "end_break")
              }
            >
              {session.phase === "focus" ? "Start break" : "End break"}
            </Button>
            <Button
              variant="outline"
              type="button"
              disabled={controlsDisabled}
              onClick={() => command("complete")}
            >
              Complete focus session
            </Button>
          </div>
        ) : (
          <div className="task-actions">
            <p className="hint">Controlled on another registered device.</p>
            <Button
              type="button"
              disabled={controlsDisabled}
              onClick={() => command("takeover")}
            >
              Take over on this device
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
};
