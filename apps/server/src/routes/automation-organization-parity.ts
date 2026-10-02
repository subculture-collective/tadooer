import type {
  AutomationConfirmationResponse,
  AutomationPreviewCommand,
} from "@suite/contracts";
import type {
  OrganizationFields,
  ProjectRecord,
  SuiteDatabase,
  TagRecord,
} from "@suite/persistence";
import { noteResponse, projectResponse, tagResponse } from "./shared.ts";

// Organization parity operations (issue #28, ADR 0019). automation.ts keeps
// the shared preview/confirm protocol; this module supplies the domain checks.

export type OrganizationParityCommand = Extract<
  AutomationPreviewCommand,
  {
    operation:
      | "projects.reorder"
      | "tags.reorder"
      | "projects.set_backlog"
      | "notes.mutate";
  }
>;
type ProjectMutation = Extract<
  AutomationPreviewCommand,
  { operation: "projects.mutate" }
>["input"];
type TagMutation = Extract<
  AutomationPreviewCommand,
  { operation: "tags.mutate" }
>["input"];

interface Affected {
  readonly entityKind: "project" | "tag" | "note" | "task";
  readonly entityId: string;
}
interface BaseRevision extends Affected {
  readonly revision: number;
}
export type ParityPreview =
  | {
      readonly ok: true;
      readonly summary: string;
      readonly affected: readonly Affected[];
      readonly baseRevisions: readonly BaseRevision[];
    }
  | {
      readonly ok: false;
      readonly status: number;
      readonly code: string;
      readonly message: string;
    };
type Result = AutomationConfirmationResponse["result"];
export type ParityConfirmation =
  | { readonly ok: true; readonly apply: () => Result }
  | { readonly ok: false; readonly status: number; readonly message: string };

export const isOrganizationParityCommand = (
  command: AutomationPreviewCommand,
): command is OrganizationParityCommand =>
  command.operation === "projects.reorder" ||
  command.operation === "tags.reorder" ||
  command.operation === "projects.set_backlog" ||
  command.operation === "notes.mutate";

/** Maps an assistant lifecycle action onto the shared persistence boundary. */
export const organizationFieldsFor = (
  input: ProjectMutation | TagMutation,
): OrganizationFields => {
  switch (input.action) {
    case "create":
    case "rename":
      return { title: input.title };
    case "archive":
    case "restore":
      return { archived: input.action === "archive" };
    case "complete":
    case "reopen":
      return { completed: input.action === "complete" };
    case "configure": {
      return Object.fromEntries(
        Object.entries(input).filter(
          ([key]) => !["action", "id", "expectedRevision"].includes(key),
        ),
      );
    }
  }
};

export const organizationSummary = (
  kind: "project" | "tag",
  input: ProjectMutation | TagMutation,
  currentTitle: string,
): string => {
  switch (input.action) {
    case "create":
      return `Create ${kind} "${input.title}"`;
    case "rename":
      return `Rename ${kind} "${currentTitle}" to "${input.title}"`;
    case "archive":
      return `Archive ${kind} "${currentTitle}"; task assignments are retained`;
    case "restore":
      return `Restore ${kind} "${currentTitle}"${kind === "project" ? " and clear any completion" : ""}; task assignments are retained`;
    case "complete":
      return `Complete and archive project "${currentTitle}"; task assignments are retained`;
    case "reopen":
      return `Reopen project "${currentTitle}" as active`;
    case "configure":
      return `Change ${kind} "${currentTitle}" settings: ${Object.keys(
        organizationFieldsFor(input),
      ).join(", ")}`;
  }
};

const conflict = (message: string): ParityPreview => ({
  ok: false,
  status: 412,
  code: "REVISION_CONFLICT",
  message,
});

const orderMatches = (
  current: readonly { readonly id: string; readonly revision: number }[],
  items: readonly { readonly id: string; readonly revision: number }[],
) =>
  current.length === items.length &&
  items.every(
    (item) =>
      current.find(({ id }) => id === item.id)?.revision === item.revision,
  );

