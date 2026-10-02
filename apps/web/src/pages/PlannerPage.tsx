import { useEffect, useMemo, useState, type SyntheticEvent } from "react";
import type {
  BaikalStatusResponse,
  PlannerResponse,
  SavedDayOrder,
  Task,
} from "@suite/contracts";
import {
  AlertCircleIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  LoaderCircleIcon,
} from "lucide-react";
import {
  buildCalendarRange,
  shiftCalendarAnchor,
  type CalendarRange,
  type CalendarView,
} from "../components/calendar/calendar-range.ts";
import {
  PlannerTimeGrid,
  plannerCalendarDays,
} from "../components/calendar/PlannerTimeGrid.tsx";
import {
  DayOrderList,
  orderedDayTasks,
  useDayOrders,
  type DayOrderActions,
} from "../day-order.tsx";
import {
  PlannerDetailsSheet,
  type PlannerDetailsSelection,
} from "../components/calendar/PlannerDetailsSheet.tsx";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "../components/ui/alert.tsx";
import { Badge } from "../components/ui/badge.tsx";
import { Button } from "../components/ui/button.tsx";
import { Card, CardContent, CardHeader } from "../components/ui/card.tsx";
import { PageHeader } from "../components/ui/page-header.tsx";
import { Tabs, TabsList, TabsTrigger } from "../components/ui/tabs.tsx";
import { useLiveRevision } from "../live-sync/views.ts";

interface PlannerPageProps {
  readonly planner: PlannerResponse | null;
  readonly timeZone: string;
  readonly busy: boolean;
  readonly loading?: boolean;
  readonly error?: string | null;
  readonly onLoadPlanner: (range: CalendarRange) => Promise<void>;
  readonly tasks: readonly Task[];
  readonly onChangeTaskStatus: (
    task: Task,
    action: "complete" | "reopen",
  ) => Promise<boolean>;
  readonly onSubmitTaskEdit: (
    event: SyntheticEvent<HTMLFormElement, SubmitEvent>,
    task: Task,
  ) => Promise<boolean>;
  readonly calendars: BaikalStatusResponse["calendars"];
  readonly onSubmitTimeBlock: (
    event: SyntheticEvent<HTMLFormElement, SubmitEvent>,
    task: Task,
    window: CalendarRange,
  ) => Promise<boolean>;
  readonly onRemoveTimeBlock: (
    task: Task,
    window: CalendarRange,
  ) => Promise<boolean>;
  /**
   * ADR 0050: saved day orders from the offline cache and the queued
   * reorder. Both work without a connection.
   */
  readonly dayOrders?: readonly SavedDayOrder[] | undefined;
  readonly dayOrderActions?: DayOrderActions | undefined;
}

const calendarViewLabel: Readonly<Record<CalendarView, string>> = {
  day: "Day",
  "3day": "3 days",
  week: "Week",
};

const displayTime = (value: string, timeZone: string): string =>
  new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));

