import { describe, expect, it } from "vitest";
import {
  childPositionGap,
  groupTaskHierarchy,
  planChildPosition,
  summarizeChildren,
  validateTaskParent,
} from "./task-hierarchy.ts";

describe("validateTaskParent", () => {
  const parent = { id: "p", parentId: null, deletedAt: null };
  it("accepts a live top-level parent for a task without children", () => {
    expect(
      validateTaskParent({ taskId: "t", parent, taskHasActiveChildren: false }),
    ).toBeNull();
  });
  it("rejects cycles, a third level, deleted and missing parents", () => {
    const check = (
      candidate: Parameters<typeof validateTaskParent>[0]["parent"],
      taskHasActiveChildren = false,
    ) =>
      validateTaskParent({
        taskId: "t",
        parent: candidate,
        taskHasActiveChildren,
      });
    expect(check(undefined)).toBe("parent_missing");
    expect(check({ id: "t" })).toBe("self_parent");
    expect(check({ ...parent, deletedAt: "2026-09-24T00:00:00.000Z" })).toBe(
      "parent_deleted",
    );
    expect(check({ ...parent, parentId: "grandparent" })).toBe(
      "parent_is_child",
    );
    expect(check(parent, true)).toBe("task_has_children");
  });
});

describe("planChildPosition", () => {
  it("uses sparse keys and midpoints before renumbering", () => {
    expect(planChildPosition([])).toEqual({
      kind: "insert",
      position: childPositionGap,
    });
    expect(planChildPosition([1024, 2048])).toEqual({
      kind: "insert",
      position: 3072,
    });
    expect(planChildPosition([1024, 2048], 0)).toEqual({
      kind: "insert",
      position: 0,
    });
    expect(planChildPosition([1024, 2048], 1)).toEqual({
      kind: "insert",
      position: 1536,
    });
    expect(planChildPosition([1024, 2048], 99)).toEqual({
      kind: "insert",
      position: 3072,
    });
  });
  it("renumbers every sibling when no integer gap remains", () => {
    expect(planChildPosition([10, 11, 12], 1)).toEqual({
      kind: "renumber",
      position: 2048,
      siblingPositions: [1024, 3072, 4096],
    });
  });
});

describe("hierarchy grouping and rollups", () => {
  const tasks = [
    { id: "p", parentId: null, status: "open" as const, estimateMinutes: 5 },
    {
      id: "b",
      parentId: "p",
      childPosition: 2048,
      status: "open" as const,
      estimateMinutes: 30,
    },
    {
      id: "a",
      parentId: "p",
      childPosition: 1024,
      status: "completed" as const,
      estimateMinutes: 15,
    },
    { id: "o", parentId: "gone", status: "open" as const },
  ];
  it("orders children by position and exposes orphans instead of dropping them", () => {
    const grouped = groupTaskHierarchy(tasks);
    expect(grouped.roots.map(({ id }) => id)).toEqual(["p"]);
    expect(grouped.childrenByParent.get("p")?.map(({ id }) => id)).toEqual([
      "a",
      "b",
    ]);
    expect(grouped.orphans.map(({ id }) => id)).toEqual(["o"]);
  });
  it("sums only open child estimates and never includes the parent's own", () => {
    expect(summarizeChildren(tasks.slice(1, 3))).toEqual({
      total: 2,
      completed: 1,
      openEstimateMinutes: 30,
      allCompleted: false,
    });
    expect(summarizeChildren([])).toMatchObject({ allCompleted: false });
  });
});
