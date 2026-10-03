import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Task } from "@suite/contracts";
import { TodayQueue } from "./today-queue.tsx";

const task = (
  id: string,
  title: string,
  plannedStart: string | null,
): Task => ({
  id,
  title,
  notes: "",
  status: "open",
  revision: 1,
  createdAt: "2026-08-10T12:00:00.000Z",
  updatedAt: "2026-08-10T12:00:00.000Z",
  completedAt: null,
  deletedAt: null,
  plannedStart,
  estimateMinutes: 30,
  projectId: null,
  tagIds: [],
});
const preferences = {
  workingDays: [1, 2, 3, 4, 5],
  workdayStart: "09:00",
  workdayEnd: "17:00",
  breakStart: "12:00",
  breakEnd: "12:30",
  timeZone: "America/Chicago",
};
const render = (withPreferences = true) =>
  renderToStaticMarkup(
    <TodayQueue
      at="2026-08-10T15:00:00.000Z"
      preferences={withPreferences ? preferences : undefined}
      tasks={[
        task("overdue", "Quarterly report", "2026-08-10T14:00:00.000Z"),
        task("today", "Today task", "2026-08-10T16:00:00.000Z"),
        task("future", "Future task title", "2026-08-11T05:00:00.000Z"),
        task("inbox", "Inbox note", null),
      ]}
      activeSession={null}
      calendars={[]}
      busy={false}
      calendarActionsAvailable={false}
      focusActionsAvailable={false}
      onStartFocus={() => undefined}
      onChangeTaskStatus={async () => await Promise.resolve(true)}
      onSubmitTimeBlock={async () => await Promise.resolve()}
      onRemoveTimeBlock={async () => await Promise.resolve()}
      onViewTasks={() => undefined}
    />,
  );

describe("TodayQueue", () => {
  it("renders accessible queue hierarchy while hiding future work", () => {
    const markup = render();
    expect(markup).toContain(">Overdue</h2>");
    expect(markup).toContain(">Scheduled today</h2>");
    expect(markup).toContain(">Planning</h2>");
    expect(markup).toContain("1 future task hidden");
    expect(markup).not.toContain("Future task title");
    expect(markup).toContain('aria-label="Complete “Quarterly report”"');
    expect(markup).toContain('aria-label="Start focus on “Quarterly report”"');
    expect(markup).toContain('aria-label="Complete “Inbox note”"');
    expect(markup).toContain("Reconnect to start focus");
    expect(markup).toContain("Reconnect to change calendar blocks");
  });

  it("hides scheduled titles without cached preferences", () => {
    const markup = render(false);
    expect(markup).toContain(
      "3 scheduled tasks hidden until the planning time zone is available.",
    );
    expect(markup).not.toContain("Today task");
    expect(markup).not.toContain("Future task title");
  });

  it("renders the empty queue state", () => {
    const markup = renderToStaticMarkup(
      <TodayQueue
        at="2026-08-10T15:00:00.000Z"
        preferences={preferences}
        tasks={[]}
        activeSession={null}
        calendars={[]}
        busy={false}
        calendarActionsAvailable={false}
        focusActionsAvailable={false}
        onStartFocus={() => undefined}
        onChangeTaskStatus={async () => await Promise.resolve(true)}
        onSubmitTimeBlock={async () => await Promise.resolve()}
        onRemoveTimeBlock={async () => await Promise.resolve()}
        onViewTasks={() => undefined}
      />,
    );
    expect(markup).toContain("Today is clear.");
  });
});
