import { randomUUID } from "node:crypto";
import type { PlannerResponse } from "@suite/contracts";
import {
  plannerWindowSchema,
  planningPreferencesSchema,
} from "@suite/contracts";
import { readDayPlan } from "../day-plan.ts";
import { sendJson, sendError, sameOrigin, readJson } from "../http-utils.ts";
import type { RouteHandler } from "./shared.ts";
import { taskResponse, calendarEventResponse } from "./shared.ts";

const projectedEventTime = (value: string, allDay: boolean): string => {
  const normalized =
    allDay && /^\d{8}$/.test(value)
      ? `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6)}T00:00:00.000Z`
      : value;
  return new Date(normalized).toISOString();
};

export const handlePlanner: RouteHandler = async (
  request,
  response,
  url,
  ctx,
) => {
  const { stores: database, auth, baikal: connector, google } = ctx;
  const method = request.method ?? "GET";

  if (method === "GET" && url.pathname === "/api/planner") {
    const session = auth.authenticate(request, false);
    if (session === undefined) {
      sendError(response, 401, "AUTH_REQUIRED", "Authentication required");
      return true;
    }
    const window = plannerWindowSchema.safeParse({
      from: url.searchParams.get("from"),
      to: url.searchParams.get("to"),
    });
    if (!window.success) {
      sendError(
        response,
        400,
        "INVALID_PLANNER_WINDOW",
        "Planner window must be positive and no longer than 31 days",
      );
      return true;
    }
    const status = await connector.status(session.owner.id);
    const googleStatus = google.status(session.owner.id);
    let fresh = true;
    let connectedProviders = 0;
    let projectedAt: string | null = null;
    if (status.ok && status.status.connected) {
      connectedProviders += 1;
      for (const calendar of status.status.calendars.filter(
        (candidate) => candidate.supportsEvents,
      )) {
        const result = await connector.projectEvents(
          session.owner.id,
          calendar.id,
          window.data.from,
          window.data.to,
        );
        if (!result.ok) {
          fresh = false;
          continue;
        }
        const now = new Date().toISOString();
        projectedAt = now;
        database.replaceCalendarEventWindow(
          session.owner.id,
          calendar.id,
          window.data.from,
          window.data.to,
          result.value.map((resource) => ({
            id: randomUUID(),
            providerId: calendar.providerId,
            calendarId: calendar.id,
            href: resource.href,
            uid: resource.event.uid,
            etag: resource.etag,
            rawIcs: resource.rawIcs,
            summary: resource.event.summary,
            startsAt: projectedEventTime(
              resource.event.startsAt,
              resource.event.allDay,
            ),
            endsAt: projectedEventTime(
              resource.event.endsAt,
              resource.event.allDay,
            ),
            allDay: resource.event.allDay,
            recurrence: "none" as const,
            freshness: "current" as const,
            mutable: false,
            revision: 1,
            projectedAt: now,
          })),
        );
      }
    }
    if (googleStatus.connected) {
      connectedProviders += 1;
      if (
        googleStatus.state !== "connected" ||
        googleStatus.freshness.some(({ state }) => state !== "fresh")
      )
        fresh = false;
      for (const item of googleStatus.freshness) {
        if (
          item.lastSuccessfulSyncAt !== null &&
          (projectedAt === null || item.lastSuccessfulSyncAt > projectedAt)
        )
          projectedAt = item.lastSuccessfulSyncAt;
      }
    }
    if (connectedProviders === 0) fresh = false;
    const events = database.listCalendarEvents(
      session.owner.id,
      window.data.from,
      window.data.to,
    );
    const body: PlannerResponse = {
      window: window.data,
      tasks: database
        .listTasks(session.owner.id)
        .filter(
          (task) =>
            task.plannedStart !== null &&
            Date.parse(task.plannedStart) >= Date.parse(window.data.from) &&
            Date.parse(task.plannedStart) < Date.parse(window.data.to),
        )
        .toSorted((left, right) => {
          const leftTime =
            left.plannedStart === null
              ? Number.POSITIVE_INFINITY
              : Date.parse(left.plannedStart);
          const rightTime =
            right.plannedStart === null
              ? Number.POSITIVE_INFINITY
              : Date.parse(right.plannedStart);
          return leftTime - rightTime || left.id.localeCompare(right.id);
        })
        .map(taskResponse),
      events: events.map(calendarEventResponse),
      freshness: fresh
        ? {
            state: "fresh",
            projectedAt,
            message: "Calendar projection is current",
          }
        : {
            state: events.length === 0 ? "unavailable" : "stale",
            projectedAt: events.at(0)?.projectedAt ?? null,
            message:
              events.length === 0
                ? "Calendar projection is unavailable"
                : "Showing the last safe calendar projection",
          },
    };
    sendJson(response, 200, body);
    return true;
  }

  if (method === "GET" && url.pathname === "/api/day-plan") {
    const session = auth.authenticate(request, false);
    if (session === undefined) {
      sendError(response, 401, "AUTH_REQUIRED", "Authentication required");
      return true;
    }
    const requestedAt = url.searchParams.get("at");
    const at = requestedAt === null ? new Date() : new Date(requestedAt);
    if (!Number.isFinite(at.getTime())) {
      sendError(
        response,
        400,
        "INVALID_DAY_PLAN_TIME",
        "Day-plan time must be an ISO timestamp",
      );
      return true;
    }
    const body = await readDayPlan(ctx, session.owner.id, at);
    sendJson(response, 200, body);
    return true;
  }

  if (method === "GET" && url.pathname === "/api/planning/preferences") {
    const session = auth.authenticate(request, false);
    if (session === undefined) {
      sendError(response, 401, "AUTH_REQUIRED", "Authentication required");
      return true;
    }
    sendJson(response, 200, database.getPlanningPreferences(session.owner.id));
    return true;
  }

  if (method === "PUT" && url.pathname === "/api/planning/preferences") {
    if (!sameOrigin(request)) {
      sendError(
        response,
        403,
        "ORIGIN_REQUIRED",
        "Same-origin request required",
      );
      return true;
    }
    const session = auth.authenticate(request, true);
    if (session === undefined) {
      sendError(response, 401, "AUTH_REQUIRED", "Authentication required");
      return true;
    }
    if (
      !auth.csrfMatches(
        session,
        request.headers["x-csrf-token"] as string | undefined,
      )
    ) {
      sendError(response, 403, "CSRF_INVALID", "Valid CSRF token required");
      return true;
    }
    const parsed = planningPreferencesSchema.safeParse(await readJson(request));
    if (!parsed.success) {
      sendError(
        response,
        400,
        "INVALID_PLANNING_PREFERENCES",
        "Planning preferences are invalid",
      );
      return true;
    }
    sendJson(
      response,
      200,
      database.putPlanningPreferences(
        session.owner.id,
        parsed.data,
        new Date().toISOString(),
      ),
    );
    return true;
  }

  return false;
};
