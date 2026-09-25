import type {
  AutomationConfirmationResponse,
  AutomationPreviewCommand,
} from "@suite/contracts";
import type { SuiteDatabase } from "@suite/persistence";
import { taskLinksResponse } from "./task-links.ts";

// Task attachments and imported issue links (issue #30, ADR 0021).
// automation.ts keeps the shared preview/confirm protocol; this module
// supplies the domain checks. Summaries name hosts and titles, never full
// addresses, so preview records carry no query-string tokens.

export type TaskLinkCommand = Extract<
  AutomationPreviewCommand,
  { operation: "task_links.mutate" }
>;

interface Affected {
  readonly entityKind: "task" | "task_attachment" | "task_issue_link";
  readonly entityId: string;
}
interface BaseRevision extends Affected {
  readonly revision: number;
}
export type TaskLinkPreview =
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
export type TaskLinkConfirmation =
  | { readonly ok: true; readonly apply: () => Result }
  | { readonly ok: false; readonly status: number; readonly message: string };

export const isTaskLinkCommand = (
  command: AutomationPreviewCommand,
): command is TaskLinkCommand => command.operation === "task_links.mutate";

const host = (url: string | null): string => {
  if (url === null) return "no address";
  try {
    return new URL(url).host;
  } catch {
    return "an address";
  }
};

const quoted = (value: string): string =>
  `"${value.length > 60 ? `${value.slice(0, 57)}...` : value}"`;

const stale = (message: string): TaskLinkPreview => ({
  ok: false,
  status: 412,
  code: "REVISION_CONFLICT",
  message,
});

export const previewTaskLinks = (
  database: SuiteDatabase,
  ownerId: string,
  command: TaskLinkCommand,
): TaskLinkPreview => {
  const input = command.input;
  if (input.action === "add_attachment") {
    const task = database.getTask(ownerId, input.taskId);
    if (task === undefined)
      return {
        ok: false,
        status: 404,
        code: "TASK_NOT_FOUND",
        message: "Task not found",
      };
    if (database.taskLinks.getAttachment(ownerId, input.id) !== undefined)
      return stale("Attachment already exists");
    if (
      database.taskLinks.canCreateAttachment(
        ownerId,
        input.taskId,
        input.attachment,
      ) !== "ok"
    )
      return {
        ok: false,
        status: 409,
        code: "TASK_ATTACHMENT_INVALID",
        message:
          "Attachment is invalid or the task already holds 100 attachments",
      };
    const attachment = input.attachment;
    return {
      ok: true,
      summary:
        attachment.kind === "link"
          ? `Add a link to ${host(attachment.url)} on task ${quoted(task.title)}`
          : `Add a note attachment (${String(attachment.text.length)} characters) to task ${quoted(task.title)}`,
      affected: [
        { entityKind: "task", entityId: task.id },
        { entityKind: "task_attachment", entityId: input.id },
      ],
      baseRevisions: [],
    };
  }
  if (input.action === "remove_issue_link") {
    const link = database.taskLinks.getIssueLink(ownerId, input.id);
    const task =
      link === undefined ? undefined : database.getTask(ownerId, link.taskId);
    if (link?.revision !== input.expectedRevision || task === undefined)
      return stale("Issue link changed or is unavailable");
    return {
      ok: true,
      summary: `Remove the ${link.providerKey ?? "unknown provider"} issue link from task ${quoted(task.title)}; the import provenance keeps the original fields`,
      affected: [{ entityKind: "task_issue_link", entityId: link.id }],
      baseRevisions: [
        {
          entityKind: "task_issue_link",
          entityId: link.id,
          revision: link.revision,
        },
      ],
    };
  }
  const attachment = database.taskLinks.getAttachment(ownerId, input.id);
  const task =
    attachment === undefined
      ? undefined
      : database.getTask(ownerId, attachment.taskId);
  if (attachment?.revision !== input.expectedRevision || task === undefined)
    return stale("Attachment changed or is unavailable");
  if (
    input.action === "update_attachment" &&
    !database.taskLinks.checkAttachmentPatch(attachment, input.patch)
  )
    return {
      ok: false,
      status: 409,
      code: "TASK_ATTACHMENT_INVALID",
      message: "Only link addresses and note text can change for their kind",
    };
  const label = attachment.title === "" ? attachment.kind : attachment.title;
  return {
    ok: true,
    summary:
      input.action === "remove_attachment"
        ? `Permanently remove ${attachment.kind} attachment ${quoted(label)} from task ${quoted(task.title)}`
        : `Edit ${attachment.kind} attachment ${quoted(label)} on task ${quoted(task.title)}: ${Object.keys(input.patch).join(", ")}`,
    affected: [{ entityKind: "task_attachment", entityId: attachment.id }],
    baseRevisions: [
      {
        entityKind: "task_attachment",
        entityId: attachment.id,
        revision: attachment.revision,
      },
    ],
  };
};

/**
 * Returns the atomic mutation run inside the confirmation transaction. The
 * frozen base revisions are checked by automation.ts before this runs.
 */
export const confirmTaskLinks = (
  database: SuiteDatabase,
  ownerId: string,
  command: TaskLinkCommand,
): TaskLinkConfirmation => {
  const input = command.input;
  if (
    input.action === "add_attachment" &&
    database.taskLinks.getAttachment(ownerId, input.id) !== undefined
  )
    return { ok: false, status: 412, message: "Attachment already exists" };
  return {
    ok: true,
    apply: () => {
      const now = new Date().toISOString();
      const result =
        input.action === "add_attachment"
          ? database.taskLinks.createAttachment(
              ownerId,
              input.taskId,
              input.id,
              input.attachment,
              now,
            )
          : input.action === "update_attachment"
            ? database.taskLinks.updateAttachment(
                ownerId,
                input.id,
                input.expectedRevision,
                input.patch,
                now,
              )
            : input.action === "remove_attachment"
              ? database.taskLinks.deleteAttachment(
                  ownerId,
                  input.id,
                  input.expectedRevision,
                )
              : database.taskLinks.deleteIssueLink(
                  ownerId,
                  input.id,
                  input.expectedRevision,
                );
      if (result.kind !== "applied")
        throw new Error("Task link changed during atomic confirmation");
      return taskLinksResponse(result.links);
    },
  };
};
