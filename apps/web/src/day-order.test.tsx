import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Task } from "@suite/contracts";
import { DayOrderList, orderedDayTasks } from "./day-order.tsx";
import { PlanTomorrowPanel, planCandidates } from "./plan-tomorrow.tsx";
import { TodayQueue } from "./today-queue.tsx";

const task = (id: string, fields: Partial<Task> = {}): Task => ({
  id,
  title: id.toUpperCase(),
  notes: "",
  status: "open",
  revision: 1,
  createdAt: "2026-09-20T12:00:00.000Z",
  updatedAt: "2026-09-20T12:00:00.000Z",
  completedAt: null,
  deletedAt: null,
  plannedStart: null,
  plannedDay: null,
  estimateMinutes: null,
  projectId: null,
  tagIds: [],
  ...fields,
});

/** Whether the button with this accessible label is disabled. */
const disabled = (markup: string, label: string): boolean => {
  const tag = new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`).exec(
    markup,
  )?.[0];
  if (tag === undefined) throw new Error(`No button labelled ${label}`);
  return tag.includes('disabled=""');
};

const today = "2026-09-24";
const tomorrow = "2026-09-25";
const tasks = [
  task("a", { plannedDay: today }),
  task("b", { plannedDay: today }),
  task("c", { plannedDay: today }),
  task("t", { plannedDay: tomorrow }),
  task("inbox"),
  task("timed", { plannedStart: "2026-09-24T20:00:00.000Z" }),
  task("done", { status: "completed", plannedDay: tomorrow }),
];

describe("day order in the browser (ADR 0027, ADR 0050)", () => {
  it("orders a date's cached members by the saved ranks", () => {
    // The saved ranks name a task that left the day ("done") and miss one
    // that joined it ("b"): the first is ignored, the second follows the
    // ranked members, and every member can be moved.
    const ordered = orderedDayTasks(tasks, today, {
      taskIds: ["c", "done", "a"],
    });
    expect(ordered.map(({ task: { id }, movable }) => [id, movable])).toEqual([
      ["c", true],
      ["a", true],
      ["b", true],
    ]);
    expect(
      orderedDayTasks(tasks, today, undefined).map(({ task: { id } }) => id),
    ).toEqual(["a", "b", "c"]);
  });

  it("disables moves at either end and before the device has synced", () => {
    const items = orderedDayTasks(tasks, today, {
      taskIds: ["b", "a", "c"],
    });
    const markup = (available: boolean) =>
      renderToStaticMarkup(
        <DayOrderList
          label="Order for today"
          items={items}
          available={available}
          busy={false}
          onMove={() => undefined}
        />,
      );
    const online = markup(true);
    expect(online).toContain('aria-label="Order for today"');
    expect(disabled(online, "Move “B” up")).toBe(true);
    expect(disabled(online, "Move “B” down")).toBe(false);
    expect(disabled(online, "Move “C” down")).toBe(true);
    expect(markup(false).match(/disabled=""/g)).toHaveLength(6);
  });

  it("offers open, untimed tasks not yet planned for tomorrow", () => {
    expect(planCandidates(tasks, tomorrow, today).map(({ id }) => id)).toEqual([
      "a",
      "b",
      "c",
      "inbox",
    ]);
    const markup = renderToStaticMarkup(
      <PlanTomorrowPanel
        date={tomorrow}
        today={today}
        tasks={tasks}
        order={{ taskIds: ["t"] }}
        available={false}
        busy={false}
        onPlan={async () => await Promise.resolve(true)}
        onMove={() => undefined}
      />,
    );
    expect(markup).toContain(">Plan tomorrow</h2>");
    expect(markup).toContain(
      "Tomorrow can be planned once this device has synced.",
    );
    expect(markup).toContain('aria-label="Order for 2026-09-25"');
    expect(markup).toContain("Add to tomorrow, in the order you pick them");
    expect(markup).not.toContain("TIMED");
  });

  it("sorts Today's planned tasks by the saved order with move controls", () => {
    const markup = renderToStaticMarkup(
      <TodayQueue
        at="2026-09-24T15:00:00.000Z"
        preferences={{
          workingDays: [1, 2, 3, 4, 5],
          workdayStart: "09:00",
          workdayEnd: "17:00",
          breakStart: null,
          breakEnd: null,
          timeZone: "America/Chicago",
          dayStartsAt: "00:00",
        }}
        tasks={tasks}
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
        plannedTodayOrder={["c", "b", "a"]}
        onMovePlanned={() => undefined}
      />,
    );
    const planned = markup.slice(markup.indexOf("Planned for today"));
    expect(planned.indexOf("<strong>C</strong>")).toBeLessThan(
      planned.indexOf("<strong>B</strong>"),
    );
    expect(planned.indexOf("<strong>B</strong>")).toBeLessThan(
      planned.indexOf("<strong>A</strong>"),
    );
    expect(disabled(markup, "Move “C” up")).toBe(true);
    expect(disabled(markup, "Move “B” down")).toBe(false);
  });
});
