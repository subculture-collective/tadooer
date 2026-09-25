import { createHash } from "node:crypto";
import {
  idempotencyKeySchema,
  taskChildCreateRequestSchema,
  taskChildOrderRequestSchema,
  taskMoveRequestSchema,
  type TaskChildrenResponse,
} from "@suite/contracts";
import {
  StructuredCaptureError,
  type TaskHierarchyViolation,
} from "@suite/domain";
import type { SuiteDatabase } from "@suite/persistence";
import { createCapturedTask } from "../task-capture.ts";
import {
  expectedRevision,
  readJson,
  sameOrigin,
  sendError,
  sendJson,
} from "../http-utils.ts";
import type { RouteHandler } from "./shared.ts";
import { taskResponse } from "./shared.ts";

/** HTTP status and stable code for each hierarchy rule (ADR 0018). */
export const hierarchyViolationError = (
  code: TaskHierarchyViolation,
): {
  readonly status: number;
  readonly code: string;
  readonly message: string;
} =>
  ({
    parent_missing: {
      status: 404,
      code: "TASK_PARENT_NOT_FOUND",
      message: "Parent task not found",
    },
    parent_deleted: {
      status: 409,
      code: "TASK_PARENT_DELETED",
      message: "Restore the parent task before adding children to it",
    },
    self_parent: {
      status: 409,
      code: "TASK_HIERARCHY_CYCLE",
      message: "A task cannot be its own parent",
    },
    parent_is_child: {
      status: 409,
      code: "TASK_HIERARCHY_DEPTH",
      message: "Child tasks cannot have children; choose a top-level parent",
    },
    task_has_children: {
      status: 409,
      code: "TASK_HAS_CHILDREN",
      message: "Move this task's children before making it a child",
    },
  })[code];

export const taskChildrenBody = (
  database: SuiteDatabase,
  ownerId: string,
  parentId: string,
): TaskChildrenResponse | undefined => {
  const parent = database.getTask(ownerId, parentId);
  return parent === undefined
    ? undefined
    : {
        parent: taskResponse(parent),
        children: database.taskHierarchy
          .listChildren(ownerId, parentId)
          .map(taskResponse),
      };
};

export const handleTaskHierarchy: RouteHandler = async (
  request,
  response,
  url,
  ctx,
) => {
  const { stores: database, auth } = ctx;
  const method = request.method ?? "GET";
  const match = /^\/api\/tasks\/([0-9a-f-]{36})\/(children|move)$/.exec(
    url.pathname,
  );
  if (
    match === null ||
    !(
      (match[2] === "children" && ["GET", "POST", "PUT"].includes(method)) ||
      (match[2] === "move" && method === "POST")
    )
  )
    return false;
  const taskId = match[1] ?? "";
  const session = auth.authenticate(request, method !== "GET");
  if (session === undefined) {
    sendError(response, 401, "AUTH_REQUIRED", "Authentication required");
    return true;
  }
  const ownerId = session.owner.id;
  if (
    method !== "GET" &&
    (!sameOrigin(request) ||
      !auth.csrfMatches(
        session,
        request.headers["x-csrf-token"] as string | undefined,
      ))
  ) {
    sendError(
      response,
      403,
      "CSRF_REQUIRED",
      "Same-origin session and CSRF token required",
    );
    return true;
  }

  if (method === "GET") {
    const body = taskChildrenBody(database, ownerId, taskId);
    if (body === undefined)
      sendError(response, 404, "TASK_NOT_FOUND", "Task not found");
    else sendJson(response, 200, body);
    return true;
  }

  if (match[2] === "move") {
    const revision = expectedRevision(request, response);
    if (revision === undefined) return true;
    const parsed = taskMoveRequestSchema.safeParse(await readJson(request));
    if (!parsed.success) {
      sendError(response, 400, "INVALID_TASK_MOVE", "Task move is invalid");
      return true;
    }
    const result = database.taskHierarchy.move({
      ownerId,
      taskId,
      parentId: parsed.data.parentId,
      index: parsed.data.index ?? null,
      expectedRevision: revision,
      now: new Date().toISOString(),
    });
    if (result.kind === "not-found")
      sendError(response, 404, "TASK_NOT_FOUND", "Task not found");
    else if (result.kind === "precondition-failed")
      sendError(
        response,
        412,
        "TASK_REVISION_CONFLICT",
        "The task changed; reload it before trying again",
      );
    else if (result.kind === "invalid") {
      const error = hierarchyViolationError(result.code);
      sendError(response, error.status, error.code, error.message);
    } else
      sendJson(
        response,
        200,
        { task: taskResponse(result.task) },
        { ETag: `"${String(result.task.revision)}"` },
      );
    return true;
  }

  if (method === "PUT") {
    const parsed = taskChildOrderRequestSchema.safeParse(
      await readJson(request),
    );
    if (!parsed.success) {
      sendError(
        response,
        400,
        "INVALID_CHILD_ORDER",
        "Child task order is invalid",
      );
      return true;
    }
    const result = database.taskHierarchy.reorder({
      ownerId,
      parentId: taskId,
      items: parsed.data.items,
      now: new Date().toISOString(),
    });
    if (result.kind === "not-found")
      sendError(response, 404, "TASK_NOT_FOUND", "Task not found");
    else if (result.kind === "precondition-failed")
      sendError(
        response,
        412,
        "TASK_CHILDREN_CHANGED",
        "Child tasks changed; reload them before reordering",
      );
    else sendJson(response, 200, taskChildrenBody(database, ownerId, taskId));
    return true;
  }

  const key = idempotencyKeySchema.safeParse(
    request.headers["idempotency-key"],
  );
  if (!key.success) {
    sendError(
      response,
      400,
      "IDEMPOTENCY_KEY_REQUIRED",
      "A valid Idempotency-Key header is required",
    );
    return true;
  }
  const parsed = taskChildCreateRequestSchema.safeParse(
    await readJson(request),
  );
  if (!parsed.success) {
    sendError(response, 400, "INVALID_TASK", "Task input is invalid");
    return true;
  }
  const { index, ...input } = parsed.data;
  const now = new Date().toISOString();
  let result;
  try {
    result = database.taskHierarchy.createChild({
      ownerId,
      parentId: taskId,
      index: index ?? null,
      now,
      create: () =>
        createCapturedTask(
          database,
          ownerId,
          key.data,
          createHash("sha256")
            .update(JSON.stringify({ parentId: taskId, ...parsed.data }))
            .digest("hex"),
          input,
          now,
        ),
    });
  } catch (error) {
    if (!(error instanceof StructuredCaptureError)) throw error;
    sendError(response, 400, "INVALID_TASK", error.message);
    return true;
  }
  if (result.kind === "conflict") {
    sendError(
      response,
      409,
      "IDEMPOTENCY_CONFLICT",
      "The idempotency key was already used for a different request",
    );
    return true;
  }
  if (result.kind === "invalid") {
    const error = hierarchyViolationError(result.code);
    sendError(response, error.status, error.code, error.message);
    return true;
  }
  sendJson(
    response,
    result.kind === "created" ? 201 : 200,
    { task: taskResponse(result.task), replayed: result.kind === "replayed" },
    { ETag: `"${String(result.task.revision)}"` },
  );
  return true;
};
