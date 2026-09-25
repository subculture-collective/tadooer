import { useEffect, useState, type SyntheticEvent } from "react";
import type { TimeEntry, TimeReport } from "@suite/contracts";
import {
  formatClockDuration,
  worklogCsv,
  zonedCalendarDate,
} from "@suite/domain";
import {
  createTimeEntry,
  deleteTimeEntry,
  getTimeReport,
  updateTimeEntry,
} from "../api.ts";
import { Alert, AlertDescription } from "../components/ui/alert.tsx";
import { Badge } from "../components/ui/badge.tsx";
import { Button } from "../components/ui/button.tsx";
import { Card, CardContent, CardHeader } from "../components/ui/card.tsx";
import { EmptyState } from "../components/ui/empty-state.tsx";
import { Input } from "../components/ui/input.tsx";
import {
  NativeSelect,
  NativeSelectOption,
} from "../components/ui/native-select.tsx";
import { PageHeader } from "../components/ui/page-header.tsx";
import {
  addTimeEntry,
  canEditEntry,
  editTimeEntry,
  initialWorklog,
  loadWorklog,
  minutesToMilliseconds,
  periodRange,
  removeTimeEntry,
  shiftPeriod,
  worklogFileName,
  worklogRows,
  type WorklogApi,
  type WorklogPeriod,
  type WorklogState,
} from "./worklog-controller.ts";

const defaultApi: WorklogApi = {
  getTimeReport,
  createTimeEntry,
  updateTimeEntry,
  deleteTimeEntry,
};

const sourceLabel: Readonly<Record<TimeEntry["source"], string>> = {
  focus: "Focus",
  import: "Imported",
  manual: "Manual",
};

const clockTime = (value: string | null, timeZone: string) =>
  value === null
    ? null
    : new Intl.DateTimeFormat("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
        timeZone,
      }).format(new Date(value));

