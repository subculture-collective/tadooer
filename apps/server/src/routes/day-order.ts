import {
  dayOrderDateSchema,
  dayOrderPlanRequestSchema,
  dayOrderRangeSchema,
  dayOrderReorderRequestSchema,
  type DayOrder,
} from "@suite/contracts";
import type { DayOrderRecord, SuiteDatabase } from "@suite/persistence";
import { readJson, sameOrigin, sendError, sendJson } from "../http-utils.ts";
import { taskResponse, type RouteHandler } from "./shared.ts";
import { plannedDayBlockedMessage } from "../task-planning.ts";

/**
 * Saved Today and planner-day order over HTTP (issue #98, ADR 0027). Saved
 * day orders are sync feed records (ADR 0050): the store appends a feed
 * change with every write here, so other devices receive it in their next
 * round. The web app reads day orders from its offline cache and reorders
 * through the sync outbox; these routes remain for conditional online writes
 * with the exact-membership check and for planning tasks in one transaction.
 *
 * - GET  /api/day-orders?from=&to=   dates with members or a saved order
 * - GET  /api/day-orders/{date}      one date (revision 0 when never saved)
 * - PUT  /api/day-orders/{date}      full-list reorder with expectedRevision
 * - POST /api/day-orders/{date}/tasks  plan tasks for the date, appended
 */

export const dayOrderResponse = (record: DayOrderRecord): DayOrder => ({
  date: record.date,
  revision: record.revision,
  taskIds: [...record.taskIds],
});

export const dayOrderConflictMessage =
  "The day's tasks or order changed; reload the day and reorder every task it contains";

/** Reads one date's order for the assistant and the browser. */
export const readDayOrder = (
  database: SuiteDatabase,
  ownerId: string,
  date: string,
): DayOrder => dayOrderResponse(database.dayOrders.get(ownerId, date));

export const handleDayOrder: RouteHandler = async (
  request,
  response,
  url,
  { auth, stores },
) => {
  const method = request.method ?? "GET";
  const match = /^\/api\/day-orders\/(\d{4}-\d{2}-\d{2})(\/tasks)?$/.exec(
    url.pathname,
  );
  const list = method === "GET" && url.pathname === "/api/day-orders";
  const datePath = match !== null && match[2] === undefined;
  const tasksPath = match?.[2] !== undefined;
  const read = method === "GET" && datePath;
  const reorder = method === "PUT" && datePath;
  const plan = method === "POST" && tasksPath;
  if (!list && !read && !reorder && !plan) return false;
  const session = auth.authenticate(request, reorder || plan);
  if (session === undefined) {
    sendError(response, 401, "AUTH_REQUIRED", "Authentication required");
    return true;
  }
  const ownerId = session.owner.id;
  if (list) {
    const parsed = dayOrderRangeSchema.safeParse(
      Object.fromEntries(url.searchParams.entries()),
    );
    if (!parsed.success) {
      sendError(
        response,
        400,
        "INVALID_DAY_ORDER_RANGE",
        "Provide from and to calendar dates at most 62 days apart",
      );
      return true;
    }
    sendJson(response, 200, {
      dayOrders: stores.dayOrders
        .list(ownerId, parsed.data.from, parsed.data.to)
        .map(dayOrderResponse),
    });
    return true;
  }
  const date = dayOrderDateSchema.safeParse(match?.[1]);
  if (!date.success) {
    sendError(response, 400, "INVALID_DAY_ORDER_DATE", "Use a calendar date");
    return true;
  }
  if (read) {
    sendJson(response, 200, {
      dayOrder: readDayOrder(stores, ownerId, date.data),
    });
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
  if (reorder) {
    const parsed = dayOrderReorderRequestSchema.safeParse(
      await readJson(request),
    );
    if (!parsed.success) {
      sendError(
        response,
        400,
        "INVALID_DAY_ORDER",
        "Provide the current revision and every task of the day once",
      );
      return true;
    }
    const result = stores.dayOrders.reorder({
      ownerId,
      date: date.data,
      expectedRevision: parsed.data.expectedRevision,
      taskIds: parsed.data.taskIds,
      now,
    });
    if (result.kind === "conflict") {
      sendError(response, 412, "DAY_ORDER_CONFLICT", dayOrderConflictMessage);
      return true;
    }
    sendJson(response, 200, { dayOrder: dayOrderResponse(result.dayOrder) });
    return true;
  }
  const parsed = dayOrderPlanRequestSchema.safeParse(await readJson(request));
  if (!parsed.success) {
    sendError(
      response,
      400,
      "INVALID_DAY_PLAN",
      "Provide the day's current revision and up to 50 tasks with their revisions",
    );
    return true;
  }
  const result = stores.dayOrders.plan({
    ownerId,
    date: date.data,
    expectedRevision: parsed.data.expectedRevision,
    tasks: parsed.data.tasks,
    now,
  });
  if (result.kind === "conflict")
    sendError(response, 412, "DAY_ORDER_CONFLICT", dayOrderConflictMessage);
  else if (result.kind === "task-conflict")
    sendError(
      response,
      412,
      "REVISION_CONFLICT",
      "A task changed; reload before planning it",
    );
  else if (result.kind === "task-blocked")
    sendError(
      response,
      409,
      "TIME_BLOCK_REMOVE_REQUIRED",
      plannedDayBlockedMessage,
    );
  else if (result.kind === "task-invalid")
    sendError(
      response,
      409,
      "DAY_PLAN_TASK_INVALID",
      "Only open, active tasks can be planned for a day",
    );
  else
    sendJson(response, 200, {
      dayOrder: dayOrderResponse(result.dayOrder),
      tasks: result.taskIds.flatMap((taskId) => {
        const task = stores.getTask(ownerId, taskId);
        return task === undefined ? [] : [taskResponse(task)];
      }),
    });
  return true;
};
