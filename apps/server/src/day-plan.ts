import type { DayPlanResponse } from "@suite/contracts";
import { buildCalmDay, zonedDayWindow } from "@suite/domain";
import { taskResponse, type RouteContext } from "./routes/shared.ts";

export const readDayPlan = async (
  ctx: RouteContext,
  ownerId: string,
  at: Date,
): Promise<DayPlanResponse> => {
  const { stores: database, google, baikal: connector } = ctx;
  const preferences = database.getPlanningPreferences(ownerId);
  const dayWindow = zonedDayWindow(at.toISOString(), preferences.timeZone);
  const tasks = database.listTasks(ownerId).map(taskResponse);
  const events = database.listCalendarEvents(
    ownerId,
    dayWindow.from,
    dayWindow.to,
  );
  const googleStatus = google.status(ownerId);
  const baikalStatus = await connector.status(ownerId);
  const providerFreshness: boolean[] = [];
  if (baikalStatus.ok && baikalStatus.status.connected)
    providerFreshness.push(true);
  if (googleStatus.connected)
    providerFreshness.push(
      googleStatus.state === "connected" &&
        googleStatus.freshness.every(({ state }) => state === "fresh"),
    );
  const calendarFresh =
    providerFreshness.length > 0 && providerFreshness.every(Boolean);
  const calm = buildCalmDay({
    at: at.toISOString(),
    tasks: tasks.map((task) => ({
      id: task.id,
      status: task.status,
      plannedStart: task.plannedStart ?? null,
    })),
    busy: events.map(({ startsAt, endsAt }) => ({
      startsAt,
      endsAt,
    })),
    preferences,
    calendarFresh,
  });
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const projectedAt = events.at(-1)?.projectedAt ?? null;
  return {
    at: at.toISOString(),
    state: calm.state,
    preferences: {
      ...preferences,
      workingDays: [...preferences.workingDays],
    },
    orderedTasks: calm.orderedTaskIds.flatMap((id) => {
      const task = byId.get(id);
      return task === undefined ? [] : [task];
    }),
    nextTask:
      calm.nextTaskId === null ? null : (byId.get(calm.nextTaskId) ?? null),
    reminder: calm.reminder,
    freshness: calendarFresh
      ? {
          state: "fresh",
          projectedAt,
          message: "Calendar projection is current",
        }
      : {
          state: events.length === 0 ? "unavailable" : "stale",
          projectedAt,
          message:
            events.length === 0
              ? "Calendar projection is unavailable"
              : "Showing the last safe calendar projection",
        },
  };
};
