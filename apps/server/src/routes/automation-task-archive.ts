import type {
  AutomationConfirmationResponse,
  AutomationPreviewCommand,
} from "@suite/contracts";
import { validateTaskArchive } from "@suite/domain";
import type { SuiteDatabase, TaskRecord } from "@suite/persistence";
import {
  archiveViolationError,
  taskArchiveMutationBody,
} from "./task-archive.ts";

// Archive and unarchive assistant operations (issue #38, ADR 0022).
// automation.ts keeps the shared preview/confirm protocol; this module supplies
// the domain checks. A preview freezes the parent and every child it moves.

export type TaskArchiveCommand = Extract<
  AutomationPreviewCommand,
  { operation: "tasks.archive" | "tasks.unarchive" }
>;

interface Affected {
  readonly entityKind: "task";
  readonly entityId: string;
}
interface BaseRevision extends Affected {
  readonly revision: number;
}
export type ArchivePreview =
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

export const isTaskArchiveCommand = (
  command: AutomationPreviewCommand,
): command is TaskArchiveCommand =>
  command.operation === "tasks.archive" ||
  command.operation === "tasks.unarchive";

/** The family that the operation would move, or an error response. */
const plan = (
  database: SuiteDatabase,
  ownerId: string,
  command: TaskArchiveCommand,
):
  | { readonly task: TaskRecord; readonly children: readonly TaskRecord[] }
  | Extract<ArchivePreview, { ok: false }> => {
  const archive = command.operation === "tasks.archive";
  const task = archive
    ? database.getTask(ownerId, command.input.taskId)
    : database.getTask(ownerId, command.input.taskId, true);
  if (task?.deletedAt !== null || (!archive && task.archivedAt == null))
    return {
      ok: false,
      status: 404,
      code: "TASK_NOT_FOUND",
      message: archive ? "Task not found" : "Archived task not found",
    };
  if (task.revision !== command.input.expectedRevision)
    return {
      ok: false,
      status: 412,
      code: "REVISION_CONFLICT",
      message: "Task changed before preview",
    };
  const violation = validateTaskArchive({
    task,
    action: archive ? "archive" : "restore",
    blocked:
      archive && database.taskArchive.blockedIds(ownerId, task.id).length > 0,
  });
  if (violation !== null)
    return { ok: false, ...archiveViolationError(violation) };
  const children = archive
    ? database.taskHierarchy.listChildren(ownerId, task.id)
    : database.taskHierarchy
        .listChildren(ownerId, task.id, true)
        .filter(
          (child) => child.archivedAt != null && child.deletedAt === null,
        );
  return { task, children };
};

export const previewTaskArchive = (
  database: SuiteDatabase,
  ownerId: string,
  command: TaskArchiveCommand,
): ArchivePreview => {
  const planned = plan(database, ownerId, command);
  if ("ok" in planned) return planned;
  const family = [planned.task, ...planned.children];
  const children =
    planned.children.length === 0
      ? ""
      : ` with ${String(planned.children.length)} child task${planned.children.length === 1 ? "" : "s"}`;
  return {
    ok: true,
    summary:
      command.operation === "tasks.archive"
        ? `Archive task "${planned.task.title}"${children}; it leaves active lists, Today, the Planner and reminders and stays searchable in History`
        : `Restore archived task "${planned.task.title}"${children} to active tasks; completion and dates are unchanged`,
    affected: family.map(({ id }) => ({ entityKind: "task", entityId: id })),
    baseRevisions: family.map(({ id, revision }) => ({
      entityKind: "task",
      entityId: id,
      revision,
    })),
  };
};

/** Confirmation re-checks the frozen family inside the confirmation transaction. */
export const confirmTaskArchive = (
  database: SuiteDatabase,
  ownerId: string,
  command: TaskArchiveCommand,
  frozenIds: readonly string[],
):
  | { readonly ok: true; readonly apply: () => Result }
  | {
      readonly ok: false;
      readonly status: number;
      readonly message: string;
    } => {
  const planned = plan(database, ownerId, command);
  if ("ok" in planned)
    return { ok: false, status: planned.status, message: planned.message };
  const family = [planned.task, ...planned.children].map(({ id }) => id);
  if (
    family.length !== frozenIds.length ||
    family.some((id) => !frozenIds.includes(id))
  )
    return {
      ok: false,
      status: 412,
      message: "The task's children changed after preview",
    };
  return {
    ok: true,
    apply: () => {
      const input = {
        ownerId,
        taskId: command.input.taskId,
        expectedRevision: command.input.expectedRevision,
        now: new Date().toISOString(),
      };
      const result =
        command.operation === "tasks.archive"
          ? database.taskArchive.archive(input)
          : database.taskArchive.restore(input);
      if (result.kind !== "archived" && result.kind !== "restored")
        throw new Error("Task archive changed during atomic confirmation");
      return taskArchiveMutationBody(result);
    },
  };
};
