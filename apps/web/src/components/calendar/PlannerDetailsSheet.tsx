import type {
  BaikalStatusResponse,
  CalendarEventProjection,
  Task,
} from "@suite/contracts";
import { useEffect, useState, type SyntheticEvent } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { TimeBlockForm } from "@/time-block-form";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";

export type PlannerDetailsSelection =
  | { readonly kind: "event"; readonly event: CalendarEventProjection }
  | { readonly kind: "task"; readonly task: Task };

interface PlannerDetailsSheetProps {
  readonly selection: PlannerDetailsSelection | null;
  readonly tasks: readonly Task[];
  readonly events: readonly CalendarEventProjection[];
  readonly busy: boolean;
  readonly timeZone: string;
  readonly error: string | null;
  readonly opener: HTMLElement | null;
  readonly onOpenChange: (open: boolean) => void;
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
  ) => Promise<boolean>;
  readonly onRemoveTimeBlock: (task: Task) => Promise<boolean>;
}

export const eventTask = (
  selection: PlannerDetailsSelection,
  tasks: readonly Task[],
): Task | undefined =>
  tasks.find(
    (task) =>
      task.id ===
      (selection.kind === "task"
        ? selection.task.id
        : selection.event.linkedTaskId),
  );

export const localDateTimeValue = (value: string, timeZone: string): string => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(value));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}`;
};

export const displayEventTime = (
  value: string,
  allDay: boolean,
  timeZone: string,
): string =>
  allDay
    ? value.slice(0, 10)
    : new Intl.DateTimeFormat("en-US", {
        timeZone,
        weekday: "short",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      }).format(new Date(value));

export function PlannerDetailsSheet({
  selection,
  tasks,
  events,
  busy,
  timeZone,
  error,
  opener,
  onOpenChange,
  onChangeTaskStatus,
  onSubmitTaskEdit,
  calendars,
  onSubmitTimeBlock,
  onRemoveTimeBlock,
}: PlannerDetailsSheetProps) {
  const [actionError, setActionError] = useState<string | null>(null);
  const task = selection === null ? undefined : eventTask(selection, tasks);
  const event =
    selection?.kind === "event"
      ? events.find(
          (candidate) =>
            candidate.identity.providerId ===
              selection.event.identity.providerId &&
            candidate.identity.calendarId ===
              selection.event.identity.calendarId &&
            candidate.href === selection.event.href,
        )
      : undefined;
  const selectionKey =
    selection?.kind === "task"
      ? `task:${selection.task.id}`
      : selection === null
        ? "closed"
        : `event:${selection.event.identity.providerId}:${selection.event.identity.calendarId}:${selection.event.href}`;
  useEffect(() => setActionError(null), [selectionKey]);
  useEffect(() => {
    if (selection?.kind === "event" && event === undefined) onOpenChange(false);
  }, [event, onOpenChange, selection]);
  const title = task?.title ?? event?.summary ?? "Planner details";
  const description =
    event === undefined
      ? "Suite task"
      : `${event.source.providerDisplayLabel} · ${event.source.calendarName}`;
  const deviceTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const blockDefaults =
    event === undefined
      ? {}
      : {
          defaultCalendarId: event.identity.calendarId,
          defaultStartsAt: localDateTimeValue(event.startsAt, deviceTimeZone),
          defaultDurationMinutes: Math.round(
            (new Date(event.endsAt).getTime() -
              new Date(event.startsAt).getTime()) /
              60_000,
          ),
        };

  return (
    <Sheet open={selection !== null} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full max-w-md overflow-y-auto"
        onCloseAutoFocus={(closeEvent) => {
          closeEvent.preventDefault();
          if (opener?.isConnected) opener.focus();
          else
            document
              .querySelector<HTMLElement>('[aria-label="Previous period"]')
              ?.focus();
        }}
      >
        <SheetHeader>
          <SheetTitle>{title}</SheetTitle>
          <SheetDescription>{description}</SheetDescription>
        </SheetHeader>
        <div className="grid gap-4 px-4 pb-4">
          {error !== null && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          {actionError !== null && (
            <Alert variant="destructive">
              <AlertDescription>{actionError}</AlertDescription>
            </Alert>
          )}
          {event !== undefined && (
            <dl className="grid gap-2 text-sm">
              <div>
                <dt className="text-subtext-2">Starts</dt>
                <dd>
                  {displayEventTime(event.startsAt, event.allDay, timeZone)}
                </dd>
              </div>
              <div>
                <dt className="text-subtext-2">Ends</dt>
                <dd>
                  {displayEventTime(event.endsAt, event.allDay, timeZone)}
                </dd>
              </div>
            </dl>
          )}
          {task === undefined ? (
            <p className="text-sm text-subtext">
              This provider calendar event is read-only in Productivity Suite.
            </p>
          ) : (
            <>
              <form
                key={`edit:${selectionKey}`}
                className="grid gap-3"
                onSubmit={(formEvent) =>
                  void (async () => {
                    setActionError(null);
                    if (!(await onSubmitTaskEdit(formEvent, task)))
                      setActionError(
                        "Task changes could not be saved. Try again.",
                      );
                  })()
                }
              >
                <label className="grid gap-1 text-sm">
                  Title
                  <Input name="title" defaultValue={task.title} required />
                </label>
                <label className="grid gap-1 text-sm">
                  Notes
                  <Input name="notes" defaultValue={task.notes} />
                </label>
                <label className="grid gap-1 text-sm">
                  Estimate minutes
                  <Input
                    name="estimateMinutes"
                    type="number"
                    min="1"
                    max="720"
                    defaultValue={task.estimateMinutes ?? ""}
                  />
                </label>
                <input
                  type="hidden"
                  name="deadlineKind"
                  value={task.deadline?.kind ?? "none"}
                />
                {task.deadline !== null && task.deadline !== undefined ? (
                  <input
                    type="hidden"
                    name="deadlineValue"
                    value={task.deadline.value.replace(/Z$/, "")}
                  />
                ) : null}
                <Button disabled={busy}>Save task</Button>
              </form>
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void (async () => {
                    setActionError(null);
                    if (
                      !(await onChangeTaskStatus(
                        task,
                        task.status === "completed" ? "reopen" : "complete",
                      ))
                    )
                      setActionError(
                        "Task status could not be updated. Try again.",
                      );
                  })()
                }
              >
                {task.status === "completed" ? "Reopen task" : "Complete task"}
              </Button>
              <TimeBlockForm
                key={`block:${selectionKey}`}
                task={task}
                calendars={calendars}
                busy={busy}
                available
                startLabel="Start (device time)"
                {...blockDefaults}
                onSubmit={async (formEvent, scheduledTask) => {
                  setActionError(null);
                  if (!(await onSubmitTimeBlock(formEvent, scheduledTask)))
                    setActionError(
                      "Calendar block could not be saved. Try again.",
                    );
                }}
                onRemove={async (scheduledTask) => {
                  setActionError(null);
                  if (!(await onRemoveTimeBlock(scheduledTask)))
                    setActionError(
                      "Calendar block could not be removed. Try again.",
                    );
                }}
              />
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
