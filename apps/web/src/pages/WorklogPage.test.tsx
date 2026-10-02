import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ApiRequestError, type TimeReport } from "@suite/contracts";
import { worklogCsv } from "@suite/domain";
import {
  addTimeEntry,
  canEditEntry,
  editTimeEntry,
  initialWorklog,
  loadWorklog,
  minutesToMilliseconds,
  offlineSavedNotice,
  periodRange,
  queueTimeEntryWrite,
  shiftPeriod,
  worklogFileName,
  worklogRows,
  type TimeEntryQueue,
  type WorklogApi,
} from "./worklog-controller.ts";
import { WorklogPage, WorklogView } from "./WorklogPage.tsx";

const ids = {
  parent: "00000000-0000-4000-8000-000000000001",
  child: "00000000-0000-4000-8000-000000000002",
  archived: "00000000-0000-4000-8000-000000000003",
  project: "00000000-0000-4000-8000-0000000000aa",
  manual: "10000000-0000-4000-8000-000000000001",
  focus: "20000000-0000-4000-8000-000000000001",
  imported: "30000000-0000-4000-8000-000000000001",
};
const minutes = (value: number) => value * 60_000;
const none = { focus: 0, import: 0, manual: 0 };

const report: TimeReport = {
  from: "2026-09-21",
  to: "2026-09-27",
  timeZone: "America/Chicago",
  generatedAt: "2026-09-24T17:00:00.000Z",
  totalMs: minutes(100),
  bySource: { focus: minutes(30), import: minutes(40), manual: minutes(30) },
  days: [
    {
      date: "2026-09-23",
      totalMs: minutes(40),
      workStart: "2026-09-23T14:00:00.000Z",
      workEnd: "2026-09-23T22:30:00.000Z",
      breakCount: 1,
      breakMs: minutes(15),
      tasks: [
        {
          taskId: ids.archived,
          totalMs: minutes(40),
          bySource: { ...none, import: minutes(40) },
        },
      ],
    },
    {
      date: "2026-09-24",
      totalMs: minutes(60),
      workStart: null,
      workEnd: null,
      breakCount: null,
      breakMs: null,
      tasks: [
        {
          taskId: ids.child,
          totalMs: minutes(60),
          bySource: { ...none, focus: minutes(30), manual: minutes(30) },
        },
      ],
    },
  ],
  weeks: [{ weekStart: "2026-09-21", totalMs: minutes(100), daysWorked: 2 }],
  tasks: [
    {
      taskId: ids.child,
      title: "Collect numbers",
      parentId: ids.parent,
      projectId: ids.project,
      status: "open",
      archived: false,
      estimateMinutes: 45,
      rollupEstimateMinutes: 45,
      ownMs: minutes(60),
      childrenMs: 0,
      allTimeMs: minutes(60),
      bySource: { ...none, focus: minutes(30), manual: minutes(30) },
    },
    {
      taskId: ids.archived,
      title: "=Old report",
      parentId: null,
      projectId: null,
      status: "completed",
      archived: true,
      estimateMinutes: null,
      rollupEstimateMinutes: null,
      ownMs: minutes(40),
      childrenMs: 0,
      allTimeMs: minutes(40),
      bySource: { ...none, import: minutes(40) },
    },
    {
      taskId: ids.parent,
      title: "Quarterly report",
      parentId: null,
      projectId: ids.project,
      status: "open",
      archived: false,
      estimateMinutes: null,
      rollupEstimateMinutes: 45,
      ownMs: 0,
      childrenMs: minutes(60),
      allTimeMs: minutes(60),
      bySource: none,
    },
  ],
  projects: [
    {
      projectId: ids.project,
      title: "Client work",
      totalMs: minutes(60),
      estimateMinutes: 45,
    },
    {
      projectId: null,
      title: "No project",
      totalMs: minutes(40),
      estimateMinutes: null,
    },
  ],
  entries: [
    {
      id: ids.imported,
      taskId: ids.archived,
      workDate: "2026-09-23",
      durationMs: minutes(40),
      source: "import",
      revision: 1,
      note: "",
      startedAt: null,
      endedAt: null,
      running: false,
      provenance: {
        source: "super_productivity",
        kind: "task_day",
        sourceTaskId: "old",
        sourceWorkDate: "2026-09-23",
        sourceStore: "archiveOld",
      },
      createdAt: "2026-09-24T00:00:00.000Z",
      updatedAt: "2026-09-24T00:00:00.000Z",
    },
    {
      id: ids.focus,
      taskId: ids.child,
      workDate: "2026-09-24",
      durationMs: minutes(30),
      source: "focus",
      revision: null,
      note: "",
      startedAt: "2026-09-24T15:00:00.000Z",
      endedAt: "2026-09-24T15:30:00.000Z",
      running: true,
      provenance: null,
      createdAt: null,
      updatedAt: null,
    },
    {
      id: ids.manual,
      taskId: ids.child,
      workDate: "2026-09-24",
      durationMs: minutes(30),
      source: "manual",
      revision: 2,
      note: "Call",
      startedAt: null,
      endedAt: null,
      running: false,
      provenance: null,
      createdAt: "2026-09-24T00:00:00.000Z",
      updatedAt: "2026-09-24T00:00:00.000Z",
    },
  ],
};

