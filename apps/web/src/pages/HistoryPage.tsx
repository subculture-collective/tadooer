import { useEffect, useState, type SyntheticEvent } from "react";
import type {
  ArchivedTask,
  TaskHistoryEntry,
  TaskHistoryProvenance,
} from "@suite/contracts";
import { getTaskHistory, unarchiveTask } from "../api.ts";
import { Alert, AlertDescription } from "../components/ui/alert.tsx";
import { Badge } from "../components/ui/badge.tsx";
import { Button } from "../components/ui/button.tsx";
import { Card, CardContent, CardHeader } from "../components/ui/card.tsx";
import { EmptyState } from "../components/ui/empty-state.tsx";
import { Input } from "../components/ui/input.tsx";
import { PageHeader } from "../components/ui/page-header.tsx";
import {
  emptyHistory,
  loadMoreHistory,
  restoreFromHistory,
  searchHistory,
  type HistoryApi,
  type HistoryState,
} from "./history-controller.ts";
import { useLiveRefetch } from "../live-sync/views.ts";

const defaultApi: HistoryApi = { getTaskHistory, unarchiveTask };

const reviewLabel: Readonly<
  Record<TaskHistoryProvenance["review"][number], string>
> = {
  blank_title: "Imported without a title",
  notes_unrepresentable:
    "Notes were longer than 20,000 characters; the full text is in import provenance",
  estimate_unrepresentable:
    "Estimate was not whole minutes up to 12 hours; the source value is in import provenance",
};

const referenceLabel = (
  reference: TaskHistoryProvenance["historicalReferences"][number],
): string => {
  const what = {
    project: "Project",
    tag: "Tag",
    repeat_config: "Repeat configuration",
    parent: "Parent task",
  }[reference.kind];
  const why = {
    missing_from_export: "not in the source export",
    system_tag: "a Super Productivity priority or board marker",
    recurrence_unsupported: "imported before recurring series were supported",
    lifecycle_mismatch: "the parent was in the other of active and archived",
  }[reference.reason];
  return `${what} ${reference.sourceId}: ${why}`;
};

const formatDate = (value: string | null | undefined, timeZone: string) =>
  value == null
    ? null
    : new Intl.DateTimeFormat("en-US", {
        dateStyle: "medium",
        timeZone,
      }).format(new Date(value));

