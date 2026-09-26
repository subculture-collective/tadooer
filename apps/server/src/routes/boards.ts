import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import {
  boardCreateRequestSchema,
  boardMoveRequestSchema,
  boardOrderRequestSchema,
  boardPanelOrderRequestSchema,
  boardUpdateRequestSchema,
} from "@suite/contracts";
import { planningDate, type BoardClock } from "@suite/domain";
import type { BoardMutationResult, SuiteDatabase } from "@suite/persistence";
import {
  expectedRevision,
  readJson,
  sameOrigin,
  sendError,
  sendJson,
} from "../http-utils.ts";
import { sendEmpty, type RouteHandler } from "./shared.ts";

/**
 * Boards with filtered panels (issue #63, ADR 0028). Online-only: boards are
 * not in the sync change feed or the offline cache.
 *
 * - GET    /api/boards                       every board's configuration
 * - POST   /api/boards                       create from a configuration or template
 * - PUT    /api/boards/order                 full-list reorder with revisions
 * - GET    /api/boards/{id}                  configuration, panel membership, markers
 * - PUT    /api/boards/{id}                  replace the configuration (expectedRevision)
 * - DELETE /api/boards/{id}                  with If-Match
 * - PUT    /api/boards/{id}/panels/{p}/order manual order of the panel's members
 * - POST   /api/boards/{id}/panels/{p}/tasks move a task into the panel (dryRun previews)
 */

/** The owner's planning date and zone, which decide the `today` marker. */
export const boardClock = (
  database: SuiteDatabase,
  ownerId: string,
  now: Date,
): BoardClock => {
  const preferences = database.getPlanningPreferences(ownerId);
  return {
    today: planningDate(now, preferences.timeZone, preferences.dayStartsAt),
    timeZone: preferences.timeZone,
  };
};

export const boardConflictMessage =
  "The board changed; reload it before trying again";

const sendBoardOutcome = (
  response: ServerResponse,
  result: BoardMutationResult,
  success: (
    board: Extract<BoardMutationResult, { kind: "applied" }>["board"],
  ) => void,
): void => {
  if (result.kind === "conflict")
    sendError(response, 412, "BOARD_REVISION_CONFLICT", boardConflictMessage);
  else if (result.kind === "invalid")
    sendError(response, 400, "INVALID_BOARD", result.detail);
  else success(result.board);
};

