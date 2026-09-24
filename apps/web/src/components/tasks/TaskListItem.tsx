import type { SyntheticEvent } from "react";
import type {
  ActiveSession,
  BaikalStatusResponse,
  Task,
} from "@suite/contracts";
import { TimeBlockForm } from "../../time-block-form.tsx";
import { Badge } from "../ui/badge.tsx";
import { Button } from "../ui/button.tsx";

export type TaskListItemState =
  "overdue" | "scheduled" | "planning" | "completed";

interface TaskListItemProps {
  readonly task: Task;
  readonly state: TaskListItemState;
  readonly at: string;
  readonly timeZone: string;
  readonly activeSession: ActiveSession | null;
  readonly calendars: BaikalStatusResponse["calendars"];
  readonly busy: boolean;
  readonly calendarActionsAvailable: boolean;
  readonly focusActionsAvailable: boolean;
  readonly onStartFocus: (task: Task) => void;
  readonly onChangeTaskStatus: (
    task: Task,
    action: "complete" | "reopen",
  ) => Promise<void>;
  readonly onSubmitTimeBlock: (
    event: SyntheticEvent<HTMLFormElement, SubmitEvent>,
    task: Task,
  ) => Promise<void>;
  readonly onRemoveTimeBlock: (task: Task) => Promise<void>;
}

const taskTime = (value: string, timeZone: string): string =>
  new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));

export const TaskListItem = ({
  task,
  state,
  at,
  timeZone,
  activeSession,
  calendars,
  busy,
  calendarActionsAvailable,
  focusActionsAvailable,
  onStartFocus,
  onChangeTaskStatus,
  onSubmitTimeBlock,
  onRemoveTimeBlock,
}: TaskListItemProps) => {
  const hasNonterminalFocus =
    activeSession !== null &&
    activeSession.state !== "completed" &&
    activeSession.state !== "expired";
  const focusRunning = hasNonterminalFocus && activeSession.taskId === task.id;
  const focusBlocked = hasNonterminalFocus && activeSession.taskId !== task.id;
  const scheduleLabel =
    task.plannedStart === null
      ? `Schedule “${task.title}”`
      : `Change schedule for “${task.title}”`;

  return (
    <li className="today-task-row">
      <div>
        <strong>{task.title}</strong>
        <p className="today-task-meta">
          {state === "overdue"
            ? "Overdue"
            : state === "planning" || state === "completed"
              ? "No time set"
              : taskTime(task.plannedStart ?? at, timeZone)}
          {task.estimateMinutes === null
            ? ""
            : ` · ${String(task.estimateMinutes)} min`}
        </p>
      </div>
      <div className="today-task-actions">
        <Button
          type="button"
          disabled={busy}
          aria-label={`${task.status === "completed" ? "Reopen" : "Complete"} “${task.title}”`}
          onClick={() =>
            void onChangeTaskStatus(
              task,
              task.status === "completed" ? "reopen" : "complete",
            )
          }
        >
          {task.status === "completed" ? "Reopen" : "Complete"}
        </Button>
        {state === "completed" ? null : focusRunning ? (
          <Badge variant="now">Focus running</Badge>
        ) : (
          <Button
            type="button"
            disabled={busy || !focusActionsAvailable || focusBlocked}
            aria-label={`Start focus on “${task.title}”`}
            onClick={() => onStartFocus(task)}
          >
            Start focus
          </Button>
        )}
        {state === "completed" ? null : !focusActionsAvailable ? (
          <span className="hint">Reconnect to start focus.</span>
        ) : null}
        {state === "completed" ? null : (
          <details>
            <summary>{scheduleLabel}</summary>
            <TimeBlockForm
              task={task}
              calendars={calendars}
              busy={busy}
              available={calendarActionsAvailable}
              onSubmit={onSubmitTimeBlock}
              onRemove={onRemoveTimeBlock}
            />
          </details>
        )}
      </div>
    </li>
  );
};
