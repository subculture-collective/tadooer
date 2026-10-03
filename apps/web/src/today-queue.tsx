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
import { Button } from "./components/ui/button.tsx";
import { Card, CardContent, CardHeader } from "./components/ui/card.tsx";
import { EmptyState } from "./components/ui/empty-state.tsx";
import { SectionHeading } from "./components/ui/section-heading.tsx";

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
  /** ADR 0027, 0050: saved ranks of today's date-only tasks, from the cache. */
  readonly plannedTodayOrder?: readonly string[] | undefined;
  /** Moves within today's order; absent until the device has synced once. */
  readonly onMovePlanned?:
    ((taskId: string, direction: -1 | 1) => void) | undefined;
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
  plannedTodayOrder,
  onMovePlanned,
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
      : buildTodayQueue({
          at,
          timeZone: preferences.timeZone,
          dayStartsAt: preferences.dayStartsAt,
          tasks,
          plannedTodayOrder,
        });
  const planning =
    queue === undefined
      ? tasks
          .filter(
            (task) =>
              task.status === "open" &&
              task.deletedAt == null &&
              task.plannedStart == null &&
              task.plannedDay == null,
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
  const plannedToday =
    queue?.plannedTodayTaskIds.flatMap((id) => {
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
            (task.plannedStart != null || task.plannedDay != null),
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
  // ADR 0050: every planned task can move; a reorder queues offline and the
  // server reconciles membership when it applies it.
  const movable = plannedToday;
  const moveControls = (task: Task, state: TaskListItemState) => {
    if (state !== "planned-day" || onMovePlanned === undefined)
      return undefined;
    const index = movable.findIndex(({ id }) => id === task.id);
    return {
      canMoveUp: index > 0,
      canMoveDown: index !== -1 && index < movable.length - 1,
      onMove: (direction: -1 | 1) => onMovePlanned(task.id, direction),
    };
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
        moveControls={moveControls(task, state)}
      />
    );
  };
  const section = (
    title: string,
    className: string,
    listed: readonly Task[],
    state: "overdue" | "scheduled" | "planned-day" | "planning",
  ) => (
    <Card
      className={`today-section ${className}`}
      aria-labelledby={`${className}-title`}
    >
      <CardHeader>
        <SectionHeading id={`${className}-title`} title={title} />
      </CardHeader>
      <CardContent>
        <ul>{listed.map((task) => row(task, state))}</ul>
      </CardContent>
    </Card>
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
          <Button variant="link" type="button" onClick={onViewTasks}>
            View tasks
          </Button>
        </p>
      ) : null}
      {overdue.length +
        scheduled.length +
        plannedToday.length +
        planning.length ===
      0 ? (
        <EmptyState title="Today is clear." />
      ) : (
        <>
          {section("Overdue", "today-overdue", overdue, "overdue")}
          {section(
            "Scheduled today",
            "today-scheduled",
            scheduled,
            "scheduled",
          )}
          {plannedToday.length > 0
            ? section(
                "Planned for today",
                "today-planned-day",
                plannedToday,
                "planned-day",
              )
            : null}
          {section("Planning", "today-planning", planning, "planning")}
        </>
      )}
      {completed.length > 0 ? (
        <Card
          className="today-completed"
          aria-live="polite"
          aria-labelledby="today-completed-title"
        >
          <CardHeader>
            <SectionHeading
              id="today-completed-title"
              title="Completed just now"
            />
          </CardHeader>
          <CardContent>
            <ul>{completed.map((task) => row(task, "completed"))}</ul>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
};
