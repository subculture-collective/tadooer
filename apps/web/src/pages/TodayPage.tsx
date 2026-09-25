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
import { addCalendarDays, planningDate } from "@suite/domain";
import {
  dayMembersKey,
  useDayOrders,
  type DayOrderApi,
} from "../day-order.tsx";
import { PlanTomorrowPanel } from "../plan-tomorrow.tsx";
import { NoteMarkdown } from "../components/notes/NoteMarkdown.tsx";
import { useApplicationPreferences } from "../application-preferences.tsx";

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
  /** ADR 0027: enables saved day order and plan-tomorrow writes. */
  readonly csrfToken?: string | undefined;
  readonly online?: boolean | undefined;
  /** Called after tasks were planned so the task list can refresh. */
  readonly onTasksPlanned?: (() => void) | undefined;
  readonly dayOrderApi?: DayOrderApi | undefined;
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
  // ADR 0030: the owner's daily summary note text.
  const { dailySummaryNote } = useApplicationPreferences().snapshot.preferences;
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
    csrfToken,
    online = false,
    onTasksPlanned,
    dayOrderApi,
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
  // ADR 0027: today is the owner's planning date, which may start after
  // local midnight.
  const today = planningDate(
    logicalAt,
    preferences?.timeZone ?? "UTC",
    preferences?.dayStartsAt,
  );
  const tomorrow = addCalendarDays(today, 1);
  const dayOrders = useDayOrders({
    from: today,
    to: tomorrow,
    csrfToken,
    online: online && preferences !== undefined,
    api: dayOrderApi,
    membersKey: dayMembersKey(tasks, [today, tomorrow]),
  });
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
      {dailySummaryNote.trim() !== "" && (
        <Card aria-labelledby="daily-summary-note-title">
          <CardHeader>
            <SectionHeading
              as="h3"
              id="daily-summary-note-title"
              title="Daily note"
            />
          </CardHeader>
          <CardContent>
            <NoteMarkdown content={dailySummaryNote} />
          </CardContent>
        </Card>
      )}
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
        plannedTodayOrder={dayOrders.orders.get(today)?.taskIds}
        onMovePlanned={
          dayOrders.enabled
            ? (taskId, direction) =>
                void dayOrders.move(today, taskId, direction)
            : undefined
        }
      />
      {dayOrders.message !== null ? (
        <p className="message" role="status">
          {dayOrders.message}
        </p>
      ) : null}
      {preferences === undefined ? null : (
        <PlanTomorrowPanel
          date={tomorrow}
          today={today}
          tasks={tasks}
          order={dayOrders.orders.get(tomorrow)}
          available={dayOrders.enabled}
          busy={busy || dayOrders.pending}
          onPlan={async (selected) => {
            const saved = await dayOrders.plan(tomorrow, selected);
            if (saved) onTasksPlanned?.();
            return saved;
          }}
          onMove={(taskId, direction) =>
            void dayOrders.move(tomorrow, taskId, direction)
          }
        />
      )}
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
