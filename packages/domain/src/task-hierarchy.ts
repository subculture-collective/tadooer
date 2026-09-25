/**
 * Task hierarchy rules (ADR 0018). A task is either top-level or a child of one
 * top-level task: at most two levels, matching Super Productivity 19.1.0.
 * Children are full tasks. Checklist subtasks are a separate concept.
 */
export const taskHierarchyMaxDepth = 2;
/** Gap between sparse child position keys; inserts normally touch one row. */
export const childPositionGap = 1024;

export type TaskHierarchyViolation =
  | "parent_missing"
  | "parent_deleted"
  | "self_parent"
  | "parent_is_child"
  | "task_has_children";

export interface HierarchyParentCandidate {
  readonly id: string;
  readonly parentId?: string | null | undefined;
  readonly deletedAt?: string | null | undefined;
}

/** Returns the first rule a proposed parent assignment breaks, or null. */
export const validateTaskParent = (input: {
  readonly taskId: string;
  readonly parent: HierarchyParentCandidate | undefined;
  readonly taskHasActiveChildren: boolean;
}): TaskHierarchyViolation | null => {
  if (input.parent === undefined) return "parent_missing";
  if (input.parent.id === input.taskId) return "self_parent";
  if (input.parent.deletedAt != null) return "parent_deleted";
  if (input.parent.parentId != null) return "parent_is_child";
  if (input.taskHasActiveChildren) return "task_has_children";
  return null;
};

export type ChildPositionPlan =
  | { readonly kind: "insert"; readonly position: number }
  | {
      readonly kind: "renumber";
      readonly position: number;
      /** New keys for the existing siblings, in their current order. */
      readonly siblingPositions: readonly number[];
    };

/**
 * Places a child at `index` among siblings already sorted by position (the
 * moving task excluded). Uses a midpoint when a gap exists; otherwise renumbers
 * the whole sibling list with even gaps.
 */
export const planChildPosition = (
  siblingPositions: readonly number[],
  index?: number | null,
): ChildPositionPlan => {
  const count = siblingPositions.length;
  const at = Math.max(0, Math.min(index ?? count, count));
  const before = at === 0 ? undefined : siblingPositions[at - 1];
  const after = at === count ? undefined : siblingPositions[at];
  if (before === undefined && after === undefined)
    return { kind: "insert", position: childPositionGap };
  if (before === undefined && after !== undefined)
    return { kind: "insert", position: after - childPositionGap };
  if (after === undefined && before !== undefined)
    return { kind: "insert", position: before + childPositionGap };
  if (before !== undefined && after !== undefined && after - before >= 2)
    return { kind: "insert", position: Math.floor((before + after) / 2) };
  return {
    kind: "renumber",
    position: (at + 1) * childPositionGap,
    siblingPositions: siblingPositions.map(
      (_, i) => (i < at ? i + 1 : i + 2) * childPositionGap,
    ),
  };
};

export interface HierarchyTaskLike {
  readonly id: string;
  readonly parentId?: string | null | undefined;
  readonly childPosition?: number | null | undefined;
  readonly status: "open" | "completed";
  readonly estimateMinutes?: number | null | undefined;
  readonly deletedAt?: string | null | undefined;
}

export const compareChildren = (
  left: HierarchyTaskLike,
  right: HierarchyTaskLike,
): number =>
  (left.childPosition ?? 0) - (right.childPosition ?? 0) ||
  left.id.localeCompare(right.id);

/** Groups active tasks by parent. Children of an absent parent are returned as orphans. */
export const groupTaskHierarchy = <T extends HierarchyTaskLike>(
  tasks: readonly T[],
): {
  readonly roots: readonly T[];
  readonly childrenByParent: ReadonlyMap<string, readonly T[]>;
  readonly orphans: readonly T[];
} => {
  const ids = new Set(tasks.map(({ id }) => id));
  const childrenByParent = new Map<string, T[]>();
  const roots: T[] = [];
  const orphans: T[] = [];
  for (const task of tasks) {
    if (task.parentId == null) roots.push(task);
    else if (!ids.has(task.parentId)) orphans.push(task);
    else
      childrenByParent.set(task.parentId, [
        ...(childrenByParent.get(task.parentId) ?? []),
        task,
      ]);
  }
  for (const [parentId, children] of childrenByParent)
    childrenByParent.set(parentId, children.toSorted(compareChildren));
  return { roots, childrenByParent, orphans };
};

export interface ChildRollup {
  readonly total: number;
  readonly completed: number;
  /** Sum of estimates of open children, as Super Productivity's parent estimate. */
  readonly openEstimateMinutes: number;
  readonly allCompleted: boolean;
}

/**
 * Derived parent totals. They are computed on read and never overwrite the
 * parent's own stored estimate.
 */
export const summarizeChildren = (
  children: readonly HierarchyTaskLike[],
): ChildRollup => {
  const active = children.filter((child) => child.deletedAt == null);
  const completed = active.filter((child) => child.status === "completed");
  return {
    total: active.length,
    completed: completed.length,
    openEstimateMinutes: active
      .filter((child) => child.status === "open")
      .reduce((sum, child) => sum + (child.estimateMinutes ?? 0), 0),
    allCompleted: active.length > 0 && completed.length === active.length,
  };
};
