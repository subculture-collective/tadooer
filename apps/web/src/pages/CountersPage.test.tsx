import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  ApiRequestError,
  type Counter,
  type CounterHistory,
  type CounterMutationResponse,
  type EvaluationList,
} from "@suite/contracts";
import {
  dayValue,
  formatCounterValue,
  initialCounters,
  loadCounters,
  parseCounterInput,
  setCounterDay,
  stepCounter,
  toggleStopwatch,
  weekDays,
  weekRange,
  type CountersApi,
} from "./counters-controller.ts";
import { CounterToday, CounterWeek, CountersPage } from "./CountersPage.tsx";

const ids = {
  water: "00000000-0000-4000-8000-000000000001",
  desk: "00000000-0000-4000-8000-000000000002",
  hidden: "00000000-0000-4000-8000-000000000003",
  evaluation: "10000000-0000-4000-8000-000000000001",
};
const stamp = "2026-09-24T15:00:00.000Z";
const counter = (overrides: Partial<Counter>): Counter => ({
  id: ids.water,
  title: "Water",
  kind: "click",
  icon: null,
  enabled: true,
  hidden: false,
  position: 0,
  streak: {
    enabled: true,
    minValue: 2,
    mode: "weekdays",
    weekdays: [1, 2, 3, 4, 5],
    weeklyFrequency: 3,
  },
  countdownMs: null,
  runningSince: null,
  currentStreak: 3,
  revision: 1,
  createdAt: stamp,
  updatedAt: stamp,
  deletedAt: null,
  provenance: null,
  ...overrides,
});

const history: CounterHistory = {
  from: "2026-09-21",
  to: "2026-09-27",
  today: "2026-09-24",
  timeZone: "America/Chicago",
  generatedAt: stamp,
  counters: [
    counter({}),
    counter({
      id: ids.desk,
      title: "Standing desk",
      kind: "stopwatch",
      position: 1,
      runningSince: "2026-09-24T14:00:00.000Z",
      currentStreak: null,
      streak: {
        enabled: false,
        minValue: 1,
        mode: "weekdays",
        weekdays: [],
        weeklyFrequency: 3,
      },
      revision: 4,
    }),
    counter({ id: ids.hidden, title: "Secret", hidden: true, position: 2 }),
  ],
  values: [
    {
      counterId: ids.water,
      day: "2026-09-24",
      value: 3,
      revision: 2,
      updatedAt: stamp,
      importedValue: null,
    },
    {
      counterId: ids.desk,
      day: "2026-09-23",
      value: 45 * 60_000,
      revision: 1,
      updatedAt: stamp,
      importedValue: 45 * 60_000,
    },
  ],
};

const evaluations: EvaluationList = {
  from: "2026-09-21",
  to: "2026-09-27",
  timeZone: "America/Chicago",
  evaluations: [
    {
      id: ids.evaluation,
      day: "2026-09-23",
      notes: "",
      reflection: "Calm day",
      impact: 4,
      energy: 2,
      remindTomorrow: false,
      importedFocusSessionsMs: [25 * 60_000],
      revision: 1,
      createdAt: stamp,
      updatedAt: stamp,
      provenance: { source: "super_productivity", sourceDay: "2026-09-23" },
    },
  ],
  focus: [{ day: "2026-09-24", ms: 50 * 60_000, intervals: 2 }],
};

const mutation = (): Promise<CounterMutationResponse> =>
  Promise.resolve({ counter: counter({}), values: [], clampedMs: 0 });

const fakeApi = (overrides: Partial<CountersApi> = {}): CountersApi => ({
  getCounterHistory: vi.fn(() => Promise.resolve(history)),
  createCounter: vi.fn(mutation),
  updateCounter: vi.fn(mutation),
  deleteCounter: vi.fn(mutation),
  recordCounterDay: vi.fn(mutation),
  controlCounterStopwatch: vi.fn(mutation),
  getEvaluations: vi.fn(() => Promise.resolve(evaluations)),
  saveEvaluation: vi.fn(() =>
    Promise.resolve({
      evaluation: evaluations.evaluations[0] ?? ({} as never),
    }),
  ),
  ...overrides,
});