export const PlannerPage = ({
  planner,
  timeZone,
  busy,
  loading = false,
  error = null,
  onLoadPlanner,
  tasks,
  onChangeTaskStatus,
  onSubmitTaskEdit,
  calendars,
  onSubmitTimeBlock,
  onRemoveTimeBlock,
  dayOrders: savedDayOrders,
  dayOrderActions,
}: PlannerPageProps) => {
  const [view, setView] = useState<CalendarView>("week");
  const [anchor, setAnchor] = useState(() => new Date());
  const [selection, setSelection] = useState<PlannerDetailsSelection | null>(
    null,
  );
  const [opener, setOpener] = useState<HTMLElement | null>(null);
  const range = useMemo(
    () => buildCalendarRange(view, anchor, timeZone),
    [anchor, timeZone, view],
  );
  const matchesRange =
    planner !== null &&
    planner.window.from === range.from &&
    planner.window.to === range.to;
  const dayKeys = useMemo(
    () => plannerCalendarDays(range, view, timeZone).map(({ key }) => key),
    [range, view, timeZone],
  );
  const dayOrders = useDayOrders({
    tasks,
    saved: savedDayOrders,
    actions: dayOrderActions,
  });
  const orderedDays = dayKeys
    .map((date) => ({
      date,
      items: orderedDayTasks(tasks, date, dayOrders.orders.get(date)),
    }))
    .filter(({ items }) => items.length > 1);

  // ADR 0045: the open range loads again when calendar data changes
  // on another device.
  const livePlanner = useLiveRevision("planner");
  useEffect(() => {
    void onLoadPlanner(range);
  }, [onLoadPlanner, range, livePlanner]);

  return (
    <div className="today-page">
      <PageHeader
        eyebrow="Calendar context"
        title="Planner"
        description="Place projected calendar events and Suite tasks on a real time grid."
        actions={
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setAnchor(new Date())}
            disabled={busy}
          >
            Today
          </Button>
        }
      />
      <Card aria-label="Planner controls and calendar">
        <CardHeader className="gap-3 border-b">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-1">
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Previous period"
                onClick={() =>
                  setAnchor((current) =>
                    shiftCalendarAnchor(view, current, -1, timeZone),
                  )
                }
                disabled={busy}
              >
                <ChevronLeftIcon />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Next period"
                onClick={() =>
                  setAnchor((current) =>
                    shiftCalendarAnchor(view, current, 1, timeZone),
                  )
                }
                disabled={busy}
              >
                <ChevronRightIcon />
              </Button>
              <p className="ml-1 text-sm font-medium text-foreground">
                {displayTime(range.from, timeZone)} —{" "}
                {displayTime(range.to, timeZone)}
              </p>
            </div>
            <Tabs
              value={view}
              onValueChange={(value) => setView(value as CalendarView)}
            >
              <TabsList aria-label="Calendar view">
                {(
                  Object.keys(calendarViewLabel) as readonly CalendarView[]
                ).map((value) => (
                  <TabsTrigger key={value} value={value}>
                    {calendarViewLabel[value]}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
          </div>
        </CardHeader>
        <CardContent className="grid gap-3 pt-4">
          {loading && (
            <p
              className="flex items-center gap-2 text-sm text-subtext"
              role="status"
            >
              <LoaderCircleIcon
                className="size-4 animate-spin"
                aria-hidden="true"
              />
              Loading the selected period…
            </p>
          )}
          {error !== null && (
            <Alert variant="warning">
              <AlertCircleIcon />
              <AlertTitle>Could not refresh this period</AlertTitle>
              <AlertDescription>
                <p>
                  {error}.{" "}
                  {matchesRange
                    ? "Showing saved data for this period."
                    : "The previous period is hidden."}
                </p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={loading}
                  onClick={() => void onLoadPlanner(range)}
                >
                  Retry
                </Button>
              </AlertDescription>
            </Alert>
          )}
          {planner === null || !matchesRange ? (
            <p className="text-sm text-subtext">
              {error === null
                ? "Waiting for calendar context for this period…"
                : "No current data for the selected period."}
            </p>
          ) : (
            <>
              <Badge
                className="w-fit"
                variant={
                  planner.freshness.state === "fresh"
                    ? "success"
                    : planner.freshness.state === "stale"
                      ? "warning"
                      : "secondary"
                }
              >
                {planner.freshness.message}
              </Badge>
              <PlannerTimeGrid
                view={view}
                range={range}
                timeZone={timeZone}
                events={planner.events}
                tasks={planner.tasks}
                dayOrders={
                  new Map(
                    [...dayOrders.orders].map(([date, order]) => [
                      date,
                      order.taskIds,
                    ]),
                  )
                }
                onSelectEntry={(entry) => {
                  setOpener(
                    document.activeElement instanceof HTMLElement
                      ? document.activeElement
                      : null,
                  );
                  setSelection(entry);
                }}
              />
            </>
          )}
        </CardContent>
      </Card>
      {orderedDays.length > 0 ? (
        <Card aria-labelledby="planner-day-order-title">
          <CardHeader>
            <h2 id="planner-day-order-title" className="text-base font-medium">
              Day order
            </h2>
          </CardHeader>
          <CardContent className="grid gap-3">
            {!dayOrders.enabled ? (
              <p className="hint">
                The order of a day can be changed once this device has synced.
              </p>
            ) : null}
            {dayOrders.message !== null ? (
              <p className="message" role="status">
                {dayOrders.message}
              </p>
            ) : null}
            {orderedDays.map(({ date, items }) => (
              <section key={date} aria-label={`Order for ${date}`}>
                <h3 className="text-sm font-medium">{date}</h3>
                <DayOrderList
                  label={`Tasks planned for ${date}`}
                  items={items}
                  available={dayOrders.enabled}
                  busy={busy || dayOrders.pending}
                  onMove={(taskId, direction) =>
                    void dayOrders.move(date, taskId, direction)
                  }
                />
              </section>
            ))}
          </CardContent>
        </Card>
      ) : null}
      <PlannerDetailsSheet
        selection={selection}
        tasks={tasks}
        events={planner?.events ?? []}
        busy={busy}
        timeZone={timeZone}
        error={null}
        opener={opener}
        onOpenChange={(open) => {
          if (!open) {
            setSelection(null);
          }
        }}
        onChangeTaskStatus={onChangeTaskStatus}
        onSubmitTaskEdit={onSubmitTaskEdit}
        calendars={calendars}
        onSubmitTimeBlock={(event, task) =>
          onSubmitTimeBlock(event, task, range)
        }
        onRemoveTimeBlock={(task) => onRemoveTimeBlock(task, range)}
      />
    </div>
  );
};