export const previewOrganizationParity = (
  database: SuiteDatabase,
  ownerId: string,
  command: OrganizationParityCommand,
): ParityPreview => {
  if (
    command.operation === "projects.reorder" ||
    command.operation === "tags.reorder"
  ) {
    const kind = command.operation === "projects.reorder" ? "project" : "tag";
    const current: readonly (ProjectRecord | TagRecord)[] =
      kind === "project"
        ? database.listProjects(ownerId)
        : database.listTags(ownerId);
    if (!orderMatches(current, command.input.items))
      return conflict(
        `Every ${kind} must be listed once with its current revision`,
      );
    return {
      ok: true,
      summary: `Reorder all ${String(current.length)} ${kind}s: ${command.input.items
        .map(
          ({ id }) =>
            `"${current.find((record) => record.id === id)?.title ?? id}"`,
        )
        .join(", ")}`,
      affected: current.map(({ id }) => ({ entityKind: kind, entityId: id })),
      baseRevisions: current.map(({ id, revision }) => ({
        entityKind: kind,
        entityId: id,
        revision,
      })),
    };
  }
  if (command.operation === "projects.set_backlog") {
    const input = command.input;
    const project = database
      .listProjects(ownerId)
      .find(({ id }) => id === input.projectId);
    if (project?.revision !== input.expectedRevision)
      return conflict("Project changed or is unavailable");
    const task = database.getTask(ownerId, input.taskId);
    if (
      task?.projectId !== project.id ||
      !project.backlogEnabled ||
      project.archivedAt !== null ||
      project.backlogTaskIds.includes(task.id) === input.inBacklog
    )
      return {
        ok: false,
        status: 409,
        code: "BACKLOG_MOVE_INVALID",
        message:
          "The task must be an active task of this unarchived project with its backlog enabled, and the move must change membership",
      };
    return {
      ok: true,
      summary: `Move task "${task.title}" ${input.inBacklog ? "into" : "out of"} the backlog of project "${project.title}"`,
      affected: [
        { entityKind: "project", entityId: project.id },
        { entityKind: "task", entityId: task.id },
      ],
      baseRevisions: [
        {
          entityKind: "project",
          entityId: project.id,
          revision: project.revision,
        },
      ],
    };
  }
  const input = command.input;
  if (input.action === "reorder") {
    const current = database.notes.list(ownerId);
    if (!orderMatches(current, input.items))
      return conflict(
        "Every note must be listed once with its current revision",
      );
    return {
      ok: true,
      summary: `Reorder all ${String(current.length)} notes`,
      affected: current.map(({ id }) => ({ entityKind: "note", entityId: id })),
      baseRevisions: current.map(({ id, revision }) => ({
        entityKind: "note",
        entityId: id,
        revision,
      })),
    };
  }
  if (input.action === "create") {
    if (database.notes.get(ownerId, input.id) !== undefined)
      return conflict("Note already exists");
    if (
      !database.notes.associationExists(ownerId, input.projectId, input.tagId)
    )
      return {
        ok: false,
        status: 404,
        code: "NOTE_ASSOCIATION_NOT_FOUND",
        message: "Project or tag not found",
      };
    return {
      ok: true,
      summary: `Create ${input.pinnedToToday ? "a note pinned to Today" : "a note"} (${String(input.content.length)} characters)${input.projectId === null ? "" : " in a project"}${input.tagId === null ? "" : " for a tag"}`,
      affected: [{ entityKind: "note", entityId: input.id }],
      baseRevisions: [],
    };
  }
  const note = database.notes.get(ownerId, input.id);
  if (note?.revision !== input.expectedRevision)
    return conflict("Note changed or is unavailable");
  if (
    input.action === "update" &&
    !database.notes.associationExists(
      ownerId,
      input.patch.projectId === undefined
        ? input.patch.tagId != null
          ? null
          : note.projectId
        : input.patch.projectId,
      input.patch.tagId === undefined
        ? input.patch.projectId != null
          ? null
          : note.tagId
        : input.patch.tagId,
    )
  )
    return {
      ok: false,
      status: 404,
      code: "NOTE_ASSOCIATION_NOT_FOUND",
      message: "Project or tag not found",
    };
  const excerpt = note.content.trim().split("\n", 1)[0]?.slice(0, 60) ?? "";
  return {
    ok: true,
    summary:
      input.action === "delete"
        ? `Permanently delete note "${excerpt}"`
        : `Edit note "${excerpt}": ${Object.keys(input.patch).join(", ")}`,
    affected: [{ entityKind: "note", entityId: note.id }],
    baseRevisions: [
      { entityKind: "note", entityId: note.id, revision: note.revision },
    ],
  };
};

