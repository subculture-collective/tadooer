import { useState, type SyntheticEvent } from "react";
import type {
  Project,
  RecurringSeries,
  RecurringSeriesCreateRequest,
  RecurringSeriesMutationResponse,
  Tag,
  Task,
} from "@suite/contracts";
import {
  changeRecurrenceOccurrence,
  createRecurringSeries,
  getRecurringSeries,
  patchRecurringSeries,
  setRecurringSeriesState,
} from "../../api.ts";
import { Badge } from "../ui/badge.tsx";
import { Button } from "../ui/button.tsx";
import { Checkbox } from "../ui/checkbox.tsx";
import { Input } from "../ui/input.tsx";
import { NativeSelect } from "../ui/native-select.tsx";
import { Textarea } from "../ui/textarea.tsx";

// Recurring series in the browser (issue #42, ADR 0023). Series writes are
// online-only; instances arrive through sync as ordinary tasks.

const weekdayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const weekOrdinals: Readonly<Record<string, string>> = {
  "1": "first",
  "2": "second",
  "3": "third",
  "4": "fourth",
  "-1": "last",
};

/** A short sentence such as "Every 2 weeks on Mon, Thu at 09:00". */
export const describeRecurrence = (
  series: Pick<RecurringSeries, "rule" | "startTime" | "anchor">,
): string => {
  const { rule } = series;
  const unit = {
    daily: "day",
    weekly: "week",
    monthly: "month",
    yearly: "year",
  }[rule.cycle];
  let text =
    rule.interval === 1
      ? `Every ${unit}`
      : `Every ${String(rule.interval)} ${unit}s`;
  if (rule.cycle === "weekly")
    text += ` on ${rule.weekdays.map((day) => weekdayNames[day]).join(", ")}`;
  if (rule.cycle === "monthly")
    text +=
      rule.monthly.kind === "last_day"
        ? " on the last day"
        : rule.monthly.kind === "nth_weekday"
          ? ` on the ${weekOrdinals[String(rule.monthly.week)] ?? ""} ${weekdayNames[rule.monthly.weekday] ?? ""}`
          : " on the start date's day";
  if (series.startTime !== null) text += ` at ${series.startTime}`;
  if (series.anchor === "completion") text += ", counted from completion";
  return text;
};

const text = (data: FormData, name: string): string => {
  const value = data.get(name);
  return typeof value === "string" ? value.trim() : "";
};

/** Rule and option fields from a recurrence form, in contract form. */
export const recurrenceFormPayload = (
  data: FormData,
): Omit<
  RecurringSeriesCreateRequest,
  "title" | "notes" | "projectId" | "tagIds" | "estimateMinutes"
> => {
  const cycle = text(data, "cycle") as
    "daily" | "weekly" | "monthly" | "yearly";
  const interval = Number(text(data, "interval") || "1");
  const monthlyKind = text(data, "monthly");
  const rule =
    cycle === "weekly"
      ? {
          cycle,
          interval,
          weekdays: data
            .getAll("weekdays")
            .map(Number)
            .toSorted((left, right) => left - right),
        }
      : cycle === "monthly"
        ? {
            cycle,
            interval,
            monthly:
              monthlyKind === "nth_weekday"
                ? {
                    kind: "nth_weekday" as const,
                    week: Number(text(data, "week")) as 1 | 2 | 3 | 4 | -1,
                    weekday: Number(text(data, "weekday")),
                  }
                : monthlyKind === "last_day"
                  ? { kind: "last_day" as const }
                  : { kind: "day_of_month" as const },
          }
        : {
            cycle:
              cycle === "yearly" ? ("yearly" as const) : ("daily" as const),
            interval,
          };
  const startTime = text(data, "startTime") || null;
  const reminder = text(data, "startReminder");
  return {
    rule,
    startDate: text(data, "startDate"),
    endDate: text(data, "endDate") || null,
    startTime,
    startReminder:
      startTime === null || reminder === "" || reminder === "default"
        ? { kind: "default" }
        : reminder === "none"
          ? { kind: "none" }
          : {
              kind: "before_start",
              minutes: Number(reminder) as 0 | 5 | 10 | 15 | 30 | 60,
            },
    anchor: text(data, "anchor") === "completion" ? "completion" : "schedule",
    waitForCompletion: data.get("waitForCompletion") === "on",
    missedOccurrences: text(data, "missed") === "skip" ? "skip" : "latest",
    childTemplates: text(data, "childTemplates")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "")
      .map((title) => ({ title, notes: "", estimateMinutes: null })),
  };
};

