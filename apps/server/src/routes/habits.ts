import { randomUUID } from "node:crypto";
import {
  completeHabitRequestSchema,
  createHabitRequestSchema,
  habitSchema,
  type HabitListResponse,
} from "@suite/contracts";
import { readJson, sameOrigin, sendError, sendJson } from "../http-utils.ts";
import type { RouteHandler } from "./shared.ts";

export const handleHabits: RouteHandler = async (
  request,
  response,
  url,
  ctx,
) => {
  if (!url.pathname.startsWith("/api/habits")) return false;
  const session = ctx.auth.authenticate(request, request.method !== "GET");
  if (session === undefined) {
    sendError(response, 401, "AUTH_REQUIRED", "Authentication required");
    return true;
  }
  if (request.method === "GET" && url.pathname === "/api/habits") {
    const habits = ctx.stores.listHabits(session.owner.id);
    const body: HabitListResponse = {
      habits: habits.map((habit) => habitSchema.parse(habit)),
      occurrences: habits.flatMap((habit) =>
        ctx.stores.listHabitOccurrences(habit.id),
      ),
    };
    sendJson(response, 200, body);
    return true;
  }
  if (!sameOrigin(request)) {
    sendError(response, 403, "ORIGIN_REQUIRED", "Same-origin request required");
    return true;
  }
  if (
    !ctx.auth.csrfMatches(
      session,
      request.headers["x-csrf-token"] as string | undefined,
    )
  ) {
    sendError(response, 403, "CSRF_INVALID", "Valid CSRF token required");
    return true;
  }
  const now = new Date().toISOString();
  if (request.method === "POST" && url.pathname === "/api/habits") {
    const parsed = createHabitRequestSchema.safeParse(await readJson(request));
    if (!parsed.success) {
      sendError(response, 400, "INVALID_HABIT", "Habit input is invalid");
      return true;
    }
    const habit = {
      id: randomUUID(),
      ownerId: session.owner.id,
      ...parsed.data,
      revision: 1,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    };
    ctx.stores.createHabit(habit);
    sendJson(response, 201, habit);
    return true;
  }
  const match = /^\/api\/habits\/([0-9a-f-]{36})\/occurrences$/.exec(
    url.pathname,
  );
  if (request.method === "POST" && match !== null) {
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
    const habit = ctx.stores
      .listHabits(session.owner.id)
      .find(({ id }) => id === match[1]);
    if (habit === undefined) {
      sendError(response, 404, "HABIT_NOT_FOUND", "Habit not found");
      return true;
    }
    const occurrence = {
      id: randomUUID(),
      habitId: habit.id,
      periodKey: parsed.data.periodKey,
      completedAt: now,
      createdAt: now,
    };
    ctx.stores.recordHabitOccurrence(occurrence);
    sendJson(response, 201, occurrence);
    return true;
  }
  return false;
};