/**
 * Revalidates stale-sensitive membership, then returns the atomic mutation run
 * inside the confirmation transaction. A throw there rolls everything back.
 */
export const confirmOrganizationParity = (
  database: SuiteDatabase,
  ownerId: string,
  command: OrganizationParityCommand,
): ParityConfirmation => {
  const now = () => new Date().toISOString();
  if (
    command.operation === "projects.reorder" ||
    command.operation === "tags.reorder"
  ) {
    const kind = command.operation === "projects.reorder" ? "project" : "tag";
    const current: readonly (ProjectRecord | TagRecord)[] =
      kind === "project"
        ? database.listProjects(ownerId)
        : database.listTags(ownerId);
    if (!orderMatches(current, command.input.items))
      return {
        ok: false,
        status: 412,
        message: `${kind === "project" ? "Project" : "Tag"} membership changed before confirmation`,
      };
    return {
      ok: true,
      apply: () => {
        const records = database.reorderOrganization(
          kind,
          ownerId,
          command.input.items,
          now(),
        );
        if (records === undefined)
          throw new Error("Order changed during atomic confirmation");
        return kind === "project"
          ? {
              projects: records.map((record) =>
                projectResponse(record as ProjectRecord),
              ),
            }
          : {
              tags: records.map((record) => tagResponse(record as TagRecord)),
            };
      },
    };
  }
  if (command.operation === "projects.set_backlog") {
    const input = command.input;
    return {
      ok: true,
      apply: () => {
        const result = database.setProjectBacklog(
          ownerId,
          input.projectId,
          input.expectedRevision,
          input.taskId,
          input.inBacklog,
          now(),
        );
        if (result.kind !== "applied")
          throw new Error("Backlog changed during atomic confirmation");
        return { project: projectResponse(result.project) };
      },
    };
  }
  const input = command.input;
  if (input.action === "reorder") {
    if (!orderMatches(database.notes.list(ownerId), input.items))
      return {
        ok: false,
        status: 412,
        message: "Note membership changed before confirmation",
      };
  }
  if (
    input.action === "create" &&
    database.notes.get(ownerId, input.id) !== undefined
  )
    return { ok: false, status: 412, message: "Note already exists" };
  return {
    ok: true,
    apply: () => {
      const result =
        input.action === "create"
          ? database.notes.create(ownerId, input, now())
          : input.action === "update"
            ? database.notes.update(
                ownerId,
                input.id,
                input.expectedRevision,
                input.patch,
                now(),
              )
            : input.action === "delete"
              ? database.notes.delete(
                  ownerId,
                  input.id,
                  input.expectedRevision,
                  now(),
                )
              : database.notes.reorder(ownerId, input.items, now());
      if (result.kind !== "applied")
        throw new Error("Note changed during atomic confirmation");
      return {
        notes: result.notes.map(noteResponse),
        deletedIds: input.action === "delete" ? [input.id] : [],
      };
    },
  };
};