const fakeApi = (overrides: Partial<WorklogApi> = {}): WorklogApi => ({
  getTimeReport: vi.fn(() => Promise.resolve(report)),
  createTimeEntry: vi.fn(() =>
    Promise.resolve({ timeEntry: null, deletedId: null, dayTotalMs: 0 }),
  ),
  updateTimeEntry: vi.fn(() =>
    Promise.resolve({ timeEntry: null, deletedId: null, dayTotalMs: 0 }),
  ),
  deleteTimeEntry: vi.fn(() =>
    Promise.resolve({ timeEntry: null, deletedId: null, dayTotalMs: 0 }),
  ),
  ...overrides,
});

describe("worklog controller", () => {
  it("computes Monday weeks and calendar months and moves between them", () => {
    expect(periodRange("2026-09-24", "week")).toEqual({
      from: "2026-09-21",
      to: "2026-09-27",
    });
    expect(periodRange("2026-02-14", "month")).toEqual({
      from: "2026-02-01",
      to: "2026-02-28",
    });
    expect(periodRange("2026-12-31", "month")).toEqual({
      from: "2026-12-01",
      to: "2026-12-31",
    });
    expect(shiftPeriod("2026-09-24", "week", 1)).toBe("2026-09-28");
    expect(shiftPeriod("2026-03-10", "month", -1)).toBe("2026-02-28");
  });

  it("parses minutes, including corrections, and rejects zero or over a day", () => {
    expect(minutesToMilliseconds("90")).toBe(minutes(90));
    expect(minutesToMilliseconds(" -15 ")).toBe(-minutes(15));
    for (const value of ["", "0", "abc", "1441"])
      expect(minutesToMilliseconds(value)).toBeNull();
  });

  it("loads the period and reloads after adding time", async () => {
    const api = fakeApi();
    const loaded = await loadWorklog(api, "week", "2026-09-24");
    expect(api.getTimeReport).toHaveBeenCalledWith("2026-09-21", "2026-09-27");
    const added = await addTimeEntry(
      api,
      loaded,
      {
        id: ids.manual,
        taskId: ids.child,
        workDate: "2026-09-24",
        durationMs: -minutes(5),
      },
      "csrf",
    );
    expect(added).toMatchObject({
      saved: true,
      state: { notice: "Correction recorded.", error: null },
    });
    expect(api.createTimeEntry).toHaveBeenCalledWith(
      {
        id: ids.manual,
        taskId: ids.child,
        workDate: "2026-09-24",
        durationMs: -minutes(5),
      },
      "csrf",
    );
  });

  it("reloads and explains a stale correction", async () => {
    const api = fakeApi({
      updateTimeEntry: vi.fn(() =>
        Promise.reject(
          new ApiRequestError(412, "TIME_ENTRY_REVISION_CONFLICT", "changed"),
        ),
      ),
    });
    const state = { ...initialWorklog("2026-09-24"), report };
    const manual = report.entries[2];
    if (manual === undefined) throw new Error("fixture");
    const result = await editTimeEntry(
      api,
      state,
      manual,
      { durationMs: minutes(20) },
      "csrf",
    );
    expect(result.saved).toBe(false);
    expect(result.state.error).toContain("changed since the worklog loaded");
    expect(api.updateTimeEntry).toHaveBeenCalledWith(
      ids.manual,
      2,
      { durationMs: minutes(20) },
      "csrf",
    );
    expect(api.getTimeReport).toHaveBeenCalled();
  });

  it("allows edits only to manual and imported entries on active tasks", () => {
    const [imported, focus, manual] = report.entries;
    if (imported === undefined || focus === undefined || manual === undefined)
      throw new Error("fixture");
    expect(canEditEntry(report, imported)).toBe(false);
    expect(canEditEntry(report, focus)).toBe(false);
    expect(canEditEntry(report, manual)).toBe(true);
  });

  it("exports one CSV row per task and day with parent, project and sources", () => {
    const rows = worklogRows(report);
    expect(rows).toEqual([
      {
        date: "2026-09-23",
        task: "=Old report",
        parentTask: "",
        project: "",
        durationMs: minutes(40),
        estimateMinutes: null,
        sources: ["import"],
      },
      {
        date: "2026-09-24",
        task: "Collect numbers",
        parentTask: "Quarterly report",
        project: "Client work",
        durationMs: minutes(60),
        estimateMinutes: 45,
        sources: ["focus", "manual"],
      },
    ]);
    expect(worklogCsv(rows)).toContain(
      "2026-09-23,'=Old report,,,0:40,0.67,2400000,,import",
    );
    expect(worklogFileName(report)).toBe(
      "worklog-2026-09-21-to-2026-09-27.csv",
    );
  });
});

