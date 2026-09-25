import { describe, expect, it } from "vitest";
import { prepareSuperProductivityImport } from "./super-productivity-apply.ts";

// Archived history import (issue #38, ADR 0022). Fixtures are synthetic.
const state = (entities: Record<string, unknown>) => ({
  ids: Object.keys(entities),
  entities,
});
const done = { isDone: true, doneOn: 1700000060000, created: 1700000000000 };
const prepare = (data: Record<string, unknown>) =>
  prepareSuperProductivityImport(JSON.stringify({ data }));
const codes = (report: { issues: readonly { code: string }[] }) =>
  report.issues.map(({ code }) => code);
const blocking = (report: {
  issues: readonly { code: string; blocking?: boolean }[];
}) => report.issues.filter((issue) => issue.blocking !== false);

describe("archived Super Productivity history", () => {
  it("applies both archive stores as archived history with their hierarchy and original timestamps", () => {
    const { report, records } = prepare({
      task: state({ live: { id: "live", title: "Live" } }),
      project: state({ p: { id: "p", title: "Project" } }),
      tag: state({ tag: { id: "tag", title: "Tag" } }),
      archiveYoung: {
        task: state({
          parent: {
            id: "parent",
            title: "Young parent",
            subTaskIds: ["second", "first"],
            projectId: "p",
            tagIds: ["tag"],
            ...done,
          },
          first: { id: "first", title: "First", parentId: "parent", ...done },
          second: {
            id: "second",
            title: "Second",
            parentId: "parent",
            ...done,
          },
        }),
        timeTracking: { project: {}, tag: {} },
        lastTimeTrackingFlush: 1700000000000,
        lastFlush: 1700000000000,
      },
      archiveOld: {
        task: state({ old: { id: "old", title: "Old", ...done } }),
        timeTracking: { project: {}, tag: {} },
      },
    });
    expect(blocking(report)).toEqual([]);
    expect(report.canApply).toBe(true);
    expect(report.totals).toMatchObject({ tasks: 5, archived: 4 });
    const tasks = new Map(
      records
        .filter(({ kind }) => kind === "task")
        .map((record) => [record.sourceId, record]),
    );
    expect(tasks.get("live")).toMatchObject({
      archived: false,
      archiveStore: "task",
    });
    expect(tasks.get("parent")).toMatchObject({
      archived: true,
      archiveStore: "archiveYoung",
      projectId: "p",
      tagIds: ["tag"],
      createdAt: new Date(1700000000000).toISOString(),
      completedAt: new Date(1700000060000).toISOString(),
      historicalReferences: [],
      review: [],
    });
    expect(tasks.get("first")).toMatchObject({
      parentSourceId: "parent",
      childIndex: 1,
    });
    expect(tasks.get("second")).toMatchObject({ childIndex: 0 });
    expect(tasks.get("old")).toMatchObject({
      archived: true,
      archiveStore: "archiveOld",
    });
  });

  it("keeps unresolved archived references as provenance but blocks the same references on live tasks", () => {
    const archived = prepare({
      task: state({}),
      tag: state({ tag: { id: "tag", title: "Tag" } }),
      archiveOld: {
        task: state({
          a: {
            id: "a",
            title: "A",
            projectId: "gone-project",
            tagIds: ["tag", "gone-tag", "EM_URGENT", "TODAY"],
            repeatCfgId: "gone-repeat",
            ...done,
          },
          b: { id: "b", title: "B", projectId: "gone-project", ...done },
        }),
      },
    });
    expect(blocking(archived.report)).toEqual([]);
    expect(
      archived.report.issues
        .filter(({ code }) => code === "historical_reference")
        .map(({ detail }) => detail.split(";")[0]),
    ).toEqual([
      "2 archived tasks reference projects absent from the export",
      "1 archived task references repeat configurations absent from the export",
      "1 archived task references tags absent from the export",
    ]);
    const a = archived.records.find(({ sourceId }) => sourceId === "a");
    expect(a).toMatchObject({
      projectId: null,
      tagIds: ["tag"],
      historicalReferences: [
        {
          kind: "project",
          sourceId: "gone-project",
          reason: "missing_from_export",
        },
        {
          kind: "repeat_config",
          sourceId: "gone-repeat",
          reason: "missing_from_export",
        },
        { kind: "tag", sourceId: "gone-tag", reason: "missing_from_export" },
        { kind: "tag", sourceId: "EM_URGENT", reason: "system_tag" },
      ],
    });
    expect(
      archived.report.tasks.find(({ sourceId }) => sourceId === "a")
        ?.historicalReferences,
    ).toHaveLength(4);

    const live = prepare({
      task: state({
        a: {
          id: "a",
          title: "A",
          projectId: "gone-project",
          tagIds: ["gone-tag"],
        },
      }),
    });
    expect(live.report.canApply).toBe(false);
    expect(codes(live.report)).toEqual(
      expect.arrayContaining(["missing_project", "missing_tag"]),
    );
  });

  it("imports blank archived titles with a flagged placeholder and keeps blank live titles blocked", () => {
    const { report, records } = prepare({
      task: state({}),
      archiveOld: {
        task: state({ blank: { id: "blank", title: "  ", ...done } }),
      },
    });
    expect(report.canApply).toBe(true);
    expect(records[0]).toMatchObject({
      title: "Untitled archived task",
      review: ["blank_title"],
    });
    expect(report.tasks[0]).toMatchObject({
      title: "Untitled archived task",
      review: ["blank_title"],
    });
    expect(report.issues).toContainEqual(
      expect.objectContaining({
        code: "history_review",
        sourceId: "blank",
        blocking: false,
      }),
    );
    const live = prepare({
      task: state({ blank: { id: "blank", title: "" } }),
    });
    expect(live.report.canApply).toBe(false);
    expect(codes(live.report)).toContain("invalid_task");
  });

  it("flags unrepresentable archived notes and estimates instead of rounding or blocking", () => {
    const long = "n".repeat(20005);
    const { report, records } = prepare({
      task: state({}),
      archiveYoung: {
        task: state({
          notes: { id: "notes", title: "Notes", notes: long, ...done },
          estimate: {
            id: "estimate",
            title: "Estimate",
            timeEstimate: 90500,
            ...done,
          },
        }),
      },
    });
    expect(report.canApply).toBe(true);
    const notes = records.find(({ sourceId }) => sourceId === "notes");
    expect(notes?.notes).toHaveLength(20000);
    expect(notes?.review).toEqual(["notes_unrepresentable"]);
    // The full source text stays in provenance.
    expect(notes?.sourceJson).toContain(long);
    expect(
      records.find(({ sourceId }) => sourceId === "estimate"),
    ).toMatchObject({
      estimateMinutes: null,
      review: ["estimate_unrepresentable"],
    });
    expect(
      report.tasks.find(({ sourceId }) => sourceId === "estimate")?.review,
    ).toEqual(["estimate_unrepresentable"]);
  });

  it("never schedules or reminds archived history but keeps legacy schedule fields in provenance", () => {
    const { report, records } = prepare({
      task: state({}),
      archiveOld: {
        task: state({
          old: {
            id: "old",
            title: "Old",
            plannedAt: 1700000000000,
            dueWithTime: 1700000000000,
            remindAt: 1699999990000,
            dueDay: "2023-11-14",
            ...done,
          },
        }),
      },
    });
    expect(report.canApply).toBe(true);
    expect(records[0]).toMatchObject({
      plannedStart: null,
      plannedDay: null,
      startReminder: { kind: "default" },
      deadlineReminderMinutes: null,
    });
    expect(JSON.parse(records[0]?.sourceJson ?? "{}")).toMatchObject({
      plannedAt: 1700000000000,
      remindAt: 1699999990000,
      dueWithTime: 1700000000000,
    });
  });

  it("collapses identical live/archive copies and blocks divergent ones with the differing fields", () => {
    const copy = { id: "dup", title: "Same", created: 1700000000000 };
    const identical = prepare({
      task: state({ dup: { ...copy, modified: 1 } }),
      // `modified` and the leaked `subTasks` copy are ignored view state.
      archiveYoung: {
        task: state({ dup: { ...copy, modified: 2, subTasks: [] } }),
      },
    });
    expect(identical.report.canApply).toBe(true);
    expect(identical.report.totals.tasks).toBe(1);
    expect(identical.records).toMatchObject([
      { sourceId: "dup", archived: false, archiveStore: "task" },
    ]);
    expect(identical.report.issues).toContainEqual(
      expect.objectContaining({
        code: "duplicate_copy_collapsed",
        sourceId: "dup",
        blocking: false,
      }),
    );
    const divergent = prepare({
      task: state({ dup: copy }),
      archiveYoung: {
        task: state({ dup: { ...copy, isDone: true, doneOn: 1700000060000 } }),
      },
    });
    expect(divergent.report.canApply).toBe(false);
    expect(divergent.report.issues).toContainEqual(
      expect.objectContaining({
        code: "duplicate_task",
        sourceId: "dup",
        blocking: true,
        detail: expect.stringContaining("different doneOn, isDone") as string,
      }),
    );
  });

  it("detaches children whose parent is in the other lifecycle and reports it", () => {
    const { report, records } = prepare({
      task: state({
        liveParent: {
          id: "liveParent",
          title: "Live parent",
          subTaskIds: ["archivedChild"],
        },
        liveChild: {
          id: "liveChild",
          title: "Live child",
          parentId: "archivedParent",
        },
      }),
      archiveYoung: {
        task: state({
          archivedParent: {
            id: "archivedParent",
            title: "Archived parent",
            subTaskIds: ["liveChild"],
            ...done,
          },
          archivedChild: {
            id: "archivedChild",
            title: "Archived child",
            parentId: "liveParent",
            ...done,
          },
          lostChild: {
            id: "lostChild",
            title: "Lost child",
            parentId: "gone",
            ...done,
          },
        }),
      },
    });
    expect(blocking(report)).toEqual([]);
    const bySource = new Map(
      records.map((record) => [record.sourceId, record]),
    );
    expect(bySource.get("liveChild")).toMatchObject({
      archived: false,
      parentSourceId: null,
      historicalReferences: [
        {
          kind: "parent",
          sourceId: "archivedParent",
          reason: "lifecycle_mismatch",
        },
      ],
    });
    expect(bySource.get("archivedChild")).toMatchObject({
      archived: true,
      parentSourceId: null,
      historicalReferences: [
        {
          kind: "parent",
          sourceId: "liveParent",
          reason: "lifecycle_mismatch",
        },
      ],
    });
    expect(bySource.get("lostChild")).toMatchObject({
      parentSourceId: null,
      historicalReferences: [
        { kind: "parent", sourceId: "gone", reason: "missing_from_export" },
      ],
    });
    expect(
      report.issues.filter(({ code }) => code === "historical_parent_detached"),
    ).toHaveLength(2);
  });

  it("imports archived work history and still blocks unreviewed archive fields", () => {
    const tracked = prepare({
      task: state({}),
      archiveOld: {
        task: state({ old: { id: "old", title: "Old", ...done } }),
        timeTracking: { project: { p: { "2026-01-01": { s: 1, e: 2 } } } },
      },
    });
    // ADR 0024: the record is kept with its source project ID.
    expect(tracked.report.canApply).toBe(true);
    expect(tracked.workContexts).toEqual([
      expect.objectContaining({
        contextKind: "project",
        sourceContextId: "p",
        sourceStore: "archiveOld",
      }),
    ]);
    expect(tracked.report.issues).toContainEqual(
      expect.objectContaining({
        code: "work_context_historical",
        blocking: false,
      }),
    );
    const unknown = prepare({
      task: state({}),
      archiveYoung: { task: state({}), surprise: true },
    });
    expect(unknown.report.canApply).toBe(false);
    expect(codes(unknown.report)).toContain("unknown_section");
  });
});
