import { describe, expect, it } from "vitest";
import type { CalendarEventProjection, Task } from "@suite/contracts";
import { eventTask, localDateTimeValue } from "./PlannerDetailsSheet.tsx";

const task: Task = {
  id: "00000000-0000-4000-8000-000000000003",
  title: "Current title",
  notes: "",
  status: "open",
  revision: 2,
  createdAt: "2026-08-17T00:00:00.000Z",
  updatedAt: "2026-08-17T00:00:00.000Z",
  plannedStart: "2026-08-17T14:00:00.000Z",
  estimateMinutes: 30,
};

const event: CalendarEventProjection = {
  identity: {
    providerId: "00000000-0000-4000-8000-000000000001",
    calendarId: "00000000-0000-4000-8000-000000000002",
    eventId: "meeting.ics",
  },
  href: "/calendars/work/meeting.ics",
  uid: "meeting",
  etag: '"event-etag"',
  summary: "Planning meeting",
  startsAt: "2026-08-17T14:00:00.000Z",
  endsAt: "2026-08-17T15:00:00.000Z",
  allDay: false,
  recurrence: "none",
  projectedAt: "2026-08-17T00:00:00.000Z",
  source: {
    providerKind: "caldav",
    providerDisplayLabel: "Work",
    calendarName: "Company",
  },
  linkedTaskId: task.id,
};

describe("PlannerDetailsSheet details data", () => {
  it("resolves a linked event and a selected task from the current task collection", () => {
    const refreshed = { ...task, title: "Refreshed title", revision: 3 };
    expect(eventTask({ kind: "event", event }, [refreshed])).toBe(refreshed);
    expect(eventTask({ kind: "task", task }, [refreshed])).toBe(refreshed);
  });

  it("formats a block start in the device local wall time expected by datetime-local", () => {
    expect(localDateTimeValue(event.startsAt, "America/Chicago")).toBe(
      "2026-08-17T09:00",
    );
  });
});
