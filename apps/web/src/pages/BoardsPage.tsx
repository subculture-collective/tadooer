import { useCallback, useEffect, useState, type SyntheticEvent } from "react";
import {
  ApiRequestError,
  boardMarkerSchema,
  type Board,
  type BoardMoveChange,
  type BoardPanelFilter,
  type BoardView,
  type Project,
  type Tag,
  type Task,
} from "@suite/contracts";
import {
  createBoard,
  deleteBoard,
  getBoardView,
  getBoards,
  moveTaskToPanel,
  reorderBoardPanel,
  updateBoard,
} from "../api.ts";
import { Alert, AlertDescription } from "../components/ui/alert.tsx";
import { Button } from "../components/ui/button.tsx";
import { Card, CardContent, CardHeader } from "../components/ui/card.tsx";
import { Checkbox } from "../components/ui/checkbox.tsx";
import { EmptyState } from "../components/ui/empty-state.tsx";
import { Input } from "../components/ui/input.tsx";
import { NativeSelect } from "../components/ui/native-select.tsx";
import { PageHeader } from "../components/ui/page-header.tsx";
import { SectionHeading } from "../components/ui/section-heading.tsx";

/**
 * Boards with filtered panels (issue #63, ADR 0028). Online-only: the page
 * reads boards over HTTP and never caches them. Moves use buttons and show
 * the exact task changes before applying them; there is no drag-and-drop.
 */

export interface BoardsPageProps {
  readonly csrfToken: string;
  readonly online: boolean;
  readonly tasks: readonly Task[];
  readonly projects: readonly Project[];
  readonly tags: readonly Tag[];
}

const emptyFilter: BoardPanelFilter = {
  includedTagIds: [],
  includedTagsMatch: "all",
  excludedTagIds: [],
  excludedTagsMatch: "any",
  includedMarkers: [],
  excludedMarkers: [],
  projectIds: [],
  doneState: "all",
  scheduledState: "all",
  backlogState: "all",
  parentsOnly: false,
  sortBy: null,
  sortDir: "asc",
};

interface PanelDraft {
  readonly id?: string;
  readonly title: string;
  readonly filter: BoardPanelFilter;
}
interface BoardDraft {
  readonly title: string;
  readonly columns: number;
  readonly panels: readonly PanelDraft[];
}

const markerLabel = (marker: string): string =>
  marker === "in_progress" ? "in progress" : marker;

export const describeBoardChange = (
  change: BoardMoveChange,
  names: {
    readonly tag: (id: string) => string;
    readonly project: (id: string) => string;
  },
): string => {
  switch (change.kind) {
    case "add_tag":
      return `Add tag "${names.tag(change.tagId)}"`;
    case "remove_tag":
      return `Remove tag "${names.tag(change.tagId)}"`;
    case "add_marker":
      return `Mark as ${markerLabel(change.marker)}`;
    case "remove_marker":
      return `Unmark ${markerLabel(change.marker)}`;
    case "complete":
      return "Complete the task";
    case "reopen":
      return "Reopen the task";
    case "assign_project":
      return `Move to project "${names.project(change.projectId)}"`;
    case "plan_today":
      return `Plan for ${change.date}`;
    case "clear_planned_day":
      return "Clear the planned day";
    case "add_to_backlog":
      return "Add to the project backlog";
    case "remove_from_backlog":
      return "Remove from the project backlog";
  }
};

/** A trimmed string field of a submitted form; empty when absent. */
const formString = (data: FormData, key: string): string => {
  const value = data.get(key);
  return typeof value === "string" ? value.trim() : "";
};

const failure = (error: unknown, fallback: string): string =>
  error instanceof ApiRequestError
    ? error.status === 412
      ? "The board changed since it loaded. It was reloaded; try again."
      : error.message
    : fallback;

