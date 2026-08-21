import { useMemo, useState, type SyntheticEvent } from "react";
import {
  type ActiveSession,
  type BaikalStatusResponse,
  type PlanningPreferences,
  type Task,
} from "@suite/contracts";
import { buildTodayQueue } from "@suite/domain";
import { TimeBlockForm } from "./time-block-form.tsx";

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

const isNonterminal = (session: ActiveSession | null): boolean =>
  session !== null &&
  session.state !== "completed" &&
  session.state !== "expired";

const taskTime = (value: string, timeZone: string): string =>
  new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));

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
  const row = (
    task: Task,
    state: "overdue" | "scheduled" | "planning" | "completed",
  ) => {
    const focusRunning =
      isNonterminal(activeSession) && activeSession?.taskId === task.id;
    const focusBlocked =
      isNonterminal(activeSession) && activeSession?.taskId !== task.id;
    const scheduleLabel =
      task.plannedStart == null
        ? `Schedule “${task.title}”`
        : `Change schedule for “${task.title}”`;
    return (
      <li key={task.id} className="today-task-row">
        <div>
          <strong>{task.title}</strong>
          <p className="today-task-meta">
            {state === "overdue"
              ? "Overdue"
              : state === "planning" || state === "completed"
                ? "No time set"
                : taskTime(
                    task.plannedStart ?? at,
                    preferences?.timeZone ?? "UTC",
                  )}
            {task.estimateMinutes == null
              ? ""
              : ` · ${String(task.estimateMinutes)} min`}
          </p>
        </div>
        <div className="today-task-actions">
          <button
            type="button"
            disabled={busy}
            aria-label={`${task.status === "completed" ? "Reopen" : "Complete"} “${task.title}”`}
            onClick={() =>
              void changeStatus(
                task,
                task.status === "completed" ? "reopen" : "complete",
              )
            }
          >
            {task.status === "completed" ? "Reopen" : "Complete"}
          </button>
          {state === "completed" ? null : focusRunning ? (
            <span>Focus running</span>
          ) : (
            <button
              type="button"
              disabled={busy || !focusActionsAvailable || focusBlocked}
              aria-label={`Start focus on “${task.title}”`}
              onClick={() => onStartFocus(task)}
            >
              Start focus
            </button>
          )}
          {state !== "completed" && !focusActionsAvailable ? (
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
