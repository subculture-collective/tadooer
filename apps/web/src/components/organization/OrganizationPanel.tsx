import { useState, type SyntheticEvent } from "react";
import type { Note, Project, Tag, Task } from "@suite/contracts";
import {
  patchProject,
  patchTag,
  reorderProjects,
  reorderTags,
  setProjectBacklog,
} from "../../api.ts";
import { Badge } from "../ui/badge.tsx";
import { Button } from "../ui/button.tsx";
import { Card, CardContent, CardHeader } from "../ui/card.tsx";
import { Input } from "../ui/input.tsx";
import { NativeSelect } from "../ui/native-select.tsx";
import { SectionHeading } from "../ui/section-heading.tsx";
import { Textarea } from "../ui/textarea.tsx";
import { NoteMarkdown } from "../notes/NoteMarkdown.tsx";
import type {
  LocalNotePatch,
  LocalOrganizationPatch,
} from "../../local-store.ts";

/** ADR 0033: lifecycle and appearance edits that the offline outbox accepts. */
export interface OrganizationQueue {
  readonly patchProject: (
    project: Project,
    fields: LocalOrganizationPatch,
  ) => Promise<void>;
  readonly patchTag: (
    tag: Tag,
    fields: LocalOrganizationPatch,
  ) => Promise<void>;
}

/**
 * ADR 0046: note writes go through the offline outbox. Each call queues the
 * operation, updates the cached notes and syncs when a connection exists.
 */
export interface NoteQueue {
  readonly create: (input: {
    readonly content: string;
    readonly projectId: string | null;
    readonly tagId: string | null;
    readonly pinnedToToday: boolean;
  }) => Promise<void>;
  readonly patch: (note: Note, fields: LocalNotePatch) => Promise<void>;
  readonly remove: (note: Note) => Promise<void>;
  /** Exchanges the order of two notes with one position patch each. */
  readonly swap: (note: Note, neighbour: Note) => Promise<void>;
}

const queueableKeys = new Set([
  "title",
  "archived",
  "completed",
  "color",
  "icon",
]);

export interface OrganizationPanelProps {
  readonly projects: readonly Project[];
  readonly tags: readonly Tag[];
  readonly tasks: readonly Task[];
  readonly csrfToken: string;
  readonly online: boolean;
  readonly onProjectsChange: (projects: readonly Project[]) => void;
  readonly onTagsChange: (tags: readonly Tag[]) => void;
  /** When present, lifecycle and appearance changes queue offline. */
  readonly queue?: OrganizationQueue;
  /** Notes from the offline cache (ADR 0046), in the owner's order. */
  readonly notes?: readonly Note[];
  /** When present, notes can be written, online or offline. */
  readonly noteQueue?: NoteQueue;
}

const move = <T,>(items: readonly T[], index: number, offset: -1 | 1): T[] => {
  const next = [...items];
  const target = index + offset;
  const item = next[index];
  const other = next[target];
  if (item === undefined || other === undefined) return next;
  next[index] = other;
  next[target] = item;
  return next;
};

const noNotes: readonly Note[] = [];

const replace = <T extends { readonly id: string }>(
  items: readonly T[],
  record: T,
): T[] => items.map((item) => (item.id === record.id ? record : item));

const text = (data: FormData, name: string): string => {
  const value = data.get(name);
  return typeof value === "string" ? value : "";
};

const failure = (error: unknown): string =>
  error instanceof Error ? error.message : "The change could not be saved";

const Swatch = ({
  color,
  icon,
}: {
  readonly color: string | null;
  readonly icon: string | null;
}) => (
  <span className="organization-swatch" aria-hidden="true">
    <span
      className="organization-swatch__color"
      style={color === null ? undefined : { backgroundColor: color }}
    />
    {icon !== null && <span className="organization-swatch__icon">{icon}</span>}
  </span>
);

/**
 * Project, tag, backlog and note management. Project and tag reorder, menu
 * visibility and backlog are online HTTP requests with revision
 * preconditions. Notes are read from the offline cache and written through
 * the sync outbox (ADR 0046), so they work without a connection.
 */