const PanelEditor = ({
  panel,
  index,
  count,
  tags,
  projects,
  onChange,
  onMove,
  onRemove,
}: {
  readonly panel: PanelDraft;
  readonly index: number;
  readonly count: number;
  readonly tags: readonly Tag[];
  readonly projects: readonly Project[];
  readonly onChange: (panel: PanelDraft) => void;
  readonly onMove: (direction: -1 | 1) => void;
  readonly onRemove: () => void;
}) => {
  const filter = panel.filter;
  const set = (patch: Partial<BoardPanelFilter>) =>
    onChange({ ...panel, filter: { ...filter, ...patch } });
  const toggle = (list: readonly string[], id: string): string[] =>
    list.includes(id) ? list.filter((item) => item !== id) : [...list, id];
  const label = `Panel ${String(index + 1)}`;
  return (
    <fieldset className="board-panel-editor">
      <legend>{label}</legend>
      <label className="field">
        <span>Title</span>
        <Input
          value={panel.title}
          aria-label={`${label} title`}
          onChange={(event) =>
            onChange({ ...panel, title: event.currentTarget.value })
          }
        />
      </label>
      <fieldset>
        <legend>Included tags and markers</legend>
        {tags.map((tag) => (
          <label key={tag.id}>
            <Checkbox
              checked={filter.includedTagIds.includes(tag.id)}
              onCheckedChange={() =>
                set({ includedTagIds: toggle(filter.includedTagIds, tag.id) })
              }
            />
            {tag.displayName}
          </label>
        ))}
        {boardMarkerSchema.options.map((marker) => (
          <label key={marker}>
            <Checkbox
              checked={filter.includedMarkers.includes(marker)}
              onCheckedChange={() =>
                set({
                  includedMarkers: toggle(
                    filter.includedMarkers,
                    marker,
                  ) as BoardPanelFilter["includedMarkers"],
                })
              }
            />
            Marker: {markerLabel(marker)}
          </label>
        ))}
        <label className="field">
          <span>Match</span>
          <NativeSelect
            value={filter.includedTagsMatch}
            onChange={(event) =>
              set({
                includedTagsMatch: event.currentTarget.value as "all" | "any",
              })
            }
          >
            <option value="all">All of them</option>
            <option value="any">Any of them</option>
          </NativeSelect>
        </label>
      </fieldset>
      <fieldset>
        <legend>Excluded tags and markers</legend>
        {tags.map((tag) => (
          <label key={tag.id}>
            <Checkbox
              checked={filter.excludedTagIds.includes(tag.id)}
              onCheckedChange={() =>
                set({ excludedTagIds: toggle(filter.excludedTagIds, tag.id) })
              }
            />
            {tag.displayName}
          </label>
        ))}
        {boardMarkerSchema.options.map((marker) => (
          <label key={marker}>
            <Checkbox
              checked={filter.excludedMarkers.includes(marker)}
              onCheckedChange={() =>
                set({
                  excludedMarkers: toggle(
                    filter.excludedMarkers,
                    marker,
                  ) as BoardPanelFilter["excludedMarkers"],
                })
              }
            />
            Marker: {markerLabel(marker)}
          </label>
        ))}
        <label className="field">
          <span>Hide when</span>
          <NativeSelect
            value={filter.excludedTagsMatch}
            onChange={(event) =>
              set({
                excludedTagsMatch: event.currentTarget.value as "any" | "all",
              })
            }
          >
            <option value="any">Any of them is present</option>
            <option value="all">All of them are present</option>
          </NativeSelect>
        </label>
      </fieldset>
      <fieldset>
        <legend>Projects (none selected means every project)</legend>
        {projects
          .filter((project) => project.archivedAt === null)
          .map((project) => (
            <label key={project.id}>
              <Checkbox
                checked={filter.projectIds.includes(project.id)}
                onCheckedChange={() =>
                  set({ projectIds: toggle(filter.projectIds, project.id) })
                }
              />
              {project.title}
            </label>
          ))}
      </fieldset>
      <label className="field">
        <span>Done state</span>
        <NativeSelect
          value={filter.doneState}
          onChange={(event) =>
            set({
              doneState: event.currentTarget
                .value as BoardPanelFilter["doneState"],
            })
          }
        >
          <option value="all">All</option>
          <option value="open">Open only</option>
          <option value="done">Done only</option>
        </NativeSelect>
      </label>
      <label className="field">
        <span>Scheduled state</span>
        <NativeSelect
          value={filter.scheduledState}
          onChange={(event) =>
            set({
              scheduledState: event.currentTarget
                .value as BoardPanelFilter["scheduledState"],
            })
          }
        >
          <option value="all">All</option>
          <option value="scheduled">Scheduled only</option>
          <option value="unscheduled">Unscheduled only</option>
        </NativeSelect>
      </label>
      <label className="field">
        <span>Backlog</span>
        <NativeSelect
          value={filter.backlogState}
          onChange={(event) =>
            set({
              backlogState: event.currentTarget
                .value as BoardPanelFilter["backlogState"],
            })
          }
        >
          <option value="all">All</option>
          <option value="no_backlog">Outside the backlog</option>
          <option value="only_backlog">Backlog only</option>
        </NativeSelect>
      </label>
      <label>
        <Checkbox
          checked={filter.parentsOnly}
          onCheckedChange={(checked) => set({ parentsOnly: checked === true })}
        />
        Top-level tasks only
      </label>
      <label className="field">
        <span>Sort</span>
        <NativeSelect
          value={filter.sortBy ?? ""}
          onChange={(event) =>
            set({
              sortBy:
                event.currentTarget.value === ""
                  ? null
                  : (event.currentTarget.value as Exclude<
                      BoardPanelFilter["sortBy"],
                      null
                    >),
            })
          }
        >
          <option value="">Manual order</option>
          <option value="dueDate">Due date</option>
          <option value="created">Created</option>
          <option value="title">Title</option>
          <option value="timeEstimate">Estimate</option>
        </NativeSelect>
      </label>
      <label className="field">
        <span>Direction</span>
        <NativeSelect
          value={filter.sortDir}
          onChange={(event) =>
            set({ sortDir: event.currentTarget.value as "asc" | "desc" })
          }
        >
          <option value="asc">Ascending</option>
          <option value="desc">Descending</option>
        </NativeSelect>
      </label>
      <div className="task-actions">
        <Button
          type="button"
          variant="outline"
          disabled={index === 0}
          onClick={() => onMove(-1)}
        >
          Move {label} left
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={index === count - 1}
          onClick={() => onMove(1)}
        >
          Move {label} right
        </Button>
        <Button type="button" variant="destructive" onClick={onRemove}>
          Remove {label}
        </Button>
      </div>
    </fieldset>
  );
};

