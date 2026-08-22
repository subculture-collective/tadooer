import type {
  ActiveSession,
  BaikalStatusResponse,
  Task,
} from "@suite/contracts";
import type { SyntheticEvent } from "react";
import { TaskCaptureForm } from "../components/tasks/TaskCaptureForm.tsx";
import { TaskListItem } from "../components/tasks/TaskListItem.tsx";

interface InboxPageProps {
  readonly tasks: readonly Task[];
  readonly activeSession: ActiveSession | null;
  readonly calendars: BaikalStatusResponse["calendars"];
  readonly busy: boolean;
  readonly calendarActionsAvailable: boolean;
  readonly focusActionsAvailable: boolean;
  readonly onSubmitTask: (
    event: SyntheticEvent<HTMLFormElement, SubmitEvent>,
  ) => Promise<void>;
  readonly onStartFocus: (task: Task) => void;
  readonly onChangeTaskStatus: (
    task: Task,
    action: "complete" | "reopen",
  ) => Promise<boolean>;
  readonly onSubmitTimeBlock: (
    event: SyntheticEvent<HTMLFormElement, SubmitEvent>,
    task: Task,
  ) => Promise<void>;
  readonly onRemoveTimeBlock: (task: Task) => Promise<void>;
}

export const InboxPage = ({
  tasks,
  activeSession,
  calendars,
  busy,
  calendarActionsAvailable,
  focusActionsAvailable,
  onSubmitTask,
  onStartFocus,
  onChangeTaskStatus,
  onSubmitTimeBlock,
  onRemoveTimeBlock,
}: InboxPageProps) => {
  const inboxTasks = tasks.filter(
    (task) =>
      task.status === "open" &&
      task.deletedAt === null &&
      task.plannedStart === null,
  );

  return (
    <div className="today-page">
      <header className="today-header">
        <p className="step">Capture and clarify</p>
        <h1>Inbox</h1>
        <p>Unscheduled tasks waiting for a decision.</p>
      </header>
      <TaskCaptureForm busy={busy} onSubmit={onSubmitTask} />
      {inboxTasks.length === 0 ? (
        <p className="muted">
          Inbox zero. Capture the next thing when it arrives.
        </p>
      ) : (
        <section
          className="today-section today-planning"
          aria-labelledby="inbox-list-title"
        >
          <h2 id="inbox-list-title">To clarify</h2>
          <ul>
            {inboxTasks.map((task) => (
              <TaskListItem
                key={task.id}
                task={task}
                state="planning"
                at={new Date().toISOString()}
                timeZone="UTC"
                activeSession={activeSession}
                calendars={calendars}
                busy={busy}
                calendarActionsAvailable={calendarActionsAvailable}
                focusActionsAvailable={focusActionsAvailable}
                onStartFocus={onStartFocus}
                onChangeTaskStatus={async (taskToChange, action) => {
                  await onChangeTaskStatus(taskToChange, action);
                }}
                onSubmitTimeBlock={onSubmitTimeBlock}
                onRemoveTimeBlock={onRemoveTimeBlock}
              />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
};