export const handleBoards: RouteHandler = async (
  request,
  response,
  url,
  { auth, stores },
) => {
  const method = request.method ?? "GET";
  const root = "/api/boards";
  const match =
    /^\/api\/boards\/([0-9a-f-]{36})(?:\/panels\/([0-9a-f-]{36})\/(order|tasks))?$/.exec(
      url.pathname,
    );
  const list = method === "GET" && url.pathname === root;
  const create = method === "POST" && url.pathname === root;
  const order = method === "PUT" && url.pathname === `${root}/order`;
  const boardPath = match !== null && match[2] === undefined;
  const read = method === "GET" && boardPath;
  const update = method === "PUT" && boardPath;
  const remove = method === "DELETE" && boardPath;
  const panelOrder = method === "PUT" && match?.[3] === "order";
  const move = method === "POST" && match?.[3] === "tasks";
  if (
    !list &&
    !create &&
    !order &&
    !read &&
    !update &&
    !remove &&
    !panelOrder &&
    !move
  )
    return false;
  const session = auth.authenticate(request, !list && !read);
  if (session === undefined) {
    sendError(response, 401, "AUTH_REQUIRED", "Authentication required");
    return true;
  }
  const ownerId = session.owner.id;
  const clock = boardClock(stores, ownerId, new Date());
  if (list) {
    sendJson(response, 200, { boards: stores.boards.listBoards(ownerId) });
    return true;
  }
  const boardId = match?.[1];
  if (read) {
    const view =
      boardId === undefined
        ? undefined
        : stores.boards.viewBoard(ownerId, boardId, clock);
    if (view === undefined)
      sendError(response, 404, "BOARD_NOT_FOUND", "Board not found");
    else sendJson(response, 200, { view });
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
    const parsed = boardCreateRequestSchema.safeParse(await readJson(request));
    if (!parsed.success) {
      sendError(
        response,
        400,
        "INVALID_BOARD",
        "Provide a board title, columns and panels, or a template name",
      );
      return true;
    }
    sendBoardOutcome(
      response,
      stores.boards.createBoard(ownerId, parsed.data, randomUUID, now),
      (board) =>
        sendJson(
          response,
          201,
          { board },
          { ETag: `"${String(board.revision)}"` },
        ),
    );
    return true;
  }
  if (order) {
    const parsed = boardOrderRequestSchema.safeParse(await readJson(request));
    if (!parsed.success) {
      sendError(
        response,
        400,
        "INVALID_BOARD_ORDER",
        "Provide every board once with its current revision",
      );
      return true;
    }
    const result = stores.boards.reorderBoards(ownerId, parsed.data.items, now);
    if (result.kind === "conflict")
      sendError(response, 412, "BOARD_REVISION_CONFLICT", boardConflictMessage);
    else sendJson(response, 200, { boards: result.boards });
    return true;
  }
  if (boardId === undefined) return false;
  if (update) {
    const parsed = boardUpdateRequestSchema.safeParse(await readJson(request));
    if (!parsed.success) {
      sendError(
        response,
        400,
        "INVALID_BOARD",
        "Provide the board's revision, title, columns and panels",
      );
      return true;
    }
    sendBoardOutcome(
      response,
      stores.boards.updateBoard(
        ownerId,
        boardId,
        parsed.data.expectedRevision,
        parsed.data,
        randomUUID,
        now,
      ),
      (board) =>
        sendJson(
          response,
          200,
          { board },
          { ETag: `"${String(board.revision)}"` },
        ),
    );
    return true;
  }
  if (remove) {
    const revision = expectedRevision(request, response);
    if (revision === undefined) return true;
    if (stores.boards.deleteBoard(ownerId, boardId, revision) === "conflict")
      sendError(response, 412, "BOARD_REVISION_CONFLICT", boardConflictMessage);
    else sendEmpty(response, 204);
    return true;
  }
  const panelId = match?.[2];
  if (panelId === undefined) return false;
  if (panelOrder) {
    const parsed = boardPanelOrderRequestSchema.safeParse(
      await readJson(request),
    );
    if (!parsed.success) {
      sendError(
        response,
        400,
        "INVALID_PANEL_ORDER",
        "Provide the board's revision and every task of the panel once",
      );
      return true;
    }
    sendBoardOutcome(
      response,
      stores.boards.reorderPanel(
        ownerId,
        boardId,
        panelId,
        parsed.data.expectedRevision,
        parsed.data.taskIds,
        clock,
        now,
      ),
      () => {
        const view = stores.boards.viewBoard(ownerId, boardId, clock);
        sendJson(response, 200, { view });
      },
    );
    return true;
  }
  const parsed = boardMoveRequestSchema.safeParse(await readJson(request));
  if (!parsed.success) {
    sendError(
      response,
      400,
      "INVALID_BOARD_MOVE",
      "Provide the board's revision, the task and its revision",
    );
    return true;
  }
  if (parsed.data.dryRun) {
    const plan = stores.boards.planMove(
      ownerId,
      boardId,
      panelId,
      parsed.data.taskId,
      clock,
    );
    if (plan.kind === "not-found")
      sendError(response, 404, "BOARD_NOT_FOUND", "Board or panel not found");
    else if (plan.kind === "invalid")
      sendError(response, 409, "BOARD_MOVE_UNSUPPORTED", plan.detail);
    else sendJson(response, 200, { applied: false, changes: plan.changes });
    return true;
  }
  const result = stores.boards.moveTask(
    ownerId,
    boardId,
    panelId,
    parsed.data,
    clock,
    now,
  );
  if (result.kind === "conflict")
    sendError(response, 412, "BOARD_REVISION_CONFLICT", boardConflictMessage);
  else if (result.kind === "task-conflict")
    sendError(
      response,
      412,
      "REVISION_CONFLICT",
      "The task changed; reload it before moving it",
    );
  else if (result.kind === "invalid")
    sendError(response, 409, "BOARD_MOVE_UNSUPPORTED", result.detail);
  else
    sendJson(response, 200, {
      applied: true,
      changes: result.changes,
      view: stores.boards.viewBoard(ownerId, boardId, clock),
    });
  return true;
};
