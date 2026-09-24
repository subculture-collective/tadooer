import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { PlannerResponse } from "@suite/contracts";
import {
  allDayFor,
  PlannerTimeGrid,
  plannerCalendarDays,
  positionTimedEntries,
} from "./PlannerTimeGrid.tsx";

const range = {
  from: "2026-08-17T05:00:00.000Z",
  to: "2026-08-18T05:00:00.000Z",
};

const planner: PlannerResponse = {
  window: range,
  freshness: { state: "fresh", projectedAt: range.from, message: "Current" },
  events: [
    {
      identity: {
        providerId: "00000000-0000-4000-8000-000000000001",
        calendarId: "00000000-0000-4000-8000-000000000002",
        eventId: "all-day.ics",
      },
      href: "/calendars/work/all-day.ics",
      uid: "all-day",
      etag: '"event-etag"',
      summary: "Company holiday",
      startsAt: "2026-08-17T00:00:00.000Z",
      endsAt: "2026-08-18T00:00:00.000Z",
      allDay: true,
      recurrence: "none",
      projectedAt: range.from,
      source: {
        providerKind: "caldav",
        providerDisplayLabel: "Work",
        calendarName: "Company",
      },
    },
    {
      identity: {
        providerId: "00000000-0000-4000-8000-000000000001",
        calendarId: "00000000-0000-4000-8000-000000000002",
        eventId: "meeting.ics",
      },
      href: "/calendars/work/meeting.ics",
      uid: "meeting",
      etag: '"meeting-etag"',
      summary: "Planning meeting",
      startsAt: "2026-08-17T14:00:00.000Z",
      endsAt: "2026-08-17T15:00:00.000Z",
      allDay: false,
      recurrence: "none",
      projectedAt: range.from,
      source: {
        providerKind: "caldav",
        providerDisplayLabel: "Work",
        calendarName: "Company",
      },
    },
  ],
  tasks: [
    {
      id: "00000000-0000-4000-8000-000000000003",
      title: "Prepare notes",
      notes: "",
      status: "open",
      revision: 1,
      createdAt: range.from,
      updatedAt: range.from,
      plannedStart: "2026-08-17T14:30:00.000Z",
      estimateMinutes: 30,
    },
  ],
};

describe("PlannerTimeGrid", () => {
  it("keeps all-day events, time ranges, and overlapping task blocks visible", () => {
    const html = renderToStaticMarkup(
      <PlannerTimeGrid
        view="day"
        range={range}
        timeZone="America/Chicago"
        events={planner.events}
        tasks={planner.tasks}
      />,
    );
    expect(html).toContain("Company holiday");
    expect(html).toContain("Planning meeting");
    expect(html).toContain("Prepare notes");
    expect(html).toContain("All day");
    expect(html).toContain("planner-time-grid__entry--task");
    expect(html).toContain('tabindex="0"');
  });

  it("uses local day boundaries and distinct lanes for overlaps", () => {
    const [day] = plannerCalendarDays(range, "day", "America/Chicago");
    if (day === undefined) throw new Error("Expected one local calendar day");
    const positioned = positionTimedEntries(
      [
        {
          id: "event",
          kind: "event",
          title: "Event",
          detail: "",
          start: new Date("2026-08-17T14:00:00.000Z"),
          end: new Date("2026-08-17T15:00:00.000Z"),
        },
        {
          id: "task",
          kind: "task",
          title: "Task",
          detail: "",
          start: new Date("2026-08-17T14:30:00.000Z"),
          end: new Date("2026-08-17T15:30:00.000Z"),
        },
      ],
      day,
    );
    expect(day.start.toISOString()).toBe(range.from);
    expect(positioned.map(({ column }) => column)).toEqual([0, 1]);
    expect(positioned.map(({ columns }) => columns)).toEqual([2, 2]);
  });

  it("maps UTC-midnight all-day storage to its provider dates in Chicago", () => {
    const days = plannerCalendarDays(
      {
        from: "2026-08-17T05:00:00.000Z",
        to: "2026-08-20T05:00:00.000Z",
      },
      "3day",
      "America/Chicago",
    );
    const [allDayEvent] = planner.events;
    if (allDayEvent === undefined) throw new Error("Expected an all-day event");
    const event = {
      ...allDayEvent,
      startsAt: "2026-08-17T00:00:00.000Z",
      endsAt: "2026-08-19T00:00:00.000Z",
    };
    const [firstDay, secondDay, thirdDay] = days;
    if (
      firstDay === undefined ||
      secondDay === undefined ||
      thirdDay === undefined
    )
      throw new Error("Expected three local calendar days");

    expect(days.map(({ key }) => key)).toEqual([
      "2026-08-17",
      "2026-08-18",
      "2026-08-19",
    ]);
    expect(allDayFor([event], firstDay)).toEqual([event]);
    expect(allDayFor([event], secondDay)).toEqual([event]);
    expect(allDayFor([event], thirdDay)).toEqual([]);
  });

  it("keeps the selected calendar grid visible for an empty period", () => {
    const html = renderToStaticMarkup(
      <PlannerTimeGrid
        view="3day"
        range={{
          from: "2026-08-17T05:00:00.000Z",
          to: "2026-08-20T05:00:00.000Z",
        }}
        timeZone="America/Chicago"
        events={[]}
        tasks={[]}
      />,
    );

    expect(html).toContain("Nothing is planned in this range");
    expect(html.match(/class="planner-time-grid__day"/g)).toHaveLength(3);
    expect(html).toContain("Timed schedule for Monday, August 17");
  });
});
