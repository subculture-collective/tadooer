import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { CalendarEventProjection, Task } from "@suite/contracts";
import { PlannerTimeGrid } from "./components/calendar/PlannerTimeGrid.tsx";
import {
  TaskPlanningForm,
  taskPlanningPatchFromForm,
} from "./components/tasks/TaskPlanningForm.tsx";
import { TodayQueue } from "./today-queue.tsx";

const task = (id: string, title: string, fields: Partial<Task> = {}): Task => ({
  id,
  title,
  notes: "",
  status: "open",
  revision: 1,
  createdAt: "2026-03-01T12:00:00.000Z",
  updatedAt: "2026-03-01T12:00:00.000Z",
  completedAt: null,
  deletedAt: null,
  plannedStart: null,
  plannedDay: null,
  estimateMinutes: null,
  projectId: null,
  tagIds: [],
  ...fields,
});

const preferences = {
  workingDays: [1, 2, 3, 4, 5],
  workdayStart: "09:00",
  workdayEnd: "17:00",
  breakStart: null,
  breakEnd: null,
  timeZone: "America/Chicago",
};

const queue = (at: string, tasks: readonly Task[]) =>
  renderToStaticMarkup(
    <TodayQueue
      at={at}
      preferences={preferences}
      tasks={tasks}
      activeSession={null}
      calendars={[]}
      busy={false}
      calendarActionsAvailable
      focusActionsAvailable
      onStartFocus={() => undefined}
      onChangeTaskStatus={async () => await Promise.resolve(true)}
      onSubmitTimeBlock={async () => await Promise.resolve()}
      onRemoveTimeBlock={async () => await Promise.resolve()}
      onViewTasks={() => undefined}
    />,
  );

describe("date-only planning in the browser", () => {
  const tasks = [
    task("a", "Pack bags", { plannedDay: "2026-03-08" }),
    task("b", "Call the landlord", { plannedDay: "2026-03-09" }),
  ];

  it("shows a planned day in Today until local midnight on a DST change", () => {
    const beforeMidnight = queue("2026-03-09T04:59:00.000Z", tasks);
    expect(beforeMidnight).toContain(">Planned for today</h2>");
    expect(beforeMidnight).toContain("Pack bags");
    expect(beforeMidnight).toContain("Today · no time set");
    expect(beforeMidnight).not.toContain("Call the landlord");
    expect(beforeMidnight).toContain("1 future task hidden");

    const afterMidnight = queue("2026-03-09T05:00:00.000Z", tasks);
    expect(afterMidnight).toContain("Overdue · planned for 2026-03-08");
    expect(afterMidnight).toContain("Call the landlord");
  });

  it("puts a date-only task in its day's all-day lane beside events without a timed block", () => {
    const events: CalendarEventProjection[] = [
      {
        identity: {
          providerId: "00000000-0000-4000-8000-000000000001",
          calendarId: "00000000-0000-4000-8000-000000000002",
          eventId: "meeting.ics",
        },
        href: "/calendars/work/meeting.ics",
        uid: "meeting",
        etag: '"meeting"',
        summary: "Planning meeting",
        startsAt: "2026-03-08T15:00:00.000Z",
        endsAt: "2026-03-08T16:00:00.000Z",
        allDay: false,
        recurrence: "none",
        projectedAt: "2026-03-08T06:00:00.000Z",
        source: {
          providerKind: "caldav",
          providerDisplayLabel: "Work",
          calendarName: "Company",
        },
      },
    ];
    const html = renderToStaticMarkup(
      <PlannerTimeGrid
        view="3day"
        range={{
          from: "2026-03-07T06:00:00.000Z",
          to: "2026-03-10T05:00:00.000Z",
        }}
        timeZone="America/Chicago"
        events={events}
        tasks={tasks}
      />,
    );
    expect(html).toContain(
      "Pack bags, planned for Sunday, March 8, no time set",
    );
    expect(html).toContain(
      "Call the landlord, planned for Monday, March 9, no time set",
    );
    expect(html).toContain("Planning meeting");
    // No timed task entry is invented for a date-only plan.
    expect(html).not.toContain("planner-time-grid__entry--task");
  });

  it("parses planning edits and disables them while offline", () => {
    const form = new FormData();
    form.set("plannedDay", "2026-03-08");
    form.set("startReminder", "30");
    form.set("deadlineReminder", "none");
    expect(taskPlanningPatchFromForm(form)).toEqual({
      plannedDay: "2026-03-08",
      plannedStart: null,
      startReminder: { kind: "before_start", minutes: 30 },
      deadlineReminder: null,
    });
    form.set("plannedDay", "");
    form.set("startReminder", "none");
    form.set("deadlineReminder", "60");
    expect(taskPlanningPatchFromForm(form)).toEqual({
      plannedDay: null,
      plannedStart: null,
      startReminder: { kind: "none" },
      deadlineReminder: { minutes: 60 },
    });
    form.set("startReminder", "7");
    expect(() => taskPlanningPatchFromForm(form)).toThrow();
    // ADR 0033: an exact time is parsed from the device-local input and is
    // exclusive with a planned day.
    form.set("startReminder", "none");
    form.set("plannedStart", "2026-03-08T09:30");
    expect(taskPlanningPatchFromForm(form)).toMatchObject({
      plannedDay: null,
      plannedStart: new Date("2026-03-08T09:30").toISOString(),
    });
    form.set("plannedDay", "2026-03-08");
    expect(() => taskPlanningPatchFromForm(form)).toThrow();

    const unavailable = renderToStaticMarkup(
      <TaskPlanningForm
        task={task("a", "Pack bags", { plannedDay: "2026-03-08" })}
        timeZone="America/Chicago"
        busy={false}
        available={false}
        onSubmit={async () => await Promise.resolve()}
      />,
    );
    expect(unavailable).toContain("Reconnect to change planning");
    expect(unavailable).toContain('value="2026-03-08"');
    expect(unavailable).toContain(
      "Deadline reminders need a deadline with a time",
    );
    // Offline, the planned day or time still saves; reminders are disabled.
    const offline = renderToStaticMarkup(
      <TaskPlanningForm
        task={task("a", "Pack bags", { plannedDay: "2026-03-08" })}
        timeZone="America/Chicago"
        busy={false}
        available={true}
        remindersAvailable={false}
        onSubmit={async () => await Promise.resolve()}
      />,
    );
    expect(offline).toContain("saved locally and syncs later");
    expect(offline).toMatch(/<input[^>]*name="plannedDay"(?![^>]*disabled)/);
    expect(offline).toMatch(/<select[^>]*name="startReminder"[^>]*disabled/);
  });
});