export const OrganizationPanel = ({
  projects,
  tags,
  tasks,
  csrfToken,
  online,
  onProjectsChange,
  onTagsChange,
  queue,
  notes = noNotes,
  noteQueue,
}: OrganizationPanelProps) => {
  const [noteFilter, setNoteFilter] = useState("all");
  const [editingNote, setEditingNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (cause: unknown) {
      setError(failure(cause));
    } finally {
      setBusy(false);
    }
  };
  const disabled = busy || !online;
  const notesDisabled = busy || noteQueue === undefined;
  const lifecycleDisabled = busy || (!online && queue === undefined);
  const queueable = (input: object): boolean =>
    queue !== undefined &&
    Object.keys(input).every((key) => queueableKeys.has(key));

  const updateProject = (
    project: Project,
    input: Parameters<typeof patchProject>[2],
  ) =>
    run(async () => {
      if (queue !== undefined && queueable(input)) {
        await queue.patchProject(project, input as LocalOrganizationPatch);
        return;
      }
      onProjectsChange(
        replace(
          projects,
          await patchProject(project.id, project.revision, input, csrfToken),
        ),
      );
    });
  const updateTag = (tag: Tag, input: Parameters<typeof patchTag>[2]) =>
    run(async () => {
      if (queue !== undefined && queueable(input)) {
        await queue.patchTag(tag, input as LocalOrganizationPatch);
        return;
      }
      onTagsChange(
        replace(tags, await patchTag(tag.id, tag.revision, input, csrfToken)),
      );
    });
  const appearance = (event: SyntheticEvent<HTMLFormElement, SubmitEvent>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const color = data.get("clearColor") === "on" ? null : text(data, "color");
    const icon = text(data, "icon").trim();
    return { color, icon: icon === "" ? null : icon };
  };

  const noteAssociation = (note: Note) =>
    note.projectId !== null
      ? `project:${note.projectId}`
      : note.tagId !== null
        ? `tag:${note.tagId}`
        : "none";
  const associationLabel = (note: Note) =>
    note.projectId !== null
      ? `Project: ${projects.find(({ id }) => id === note.projectId)?.title ?? "unknown"}`
      : note.tagId !== null
        ? `Tag: ${tags.find(({ id }) => id === note.tagId)?.displayName ?? "unknown"}`
        : "Standalone";
  const parseAssociation = (value: string) => ({
    projectId: value.startsWith("project:") ? value.slice(8) : null,
    tagId: value.startsWith("tag:") ? value.slice(4) : null,
  });
  const visibleNotes = notes.filter(
    (note) => noteFilter === "all" || noteAssociation(note) === noteFilter,
  );
  const associationOptions = (
    <>
      <option value="none">Standalone</option>
      {projects.map((project) => (
        <option key={project.id} value={`project:${project.id}`}>
          Project: {project.title}
        </option>
      ))}
      {tags.map((tag) => (
        <option key={tag.id} value={`tag:${tag.id}`}>
          Tag: {tag.displayName}
        </option>
      ))}
    </>
  );

  return (
    <Card aria-labelledby="organization-manager-title">
      <CardHeader>
        <SectionHeading
          id="organization-manager-title"
          as="h2"
          title="Manage projects, tags and notes"
        />
      </CardHeader>
      <CardContent className="organization-manager">
        {!online && (
          <p role="status">
            {queue === undefined
              ? "Organization changes need a connection."
              : "Completion, archive, restore and appearance changes are saved locally and sync later. Project and tag reorder, menu visibility and backlog need a connection."}{" "}
            {noteQueue === undefined
              ? "Notes are shown from this device and cannot be changed here."
              : "Notes are saved on this device and sync later."}
          </p>
        )}
        {error !== null && <p role="alert">{error}</p>}
        <section aria-labelledby="manage-projects">
          <h3 id="manage-projects">Projects</h3>
          {projects.length === 0 && <p>No projects yet.</p>}
          <ul className="organization-list">
            {projects.map((project, index) => {
              const projectTasks = tasks.filter(
                (task) => task.projectId === project.id,
              );
              return (
                <li key={project.id} aria-label={`Project ${project.title}`}>
                  <div className="organization-row">
                    <Swatch color={project.color} icon={project.icon} />
                    <strong>{project.title}</strong>
                    {project.completedAt !== null ? (
                      <Badge variant="success">Completed</Badge>
                    ) : (
                      project.archivedAt !== null && (
                        <Badge variant="secondary">Archived</Badge>
                      )
                    )}
                    {project.hiddenFromMenu && (
                      <Badge variant="outline">Hidden from menus</Badge>
                    )}
                  </div>
                  <div className="task-actions">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={disabled || index === 0}
                      onClick={() =>
                        void run(async () => {
                          onProjectsChange(
                            await reorderProjects(
                              move(projects, index, -1).map(
                                ({ id, revision }) => ({
                                  id,
                                  revision,
                                }),
                              ),
                              csrfToken,
                            ),
                          );
                        })
                      }
                    >
                      Move {project.title} up
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={disabled || index === projects.length - 1}
                      onClick={() =>
                        void run(async () => {
                          onProjectsChange(
                            await reorderProjects(
                              move(projects, index, 1).map(
                                ({ id, revision }) => ({
                                  id,
                                  revision,
                                }),
                              ),
                              csrfToken,
                            ),
                          );
                        })
                      }
                    >
                      Move {project.title} down
                    </Button>
                    {project.completedAt === null ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={lifecycleDisabled}
                        onClick={() =>
                          void updateProject(project, { completed: true })
                        }
                      >
                        Complete {project.title}
                      </Button>
                    ) : (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={lifecycleDisabled}
                        onClick={() =>
                          void updateProject(project, { completed: false })
                        }
                      >
                        Reopen {project.title}
                      </Button>
                    )}
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={lifecycleDisabled}
                      onClick={() =>
                        void updateProject(project, {
                          archived: project.archivedAt === null,
                        })
                      }
                    >
                      {project.archivedAt === null ? "Archive" : "Restore"}{" "}
                      {project.title}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={disabled}
                      onClick={() =>
                        void updateProject(project, {
                          hiddenFromMenu: !project.hiddenFromMenu,
                        })
                      }
                    >
                      {project.hiddenFromMenu ? "Show" : "Hide"} {project.title}{" "}
                      in menus
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={disabled}
                      onClick={() =>
                        void updateProject(project, {
                          backlogEnabled: !project.backlogEnabled,
                        })
                      }
                    >
                      {project.backlogEnabled ? "Disable" : "Enable"} backlog
                      for {project.title}
                    </Button>
                  </div>
                  <form
                    className="task-actions"
                    aria-label={`Appearance of ${project.title}`}
                    onSubmit={(event) =>
                      void updateProject(project, appearance(event))
                    }
                  >
                    <label className="field">
                      <span>Colour</span>
                      <Input
                        type="color"
                        name="color"
                        defaultValue={project.color ?? "#8888cc"}
                      />
                    </label>
                    <label>
                      <input type="checkbox" name="clearColor" /> No colour
                    </label>
                    <label className="field">
                      <span>Icon name or emoji</span>
                      <Input
                        name="icon"
                        autoComplete="off"
                        defaultValue={project.icon ?? ""}
                      />
                    </label>
                    <Button size="sm" disabled={lifecycleDisabled}>
                      Save appearance
                    </Button>
                  </form>
                  {project.backlogEnabled && (
                    <div className="organization-backlog">
                      <h4>Backlog</h4>
                      {projectTasks.length === 0 && (
                        <p>No tasks in this project.</p>
                      )}
                      <ul>
                        {projectTasks.map((task) => {
                          const inBacklog = project.backlogTaskIds.includes(
                            task.id,
                          );
                          return (
                            <li key={task.id}>
                              {task.title}{" "}
                              {inBacklog && (
                                <Badge variant="secondary">Backlog</Badge>
                              )}{" "}
                              <Button
                                type="button"
                                size="xs"
                                variant="outline"
                                disabled={
                                  disabled || project.archivedAt !== null
                                }
                                onClick={() =>
                                  void run(async () => {
                                    onProjectsChange(
                                      replace(
                                        projects,
                                        await setProjectBacklog(
                                          project.id,
                                          project.revision,
                                          task.id,
                                          !inBacklog,
                                          csrfToken,
                                        ),
                                      ),
                                    );
                                  })
                                }
                              >
                                {inBacklog
                                  ? "Move to active"
                                  : "Move to backlog"}
                              </Button>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
        <section aria-labelledby="manage-tags">
          <h3 id="manage-tags">Tags</h3>
          {tags.length === 0 && <p>No tags yet.</p>}
          <ul className="organization-list">
            {tags.map((tag, index) => (
              <li key={tag.id} aria-label={`Tag ${tag.displayName}`}>
                <div className="organization-row">
                  <Swatch color={tag.color} icon={tag.icon} />
                  <strong>{tag.displayName}</strong>
                  {tag.archivedAt !== null && (
                    <Badge variant="secondary">Archived</Badge>
                  )}
                </div>
                <div className="task-actions">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={disabled || index === 0}
                    onClick={() =>
                      void run(async () => {
                        onTagsChange(
                          await reorderTags(
                            move(tags, index, -1).map(({ id, revision }) => ({
                              id,
                              revision,
                            })),
                            csrfToken,
                          ),
                        );
                      })
                    }
                  >
                    Move {tag.displayName} up
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={disabled || index === tags.length - 1}
                    onClick={() =>
                      void run(async () => {
                        onTagsChange(
                          await reorderTags(
                            move(tags, index, 1).map(({ id, revision }) => ({
                              id,
                              revision,
                            })),
                            csrfToken,
                          ),
                        );
                      })
                    }
                  >
                    Move {tag.displayName} down
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={lifecycleDisabled}
                    onClick={() =>
                      void updateTag(tag, { archived: tag.archivedAt === null })
                    }
                  >
                    {tag.archivedAt === null ? "Archive" : "Restore"}{" "}
                    {tag.displayName}
                  </Button>
                </div>
                <form
                  className="task-actions"
                  aria-label={`Appearance of ${tag.displayName}`}
                  onSubmit={(event) => void updateTag(tag, appearance(event))}
                >
                  <label className="field">
                    <span>Colour</span>
                    <Input
                      type="color"
                      name="color"
                      defaultValue={tag.color ?? "#8888cc"}
                    />
                  </label>
                  <label>
                    <input type="checkbox" name="clearColor" /> No colour
                  </label>
                  <label className="field">
                    <span>Icon name or emoji</span>
                    <Input
                      name="icon"
                      autoComplete="off"
                      defaultValue={tag.icon ?? ""}
                    />
                  </label>
                  <Button size="sm" disabled={lifecycleDisabled}>
                    Save appearance
                  </Button>
                </form>
              </li>
            ))}
          </ul>
        </section>
        <section aria-labelledby="manage-notes">
          <h3 id="manage-notes">Notes</h3>
          <p>
            Notes use Markdown: headings, lists, checkboxes, quotes, code, bold,
            italic and http, https or mailto links. HTML is shown as text.
          </p>
          <form
            className="task-edit"
            aria-label="New note"
            onSubmit={(event) => {
              event.preventDefault();
              const form = event.currentTarget;
              const data = new FormData(form);
              if (noteQueue === undefined) return;
              void run(async () => {
                await noteQueue.create({
                  content: text(data, "content"),
                  ...parseAssociation(text(data, "association")),
                  pinnedToToday: data.get("pinnedToToday") === "on",
                });
                form.reset();
              });
            }}
          >
            <label className="field">
              <span>New note</span>
              <Textarea name="content" required maxLength={20000} />
            </label>
            <label className="field">
              <span>Belongs to</span>
              <NativeSelect name="association" defaultValue="none">
                {associationOptions}
              </NativeSelect>
            </label>
            <label>
              <input type="checkbox" name="pinnedToToday" /> Pin to Today
            </label>
            <Button disabled={notesDisabled}>Add note</Button>
          </form>
          <label className="field">
            <span>Show notes for</span>
            <NativeSelect
              value={noteFilter}
              onChange={(event) => setNoteFilter(event.currentTarget.value)}
            >
              <option value="all">All notes</option>
              {associationOptions}
            </NativeSelect>
          </label>
          {visibleNotes.length === 0 && <p>No notes here.</p>}
          <ul className="organization-list">
            {visibleNotes.map((note) => {
              const visibleIndex = visibleNotes.indexOf(note);
              // Swap with the neighbouring visible note, even under a filter.
              const reorder = (offset: -1 | 1) => {
                const neighbour = visibleNotes[visibleIndex + offset];
                if (neighbour === undefined || noteQueue === undefined) return;
                void run(() => noteQueue.swap(note, neighbour));
              };
              return (
                <li key={note.id} className="organization-note">
                  <div className="organization-row">
                    <small>{associationLabel(note)}</small>
                    {note.pinnedToToday && (
                      <Badge variant="now">Pinned to Today</Badge>
                    )}
                  </div>
                  {editingNote === note.id ? (
                    <form
                      className="task-edit"
                      aria-label="Edit note"
                      onSubmit={(event) => {
                        event.preventDefault();
                        const data = new FormData(event.currentTarget);
                        if (noteQueue === undefined) return;
                        void run(async () => {
                          await noteQueue.patch(note, {
                            content: text(data, "content"),
                            ...parseAssociation(text(data, "association")),
                          });
                          setEditingNote(null);
                        });
                      }}
                    >
                      <label className="field">
                        <span>Note</span>
                        <Textarea
                          name="content"
                          required
                          maxLength={20000}
                          defaultValue={note.content}
                        />
                      </label>
                      <label className="field">
                        <span>Belongs to</span>
                        <NativeSelect
                          name="association"
                          defaultValue={noteAssociation(note)}
                        >
                          {associationOptions}
                        </NativeSelect>
                      </label>
                      <Button size="sm" disabled={notesDisabled}>
                        Save note
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => setEditingNote(null)}
                      >
                        Cancel
                      </Button>
                    </form>
                  ) : (
                    <NoteMarkdown content={note.content} />
                  )}
                  <div className="task-actions">
                    <Button
                      type="button"
                      size="xs"
                      variant="outline"
                      disabled={notesDisabled}
                      onClick={() => setEditingNote(note.id)}
                    >
                      Edit
                    </Button>
                    <Button
                      type="button"
                      size="xs"
                      variant="outline"
                      disabled={notesDisabled}
                      onClick={() =>
                        void run(async () => {
                          await noteQueue?.patch(note, {
                            pinnedToToday: !note.pinnedToToday,
                          });
                        })
                      }
                    >
                      {note.pinnedToToday ? "Unpin" : "Pin to Today"}
                    </Button>
                    <Button
                      type="button"
                      size="xs"
                      variant="outline"
                      disabled={notesDisabled || visibleIndex === 0}
                      onClick={() => reorder(-1)}
                    >
                      Move up
                    </Button>
                    <Button
                      type="button"
                      size="xs"
                      variant="outline"
                      disabled={
                        notesDisabled ||
                        visibleIndex === visibleNotes.length - 1
                      }
                      onClick={() => reorder(1)}
                    >
                      Move down
                    </Button>
                    <Button
                      type="button"
                      size="xs"
                      variant="destructive"
                      disabled={notesDisabled}
                      onClick={() =>
                        void run(async () => {
                          await noteQueue?.remove(note);
                        })
                      }
                    >
                      Delete note
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      </CardContent>
    </Card>
  );
};
