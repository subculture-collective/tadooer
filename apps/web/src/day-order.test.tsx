import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Task } from "@suite/contracts";
import { DayOrderList, dayMembersKey, orderedDayTasks } from "./day-order.tsx";
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

describe("day order in the browser (ADR 0027)", () => {
  it("orders a date's local members by the saved order", () => {
    const ordered = orderedDayTasks(tasks, today, {
      date: today,
      revision: 2,
      taskIds: ["c", "a"],
    });
    expect(ordered.map(({ task: { id }, movable }) => [id, movable])).toEqual([
      ["c", true],
      ["a", true],
      ["b", false],
    ]);
    expect(
      orderedDayTasks(tasks, today, undefined).map(({ task: { id } }) => id),
    ).toEqual(["a", "b", "c"]);
  });

  it("keys the saved-order reload on each date's local members", () => {
    const key = dayMembersKey(tasks, [today, tomorrow]);
    expect(key).toBe("2026-09-24:a,b,c;2026-09-25:t");
    expect(
      dayMembersKey(
        tasks.map((item) =>
          item.id === "inbox" ? { ...item, plannedDay: tomorrow } : item,
        ),
        [today, tomorrow],
      ),
    ).not.toBe(key);
  });

  it("disables moves offline and at either end", () => {
    const items = orderedDayTasks(tasks, today, {
      date: today,
      revision: 1,
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
        order={{ date: tomorrow, revision: 0, taskIds: ["t"] }}
        available={false}
        busy={false}
        onPlan={async () => await Promise.resolve(true)}
        onMove={() => undefined}
      />,
    );
    expect(markup).toContain(">Plan tomorrow</h2>");
    expect(markup).toContain("Reconnect to plan tomorrow or change its order.");
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
