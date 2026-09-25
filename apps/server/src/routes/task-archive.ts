import {
  taskHistoryQuerySchema,
  type ArchivedTask,
  type TaskArchiveMutationResponse,
  type TaskHistoryResponse,
} from "@suite/contracts";
import type { TaskArchiveViolation } from "@suite/domain";
import {
  TaskHistoryCursorError,
  type ArchivedTaskRecord,
  type SuiteDatabase,
  type TaskArchiveResult,
} from "@suite/persistence";
import {
  expectedRevision,
  sameOrigin,
  sendError,
  sendJson,
} from "../http-utils.ts";
import type { RouteHandler } from "./shared.ts";
import { taskResponse } from "./shared.ts";

/** HTTP status and stable code for each archive rule (ADR 0022). */
export const archiveViolationError = (
  code: TaskArchiveViolation,
): {
  readonly status: number;
  readonly code: string;
  readonly message: string;
} =>
  ({
    task_is_child: {
      status: 409,
      code: "TASK_ARCHIVE_CHILD",
      message:
        "Archive or restore the parent task; child tasks move with their parent",
    },
    task_not_archived: {
      status: 404,
      code: "TASK_NOT_FOUND",
      message: "Archived task not found",
    },
    task_blocked: {
      status: 409,
      code: "TASK_ARCHIVE_BLOCKED",
      message:
        "Complete the focus session and remove calendar blocks before archiving this task or its children",
    },
  })[code];

const archivedTask = (record: ArchivedTaskRecord): ArchivedTask => ({
  task: taskResponse(record.task),
  provenance:
    record.provenance === null
      ? null
      : {
          source: record.provenance.source,
          sourceStore: record.provenance.sourceStore,
          review: [...record.provenance.review],
          historicalReferences: record.provenance.historicalReferences.map(
            (reference) => ({ ...reference }),
          ),
        },
});

/** Reads one history page; undefined when the cursor is not valid. */
export const taskHistoryBody = (
  database: SuiteDatabase,
  ownerId: string,
  input: {
    readonly query?: string | undefined;
    readonly cursor?: string | undefined;
    readonly limit?: number | undefined;
  },
): TaskHistoryResponse | undefined => {
  try {
    const page = database.taskArchive.history({ ownerId, ...input });
    return {
      entries: page.entries.map((entry) => ({
        ...archivedTask(entry),
        children: entry.children.map(archivedTask),
      })),
      total: page.total,
      nextCursor: page.nextCursor,
    };
  } catch (error) {
    if (error instanceof TaskHistoryCursorError) return undefined;
    throw error;
  }
};

export const taskArchiveMutationBody = (
  result: Extract<TaskArchiveResult, { kind: "archived" | "restored" }>,
): TaskArchiveMutationResponse => ({
  archive: {
    action: result.kind,
    task: taskResponse(result.task),
    children: result.children.map(taskResponse),
  },
});

export const handleTaskArchive: RouteHandler = (...args) =>
  Promise.resolve(routeTaskArchive(...args));

const routeTaskArchive = (
  ...[
    request,
    response,
    url,
    { stores: database, auth },
  ]: Parameters<RouteHandler>
): boolean => {
  const method = request.method ?? "GET";
  const action = /^\/api\/tasks\/([0-9a-f-]{36})\/(archive|unarchive)$/.exec(
    url.pathname,
  );
  const history = url.pathname === "/api/tasks/history" && method === "GET";
  if (!history && (action === null || method !== "POST")) return false;
  const session = auth.authenticate(request, !history);
  if (session === undefined) {
    sendError(response, 401, "AUTH_REQUIRED", "Authentication required");
    return true;
  }
  const ownerId = session.owner.id;

  if (history) {
    const parsed = taskHistoryQuerySchema.safeParse(
      Object.fromEntries(url.searchParams.entries()),
    );
    const body = parsed.success
      ? taskHistoryBody(database, ownerId, parsed.data)
      : undefined;
    if (body === undefined)
      sendError(
        response,
        400,
        "INVALID_HISTORY_QUERY",
        "History search, cursor or limit is invalid",
      );
    else sendJson(response, 200, body);
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
  const revision = expectedRevision(request, response);
  if (revision === undefined) return true;
  const input = {
    ownerId,
    taskId: action?.[1] ?? "",
    expectedRevision: revision,
    now: new Date().toISOString(),
  };
  const result =
    action?.[2] === "archive"
      ? database.taskArchive.archive(input)
      : database.taskArchive.restore(input);
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
    const error = archiveViolationError(result.code);
    sendError(response, error.status, error.code, error.message);
  } else
    sendJson(response, 200, taskArchiveMutationBody(result), {
      ETag: `"${String(result.task.revision)}"`,
    });
  return true;
};
