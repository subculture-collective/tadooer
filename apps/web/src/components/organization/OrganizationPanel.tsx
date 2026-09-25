import { useEffect, useState, type SyntheticEvent } from "react";
import type { Note, Project, Tag, Task } from "@suite/contracts";
import {
  createNote,
  deleteNote,
  getNotes,
  patchNote,
  patchProject,
  patchTag,
  reorderNotes,
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

export interface OrganizationPanelProps {
  readonly projects: readonly Project[];
  readonly tags: readonly Tag[];
  readonly tasks: readonly Task[];
  readonly csrfToken: string;
  readonly online: boolean;
  readonly onProjectsChange: (projects: readonly Project[]) => void;
  readonly onTagsChange: (tags: readonly Tag[]) => void;
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
 * Project, tag, backlog and note management. Writes are online HTTP requests
 * with revision preconditions; notes are read online and are not cached.
 */
export const OrganizationPanel = ({
  projects,
  tags,
  tasks,
  csrfToken,
  online,
  onProjectsChange,
  onTagsChange,
}: OrganizationPanelProps) => {
  const [notes, setNotes] = useState<readonly Note[]>([]);
  const [notesLoaded, setNotesLoaded] = useState(false);
  const [noteFilter, setNoteFilter] = useState("all");
  const [editingNote, setEditingNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!online) return;
    let current = true;
    getNotes()
      .then((loaded) => {
        if (!current) return;
        setNotes(loaded);
        setNotesLoaded(true);
      })
      .catch((cause: unknown) => {
        if (current) setError(failure(cause));
      });
    return () => {
      current = false;
    };
  }, [online]);

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

  const updateProject = (
    project: Project,
    input: Parameters<typeof patchProject>[2],
  ) =>
    run(async () => {
      onProjectsChange(
        replace(
          projects,
          await patchProject(project.id, project.revision, input, csrfToken),
        ),
      );
    });
  const updateTag = (tag: Tag, input: Parameters<typeof patchTag>[2]) =>
    run(async () => {
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
            Organization changes and notes need a connection. Notes are not
            available offline.
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
                        disabled={disabled}
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
                        disabled={disabled}
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
                      disabled={disabled}
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
                    <Button size="sm" disabled={disabled}>
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
                    disabled={disabled}
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
                  <Button size="sm" disabled={disabled}>
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
              void run(async () => {
                const note = await createNote(
                  {
                    content: text(data, "content"),
                    ...parseAssociation(text(data, "association")),
                    pinnedToToday: data.get("pinnedToToday") === "on",
                  },
                  csrfToken,
                );
                setNotes((current) => [...current, note]);
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
            <Button disabled={disabled}>Add note</Button>
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
          {notesLoaded && visibleNotes.length === 0 && <p>No notes here.</p>}
          <ul className="organization-list">
            {visibleNotes.map((note) => {
              const visibleIndex = visibleNotes.indexOf(note);
              // Swap with the neighbouring visible note, even under a filter.
              const reorder = (offset: -1 | 1) => {
                const neighbour = visibleNotes[visibleIndex + offset];
                if (neighbour === undefined) return;
                const next = notes.map((item) =>
                  item.id === note.id
                    ? neighbour
                    : item.id === neighbour.id
                      ? note
                      : item,
                );
                void run(async () => {
                  setNotes(
                    await reorderNotes(
                      next.map(({ id, revision }) => ({ id, revision })),
                      csrfToken,
                    ),
                  );
                });
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
                        void run(async () => {
                          const saved = await patchNote(
                            note.id,
                            note.revision,
                            {
                              content: text(data, "content"),
                              ...parseAssociation(text(data, "association")),
                            },
                            csrfToken,
                          );
                          setNotes((current) => replace(current, saved));
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
                      <Button size="sm" disabled={disabled}>
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
                      disabled={disabled}
                      onClick={() => setEditingNote(note.id)}
                    >
                      Edit
                    </Button>
                    <Button
                      type="button"
                      size="xs"
                      variant="outline"
                      disabled={disabled}
                      onClick={() =>
                        void run(async () => {
                          const saved = await patchNote(
                            note.id,
                            note.revision,
                            { pinnedToToday: !note.pinnedToToday },
                            csrfToken,
                          );
                          setNotes((current) => replace(current, saved));
                        })
                      }
                    >
                      {note.pinnedToToday ? "Unpin" : "Pin to Today"}
                    </Button>
                    <Button
                      type="button"
                      size="xs"
                      variant="outline"
                      disabled={disabled || visibleIndex === 0}
                      onClick={() => reorder(-1)}
                    >
                      Move up
                    </Button>
                    <Button
                      type="button"
                      size="xs"
                      variant="outline"
                      disabled={
                        disabled || visibleIndex === visibleNotes.length - 1
                      }
                      onClick={() => reorder(1)}
                    >
                      Move down
                    </Button>
                    <Button
                      type="button"
                      size="xs"
                      variant="destructive"
                      disabled={disabled}
                      onClick={() =>
                        void run(async () => {
                          await deleteNote(note.id, note.revision, csrfToken);
                          setNotes((current) =>
                            current.filter(({ id }) => id !== note.id),
                          );
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
