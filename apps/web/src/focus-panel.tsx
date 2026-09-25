import { useEffect, useState, type SyntheticEvent } from "react";
import type { ActiveSession, Task } from "@suite/contracts";
import { Button } from "./components/ui/button.tsx";
import { Card, CardContent, CardHeader } from "./components/ui/card.tsx";
import { NativeSelect } from "./components/ui/native-select.tsx";
import { SectionHeading } from "./components/ui/section-heading.tsx";
import { useApplicationPreferences } from "./application-preferences.tsx";

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

export interface FocusPanelProps {
  readonly tasks: readonly Task[];
  readonly activeSession: ActiveSession | null;
  readonly clientId: string | null;
  readonly busy: boolean;
  readonly online: boolean;
  readonly onCommand: (command: FocusPanelCommand) => void;
  readonly showStartForm?: boolean;
}

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
}: FocusPanelProps) => {
  const { notifyWhenEstimateExceeded } =
    useApplicationPreferences().snapshot.preferences;
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
  // ADR 0030 notifyWhenEstimateExceeded: session time since start against
  // the task estimate (breaks included; net focus time is server-side).
  const focusTask = tasks.find((task) => task.id === session.taskId);
  const exceeded =
    notifyWhenEstimateExceeded &&
    focusTask?.estimateMinutes != null &&
    Date.now() - Date.parse(session.startedAt) >
      focusTask.estimateMinutes * 60_000
      ? { title: focusTask.title, minutes: focusTask.estimateMinutes }
      : undefined;
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
        {exceeded !== undefined ? (
          <p className="message message-warning" role="status">
            This session has run longer than the {exceeded.minutes}
            -minute estimate for “{exceeded.title}”.
          </p>
        ) : null}
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
