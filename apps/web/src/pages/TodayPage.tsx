import { useEffect, useState, type SyntheticEvent } from "react";
import type {
  ActiveSession,
  BaikalStatusResponse,
  DayPlanResponse,
  PlanningPreferences,
  PlannerResponse,
  Task,
} from "@suite/contracts";
import { FocusPanel, type FocusPanelCommand } from "../focus-panel.tsx";
import { TodayQueue } from "../today-queue.tsx";
import { TaskCaptureForm } from "../components/tasks/TaskCaptureForm.tsx";
import { Badge } from "../components/ui/badge.tsx";
import { Card, CardContent, CardHeader } from "../components/ui/card.tsx";
import { Checkbox } from "../components/ui/checkbox.tsx";
import { EmptyState } from "../components/ui/empty-state.tsx";
import { PageHeader } from "../components/ui/page-header.tsx";
import { SectionHeading } from "../components/ui/section-heading.tsx";

export interface TodayPageProps {
  readonly dayPlan: DayPlanResponse | undefined;
  readonly planningPreferences: PlanningPreferences | undefined;
  readonly tasks: readonly Task[];
  readonly activeSession: ActiveSession | null;
  readonly clientId: string | null;
  readonly syncStatus: "online" | "offline" | "syncing" | undefined;
  readonly planner: PlannerResponse | null;
  readonly baikalCalendars: BaikalStatusResponse["calendars"];
  readonly calendarActionsAvailable: boolean;
  readonly focusActionsAvailable: boolean;
  readonly busy: boolean;
  readonly onFocusCommand: (command: FocusPanelCommand) => void;
  readonly onSubmitTask: (
    event: SyntheticEvent<HTMLFormElement, SubmitEvent>,
  ) => Promise<void>;
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
const calmStateLabel: Readonly<Record<DayPlanResponse["state"], string>> = {
  working: "Working",
  scheduled_break: "Scheduled break",
  unavailable: "Unavailable right now",
  finished_for_today: "Finished for today",
};

export const updateHiddenCalendarIds = (
  current: readonly string[],
  calendarId: string,
  checked: boolean,
): readonly string[] =>
  checked
    ? current.filter((id) => id !== calendarId)
    : current.includes(calendarId)
      ? current
      : [...current, calendarId];

export const TodayPage = (props: TodayPageProps) => {
  const {
    dayPlan,
    planningPreferences,
    tasks,
    activeSession,
    clientId,
    syncStatus,
    planner,
    baikalCalendars,
    calendarActionsAvailable,
    focusActionsAvailable,
    busy,
    onFocusCommand,
    onSubmitTask,
    onChangeTaskStatus,
    onSubmitTimeBlock,
    onRemoveTimeBlock,
    onViewTasks,
  } = props;
  const [logicalAt, setLogicalAt] = useState(
    dayPlan?.at ?? new Date().toISOString(),
  );
  const [hiddenCalendarIds, setHiddenCalendarIds] = useState<readonly string[]>(
    [],
  );
  useEffect(() => {
    if (dayPlan?.at !== undefined) setLogicalAt(dayPlan.at);
  }, [dayPlan?.at]);
  useEffect(() => {
    const timer = window.setInterval(
      () => setLogicalAt(new Date().toISOString()),
      60_000,
    );
    return () => window.clearInterval(timer);
  }, []);
  const preferences = planningPreferences ?? dayPlan?.preferences;
  return (
    <div className="today-page mx-auto flex w-full max-w-5xl flex-col gap-6">
      <PageHeader
        eyebrow="Calm daily workspace"
        title="Today"
        description={
          dayPlan === undefined
            ? "Choose the next useful task from your local workspace."
            : calmStateLabel[dayPlan.state]
        }
      >
        {dayPlan?.nextTask === null ? (
          <p className="text-xs text-subtext-2">
            No scheduled task is ready next.
          </p>
        ) : dayPlan?.nextTask !== undefined ? (
          <p className="text-xs text-subtext-2">
            Next: {dayPlan.nextTask.title}
          </p>
        ) : null}
      </PageHeader>
      <p
        className="flex items-center gap-2 text-xs text-subtext-2"
        aria-live="polite"
      >
        <span aria-hidden="true" className="size-1.5 rounded-full bg-success" />
        {syncStatus === "offline"
          ? "Offline. Tasks can be captured, completed, and reopened."
          : syncStatus === "syncing"
            ? "Syncing local tasks."
            : "Task sync is available."}
      </p>
      <TaskCaptureForm busy={busy} onSubmit={onSubmitTask} />
      <FocusPanel
        tasks={tasks}
        activeSession={activeSession}
        clientId={clientId}
        busy={busy}
        online={focusActionsAvailable}
        onCommand={onFocusCommand}
        showStartForm={false}
      />
      <TodayQueue
        at={logicalAt}
        preferences={preferences}
        tasks={tasks}
        activeSession={activeSession}
        calendars={baikalCalendars}
        busy={busy}
        calendarActionsAvailable={calendarActionsAvailable}
        focusActionsAvailable={focusActionsAvailable}
        onStartFocus={(task) =>
          onFocusCommand({ command: "start", taskId: task.id })
        }
        onChangeTaskStatus={onChangeTaskStatus}
        onSubmitTimeBlock={onSubmitTimeBlock}
        onRemoveTimeBlock={onRemoveTimeBlock}
        onViewTasks={onViewTasks}
      />
      <Card className="week-plan" aria-labelledby="week-plan-title">
        <CardHeader>
          <SectionHeading
            id="week-plan-title"
            eyebrow="Real calendar context"
            title="Week plan"
            actions={
              planner !== null ? (
                <Badge
                  variant={
                    planner.freshness.state === "fresh" ? "success" : "warning"
                  }
                >
                  {planner.freshness.message}
                </Badge>
              ) : undefined
            }
          />
        </CardHeader>
        <CardContent className="grid gap-3">
          {planner === null || planner.events.length === 0 ? (
            <EmptyState title="No supported events in this week." />
          ) : (
            <>
              <fieldset className="calendar-filters">
                <legend>Calendars</legend>
                {Array.from(
                  new Map(
                    planner.events.map((event) => [
                      event.identity.calendarId,
                      event.source,
                    ]),
                  ),
                ).map(([calendarId, source]) => (
                  <label key={calendarId}>
                    <Checkbox
                      checked={!hiddenCalendarIds.includes(calendarId)}
                      onCheckedChange={(checked) => {
                        setHiddenCalendarIds((current) =>
                          updateHiddenCalendarIds(
                            current,
                            calendarId,
                            checked === true,
                          ),
                        );
                      }}
                    />
                    {source.providerDisplayLabel} · {source.calendarName}
                  </label>
                ))}
              </fieldset>
              <ol className="timeline">
                {planner.events
                  .filter(
                    (event) =>
                      !hiddenCalendarIds.includes(event.identity.calendarId),
                  )
                  .map((event) => (
                    <li key={`${event.identity.calendarId}:${event.href}`}>
                      <time dateTime={event.startsAt}>
                        {preferences === undefined
                          ? new Date(event.startsAt).toLocaleString()
                          : new Intl.DateTimeFormat("en-US", {
                              timeZone: preferences.timeZone,
                              dateStyle: "medium",
                              timeStyle: "short",
                            }).format(new Date(event.startsAt))}
                      </time>
                      <strong>{event.summary || "Untitled event"}</strong>
                      <span className="source-badge">
                        {event.source.providerDisplayLabel} ·{" "}
                        {event.source.calendarName}
                      </span>
                    </li>
                  ))}
              </ol>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
};
