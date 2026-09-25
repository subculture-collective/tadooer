import { expect, it } from "vitest";
import { prepareSuperProductivityImport } from "./super-productivity-apply.ts";
import { zoneDayLengthMs } from "./super-productivity-counters.ts";

// Counters and metric days (issue #64, ADR 0025). Synthetic data only.
const state = (entities: Record<string, unknown>) => ({
  ids: Object.keys(entities),
  entities,
});
const hour = 3_600_000;
const weekdays = {
  0: false,
  1: true,
  2: true,
  3: true,
  4: true,
  5: true,
  6: false,
};
const exportWith = (extra: Record<string, unknown>) =>
  JSON.stringify({
    task: state({ t: { id: "t", title: "Task" } }),
    ...extra,
  });
const prepare = (extra: Record<string, unknown>) =>
  prepareSuperProductivityImport(exportWith(extra), {
    timeZone: "America/Chicago",
  });
const codes = (result: ReturnType<typeof prepare>) =>
  result.report.issues.map(({ code }) => code);

const counters = {
  coffee: {
    id: "coffee",
    title: "Coffee",
    type: "ClickCounter",
    isEnabled: true,
    isHideButton: true,
    icon: "free_breakfast",
    isOn: false,
    isTrackStreaks: true,
    streakMinValue: 2,
    streakMode: "weekly-frequency",
    streakWeekDays: weekdays,
    streakWeeklyFrequency: 3,
    countOnDay: { "2026-09-20": 3, "2026-09-21": 0, "2026-09-22": 1 },
  },
  desk: {
    id: "desk",
    title: "Standing desk",
    type: "StopWatch",
    isEnabled: true,
    icon: "directions_walk",
    isOn: true,
    isTrackStreaks: true,
    streakMinValue: 30 * 60_000,
    streakMode: "specific-days",
    streakWeekDays: weekdays,
    // The fall-back day has 25 hours in America/Chicago.
    countOnDay: { "2026-11-01": 25 * hour, "2026-09-24": 45 * 60_000 },
  },
  stretch: {
    id: "stretch",
    title: "",
    type: "RepeatedCountdownReminder",
    isEnabled: false,
    icon: null,
    isOn: false,
    countdownDuration: 30 * 60_000,
    countOnDay: {},
  },
};
const metric = {
  "2026-09-20": {
    id: "2026-09-20",
    focusSessions: [25 * 60_000, 50 * 60_000],
    remindTomorrow: false,
    reflections: [{ text: " Calm day ", created: 1758400000000 }],
    impactOfWork: 4,
    energyCheckin: 3,
  },
  "2026-09-21": {
    id: "2026-09-21",
    focusSessions: [],
    remindTomorrow: false,
    reflections: [],
  },
  "2026-09-22": {
    id: "2026-09-22",
    focusSessions: [],
    remindTomorrow: true,
    reflections: [],
    impactOfWork: null,
    energyCheckin: 1,
    totalWorkMinutes: 300,
  },
};

