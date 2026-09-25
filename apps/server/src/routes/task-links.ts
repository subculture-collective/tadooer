import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import {
  taskAttachmentCreateRequestSchema,
  taskAttachmentPatchRequestSchema,
  type TaskLinksResponse,
} from "@suite/contracts";
import type {
  TaskLinkMutationResult,
  TaskLinksRecord,
} from "@suite/persistence";
import {
  expectedRevision,
  readJson,
  sameOrigin,
  sendError,
  sendJson,
} from "../http-utils.ts";
import { sendEmpty, type RouteHandler } from "./shared.ts";

export const taskLinksResponse = (
  links: TaskLinksRecord,
): TaskLinksResponse => ({
  taskId: links.taskId,
  issueLink:
    links.issueLink === null
      ? null
      : {
          ...links.issueLink,
          syncMetadata: { ...links.issueLink.syncMetadata },
        },
  attachments: links.attachments.map((attachment) => ({ ...attachment })),
});

const sendOutcome = (
  response: ServerResponse,
  result: TaskLinkMutationResult,
  success: (links: TaskLinksRecord) => void,
) => {
  if (result.kind === "not_found")
    sendError(response, 404, "TASK_LINK_NOT_FOUND", "Task link not found");
  else if (result.kind === "conflict")
    sendError(
      response,
      412,
      "TASK_LINK_REVISION_CONFLICT",
      "The link changed; reload before trying again",
    );
  else if (result.kind === "invalid")
    sendError(
      response,
      400,
      "INVALID_TASK_ATTACHMENT",
      "Provide an http or https link or note text; a task holds at most 100 attachments",
    );
  else success(result.links);
};

const uuid = "[0-9a-f-]{36}";
const linksPath = new RegExp(`^/api/tasks/(${uuid})/links$`);
const attachmentsPath = new RegExp(`^/api/tasks/(${uuid})/attachments$`);
const attachmentPath = new RegExp(
  `^/api/tasks/(${uuid})/attachments/(${uuid})$`,
);
const issueLinkPath = new RegExp(`^/api/tasks/(${uuid})/issue-link/(${uuid})$`);

/**
 * Online-only task attachments and imported issue links (ADR 0021). They are
 * not in the sync change feed. No route contacts an issue provider.
 */
export const handleTaskLinks: RouteHandler = async (
  request,
  response,
  url,
  { auth, stores },
) => {
  const method = request.method ?? "GET";
  const listMatch = linksPath.exec(url.pathname);
  const createMatch = attachmentsPath.exec(url.pathname);
  const attachmentMatch = attachmentPath.exec(url.pathname);
  const issueMatch = issueLinkPath.exec(url.pathname);
  const list = method === "GET" && listMatch !== null;
  const create = method === "POST" && createMatch !== null;
  const patch = method === "PATCH" && attachmentMatch !== null;
  const removeAttachment = method === "DELETE" && attachmentMatch !== null;
  const removeIssue = method === "DELETE" && issueMatch !== null;
  if (!list && !create && !patch && !removeAttachment && !removeIssue)
    return false;
  const session = auth.authenticate(request, !list);
  if (session === undefined) {
    sendError(response, 401, "AUTH_REQUIRED", "Authentication required");
    return true;
  }
  const ownerId = session.owner.id;
  if (list) {
    const links = stores.taskLinks.get(ownerId, listMatch[1] ?? "");
    if (links === undefined)
      sendError(response, 404, "TASK_NOT_FOUND", "Task not found");
    else sendJson(response, 200, taskLinksResponse(links));
    return true;
  }
  if (
    !sameOrigin(request) ||
    !auth.csrfMatches(
      session,
      request.headers["x-csrf-token"] as string | undefined,
    )
  ) {
    sendError(
      response,
      403,
      "CSRF_REQUIRED",
      "Same-origin session and CSRF token required",
    );
    return true;
  }
  const now = new Date().toISOString();
  if (create) {
    const parsed = taskAttachmentCreateRequestSchema.safeParse(
      await readJson(request),
    );
    if (!parsed.success) {
      sendError(
        response,
        400,
        "INVALID_TASK_ATTACHMENT",
        "Provide an http or https link without a user name or password, or note text",
      );
      return true;
    }
    const result = stores.taskLinks.createAttachment(
      ownerId,
      createMatch[1] ?? "",
      randomUUID(),
      parsed.data,
      now,
    );
    sendOutcome(response, result, (links) => {
      sendJson(response, 201, taskLinksResponse(links));
    });
    return true;
  }
  const taskId = (attachmentMatch ?? issueMatch)?.[1];
  const id = (attachmentMatch ?? issueMatch)?.[2];
  const revision = expectedRevision(request, response);
  if (revision === undefined || id === undefined || taskId === undefined)
    return true;
  // The task in the path must own the record; otherwise it is not found.
  const owned =
    issueMatch !== null
      ? stores.taskLinks.getIssueLink(ownerId, id)
      : stores.taskLinks.getAttachment(ownerId, id);
  if (owned?.taskId !== taskId) {
    sendError(response, 404, "TASK_LINK_NOT_FOUND", "Task link not found");
    return true;
  }
  if (removeIssue || removeAttachment) {
    const result = removeIssue
      ? stores.taskLinks.deleteIssueLink(ownerId, id, revision)
      : stores.taskLinks.deleteAttachment(ownerId, id, revision);
    sendOutcome(response, result, () => {
      sendEmpty(response, 204);
    });
    return true;
  }
  const parsed = taskAttachmentPatchRequestSchema.safeParse(
    await readJson(request),
  );
  if (!parsed.success) {
    sendError(
      response,
      400,
      "INVALID_TASK_ATTACHMENT",
      "Attachment edit is invalid",
    );
    return true;
  }
  const result = stores.taskLinks.updateAttachment(
    ownerId,
    id,
    revision,
    parsed.data,
    now,
  );
  sendOutcome(response, result, (links) => {
    const attachment = links.attachments.find((item) => item.id === id);
    sendJson(
      response,
      200,
      taskLinksResponse(links),
      attachment === undefined
        ? {}
        : { ETag: `"${String(attachment.revision)}"` },
    );
  });
  return true;
};