describe("Worklog view", () => {
  it("renders days, sources, work start and end, and task and project totals", () => {
    const html = renderToStaticMarkup(
      <WorklogView
        report={report}
        online
        busy={false}
        editing={null}
        projects={[]}
        onEdit={() => undefined}
        onSave={() => undefined}
        onDelete={() => undefined}
      />,
    );
    expect(html).toContain("1:40 tracked from 2026-09-21 to 2026-09-27");
    expect(html).toContain("Imported work day 09:00–17:30 · 1 break (0:15)");
    expect(html).toContain("Running");
    expect(html).toContain("↳ Collect numbers");
    expect(html).toContain("=Old report (archived)");
    expect(html).toContain("Client work");
    // Only the manual entry on an active task can be edited.
    expect(html.match(/>Edit</g)).toHaveLength(1);
  });

  it("renders the cached entries offline and says what needs a connection (ADR 0050)", () => {
    const manual = report.entries[2];
    if (manual === undefined) throw new Error("fixture");
    const page = (queue: TimeEntryQueue | undefined) =>
      renderToStaticMarkup(
        <WorklogPage
          csrfToken="csrf"
          online={false}
          timeZone="America/Chicago"
          tasks={[{ id: ids.child, title: "Collect numbers" }]}
          // The last online report is not shown offline: it holds focus
          // time the cache cannot keep current.
          initialState={{ ...initialWorklog("2026-09-24"), report }}
          api={fakeApi()}
          cachedEntries={[manual]}
          queue={queue}
        />,
      );
    const queue: TimeEntryQueue = {
      create: () => Promise.resolve(),
      patch: () => Promise.resolve(),
      remove: () => Promise.resolve(),
    };
    const html = page(queue);
    expect(html).toContain("kept on this device for the last 90 days");
    expect(html).toContain("Focus time, all-time totals and older history");
    expect(html).toContain(
      "Changes are saved here and sync when you reconnect",
    );
    expect(html).toContain("2026-09-21 to 2026-09-27");
    // The cached manual entry is listed with its day total; the focus
    // entry of the online report is not.
    expect(html).toContain("0:30 tracked from 2026-09-21 to 2026-09-27");
    expect(html).toContain("focus 0:00, imported 0:00, manual 0:30");
    expect(html).toContain("Collect numbers");
    expect(html).not.toContain("Running");
    // The entry can be edited and time can be added without a connection.
    expect(html.match(/>Edit</g)).toHaveLength(1);
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>Add time/);
    // Before the device has synced once there is no queue: read-only.
    const readOnly = page(undefined);
    expect(readOnly).toContain(
      "Changes need a connection until this device has synced.",
    );
    expect(readOnly).toMatch(/<button[^>]*disabled=""[^>]*>Add time/);
  });
});

describe("offline time entry writes (ADR 0050)", () => {
  it("reports a queued write and a refused one in the worklog state", async () => {
    const state = initialWorklog("2026-09-24");
    const write = vi.fn(() => Promise.resolve());
    expect(await queueTimeEntryWrite(state, write)).toEqual({
      saved: true,
      state: { ...state, error: null, notice: offlineSavedNotice },
    });
    expect(write).toHaveBeenCalledTimes(1);
    expect(
      await queueTimeEntryWrite(state, () =>
        Promise.reject(new Error("Time can be recorded only on active tasks")),
      ),
    ).toEqual({
      saved: false,
      state: {
        ...state,
        notice: null,
        error: "Time can be recorded only on active tasks",
      },
    });
  });
});