export const BoardsPage = ({
  csrfToken,
  online,
  tasks,
  projects,
  tags,
}: BoardsPageProps) => {
  const [boards, setBoards] = useState<readonly Board[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [view, setView] = useState<BoardView | null>(null);
  const [draft, setDraft] = useState<BoardDraft | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [moveTargets, setMoveTargets] = useState<Record<string, string>>({});

  const names = {
    tag: (id: string) =>
      tags.find((tag) => tag.id === id)?.displayName ?? "unknown tag",
    project: (id: string) =>
      projects.find((project) => project.id === id)?.title ?? "unknown project",
  };
  const taskById = new Map(tasks.map((task) => [task.id, task]));

  const loadBoards = useCallback(async () => {
    try {
      const list = await getBoards();
      setBoards(list);
      return list;
    } catch (error) {
      setMessage(failure(error, "Boards could not be loaded."));
      return [];
    }
  }, []);

  const loadView = useCallback(async (boardId: string) => {
    try {
      setView(await getBoardView(boardId));
    } catch (error) {
      setMessage(failure(error, "The board could not be loaded."));
      setView(null);
    }
  }, []);

  useEffect(() => {
    if (!online) return;
    void loadBoards();
  }, [online, loadBoards]);

  useEffect(() => {
    if (selectedId === null || !online) {
      setView(null);
      return;
    }
    void loadView(selectedId);
  }, [selectedId, online, loadView, tasks]);

  const run = async (action: () => Promise<void>, fallback: string) => {
    setBusy(true);
    setMessage(null);
    try {
      await action();
    } catch (error) {
      setMessage(failure(error, fallback));
      await loadBoards();
      if (selectedId !== null) await loadView(selectedId);
    } finally {
      setBusy(false);
    }
  };

  const create = (input: Parameters<typeof createBoard>[0]) =>
    run(async () => {
      const board = await createBoard(input, csrfToken);
      await loadBoards();
      setSelectedId(board.id);
    }, "The board could not be created.");

  const submitNewBoard = (
    event: SyntheticEvent<HTMLFormElement, SubmitEvent>,
  ) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const title = formString(data, "title");
    if (title === "") return;
    event.currentTarget.reset();
    void create({ title, columns: 1, panels: [] });
  };

  const selected = boards.find((board) => board.id === selectedId) ?? null;

  const startEdit = () => {
    if (selected === null) return;
    setDraft({
      title: selected.title,
      columns: selected.columns,
      panels: selected.panels.map((panel) => ({
        id: panel.id,
        title: panel.title,
        filter: panel.filter,
      })),
    });
  };

  const saveDraft = () => {
    if (selected === null || draft === null) return;
    void run(async () => {
      await updateBoard(
        selected.id,
        {
          expectedRevision: selected.revision,
          title: draft.title,
          columns: draft.columns,
          panels: draft.panels.map((panel) => ({
            ...(panel.id === undefined ? {} : { id: panel.id }),
            title: panel.title,
            filter: panel.filter,
          })),
        },
        csrfToken,
      );
      setDraft(null);
      await loadBoards();
      await loadView(selected.id);
    }, "The board could not be saved.");
  };

  const remove = () => {
    if (selected === null) return;
    if (
      !window.confirm(
        `Delete board "${selected.title}"? Tasks are not changed.`,
      )
    )
      return;
    void run(async () => {
      await deleteBoard(selected.id, selected.revision, csrfToken);
      setSelectedId(null);
      setDraft(null);
      await loadBoards();
    }, "The board could not be deleted.");
  };

  const move = (taskId: string, panelId: string) => {
    if (view === null) return;
    const task = taskById.get(taskId);
    if (task === undefined) return;
    void run(async () => {
      const plan = await moveTaskToPanel(
        view.board.id,
        panelId,
        {
          expectedRevision: view.board.revision,
          taskId,
          taskRevision: task.revision,
          dryRun: true,
        },
        csrfToken,
      );
      const panelTitle =
        view.board.panels.find((panel) => panel.id === panelId)?.title ??
        "the panel";
      const lines =
        plan.changes.length === 0
          ? ["No task changes; only the panel order changes."]
          : plan.changes.map((change) => describeBoardChange(change, names));
      if (
        !window.confirm(
          `Move "${task.title}" into "${panelTitle}"?\n\n${lines.join("\n")}`,
        )
      )
        return;
      const result = await moveTaskToPanel(
        view.board.id,
        panelId,
        {
          expectedRevision: view.board.revision,
          taskId,
          taskRevision: task.revision,
        },
        csrfToken,
      );
      if (result.view !== undefined) setView(result.view);
      await loadBoards();
    }, "The task could not be moved.");
  };

  const shift = (panelId: string, taskId: string, direction: -1 | 1) => {
    if (view === null) return;
    const members =
      view.members.find((entry) => entry.panelId === panelId)?.taskIds ?? [];
    const index = members.indexOf(taskId);
    const target = index + direction;
    if (index === -1 || target < 0 || target >= members.length) return;
    const next = [...members];
    next.splice(index, 1);
    next.splice(target, 0, taskId);
    void run(async () => {
      setView(
        await reorderBoardPanel(
          view.board.id,
          panelId,
          { expectedRevision: view.board.revision, taskIds: next },
          csrfToken,
        ),
      );
      await loadBoards();
    }, "The panel order could not be saved.");
  };

  return (
    <>
      <PageHeader
        title="Boards"
        description="Filtered panels with an optional manual order. Moving a task into a panel changes its tags, markers, state or project; the change list is shown first."
      />
      {!online && (
        <Alert>
          <AlertDescription>
            Boards need a connection. They are not cached offline.
          </AlertDescription>
        </Alert>
      )}
      {message !== null && (
        <Alert role="status">
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      )}
      <Card aria-labelledby="board-list-title">
        <CardHeader>
          <SectionHeading id="board-list-title" as="h2" title="Your boards" />
        </CardHeader>
        <CardContent>
          {boards.length === 0 ? (
            <EmptyState title="No boards yet. Add a template or a blank board." />
          ) : (
            <ul className="board-list">
              {boards.map((board) => (
                <li key={board.id}>
                  <Button
                    type="button"
                    variant={board.id === selectedId ? "default" : "outline"}
                    aria-pressed={board.id === selectedId}
                    onClick={() => {
                      setSelectedId(board.id);
                      setDraft(null);
                    }}
                  >
                    {board.title}
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <div className="task-actions">
            <Button
              type="button"
              disabled={busy || !online}
              onClick={() => void create({ template: "eisenhower" })}
            >
              Add Eisenhower matrix
            </Button>
            <Button
              type="button"
              disabled={busy || !online}
              onClick={() => void create({ template: "kanban" })}
            >
              Add Kanban board
            </Button>
          </div>
          <form onSubmit={submitNewBoard}>
            <label className="field">
              <span>New blank board</span>
              <Input name="title" autoComplete="off" required maxLength={240} />
            </label>
            <Button disabled={busy || !online}>Add board</Button>
          </form>
        </CardContent>
      </Card>
      {selected !== null && draft === null && (
        <Card aria-labelledby="board-view-title">
          <CardHeader>
            <SectionHeading
              id="board-view-title"
              as="h2"
              title={selected.title}
            >
              <p>
                <small>
                  {String(selected.columns)}{" "}
                  {selected.columns === 1 ? "column" : "columns"} · revision{" "}
                  {String(selected.revision)}
                </small>
              </p>
            </SectionHeading>
          </CardHeader>
          <CardContent>
            <div className="task-actions">
              <Button
                type="button"
                variant="outline"
                disabled={busy || !online}
                onClick={startEdit}
              >
                Edit board
              </Button>
              <Button
                type="button"
                variant="destructive"
                disabled={busy || !online}
                onClick={remove}
              >
                Delete board
              </Button>
            </div>
            {view === null ? (
              <p>Loading the board…</p>
            ) : (
              <div
                className="board-grid"
                style={{
                  display: "grid",
                  gap: "1rem",
                  gridTemplateColumns: `repeat(${String(selected.columns)}, minmax(0, 1fr))`,
                }}
              >
                {view.board.panels.map((panel) => {
                  const members =
                    view.members.find((entry) => entry.panelId === panel.id)
                      ?.taskIds ?? [];
                  const manual = panel.filter.sortBy === null;
                  return (
                    <section
                      key={panel.id}
                      className="board-panel"
                      aria-labelledby={`panel-${panel.id}`}
                    >
                      <h3 id={`panel-${panel.id}`}>
                        {panel.title} <small>({String(members.length)})</small>
                      </h3>
                      {members.length === 0 ? (
                        <p>
                          <small>No tasks match.</small>
                        </p>
                      ) : (
                        <ol className="board-panel-tasks">
                          {members.map((taskId, index) => {
                            const task = taskById.get(taskId);
                            const title = task?.title ?? "Task not loaded";
                            const markers = view.markers[taskId] ?? [];
                            const targetId =
                              moveTargets[`${panel.id}:${taskId}`] ??
                              view.board.panels.find(
                                ({ id }) => id !== panel.id,
                              )?.id ??
                              "";
                            return (
                              <li key={taskId}>
                                <strong>{title}</strong>
                                {task?.status === "completed" && (
                                  <small> · Completed</small>
                                )}
                                {markers.length > 0 && (
                                  <small>
                                    {" "}
                                    · {markers.map(markerLabel).join(", ")}
                                  </small>
                                )}
                                <div className="task-actions">
                                  {manual && (
                                    <>
                                      <Button
                                        type="button"
                                        variant="outline"
                                        disabled={
                                          busy || !online || index === 0
                                        }
                                        aria-label={`Move ${title} up in ${panel.title}`}
                                        onClick={() =>
                                          shift(panel.id, taskId, -1)
                                        }
                                      >
                                        Up
                                      </Button>
                                      <Button
                                        type="button"
                                        variant="outline"
                                        disabled={
                                          busy ||
                                          !online ||
                                          index === members.length - 1
                                        }
                                        aria-label={`Move ${title} down in ${panel.title}`}
                                        onClick={() =>
                                          shift(panel.id, taskId, 1)
                                        }
                                      >
                                        Down
                                      </Button>
                                    </>
                                  )}
                                  {view.board.panels.length > 1 && (
                                    <>
                                      <NativeSelect
                                        aria-label={`Target panel for ${title}`}
                                        value={targetId}
                                        onChange={(event) =>
                                          setMoveTargets({
                                            ...moveTargets,
                                            [`${panel.id}:${taskId}`]:
                                              event.currentTarget.value,
                                          })
                                        }
                                      >
                                        {view.board.panels
                                          .filter(({ id }) => id !== panel.id)
                                          .map((other) => (
                                            <option
                                              key={other.id}
                                              value={other.id}
                                            >
                                              {other.title}
                                            </option>
                                          ))}
                                      </NativeSelect>
                                      <Button
                                        type="button"
                                        disabled={
                                          busy ||
                                          !online ||
                                          targetId === "" ||
                                          task === undefined
                                        }
                                        aria-label={`Move ${title} to another panel`}
                                        onClick={() => move(taskId, targetId)}
                                      >
                                        Move
                                      </Button>
                                    </>
                                  )}
                                </div>
                              </li>
                            );
                          })}
                        </ol>
                      )}
                    </section>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      )}
      {selected !== null && draft !== null && (
        <Card aria-labelledby="board-edit-title">
          <CardHeader>
            <SectionHeading
              id="board-edit-title"
              as="h2"
              title={`Edit ${selected.title}`}
            />
          </CardHeader>
          <CardContent>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                saveDraft();
              }}
            >
              <label className="field">
                <span>Board title</span>
                <Input
                  value={draft.title}
                  required
                  maxLength={240}
                  onChange={(event) =>
                    setDraft({ ...draft, title: event.currentTarget.value })
                  }
                />
              </label>
              <label className="field">
                <span>Columns</span>
                <Input
                  type="number"
                  min={1}
                  max={6}
                  value={draft.columns}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      columns: Math.min(
                        6,
                        Math.max(1, Number(event.currentTarget.value) || 1),
                      ),
                    })
                  }
                />
              </label>
              {draft.panels.map((panel, index) => (
                <PanelEditor
                  key={panel.id ?? `new-${String(index)}`}
                  panel={panel}
                  index={index}
                  count={draft.panels.length}
                  tags={tags.filter((tag) => tag.archivedAt === null)}
                  projects={projects}
                  onChange={(next) =>
                    setDraft({
                      ...draft,
                      panels: draft.panels.map((item, position) =>
                        position === index ? next : item,
                      ),
                    })
                  }
                  onMove={(direction) => {
                    const panels = [...draft.panels];
                    const target = index + direction;
                    if (target < 0 || target >= panels.length) return;
                    panels.splice(target, 0, ...panels.splice(index, 1));
                    setDraft({ ...draft, panels });
                  }}
                  onRemove={() =>
                    setDraft({
                      ...draft,
                      panels: draft.panels.filter(
                        (_, position) => position !== index,
                      ),
                    })
                  }
                />
              ))}
              <div className="task-actions">
                <Button
                  type="button"
                  variant="outline"
                  disabled={draft.panels.length >= 12}
                  onClick={() =>
                    setDraft({
                      ...draft,
                      panels: [
                        ...draft.panels,
                        {
                          title: `Panel ${String(draft.panels.length + 1)}`,
                          filter: emptyFilter,
                        },
                      ],
                    })
                  }
                >
                  Add panel
                </Button>
                <Button disabled={busy || !online}>Save board</Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setDraft(null)}
                >
                  Cancel
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}
    </>
  );
};