describe("counters controller", () => {
  it("uses Monday weeks and formats counts and stopwatch minutes", () => {
    expect(weekRange("2026-09-24")).toEqual({
      from: "2026-09-21",
      to: "2026-09-27",
    });
    expect(weekDays("2026-09-27")).toHaveLength(7);
    expect(formatCounterValue("click", 1200)).toBe("1,200");
    expect(formatCounterValue("stopwatch", 45 * 60_000)).toBe("0:45");
    expect(parseCounterInput("stopwatch", "90")).toBe(90 * 60_000);
    expect(parseCounterInput("click", "3")).toBe(3);
    for (const typed of ["", "-1", "1.5", "1000001"])
      expect(parseCounterInput("click", typed)).toBeNull();
    expect(dayValue(history, ids.water, "2026-09-24")).toEqual({
      value: 3,
      revision: 2,
    });
    expect(dayValue(history, ids.water, "2026-09-23")).toEqual({
      value: 0,
      revision: 0,
    });
  });

  it("sends the day revision it read and reloads after a step", async () => {
    const api = fakeApi();
    const loaded = await loadCounters(api, "2026-09-24");
    expect(api.getCounterHistory).toHaveBeenCalledWith(
      "2026-09-21",
      "2026-09-27",
    );
    const water = history.counters[0];
    if (water === undefined) throw new Error("fixture");
    const result = await stepCounter(
      api,
      loaded,
      water,
      "2026-09-24",
      -1,
      "csrf",
    );
    expect(result).toMatchObject({
      saved: true,
      state: { notice: "Water decreased.", error: null },
    });
    expect(api.recordCounterDay).toHaveBeenCalledWith(
      ids.water,
      "2026-09-24",
      { action: "increment", delta: -1, expectedRevision: 2 },
      "csrf",
    );
    const desk = history.counters[1];
    if (desk === undefined) throw new Error("fixture");
    await toggleStopwatch(api, loaded, desk, "csrf");
    expect(api.controlCounterStopwatch).toHaveBeenCalledWith(
      ids.desk,
      4,
      "stop",
      "csrf",
    );
  });

  it("reloads and explains a write that another device made stale", async () => {
    const api = fakeApi({
      recordCounterDay: vi.fn(() =>
        Promise.reject(
          new ApiRequestError(412, "COUNTER_REVISION_CONFLICT", "changed"),
        ),
      ),
    });
    const state = { ...initialCounters("2026-09-24"), history, evaluations };
    const water = history.counters[0];
    if (water === undefined) throw new Error("fixture");
    const result = await setCounterDay(
      api,
      state,
      water,
      "2026-09-23",
      4,
      "csrf",
    );
    expect(result.saved).toBe(false);
    expect(result.state.error).toContain("changed since the page loaded");
    expect(api.recordCounterDay).toHaveBeenCalledWith(
      ids.water,
      "2026-09-23",
      { action: "set", value: 4, expectedRevision: 0 },
      "csrf",
    );
    expect(api.getCounterHistory).toHaveBeenCalled();
  });
});

describe("Counters view", () => {
  it("shows today's controls with labelled buttons, streaks and a running stopwatch", () => {
    const html = renderToStaticMarkup(
      <CounterToday
        history={history}
        online
        busy={false}
        onStep={() => undefined}
        onSet={() => undefined}
        onToggle={() => undefined}
        onInvalid={() => undefined}
      />,
    );
    expect(html).toContain('aria-label="Increase Water"');
    expect(html).toContain('aria-label="Decrease Water"');
    expect(html).toContain("Today: <strong>3</strong>");
    expect(html).toContain("Streak: 3 days (at least 2 on selected weekdays)");
    expect(html).toContain("Running since 09:00");
    expect(html).toContain("Stop");
    // Hidden counters keep their history but have no daily controls.
    expect(html).not.toContain("Secret");
  });

  it("renders the week as a table with values, scores and Tadooer focus", () => {
    const html = renderToStaticMarkup(
      <CounterWeek
        history={history}
        evaluations={evaluations}
        anchor="2026-09-24"
      />,
    );
    expect(html).toContain("<caption");
    expect(html).toContain('<th scope="row">Secret</th>');
    expect(html).toContain("0:45");
    expect(html).toContain("4/4 · 2/3");
    expect(html).toContain("0:50");
  });

  it("keeps writes disabled offline", () => {
    const html = renderToStaticMarkup(
      <CountersPage
        csrfToken="csrf"
        online={false}
        timeZone="America/Chicago"
        initialState={{
          ...initialCounters("2026-09-23"),
          history,
          evaluations,
        }}
        api={fakeApi()}
      />,
    );
    expect(html).toContain("Counters need a connection");
    expect(html).toContain("Daily evaluation");
    // The form edits the owner's today inside the shown week.
    expect(html).toContain("Focus in Tadooer this day: 0:50 in 2 intervals");
    expect(html).toContain("Add counter");
  });
});
