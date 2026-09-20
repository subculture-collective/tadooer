import {
  createHabitRequestSchema,
  patchHabitRequestSchema,
  completeHabitRequestSchema,
  entityIdSchema,
  type HabitCommand,
} from "@suite/contracts";
import {
  readJson,
  sameOrigin,
  sendError,
  sendJson,
  expectedRevision,
} from "../http-utils.ts";
import type { RouteHandler } from "./shared.ts";

export const handleHabits: RouteHandler = async (
  request,
  response,
  url,
  ctx,
) => {
  if (
    url.pathname !== "/api/habits" &&
    !url.pathname.startsWith("/api/habits/")
  )
    return false;
  const session = ctx.auth.authenticate(request, request.method !== "GET");
  if (session === undefined) {
    sendError(response, 401, "AUTH_REQUIRED", "Authentication required");
    return true;
  }
  if (request.method === "GET" && url.pathname === "/api/habits") {
    sendJson(response, 200, {
      habits: ctx.stores.habits.list(session.owner.id),
      occurrences: ctx.stores.habits.occurrences(session.owner.id),
    });
    return true;
  }
  if (
    !sameOrigin(request) ||
    !ctx.auth.csrfMatches(
      session,
      request.headers["x-csrf-token"] as string | undefined,
    )
  ) {
    sendError(
      response,
      403,
      "CSRF_INVALID",
      "Same-origin request and valid CSRF token required",
    );
    return true;
  }
  const key = entityIdSchema.safeParse(request.headers["idempotency-key"]);
  if (!key.success) {
    sendError(
      response,
      400,
      "IDEMPOTENCY_KEY_REQUIRED",
      "A UUID Idempotency-Key is required",
    );
    return true;
  }
  let command: HabitCommand;
  if (request.method === "POST" && url.pathname === "/api/habits") {
    const parsed = createHabitRequestSchema.safeParse(await readJson(request));
    if (!parsed.success) {
      sendError(response, 400, "INVALID_HABIT", "Habit input is invalid");
      return true;
    }
    command = { kind: "habit.create", habit: { ...parsed.data, id: key.data } };
  } else {
    const match =
      /^\/api\/habits\/([0-9a-f-]{36})(?:\/(archive|restore|occurrences))?$/.exec(
        url.pathname,
      );
    if (match?.[1] === undefined) return false;
    const revision = expectedRevision(request, response);
    if (revision === undefined) return true;
    const habitId = match[1];
    if (request.method === "PATCH" && match[2] === undefined) {
      const fields = patchHabitRequestSchema.safeParse(await readJson(request));
      if (!fields.success) {
        sendError(response, 400, "INVALID_HABIT", "Habit edit is invalid");
        return true;
      }
      command = {
        kind: "habit.patch",
        habitId,
        baseRevision: revision,
        fields: fields.data,
      };
    } else if (request.method === "POST" && match[2] === "occurrences") {
      const parsed = completeHabitRequestSchema.safeParse(
        await readJson(request),
      );
      if (!parsed.success) {
        sendError(
          response,
          400,
          "INVALID_HABIT_OCCURRENCE",
          "Habit completion is invalid",
        );
        return true;
      }
      command = {
        kind: "habit.complete",
        habitId,
        baseRevision: revision,
        periodKey: parsed.data.periodKey,
      };
    } else if (
      request.method === "POST" &&
      (match[2] === "archive" || match[2] === "restore")
    ) {
      command = {
        kind: match[2] === "archive" ? "habit.archive" : "habit.restore",
        habitId,
        baseRevision: revision,
      };
    } else return false;
  }
  const result = ctx.stores.habits.apply({
    ownerId: session.owner.id,
    actorId: "http",
    operationId: key.data,
    command,
    now: new Date().toISOString(),
  });
  if (result.kind === "invalid") {
    sendError(
      response,
      400,
      "INVALID_HABIT",
      "Habit is unavailable or the completion date is not eligible",
    );
    return true;
  }
  if (result.kind === "idempotency-conflict") {
    sendError(
      response,
      409,
      "IDEMPOTENCY_CONFLICT",
      "Idempotency key was used for different input",
    );
    return true;
  }
  if (result.kind === "conflict") {
    sendError(
      response,
      412,
      "REVISION_CONFLICT",
      "Habit changed; refresh before retrying",
    );
    return true;
  }
  sendJson(response, result.kind === "replayed" ? 200 : 201, {
    habit: result.habit,
    occurrence: result.occurrence,
    replayed: result.kind === "replayed",
  });
  return true;
};