it("maps counters and metric days with provenance and explains every change", () => {
  const result = prepare({
    simpleCounter: state(counters),
    metric: state(metric),
  });
  expect(result.report.canApply).toBe(true);
  expect(result.report.issues.filter(({ blocking }) => blocking)).toEqual([]);
  expect(codes(result)).toEqual([
    "counter_notice",
    "counter_notice",
    "counter_notice",
    "metric_field_retained",
    "counter_reconciliation",
  ]);
  expect(
    result.counters.map(({ sourceId, title, kind }) => [sourceId, title, kind]),
  ).toEqual([
    ["coffee", "Coffee", "click"],
    ["desk", "Standing desk", "stopwatch"],
    ["stretch", "Untitled counter", "repeated_countdown"],
  ]);
  expect(result.counters[0]).toMatchObject({
    icon: "free_breakfast",
    enabled: true,
    hidden: true,
    streak: {
      enabled: true,
      minValue: 2,
      mode: "weekly_frequency",
      weekdays: [1, 2, 3, 4, 5],
      weeklyFrequency: 3,
    },
    countdownMs: null,
    // Zero days carry nothing and are skipped.
    values: [
      { day: "2026-09-20", value: 3 },
      { day: "2026-09-22", value: 1 },
    ],
  });
  expect(result.counters[1]?.values).toEqual([
    { day: "2026-09-24", value: 45 * 60_000 },
    { day: "2026-11-01", value: 25 * hour },
  ]);
  expect(result.counters[2]).toMatchObject({
    enabled: false,
    countdownMs: 30 * 60_000,
    streak: { enabled: false },
  });
  // Values and running state stay out of the definition hash.
  expect(result.counters[0]?.sourceJson).not.toContain("countOnDay");
  expect(result.counters[0]?.sourceJson).not.toContain("isOn");
  const again = prepare({
    simpleCounter: state({
      ...counters,
      coffee: {
        ...counters.coffee,
        isOn: true,
        countOnDay: { "2026-09-25": 1 },
      },
    }),
  });
  expect(again.counters[0]?.sourceHash).toBe(result.counters[0]?.sourceHash);

  // The empty metric day is skipped; focus sessions stay evaluation history.
  expect(result.evaluations).toEqual([
    expect.objectContaining({
      day: "2026-09-20",
      reflection: "Calm day",
      impact: 4,
      energy: 3,
      focusSessionsMs: [25 * 60_000, 50 * 60_000],
    }),
    expect.objectContaining({
      day: "2026-09-22",
      remindTomorrow: true,
      impact: null,
      energy: 1,
      sourceJson: '{"totalWorkMinutes":300}',
    }),
  ]);
  expect(result.report.totals.counters).toEqual({
    definitions: 3,
    dayValues: 4,
    clickCount: 4,
    stopwatchMs: 25 * hour + 45 * 60_000,
    evaluations: 2,
    focusSessions: 2,
    focusSessionMs: 75 * 60_000,
  });
  // No work history is created from focus sessions.
  expect(result.report.totals.time).toMatchObject({ taskDayMs: 0 });
});

it("blocks counter and metric data it cannot represent", () => {
  const blocked = (extra: Record<string, unknown>) => {
    const result = prepare(extra);
    expect(result.report.canApply).toBe(false);
    return result.report.issues
      .filter(({ blocking }) => blocking)
      .map(({ code }) => code);
  };
  expect(
    blocked({
      simpleCounter: state({
        desk: {
          ...counters.desk,
          // September 24 has 24 hours in Chicago.
          countOnDay: { "2026-09-24": 24 * hour + 1 },
        },
      }),
    }),
  ).toEqual(["invalid_counter_value"]);
  expect(
    blocked({
      simpleCounter: state({
        coffee: { ...counters.coffee, countOnDay: { yesterday: 1 } },
      }),
    }),
  ).toEqual(["invalid_counter_value"]);
  expect(
    blocked({
      simpleCounter: state({
        odd: { ...counters.coffee, id: "odd", type: "Timer" },
      }),
    }),
  ).toEqual(["invalid_counter"]);
  expect(
    blocked({
      simpleCounter: state({ coffee: { ...counters.coffee, futureField: 1 } }),
    }),
  ).toEqual(["unknown_counter_field"]);
  expect(
    blocked({
      metric: state({
        "2026-09-20": {
          ...metric["2026-09-20"],
          reflections: [
            { text: "One", created: 1 },
            { text: "Two", created: 2 },
          ],
        },
      }),
    }),
  ).toEqual(["metric_reflections_multiple"]);
  expect(
    blocked({
      metric: state({
        "2026-09-20": { ...metric["2026-09-20"], impactOfWork: 5 },
      }),
    }),
  ).toEqual(["invalid_metric"]);
  expect(blocked({ metric: state({ monday: { id: "monday" } }) })).toEqual([
    "invalid_metric",
  ]);
  expect(
    blocked({
      metric: state({ "2026-09-20": { ...metric["2026-09-20"], mood: 3 } }),
    }),
  ).toEqual(["unknown_metric_field"]);
});

it("measures owner-zone day lengths without the domain package", () => {
  expect(zoneDayLengthMs("2026-03-08", "America/Chicago")).toBe(23 * hour);
  expect(zoneDayLengthMs("2026-09-24", "America/Chicago")).toBe(24 * hour);
  expect(zoneDayLengthMs("2026-11-01", "America/Chicago")).toBe(25 * hour);
  expect(zoneDayLengthMs("2026-11-01", "UTC")).toBe(24 * hour);
});
