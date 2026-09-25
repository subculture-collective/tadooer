/**
 * Archived task history (ADR 0022). An archived task is kept as read-only
 * history: it leaves every active list, Today, the Planner and reminders, but
 * keeps its identity, original created/completed timestamps and revision.
 * Archiving is distinct from soft deletion; a task is never both.
 */

/** Why an imported historical record needs the owner's review. */
export const taskArchiveReviewReasons = [
  // The source title was empty; the task carries a placeholder title.
  "blank_title",
  // The source notes exceed 20,000 characters; the full text stays in provenance.
  "notes_unrepresentable",
  // The source estimate is not whole minutes up to 720; it stays in provenance.
  "estimate_unrepresentable",
] as const;
export type TaskArchiveReviewReason = (typeof taskArchiveReviewReasons)[number];

/** Source references that are kept as provenance instead of live links. */
export const historicalReferenceKinds = [
  "project",
  "tag",
  "repeat_config",
  "parent",
] as const;
export type HistoricalReferenceKind = (typeof historicalReferenceKinds)[number];

export const historicalReferenceReasons = [
  // The referenced record is absent from the export.
  "missing_from_export",
  // A Super Productivity priority/board marker, never an ordinary tag.
  "system_tag",
  // Tadooer has no recurrence yet (#42); the configuration ID is kept.
  "recurrence_unsupported",
  // The parent is in the other lifecycle (live versus archived), so the task
  // is imported at top level rather than under a parent it cannot share.
  "lifecycle_mismatch",
] as const;
export type HistoricalReferenceReason =
  (typeof historicalReferenceReasons)[number];

export interface HistoricalReference {
  readonly kind: HistoricalReferenceKind;
  readonly sourceId: string;
  readonly reason: HistoricalReferenceReason;
}

export type TaskArchiveViolation =
  "task_is_child" | "task_not_archived" | "task_blocked";

export interface ArchiveCandidate {
  readonly parentId?: string | null | undefined;
  readonly archivedAt?: string | null | undefined;
}

/**
 * Archive and restore act on a top-level task and its children together, as
 * Super Productivity archives a parent with its subtasks. A child alone is
 * never archived or restored, so a child always shares its parent's state.
 */
export const validateTaskArchive = (input: {
  readonly task: ArchiveCandidate;
  readonly action: "archive" | "restore";
  /** The task or an active child has a running focus session or calendar block. */
  readonly blocked: boolean;
}): TaskArchiveViolation | null => {
  if (input.task.parentId != null) return "task_is_child";
  if (input.action === "restore") {
    if (input.task.archivedAt == null) return "task_not_archived";
    return null;
  }
  if (input.blocked) return "task_blocked";
  return null;
};

export const historyPageLimit = { default: 50, max: 200 } as const;

/** Newest history first: completion time, else archive time, then ID. */
export const historySortKey = (task: {
  readonly completedAt: string | null;
  readonly archivedAt?: string | null | undefined;
}): string => task.completedAt ?? task.archivedAt ?? "";

export interface HistoryCursor {
  readonly sortKey: string;
  readonly id: string;
}

const base64url = (text: string): string =>
  btoa(text).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");

/** Cursors are opaque to clients; keys are ASCII timestamps and UUIDs. */
export const encodeHistoryCursor = (cursor: HistoryCursor): string =>
  base64url(JSON.stringify([cursor.sortKey, cursor.id]));

/** Returns undefined for anything that is not a cursor this module issued. */
export const decodeHistoryCursor = (
  value: string,
): HistoryCursor | undefined => {
  if (!/^[A-Za-z0-9_-]{1,400}$/.test(value)) return undefined;
  try {
    const parsed: unknown = JSON.parse(
      atob(value.replaceAll("-", "+").replaceAll("_", "/")),
    );
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 2 ||
      typeof parsed[0] !== "string" ||
      typeof parsed[1] !== "string" ||
      parsed[1] === ""
    )
      return undefined;
    return { sortKey: parsed[0], id: parsed[1] };
  } catch {
    return undefined;
  }
};

/** Escapes a search term for a SQL LIKE pattern using `\` as the escape. */
export const historyLikePattern = (query: string): string =>
  `%${query.trim().replace(/[\\%_]/g, (match) => `\\${match}`)}%`;