/** Uncontrolled rule and option fields, prefilled from a series. */
export const RecurrenceRuleFields = ({
  series,
  startDate,
  disabled,
}: {
  readonly series?: RecurringSeries;
  readonly startDate: string;
  readonly disabled: boolean;
}) => {
  const rule = series?.rule;
  const monthly = rule?.cycle === "monthly" ? rule.monthly : undefined;
  return (
    <>
      <label className="field">
        <span>Repeats</span>
        <NativeSelect
          name="cycle"
          defaultValue={rule?.cycle ?? "daily"}
          disabled={disabled}
        >
          <option value="daily">Daily</option>
          <option value="weekly">Weekly</option>
          <option value="monthly">Monthly</option>
          <option value="yearly">Yearly</option>
        </NativeSelect>
      </label>
      <label className="field">
        <span>Every</span>
        <Input
          name="interval"
          type="number"
          min="1"
          max="366"
          defaultValue={rule?.interval ?? 1}
          disabled={disabled}
        />
      </label>
      <fieldset disabled={disabled}>
        <legend>Weekdays (weekly)</legend>
        {weekdayNames.map((name, day) => (
          <label key={name}>
            <Checkbox
              name="weekdays"
              value={String(day)}
              defaultChecked={
                rule?.cycle === "weekly" && rule.weekdays.includes(day)
              }
            />
            {name}
          </label>
        ))}
      </fieldset>
      <label className="field">
        <span>Monthly on</span>
        <NativeSelect
          name="monthly"
          defaultValue={monthly?.kind ?? "day_of_month"}
          disabled={disabled}
        >
          <option value="day_of_month">The start date's day</option>
          <option value="last_day">The last day</option>
          <option value="nth_weekday">A weekday of the month</option>
        </NativeSelect>
      </label>
      <label className="field">
        <span>Week of month</span>
        <NativeSelect
          name="week"
          defaultValue={
            monthly?.kind === "nth_weekday" ? String(monthly.week) : "1"
          }
          disabled={disabled}
        >
          {Object.entries(weekOrdinals).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </NativeSelect>
      </label>
      <label className="field">
        <span>Weekday</span>
        <NativeSelect
          name="weekday"
          defaultValue={
            monthly?.kind === "nth_weekday" ? String(monthly.weekday) : "1"
          }
          disabled={disabled}
        >
          {weekdayNames.map((name, day) => (
            <option key={name} value={String(day)}>
              {name}
            </option>
          ))}
        </NativeSelect>
      </label>
      <label className="field">
        <span>Starts</span>
        <Input
          name="startDate"
          type="date"
          required
          defaultValue={series?.startDate ?? startDate}
          disabled={disabled}
        />
      </label>
      <label className="field">
        <span>Ends (optional)</span>
        <Input
          name="endDate"
          type="date"
          defaultValue={series?.endDate ?? ""}
          disabled={disabled}
        />
      </label>
      <label className="field">
        <span>Start time (optional)</span>
        <Input
          name="startTime"
          type="time"
          defaultValue={series?.startTime ?? ""}
          disabled={disabled}
        />
      </label>
      <label className="field">
        <span>Start reminder</span>
        <NativeSelect
          name="startReminder"
          defaultValue={
            series?.startReminder.kind === "before_start"
              ? String(series.startReminder.minutes)
              : (series?.startReminder.kind ?? "default")
          }
          disabled={disabled}
        >
          <option value="default">Notification preferences</option>
          <option value="none">No reminder</option>
          <option value="0">At start</option>
          {[5, 10, 15, 30, 60].map((minutes) => (
            <option key={minutes} value={String(minutes)}>
              {minutes} minutes before
            </option>
          ))}
        </NativeSelect>
      </label>
      <label className="field">
        <span>Count the pattern from</span>
        <NativeSelect
          name="anchor"
          defaultValue={series?.anchor ?? "schedule"}
          disabled={disabled}
        >
          <option value="schedule">The start date</option>
          <option value="completion">The latest completion</option>
        </NativeSelect>
      </label>
      <label className="field">
        <span>Missed while offline</span>
        <NativeSelect
          name="missed"
          defaultValue={series?.missedOccurrences ?? "latest"}
          disabled={disabled}
        >
          <option value="latest">Create the most recent one</option>
          <option value="skip">Skip them</option>
        </NativeSelect>
      </label>
      <label>
        <Checkbox
          name="waitForCompletion"
          defaultChecked={series?.waitForCompletion === true}
          disabled={disabled}
        />
        Wait until the previous instance is done
      </label>
      <label className="field">
        <span>Child tasks, one per line</span>
        <Textarea
          name="childTemplates"
          rows={2}
          defaultValue={
            series?.childTemplates.map(({ title }) => title).join("\n") ?? ""
          }
          disabled={disabled}
        />
      </label>
    </>
  );
};

export interface RecurringSeriesViewProps {
  readonly series: readonly RecurringSeries[];
  readonly projects: readonly Project[];
  readonly busy: boolean;
  readonly online: boolean;
  readonly today: string;
  readonly onState: (
    series: RecurringSeries,
    action: "pause" | "resume" | "end",
  ) => void;
  readonly onOccurrence: (
    series: RecurringSeries,
    date: string,
    action: "skip" | "unskip",
  ) => void;
  readonly onEdit: (
    series: RecurringSeries,
    event: SyntheticEvent<HTMLFormElement, SubmitEvent>,
  ) => void;
}

/** Presentational list of series with their upcoming dates and actions. */
export const RecurringSeriesView = ({
  series,
  projects,
  busy,
  online,
  today,
  onState,
  onOccurrence,
  onEdit,
}: RecurringSeriesViewProps) => {
  const disabled = busy || !online;
  if (series.length === 0)
    return <p className="muted">No recurring series yet.</p>;
  return (
    <ul className="recurring-series">
      {series.map((item) => (
        <li key={item.id}>
          <p>
            <strong>{item.title}</strong>{" "}
            <Badge variant={item.state === "active" ? "secondary" : "outline"}>
              {item.state === "active"
                ? "Active"
                : item.state === "paused"
                  ? "Paused"
                  : "Ended"}
            </Badge>
            {item.source === "super_productivity" && (
              <Badge variant="outline">Imported</Badge>
            )}
          </p>
          <p className="muted">
            {describeRecurrence(item)} · {item.instanceCount} instance
            {item.instanceCount === 1 ? "" : "s"}
            {item.waitForCompletion ? " · waits for completion" : ""}
            {item.missedOccurrences === "skip" ? " · skips missed dates" : ""}
          </p>
          {item.upcoming.length > 0 && (
            <ul aria-label={`Upcoming dates for ${item.title}`}>
              {item.upcoming.map(({ date, skipped }) => (
                <li key={date}>
                  {date}
                  {skipped ? " (skipped)" : ""}{" "}
                  <Button
                    type="button"
                    variant="outline"
                    disabled={disabled || item.state === "ended"}
                    onClick={() => {
                      onOccurrence(item, date, skipped ? "unskip" : "skip");
                    }}
                  >
                    {skipped ? `Restore ${date}` : `Skip ${date}`}
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {item.state !== "ended" && (
            <div className="task-actions">
              <Button
                type="button"
                disabled={disabled}
                onClick={() => {
                  onState(item, item.state === "active" ? "pause" : "resume");
                }}
              >
                {item.state === "active" ? "Pause" : "Resume"}
              </Button>
              <Button
                type="button"
                variant="destructive"
                disabled={disabled}
                onClick={() => {
                  onState(item, "end");
                }}
              >
                End series
              </Button>
            </div>
          )}
          {item.state !== "ended" && (
            <details>
              <summary>Edit “{item.title}”</summary>
              <form
                className="task-edit"
                onSubmit={(event) => {
                  onEdit(item, event);
                }}
              >
                <label className="field">
                  <span>Title</span>
                  <Input
                    name="title"
                    required
                    defaultValue={item.title}
                    disabled={disabled}
                  />
                </label>
                <label className="field">
                  <span>Notes</span>
                  <Textarea
                    name="notes"
                    rows={2}
                    defaultValue={item.notes}
                    disabled={disabled}
                  />
                </label>
                <label className="field">
                  <span>Estimate minutes</span>
                  <Input
                    name="estimateMinutes"
                    type="number"
                    min="1"
                    max="720"
                    defaultValue={item.estimateMinutes ?? ""}
                    disabled={disabled}
                  />
                </label>
                <label className="field">
                  <span>Project</span>
                  <NativeSelect
                    name="projectId"
                    defaultValue={item.projectId ?? ""}
                    disabled={disabled}
                  >
                    <option value="">No project</option>
                    {projects
                      .filter(
                        (project) =>
                          project.archivedAt === null ||
                          project.id === item.projectId,
                      )
                      .map((project) => (
                        <option key={project.id} value={project.id}>
                          {project.title}
                        </option>
                      ))}
                  </NativeSelect>
                </label>
                <RecurrenceRuleFields
                  series={item}
                  startDate={today}
                  disabled={disabled}
                />
                <p className="muted">
                  Title, notes, estimate, project and tag changes also update
                  open instances that still have the old value. Schedule changes
                  apply from today.
                </p>
                <Button disabled={disabled}>Save series</Button>
              </form>
            </details>
          )}
        </li>
      ))}
    </ul>
  );
};

const failure = (error: unknown): string =>
  error instanceof Error ? error.message : "The change could not be saved";

const estimateFrom = (data: FormData): number | null => {
  const value = text(data, "estimateMinutes");
  return value === "" ? null : Number(value);
};

/**
 * Loads series when opened. Every write sends the series revision and
 * replaces the list entry with the server's copy.
 */
export const RecurringSeriesManager = ({
  csrfToken,
  online,
  projects,
  today,
}: {
  readonly csrfToken: string;
  readonly online: boolean;
  readonly projects: readonly Project[];
  readonly today: string;
}) => {
  const [series, setSeries] = useState<readonly RecurringSeries[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (work: () => Promise<RecurringSeriesMutationResponse>) => {
    setBusy(true);
    setError(null);
    try {
      const { series: changed } = await work();
      setSeries((current) =>
        (current ?? []).map((item) =>
          item.id === changed.id ? changed : item,
        ),
      );
    } catch (cause: unknown) {
      setError(failure(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <details
      className="recurring-series-manager"
      onToggle={(event) => {
        if (event.currentTarget.open && series === null && online)
          void getRecurringSeries()
            .then((response) => {
              setSeries(response.series);
            })
            .catch((cause: unknown) => {
              setError(failure(cause));
            });
      }}
    >
      <summary>Recurring series</summary>
      {error !== null && <p role="alert">{error}</p>}
      {series === null ? (
        <p className="muted">
          {online ? "Loading…" : "Recurring series need a connection."}
        </p>
      ) : (
        <RecurringSeriesView
          series={series}
          projects={projects}
          busy={busy}
          online={online}
          today={today}
          onState={(item, action) =>
            void run(() =>
              setRecurringSeriesState(
                item.id,
                item.revision,
                action,
                csrfToken,
              ),
            )
          }
          onOccurrence={(item, date, action) =>
            void run(() =>
              changeRecurrenceOccurrence(
                item.id,
                item.revision,
                date,
                action,
                csrfToken,
              ),
            )
          }
          onEdit={(item, event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            const payload = recurrenceFormPayload(data);
            void run(() =>
              patchRecurringSeries(
                item.id,
                item.revision,
                {
                  title: text(data, "title"),
                  notes: text(data, "notes"),
                  estimateMinutes: estimateFrom(data),
                  projectId: text(data, "projectId") || null,
                  ...payload,
                  // Lines that keep a template's title keep its notes and estimate.
                  childTemplates: (payload.childTemplates ?? []).map(
                    (template) =>
                      item.childTemplates.find(
                        ({ title }) => title === template.title,
                      ) ?? {
                        title: template.title,
                        notes: template.notes ?? "",
                        estimateMinutes: template.estimateMinutes ?? null,
                      },
                  ),
                },
                csrfToken,
              ),
            );
          }}
        />
      )}
    </details>
  );
};

/**
 * Per-task recurrence: an instance shows its occurrence and can be deleted
 * for good; a top-level task can start a series as its first occurrence.
 */
export const TaskRecurrencePanel = ({
  task,
  csrfToken,
  online,
  today,
  tags,
}: {
  readonly task: Task;
  readonly csrfToken: string;
  readonly online: boolean;
  readonly today: string;
  readonly tags: readonly Tag[];
}) => {
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const disabled = busy || !online;
  const run = async (work: () => Promise<string>) => {
    setBusy(true);
    setMessage(null);
    try {
      setMessage(await work());
    } catch (cause: unknown) {
      setMessage(failure(cause));
    } finally {
      setBusy(false);
    }
  };
  const recurrence = task.recurrence ?? null;
  if (recurrence !== null)
    return (
      <div className="task-recurrence">
        <p className="muted">
          Recurring instance for {recurrence.occurrenceDate}.
        </p>
        <Button
          type="button"
          variant="outline"
          disabled={disabled}
          title="Delete this instance; the series never recreates this date"
          onClick={() =>
            void run(async () => {
              const series = (await getRecurringSeries()).series.find(
                ({ id }) => id === recurrence.seriesId,
              );
              if (series === undefined) return "The series no longer exists.";
              await changeRecurrenceOccurrence(
                series.id,
                series.revision,
                recurrence.occurrenceDate,
                "delete_instance",
                csrfToken,
              );
              return "Deleted this occurrence.";
            })
          }
        >
          Delete this occurrence
        </Button>
        {message !== null && <p role="status">{message}</p>}
      </div>
    );
  if (task.parentId != null) return null;
  return (
    <details className="task-recurrence">
      <summary>Repeat this task</summary>
      <form
        className="task-edit"
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          void run(async () => {
            const result = await createRecurringSeries(
              {
                title: task.title,
                notes: task.notes,
                projectId: task.projectId ?? null,
                tagIds: (task.tagIds ?? []).filter((id) =>
                  tags.some((tag) => tag.id === id && tag.archivedAt === null),
                ),
                estimateMinutes: task.estimateMinutes ?? null,
                sourceTaskId: task.id,
                ...recurrenceFormPayload(data),
              },
              csrfToken,
            );
            return `Repeats ${describeRecurrence(result.series).toLowerCase()}. This task is the ${result.series.cursorDate ?? ""} occurrence.`;
          });
        }}
      >
        <RecurrenceRuleFields startDate={today} disabled={disabled} />
        <Button disabled={disabled}>Start repeating</Button>
        {!online && (
          <p className="muted">Recurring series need a connection.</p>
        )}
      </form>
      {message !== null && <p role="status">{message}</p>}
    </details>
  );
};
