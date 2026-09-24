import type {
  ActiveSession,
  BaikalStatusResponse,
  Task,
} from "@suite/contracts";
import type { SyntheticEvent } from "react";
import { TaskCaptureForm } from "../components/tasks/TaskCaptureForm.tsx";
import { TaskListItem } from "../components/tasks/TaskListItem.tsx";
import { Card, CardContent, CardHeader } from "../components/ui/card.tsx";
import { EmptyState } from "../components/ui/empty-state.tsx";
import { PageHeader } from "../components/ui/page-header.tsx";
import { SectionHeading } from "../components/ui/section-heading.tsx";

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
    <div className="today-page mx-auto flex w-full max-w-5xl flex-col gap-6">
      <PageHeader
        eyebrow="Capture and clarify"
        title="Inbox"
        description="Unscheduled tasks waiting for a decision."
      />
      <TaskCaptureForm busy={busy} onSubmit={onSubmitTask} />
      {inboxTasks.length === 0 ? (
        <EmptyState
          title="Inbox zero"
          description="Capture the next thing when it arrives."
        />
      ) : (
        <Card
          className="today-section today-planning"
          aria-labelledby="inbox-list-title"
        >
          <CardHeader>
            <SectionHeading id="inbox-list-title" title="To clarify" />
          </CardHeader>
          <CardContent>
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
          </CardContent>
        </Card>
      )}
    </div>
  );
};