const ArchivedTaskSummary = ({
  item,
  timeZone,
  projectTitle,
}: {
  readonly item: ArchivedTask;
  readonly timeZone: string;
  readonly projectTitle: string | undefined;
}) => {
  const { task, provenance } = item;
  const completed = formatDate(task.completedAt, timeZone);
  return (
    <div className="history-task">
      <p className="history-task-title">
        <strong>{task.title}</strong>{" "}
        <Badge variant={task.status === "completed" ? "success" : "secondary"}>
          {task.status === "completed" ? "Completed" : "Open"}
        </Badge>
        {provenance !== null && provenance.review.length > 0 && (
          <>
            {" "}
            <Badge variant="warning">Needs review</Badge>
          </>
        )}
      </p>
      <p className="hint">
        Created {formatDate(task.createdAt, timeZone)}
        {completed === null ? "" : ` · completed ${completed}`} · archived{" "}
        {formatDate(task.archivedAt, timeZone)}
        {projectTitle === undefined ? "" : ` · ${projectTitle}`}
      </p>
      {task.notes !== "" && <p className="history-task-notes">{task.notes}</p>}
      {provenance !== null && (
        <div className="history-provenance">
          <p className="hint">
            Imported from Super Productivity ({provenance.sourceStore}).
          </p>
          {provenance.review.length > 0 && (
            <ul aria-label={`Review notes for ${task.title}`}>
              {provenance.review.map((reason) => (
                <li key={reason}>{reviewLabel[reason]}</li>
              ))}
            </ul>
          )}
          {provenance.historicalReferences.length > 0 && (
            <ul aria-label={`Historical references for ${task.title}`}>
              {provenance.historicalReferences.map((reference) => (
                <li key={`${reference.kind}:${reference.sourceId}`}>
                  {referenceLabel(reference)}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
};

export interface HistoryListProps {
  readonly state: HistoryState;
  readonly online: boolean;
  readonly busy: boolean;
  readonly timeZone: string;
  readonly projects: readonly { readonly id: string; readonly title: string }[];
  readonly onRestore: (entry: TaskHistoryEntry) => void;
  readonly onLoadMore: () => void;
}

/** Stateless list of archived families; restore acts on a whole family. */
export const HistoryList = ({
  state,
  online,
  busy,
  timeZone,
  projects,
  onRestore,
  onLoadMore,
}: HistoryListProps) => {
  const projectTitle = (id: string | null | undefined) =>
    projects.find((project) => project.id === id)?.title;
  if (state.entries.length === 0)
    return (
      <EmptyState
        title={
          state.query === ""
            ? "No archived tasks yet."
            : "No archived tasks match."
        }
        description="Archive a finished top-level task from Tasks to keep it here."
      />
    );
  return (
    <>
      <p role="status">
        Showing {state.entries.length} of {state.total} archived task
        {state.total === 1 ? "" : "s"}
        {state.query === "" ? "" : ` matching "${state.query}"`}.
      </p>
      <ul className="history-list">
        {state.entries.map((entry) => (
          <li key={entry.task.id}>
            <Card>
              <CardContent>
                <ArchivedTaskSummary
                  item={entry}
                  timeZone={timeZone}
                  projectTitle={projectTitle(entry.task.projectId)}
                />
                {entry.children.length > 0 && (
                  <ul
                    className="history-children"
                    aria-label={`Child tasks of ${entry.task.title}`}
                  >
                    {entry.children.map((child) => (
                      <li key={child.task.id}>
                        <ArchivedTaskSummary
                          item={child}
                          timeZone={timeZone}
                          projectTitle={projectTitle(child.task.projectId)}
                        />
                      </li>
                    ))}
                  </ul>
                )}
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy || !online}
                  onClick={() => onRestore(entry)}
                >
                  Restore to Tasks
                </Button>
              </CardContent>
            </Card>
          </li>
        ))}
      </ul>
      {state.nextCursor !== null && (
        <Button
          type="button"
          variant="ghost"
          disabled={busy || !online}
          onClick={onLoadMore}
        >
          Show more
        </Button>
      )}
    </>
  );
};

export interface HistoryPageProps {
  readonly csrfToken: string;
  readonly online: boolean;
  readonly timeZone?: string;
  readonly projects?: readonly {
    readonly id: string;
    readonly title: string;
  }[];
  /** Called after a restore so the active task cache syncs the family back. */
  readonly onRestored: () => Promise<void>;
  readonly api?: HistoryApi;
  readonly initialState?: HistoryState;
}

export const HistoryPage = ({
  csrfToken,
  online,
  timeZone = "UTC",
  projects = [],
  onRestored,
  api = defaultApi,
  initialState,
}: HistoryPageProps) => {
  const [state, setState] = useState<HistoryState>(
    initialState ?? emptyHistory,
  );
  const [draft, setDraft] = useState(initialState?.query ?? "");
  const [busy, setBusy] = useState(false);
  const run = async (next: () => Promise<HistoryState>) => {
    setBusy(true);
    try {
      setState(await next());
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    if (!online || initialState !== undefined) return;
    void run(() => searchHistory(api, ""));
    // Load once per connection; later searches are explicit.
  }, [online]);
  // ADR 0045: repeat the search that is showing when another device
  // archives or restores a task.
  useLiveRefetch(
    "history",
    () => run(() => searchHistory(api, state.query)),
    online && initialState === undefined,
  );
  const search = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    void run(() => searchHistory(api, draft.trim()));
  };
  const restore = (entry: TaskHistoryEntry) =>
    void run(async () => {
      const result = await restoreFromHistory(api, state, entry, csrfToken);
      if (result.restored) await onRestored();
      return result.state;
    });
  return (
    <section
      className="mx-auto flex w-full max-w-5xl flex-col gap-6"
      aria-labelledby="history-heading"
    >
      <PageHeader
        id="history-heading"
        title="History"
        description="Archived tasks keep their original dates and stay out of Today, the Planner and reminders. Restore returns a task and its children to Tasks."
      />
      {!online && (
        <Alert variant="warning" role="status">
          <AlertDescription>
            History needs a connection. Archived tasks are not kept offline.
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
          <form className="history-search" role="search" onSubmit={search}>
            <label className="field">
              Search titles and notes
              <Input
                type="search"
                name="query"
                maxLength={200}
                value={draft}
                disabled={!online}
                onChange={(event) => setDraft(event.target.value)}
              />
            </label>
            <Button type="submit" disabled={busy || !online}>
              Search
            </Button>
          </form>
        </CardHeader>
      </Card>
      <HistoryList
        state={state}
        online={online}
        busy={busy}
        timeZone={timeZone}
        projects={projects}
        onRestore={restore}
        onLoadMore={() => void run(() => loadMoreHistory(api, state))}
      />
    </section>
  );
};