const dayLabel = (date: string) =>
  new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${date}T00:00:00.000Z`));

const estimate = (minutes: number | null) =>
  minutes === null ? "—" : formatClockDuration(minutes * 60_000);

interface Editing {
  readonly id: string;
  readonly minutes: string;
  readonly workDate: string;
  readonly note: string;
}

export interface WorklogViewProps {
  readonly report: TimeReport;
  readonly online: boolean;
  readonly busy: boolean;
  readonly editing: Editing | null;
  readonly projects: readonly { readonly id: string; readonly title: string }[];
  readonly onEdit: (editing: Editing | null) => void;
  readonly onSave: (entry: TimeEntry, editing: Editing) => void;
  readonly onDelete: (entry: TimeEntry) => void;
}

/** Stateless worklog: days with their entries, then task and project totals. */
export const WorklogView = ({
  report,
  online,
  busy,
  editing,
  projects,
  onEdit,
  onSave,
  onDelete,
}: WorklogViewProps) => {
  const tasks = new Map(report.tasks.map((task) => [task.taskId, task]));
  const title = (taskId: string) => tasks.get(taskId)?.title ?? "Unknown task";
  const projectTitle = (id: string | null) =>
    id === null
      ? "No project"
      : (report.projects.find(({ projectId }) => projectId === id)?.title ??
        projects.find((project) => project.id === id)?.title ??
        "Unknown project");
  if (report.days.length === 0)
    return (
      <EmptyState
        title="No tracked time in this period."
        description="Focus sessions, imported history and manual entries appear here by day."
      />
    );
  return (
    <>
      <p role="status">
        {formatClockDuration(report.totalMs)} tracked from {report.from} to{" "}
        {report.to} ({report.timeZone}): focus{" "}
        {formatClockDuration(report.bySource.focus)}, imported{" "}
        {formatClockDuration(report.bySource.import)}, manual{" "}
        {formatClockDuration(report.bySource.manual)}.
      </p>
      {report.weeks.length > 1 && (
        <ul className="worklog-weeks" aria-label="Weekly totals">
          {report.weeks.map((week) => (
            <li key={week.weekStart}>
              Week of {dayLabel(week.weekStart)}:{" "}
              {formatClockDuration(week.totalMs)} over {week.daysWorked} day
              {week.daysWorked === 1 ? "" : "s"}
            </li>
          ))}
        </ul>
      )}
      <ul className="worklog-days">
        {report.days.map((day) => {
          const start = clockTime(day.workStart, report.timeZone);
          const end = clockTime(day.workEnd, report.timeZone);
          const entries = report.entries.filter(
            (entry) => entry.workDate === day.date,
          );
          return (
            <li key={day.date}>
              <Card>
                <CardHeader>
                  <h3>
                    {dayLabel(day.date)} · {formatClockDuration(day.totalMs)}
                  </h3>
                  {(start !== null || end !== null) && (
                    <p className="hint">
                      Imported work day {start ?? "?"}–{end ?? "?"}
                      {day.breakCount === null
                        ? ""
                        : ` · ${String(day.breakCount)} break${day.breakCount === 1 ? "" : "s"}`}
                      {day.breakMs === null
                        ? ""
                        : ` (${formatClockDuration(day.breakMs)})`}
                    </p>
                  )}
                </CardHeader>
                <CardContent>
                  <ul
                    className="worklog-entries"
                    aria-label={`Entries on ${day.date}`}
                  >
                    {entries.map((entry) => {
                      const key = `${entry.source}:${entry.id}:${entry.workDate}`;
                      const editable = canEditEntry(report, entry);
                      const current = editing?.id === entry.id ? editing : null;
                      return (
                        <li key={key} className="worklog-entry">
                          <span>
                            <strong>{title(entry.taskId)}</strong>{" "}
                            <Badge variant="secondary">
                              {sourceLabel[entry.source]}
                            </Badge>
                            {entry.running && (
                              <>
                                {" "}
                                <Badge variant="success">Running</Badge>
                              </>
                            )}{" "}
                            {formatClockDuration(entry.durationMs)}
                            {entry.note === "" ? "" : ` · ${entry.note}`}
                          </span>
                          {editable && current === null && (
                            <span className="worklog-actions">
                              <Button
                                type="button"
                                variant="ghost"
                                disabled={busy || !online}
                                onClick={() =>
                                  onEdit({
                                    id: entry.id,
                                    minutes: String(
                                      Math.round(entry.durationMs / 60_000),
                                    ),
                                    workDate: entry.workDate,
                                    note: entry.note,
                                  })
                                }
                              >
                                Edit
                              </Button>
                              <Button
                                type="button"
                                variant="ghost"
                                disabled={busy || !online}
                                onClick={() => onDelete(entry)}
                              >
                                Delete
                              </Button>
                            </span>
                          )}
                          {current !== null && (
                            <form
                              className="worklog-edit"
                              aria-label={`Edit entry for ${title(entry.taskId)}`}
                              onSubmit={(event) => {
                                event.preventDefault();
                                onSave(entry, current);
                              }}
                            >
                              <label className="field">
                                Minutes
                                <Input
                                  type="number"
                                  step="1"
                                  value={current.minutes}
                                  onChange={(event) =>
                                    onEdit({
                                      ...current,
                                      minutes: event.target.value,
                                    })
                                  }
                                />
                              </label>
                              <label className="field">
                                Date
                                <Input
                                  type="date"
                                  value={current.workDate}
                                  onChange={(event) =>
                                    onEdit({
                                      ...current,
                                      workDate: event.target.value,
                                    })
                                  }
                                />
                              </label>
                              <label className="field">
                                Note
                                <Input
                                  maxLength={500}
                                  value={current.note}
                                  onChange={(event) =>
                                    onEdit({
                                      ...current,
                                      note: event.target.value,
                                    })
                                  }
                                />
                              </label>
                              <Button type="submit" disabled={busy || !online}>
                                Save
                              </Button>
                              <Button
                                type="button"
                                variant="ghost"
                                onClick={() => onEdit(null)}
                              >
                                Cancel
                              </Button>
                            </form>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </CardContent>
              </Card>
            </li>
          );
        })}
      </ul>
      <Card>
        <CardHeader>
          <h3>Tasks</h3>
        </CardHeader>
        <CardContent>
          <table className="worklog-table">
            <thead>
              <tr>
                <th scope="col">Task</th>
                <th scope="col">Own</th>
                <th scope="col">Child tasks</th>
                <th scope="col">Estimate</th>
                <th scope="col">All time</th>
              </tr>
            </thead>
            <tbody>
              {report.tasks.map((task) => (
                <tr key={task.taskId}>
                  <th scope="row">
                    {task.parentId === null ? "" : "↳ "}
                    {task.title}
                    {task.archived ? " (archived)" : ""}
                  </th>
                  <td>{formatClockDuration(task.ownMs)}</td>
                  <td>
                    {task.childrenMs === 0
                      ? "—"
                      : formatClockDuration(task.childrenMs)}
                  </td>
                  <td>{estimate(task.rollupEstimateMinutes)}</td>
                  <td>{formatClockDuration(task.allTimeMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <h3>Projects</h3>
        </CardHeader>
        <CardContent>
          <table className="worklog-table">
            <thead>
              <tr>
                <th scope="col">Project</th>
                <th scope="col">Time</th>
                <th scope="col">Estimates</th>
              </tr>
            </thead>
            <tbody>
              {report.projects.map((project) => (
                <tr key={project.projectId ?? "none"}>
                  <th scope="row">{projectTitle(project.projectId)}</th>
                  <td>{formatClockDuration(project.totalMs)}</td>
                  <td>{estimate(project.estimateMinutes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </>
  );
};

export interface WorklogPageProps {
  readonly csrfToken: string;
  readonly online: boolean;
  readonly timeZone?: string;
  /** Active tasks that can receive manual time. */
  readonly tasks?: readonly { readonly id: string; readonly title: string }[];
  readonly projects?: readonly {
    readonly id: string;
    readonly title: string;
  }[];
  readonly api?: WorklogApi;
  readonly initialState?: WorklogState;
  readonly newId?: () => string;
}

const download = (name: string, text: string) => {
  const url = URL.createObjectURL(
    new Blob([text], { type: "text/csv;charset=utf-8" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
};

export const WorklogPage = ({
  csrfToken,
  online,
  timeZone = "UTC",
  tasks = [],
  projects = [],
  api = defaultApi,
  initialState,
  newId = () => crypto.randomUUID(),
}: WorklogPageProps) => {
  const today = zonedCalendarDate(new Date(), timeZone);
  const [state, setState] = useState<WorklogState>(
    initialState ?? initialWorklog(today),
  );
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [draft, setDraft] = useState({
    taskId: "",
    workDate: today,
    minutes: "",
    note: "",
  });
  const run = async (next: () => Promise<WorklogState>) => {
    setBusy(true);
    try {
      setState(await next());
    } finally {
      setBusy(false);
    }
  };
  const load = (period: WorklogPeriod, anchor: string) =>
    void run(() => loadWorklog(api, period, anchor));
  useEffect(() => {
    if (!online || initialState !== undefined) return;
    load(state.period, state.anchor);
    // Load once per connection; later loads are explicit.
  }, [online]);
  const range = periodRange(state.anchor, state.period);
  const add = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    const durationMs = minutesToMilliseconds(draft.minutes);
    if (durationMs === null || draft.taskId === "") {
      setState({
        ...state,
        notice: null,
        error:
          "Choose a task and enter nonzero minutes, up to 24 hours either way.",
      });
      return;
    }
    void run(async () => {
      const result = await addTimeEntry(
        api,
        state,
        {
          id: newId(),
          taskId: draft.taskId,
          workDate: draft.workDate,
          durationMs,
          note: draft.note.trim(),
        },
        csrfToken,
      );
      if (result.saved) setDraft({ ...draft, minutes: "", note: "" });
      return result.state;
    });
  };
  const save = (entry: TimeEntry, next: Editing) => {
    const durationMs = minutesToMilliseconds(next.minutes);
    if (durationMs === null) {
      setState({
        ...state,
        notice: null,
        error: "Enter nonzero minutes, up to 24 hours either way.",
      });
      return;
    }
    const patch = {
      ...(durationMs === entry.durationMs ? {} : { durationMs }),
      ...(next.workDate === entry.workDate ? {} : { workDate: next.workDate }),
      ...(next.note.trim() === entry.note ? {} : { note: next.note.trim() }),
    };
    if (Object.keys(patch).length === 0) {
      setEditing(null);
      return;
    }
    void run(async () => {
      const result = await editTimeEntry(api, state, entry, patch, csrfToken);
      if (result.saved) setEditing(null);
      return result.state;
    });
  };
  const remove = (entry: TimeEntry) =>
    void run(
      async () => (await removeTimeEntry(api, state, entry, csrfToken)).state,
    );
  const exportCsv = () => {
    if (state.report === null) return;
    download(
      worklogFileName(state.report),
      worklogCsv(worklogRows(state.report, projects)),
    );
  };
  return (
    <section
      className="mx-auto flex w-full max-w-5xl flex-col gap-6"
      aria-labelledby="worklog-heading"
    >
      <PageHeader
        id="worklog-heading"
        title="Worklog"
        description="Tracked time by day, task and project: focus sessions, imported Super Productivity history and manual entries. Days follow your planning time zone."
      />
      {!online && (
        <Alert variant="warning" role="status">
          <AlertDescription>
            The worklog needs a connection. Time entries are not kept offline.
          </AlertDescription>
        </Alert>
      )}
      {state.error !== null && (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      )}
      {state.notice !== null && (
        <Alert variant="info" role="status">
          <AlertDescription>{state.notice}</AlertDescription>
        </Alert>
      )}
      <Card>
        <CardHeader>
          <div className="worklog-controls">
            <label className="field">
              Period
              <NativeSelect
                value={state.period}
                disabled={busy || !online}
                onChange={(event) =>
                  load(
                    event.target.value === "month" ? "month" : "week",
                    state.anchor,
                  )
                }
              >
                <NativeSelectOption value="week">Week</NativeSelectOption>
                <NativeSelectOption value="month">Month</NativeSelectOption>
              </NativeSelect>
            </label>
            <Button
              type="button"
              variant="outline"
              disabled={busy || !online}
              onClick={() =>
                load(state.period, shiftPeriod(state.anchor, state.period, -1))
              }
            >
              Previous
            </Button>
            <span>
              {range.from} to {range.to}
            </span>
            <Button
              type="button"
              variant="outline"
              disabled={busy || !online}
              onClick={() =>
                load(state.period, shiftPeriod(state.anchor, state.period, 1))
              }
            >
              Next
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={state.report === null || state.report.days.length === 0}
              onClick={exportCsv}
            >
              Export CSV
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <form className="worklog-add" aria-label="Add time" onSubmit={add}>
            <label className="field">
              Task
              <NativeSelect
                value={draft.taskId}
                disabled={!online}
                onChange={(event) =>
                  setDraft({ ...draft, taskId: event.target.value })
                }
              >
                <NativeSelectOption value="">Choose a task</NativeSelectOption>
                {tasks.map((task) => (
                  <NativeSelectOption key={task.id} value={task.id}>
                    {task.title}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </label>
            <label className="field">
              Date
              <Input
                type="date"
                value={draft.workDate}
                disabled={!online}
                onChange={(event) =>
                  setDraft({ ...draft, workDate: event.target.value })
                }
              />
            </label>
            <label className="field">
              Minutes
              <Input
                type="number"
                step="1"
                value={draft.minutes}
                disabled={!online}
                onChange={(event) =>
                  setDraft({ ...draft, minutes: event.target.value })
                }
              />
            </label>
            <label className="field">
              Note
              <Input
                maxLength={500}
                value={draft.note}
                disabled={!online}
                onChange={(event) =>
                  setDraft({ ...draft, note: event.target.value })
                }
              />
            </label>
            <Button type="submit" disabled={busy || !online}>
              Add time
            </Button>
          </form>
          <p className="hint">
            Negative minutes record a correction, for example to remove focus
            time that kept running. A day&apos;s time on a task stays between 0
            and 24 hours.
          </p>
        </CardContent>
      </Card>
      {state.report !== null && (
        <WorklogView
          report={state.report}
          online={online}
          busy={busy}
          editing={editing}
          projects={projects}
          onEdit={setEditing}
          onSave={save}
          onDelete={remove}
        />
      )}
    </section>
  );
};
