import { useEffect, useState, type SyntheticEvent } from "react";
import type { ActiveSession, Task } from "@suite/contracts";

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
        <select
          value={taskId}
          onChange={(event) => setTaskId(event.target.value)}
          disabled={busy || !online}
        >
          {availableTasks.map((task) => (
            <option key={task.id} value={task.id}>
              {task.title}
            </option>
          ))}
        </select>
      </label>
      <button type="submit" disabled={busy || !online || taskId === ""}>
        Start focus
      </button>
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
      <section aria-labelledby="focus-panel-title">
        <h2 id="focus-panel-title">Focus session</h2>
        {recoveryMessage === null ? null : (
          <p className="hint">{recoveryMessage}</p>
        )}
        {!online ? (
          <p className="hint">Reconnect to start a focus session.</p>
        ) : null}
        <StartSession
          tasks={tasks}
          busy={busy}
          online={online}
          onCommand={onCommand}
        />
      </section>
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
    <section aria-labelledby="focus-panel-title">
      <h2 id="focus-panel-title">Focus session</h2>
      <p className="hint">
        {phaseLabel} · {stateLabel}
      </p>
      {!online ? (
        <p className="hint">Reconnect to control this session.</p>
      ) : null}
      {owner ? (
        <div className="task-actions" aria-label="Focus session controls">
          <button
            type="button"
            disabled={controlsDisabled}
            onClick={() =>
              command(session.state === "running" ? "pause" : "resume")
            }
          >
            {session.state === "running" ? "Pause" : "Resume"}
          </button>
          <button
            type="button"
            disabled={controlsDisabled}
            onClick={() =>
              command(session.phase === "focus" ? "start_break" : "end_break")
            }
          >
            {session.phase === "focus" ? "Start break" : "End break"}
          </button>
          <button
            className="btn-ghost"
            type="button"
            disabled={controlsDisabled}
            onClick={() => command("complete")}
          >
            Complete focus session
          </button>
        </div>
      ) : (
        <div className="task-actions">
          <p className="hint">Controlled on another registered device.</p>
          <button
            type="button"
            disabled={controlsDisabled}
            onClick={() => command("takeover")}
          >
            Take over on this device
          </button>
        </div>
      )}
    </section>
  );
};
