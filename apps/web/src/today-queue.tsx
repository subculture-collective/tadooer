import { useMemo, useState, type SyntheticEvent } from "react";
import {
  type ActiveSession,
  type BaikalStatusResponse,
  type PlanningPreferences,
  type Task,
} from "@suite/contracts";
import { buildTodayQueue } from "@suite/domain";
import {
  TaskListItem,
  type TaskListItemState,
} from "./components/tasks/TaskListItem.tsx";

export interface TodayQueueProps {
  readonly at: string;
  readonly preferences: PlanningPreferences | undefined;
  readonly tasks: readonly Task[];
  readonly activeSession: ActiveSession | null;
  readonly calendars: BaikalStatusResponse["calendars"];
  readonly busy: boolean;
  readonly calendarActionsAvailable: boolean;
  readonly focusActionsAvailable: boolean;
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
  readonly onViewTasks: () => void;
}

export const TodayQueue = ({
  at,
  preferences,
  tasks,
  activeSession,
  calendars,
  busy,
  calendarActionsAvailable,
  focusActionsAvailable,
  onStartFocus,
  onChangeTaskStatus,
  onSubmitTimeBlock,
  onRemoveTimeBlock,
  onViewTasks,
}: TodayQueueProps) => {
  const [recentlyCompletedIds, setRecentlyCompletedIds] = useState<
    ReadonlySet<string>
  >(new Set());
  const byId = useMemo(
    () => new Map(tasks.map((task) => [task.id, task])),
    [tasks],
  );
  const queue =
    preferences === undefined
      ? undefined
      : buildTodayQueue({ at, timeZone: preferences.timeZone, tasks });
  const planning =
    queue === undefined
      ? tasks
          .filter(
            (task) =>
              task.status === "open" &&
              task.deletedAt == null &&
              task.plannedStart == null,
          )
          .toSorted((left, right) => left.id.localeCompare(right.id))
      : queue.unscheduledTaskIds.flatMap((id) => {
          const task = byId.get(id);
          return task === undefined ? [] : [task];
        });
  const overdue =
    queue?.overdueTaskIds.flatMap((id) => {
      const task = byId.get(id);
      return task === undefined ? [] : [task];
    }) ?? [];
  const scheduled =
    queue?.scheduledTodayTaskIds.flatMap((id) => {
      const task = byId.get(id);
      return task === undefined ? [] : [task];
    }) ?? [];
  const completed = tasks.filter(
    (task) =>
      recentlyCompletedIds.has(task.id) &&
      task.status === "completed" &&
      task.deletedAt === null,
  );
  const unavailableScheduledCount =
    preferences === undefined
      ? tasks.filter(
          (task) =>
            task.status === "open" &&
            task.deletedAt == null &&
            task.plannedStart != null,
        ).length
      : 0;

  const changeStatus = async (task: Task, action: "complete" | "reopen") => {
    if (!(await onChangeTaskStatus(task, action))) return;
    setRecentlyCompletedIds((current) => {
      const next = new Set(current);
      if (action === "complete") next.add(task.id);
      else next.delete(task.id);
      return next;
    });
  };
  const row = (task: Task, state: TaskListItemState) => {
    return (
      <TaskListItem
        key={task.id}
        task={task}
        state={state}
        at={at}
        timeZone={preferences?.timeZone ?? "UTC"}
        activeSession={activeSession}
        calendars={calendars}
        busy={busy}
        calendarActionsAvailable={calendarActionsAvailable}
        focusActionsAvailable={focusActionsAvailable}
        onStartFocus={onStartFocus}
        onChangeTaskStatus={async (taskToChange, action) => {
          await changeStatus(taskToChange, action);
        }}
        onSubmitTimeBlock={onSubmitTimeBlock}
        onRemoveTimeBlock={onRemoveTimeBlock}
      />
    );
  };
  const section = (
    title: string,
    className: string,
    listed: readonly Task[],
    state: "overdue" | "scheduled" | "planning",
  ) => (
    <section
      className={`today-section ${className}`}
      aria-labelledby={`${className}-title`}
    >
      <h2 id={`${className}-title`}>{title}</h2>
      <ul>{listed.map((task) => row(task, state))}</ul>
    </section>
  );

  return (
    <div className="today-layout">
      {preferences === undefined && unavailableScheduledCount > 0 ? (
        <p className="hint">
          {unavailableScheduledCount} scheduled{" "}
          {unavailableScheduledCount === 1 ? "task" : "tasks"} hidden until the
          planning time zone is available.
        </p>
      ) : null}
      {queue !== undefined && queue.futureScheduledCount > 0 ? (
        <p className="hint">
          {queue.futureScheduledCount} future{" "}
          {queue.futureScheduledCount === 1 ? "task" : "tasks"} hidden.{" "}
          <button type="button" onClick={onViewTasks}>
            View tasks
          </button>
        </p>
      ) : null}
      {overdue.length + scheduled.length + planning.length === 0 ? (
        <p>Nothing queued for today.</p>
      ) : (
        <>
          {section("Overdue", "today-overdue", overdue, "overdue")}
          {section(
            "Scheduled today",
            "today-scheduled",
            scheduled,
            "scheduled",
          )}
          {section("Planning", "today-planning", planning, "planning")}
        </>
      )}
      {completed.length > 0 ? (
        <section
          className="today-completed"
          aria-live="polite"
          aria-labelledby="today-completed-title"
        >
          <h2 id="today-completed-title">Completed just now</h2>
          <ul>{completed.map((task) => row(task, "completed"))}</ul>
        </section>
      ) : null}
    </div>
  );
};
