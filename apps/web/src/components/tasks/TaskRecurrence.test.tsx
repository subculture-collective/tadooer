import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { recurringSeriesSchema, taskSchema } from "@suite/contracts";
import {
  describeRecurrence,
  recurrenceFormPayload,
  RecurringSeriesView,
  TaskRecurrencePanel,
} from "./TaskRecurrence.tsx";

const at = "2026-09-24T12:00:00.000Z";
const series = recurringSeriesSchema.parse({
  id: "6c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f",
  title: "Weekly review",
  notes: "",
  projectId: null,
  tagIds: [],
  estimateMinutes: 30,
  rule: { cycle: "weekly", interval: 2, weekdays: [1, 4] },
  startDate: "2026-09-01",
  endDate: null,
  startTime: "09:00",
  startReminder: { kind: "before_start", minutes: 15 },
  anchor: "schedule",
  waitForCompletion: true,
  missedOccurrences: "skip",
  childTemplates: [{ title: "Inbox zero", notes: "", estimateMinutes: 10 }],
  state: "active",
  anchorDate: "2026-09-01",
  cursorDate: "2026-09-21",
  floorDate: "2026-09-01",
  revision: 3,
  createdAt: at,
  updatedAt: at,
  pausedAt: null,
  endedAt: null,
  upcoming: [
    { date: "2026-10-01", skipped: false },
    { date: "2026-10-05", skipped: true },
  ],
  exceptions: [{ date: "2026-10-05", state: "skipped" }],
  instanceCount: 4,
  source: "super_productivity",
});

describe("recurrence in the browser", () => {
  it("describes rules in plain words", () => {
    expect(describeRecurrence(series)).toBe(
      "Every 2 weeks on Mon, Thu at 09:00",
    );
    expect(
      describeRecurrence({
        rule: {
          cycle: "monthly",
          interval: 1,
          monthly: { kind: "nth_weekday", week: -1, weekday: 5 },
        },
        startTime: null,
        anchor: "completion",
      }),
    ).toBe("Every month on the last Fri, counted from completion");
  });

  it("builds a contract payload from the rule form", () => {
    const data = new FormData();
    const fields: [string, string][] = [
      ["cycle", "monthly"],
      ["interval", "3"],
      ["monthly", "nth_weekday"],
      ["week", "-1"],
      ["weekday", "5"],
      ["startDate", "2026-09-25"],
      ["endDate", ""],
      ["startTime", "07:30"],
      ["startReminder", "30"],
      ["anchor", "completion"],
      ["missed", "skip"],
      ["waitForCompletion", "on"],
      ["childTemplates", "Pack bag\n\n Charge phone "],
    ];
    for (const [name, value] of fields) data.append(name, value);
    expect(recurrenceFormPayload(data)).toEqual({
      rule: {
        cycle: "monthly",
        interval: 3,
        monthly: { kind: "nth_weekday", week: -1, weekday: 5 },
      },
      startDate: "2026-09-25",
      endDate: null,
      startTime: "07:30",
      startReminder: { kind: "before_start", minutes: 30 },
      anchor: "completion",
      waitForCompletion: true,
      missedOccurrences: "skip",
      childTemplates: [
        { title: "Pack bag", notes: "", estimateMinutes: null },
        { title: "Charge phone", notes: "", estimateMinutes: null },
      ],
    });
    const weekly = new FormData();
    weekly.append("cycle", "weekly");
    weekly.append("weekdays", "4");
    weekly.append("weekdays", "1");
    weekly.append("startDate", "2026-09-25");
    weekly.append("startReminder", "15");
    expect(recurrenceFormPayload(weekly)).toMatchObject({
      rule: { cycle: "weekly", interval: 1, weekdays: [1, 4] },
      // Without a start time the reminder falls back to the preferences.
      startReminder: { kind: "default" },
    });
  });

  it("lists upcoming dates with skip and restore actions", () => {
    const html = renderToStaticMarkup(
      <RecurringSeriesView
        series={[series]}
        projects={[]}
        busy={false}
        online
        today="2026-09-24"
        onState={() => undefined}
        onOccurrence={() => undefined}
        onEdit={() => undefined}
      />,
    );
    expect(html).toContain("Weekly review");
    expect(html).toContain("Imported");
    expect(html).toContain("4 instances");
    expect(html).toContain("waits for completion");
    expect(html).toContain("Skip 2026-10-01");
    expect(html).toContain("2026-10-05 (skipped)");
    expect(html).toContain("Restore 2026-10-05");
    expect(html).toContain("Pause");
    expect(html).toContain("End series");
    expect(
      renderToStaticMarkup(
        <RecurringSeriesView
          series={[{ ...series, state: "ended", upcoming: [] }]}
          projects={[]}
          busy={false}
          online
          today="2026-09-24"
          onState={() => undefined}
          onOccurrence={() => undefined}
          onEdit={() => undefined}
        />,
      ),
    ).not.toContain("End series");
  });

  it("offers per-task repeat and occurrence deletion", () => {
    const task = taskSchema.parse({
      id: "8b2c3d4e-5f6a-4b7c-9d8e-0f1a2b3c4d5e",
      title: "Water plants",
      notes: "",
      status: "open",
      revision: 1,
      createdAt: at,
      updatedAt: at,
    });
    const props = {
      csrfToken: "token",
      online: true,
      today: "2026-09-24",
      tags: [],
    };
    expect(
      renderToStaticMarkup(<TaskRecurrencePanel task={task} {...props} />),
    ).toContain("Repeat this task");
    const instance = renderToStaticMarkup(
      <TaskRecurrencePanel
        task={{
          ...task,
          recurrence: { seriesId: series.id, occurrenceDate: "2026-09-24" },
        }}
        {...props}
      />,
    );
    expect(instance).toContain("Recurring instance for 2026-09-24");
    expect(instance).toContain("Delete this occurrence");
  });
});
