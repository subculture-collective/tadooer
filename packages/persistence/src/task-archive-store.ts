import type { DatabaseSync } from "node:sqlite";
import {
  decodeHistoryCursor,
  encodeHistoryCursor,
  historyLikePattern,
  historyPageLimit,
  historySortKey,
  validateTaskArchive,
  type HistoricalReference,
  type TaskArchiveReviewReason,
  type TaskArchiveViolation,
} from "@suite/domain";
import type { TaskRecord } from "./index.ts";

/**
 * Archived task history (issue #38, docs/adr/0022-task-archive-and-history.md).
 * An archived task stays in `tasks` with `archived_at` set, so its identity,
 * timestamps, focus history and calendar provenance keep their references.
 * Active queries exclude it; triggers keep it read-only while archived.
 */
export const taskArchiveMigration = {
  id: "0026_task_archive_history",
  sql: `
      ALTER TABLE tasks ADD COLUMN archived_at TEXT;
      CREATE INDEX tasks_archived ON tasks(owner_id, archived_at, id)
        WHERE archived_at IS NOT NULL;
      CREATE TRIGGER tasks_archive_not_deleted_insert
      BEFORE INSERT ON tasks
      WHEN NEW.archived_at IS NOT NULL AND NEW.deleted_at IS NOT NULL
      BEGIN
        SELECT RAISE(ABORT, 'an archived task cannot be deleted');
      END;
      CREATE TRIGGER tasks_archive_not_deleted_update
      BEFORE UPDATE OF archived_at, deleted_at ON tasks
      WHEN NEW.archived_at IS NOT NULL AND NEW.deleted_at IS NOT NULL
      BEGIN
        SELECT RAISE(ABORT, 'an archived task cannot be deleted');
      END;
      CREATE TRIGGER tasks_archived_read_only
      BEFORE UPDATE ON tasks
      WHEN OLD.archived_at IS NOT NULL AND NEW.archived_at IS NOT NULL AND (
        NEW.archived_at IS NOT OLD.archived_at OR NEW.title IS NOT OLD.title
        OR NEW.notes IS NOT OLD.notes OR NEW.status IS NOT OLD.status
        OR NEW.completed_at IS NOT OLD.completed_at
        OR NEW.planned_start IS NOT OLD.planned_start
        OR NEW.estimate_minutes IS NOT OLD.estimate_minutes
        OR NEW.deadline_date IS NOT OLD.deadline_date
        OR NEW.deadline_at IS NOT OLD.deadline_at
        OR NEW.project_id IS NOT OLD.project_id
        OR NEW.parent_id IS NOT OLD.parent_id
        OR NEW.child_position IS NOT OLD.child_position
        OR NEW.planned_day IS NOT OLD.planned_day
        OR NEW.start_reminder_mode IS NOT OLD.start_reminder_mode
        OR NEW.start_reminder_minutes IS NOT OLD.start_reminder_minutes
        OR NEW.deadline_reminder_minutes IS NOT OLD.deadline_reminder_minutes)
      BEGIN
        SELECT RAISE(ABORT, 'an archived task is read-only');
      END;
      CREATE TABLE task_archive_provenance (
        task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
        owner_id TEXT NOT NULL REFERENCES owner_accounts(id) ON DELETE CASCADE,
        source_kind TEXT NOT NULL CHECK(source_kind IN ('super_productivity')),
        source_store TEXT NOT NULL CHECK(source_store IN ('task','archiveYoung','archiveOld')),
        review_json TEXT NOT NULL,
        recorded_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE task_historical_references (
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        owner_id TEXT NOT NULL REFERENCES owner_accounts(id) ON DELETE CASCADE,
        reference_kind TEXT NOT NULL
          CHECK(reference_kind IN ('project','tag','repeat_config','parent')),
        source_id TEXT NOT NULL CHECK(length(source_id) BETWEEN 1 AND 200),
        reason TEXT NOT NULL CHECK(reason IN
          ('missing_from_export','system_tag','recurrence_unsupported','lifecycle_mismatch')),
        position INTEGER NOT NULL CHECK(position >= 0),
        PRIMARY KEY(task_id, reference_kind, source_id)
      ) STRICT;
    `,
};

export type TaskArchiveResult =
  | {
      readonly kind: "archived" | "restored";
      readonly task: TaskRecord;
      readonly children: readonly TaskRecord[];
    }
  | { readonly kind: "not-found" }
  | { readonly kind: "precondition-failed"; readonly task: TaskRecord }
  | {
      readonly kind: "invalid";
      readonly code: TaskArchiveViolation;
      readonly task: TaskRecord;
    };

export interface TaskArchiveProvenanceRecord {
  readonly source: "super_productivity";
  readonly sourceStore: "task" | "archiveYoung" | "archiveOld";
  readonly review: readonly TaskArchiveReviewReason[];
  readonly historicalReferences: readonly HistoricalReference[];
}

export interface ArchivedTaskRecord {
  readonly task: TaskRecord;
  readonly provenance: TaskArchiveProvenanceRecord | null;
}

export interface TaskHistoryEntryRecord extends ArchivedTaskRecord {
  readonly children: readonly ArchivedTaskRecord[];
}

export interface TaskHistoryPage {
  readonly entries: readonly TaskHistoryEntryRecord[];
  readonly total: number;
  readonly nextCursor: string | null;
}

export class TaskHistoryCursorError extends Error {
  constructor() {
    super("TASK_HISTORY_CURSOR_INVALID");
  }
}

export interface TaskArchiveDependencies {
  readonly getTask: (
    ownerId: string,
    taskId: string,
    includeInactive?: boolean,
  ) => TaskRecord | undefined;
  readonly appendChange: (
    ownerId: string,
    entityId: string,
    kind: "archived" | "upsert",
    revision: number,
    now: string,
  ) => void;
}

export class SqliteTaskArchiveStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly deps: TaskArchiveDependencies,
  ) {}

  /**
   * Archives a top-level task and its active children in one transaction.
   * Deleted children stay deleted. A running focus session or a calendar
   * block on any of them blocks the archive, as it blocks deletion.
   */
  archive(input: {
    readonly ownerId: string;
    readonly taskId: string;
    readonly expectedRevision: number;
    readonly now: string;
  }): TaskArchiveResult {
    return this.#transaction("task_archive", () => {
      const task = this.deps.getTask(input.ownerId, input.taskId);
      if (task === undefined) return { kind: "not-found" };
      if (task.revision !== input.expectedRevision)
        return { kind: "precondition-failed", task };
      const children = this.#children(input.ownerId, task.id, "active");
      const violation = validateTaskArchive({
        task,
        action: "archive",
        blocked: this.blockedIds(input.ownerId, task.id).length > 0,
      });
      if (violation !== null) return { kind: "invalid", code: violation, task };
      for (const record of [task, ...children])
        this.#setArchived(input.ownerId, record, input.now, input.now);
      return this.#result("archived", input.ownerId, task.id);
    });
  }

  /** Restores a top-level archived task together with its archived children. */
  restore(input: {
    readonly ownerId: string;
    readonly taskId: string;
    readonly expectedRevision: number;
    readonly now: string;
  }): TaskArchiveResult {
    return this.#transaction("task_unarchive", () => {
      const task = this.deps.getTask(input.ownerId, input.taskId, true);
      if (task?.deletedAt !== null) return { kind: "not-found" };
      const violation = validateTaskArchive({
        task,
        action: "restore",
        blocked: false,
      });
      if (violation === "task_not_archived") return { kind: "not-found" };
      if (task.revision !== input.expectedRevision)
        return { kind: "precondition-failed", task };
      if (violation !== null) return { kind: "invalid", code: violation, task };
      const children = this.#children(input.ownerId, task.id, "archived");
      for (const record of [task, ...children])
        this.#setArchived(input.ownerId, record, null, input.now);
      return this.#result("restored", input.ownerId, task.id);
    });
  }

  /** IDs of the task and its active children with a focus session or calendar block. */
  blockedIds(ownerId: string, taskId: string): readonly string[] {
    return (
      this.db
        .prepare(
          `SELECT t.id FROM tasks t WHERE t.owner_id=? AND (t.id=? OR t.parent_id=?)
             AND t.deleted_at IS NULL AND t.archived_at IS NULL
             AND (EXISTS (SELECT 1 FROM active_sessions s WHERE s.task_id=t.id AND s.ended_at IS NULL)
               OR EXISTS (SELECT 1 FROM task_calendar_blocks b WHERE b.task_id=t.id))
           ORDER BY t.id`,
        )
        .all(ownerId, taskId, taskId) as { id: string }[]
    ).map(({ id }) => id);
  }

  /**
   * One page of top-level archived tasks, newest first. A family matches when
   * the parent or any archived child matches the query in title or notes.
   */
  history(input: {
    readonly ownerId: string;
    readonly query?: string | undefined;
    readonly cursor?: string | undefined;
    readonly limit?: number | undefined;
  }): TaskHistoryPage {
    const limit = Math.max(
      1,
      Math.min(input.limit ?? historyPageLimit.default, historyPageLimit.max),
    );
    const cursor =
      input.cursor === undefined
        ? undefined
        : decodeHistoryCursor(input.cursor);
    if (input.cursor !== undefined && cursor === undefined)
      throw new TaskHistoryCursorError();
    const query = (input.query ?? "").trim();
    const pattern = historyLikePattern(query);
    const matches = `(? = '' OR p.title LIKE ? ESCAPE '\\' OR p.notes LIKE ? ESCAPE '\\'
        OR EXISTS (SELECT 1 FROM tasks c WHERE c.owner_id=p.owner_id AND c.parent_id=p.id
          AND c.archived_at IS NOT NULL
          AND (c.title LIKE ? ESCAPE '\\' OR c.notes LIKE ? ESCAPE '\\')))`;
    const sortKey = "COALESCE(p.completed_at, p.archived_at)";
    const base = `FROM tasks p WHERE p.owner_id=? AND p.archived_at IS NOT NULL
        AND p.parent_id IS NULL AND ${matches}`;
    const params = [input.ownerId, query, pattern, pattern, pattern, pattern];
    const total = (
      this.db.prepare(`SELECT count(*) AS count ${base}`).get(...params) as {
        count: number;
      }
    ).count;
    const rows = this.db
      .prepare(
        `SELECT p.id ${base}
         ${cursor === undefined ? "" : `AND (${sortKey} < ? OR (${sortKey} = ? AND p.id < ?))`}
         ORDER BY ${sortKey} DESC, p.id DESC LIMIT ?`,
      )
      .all(
        ...params,
        ...(cursor === undefined
          ? []
          : [cursor.sortKey, cursor.sortKey, cursor.id]),
        limit + 1,
      ) as { id: string }[];
    const entries = rows.slice(0, limit).map(({ id }) => {
      const task = this.#required(input.ownerId, id);
      return {
        task,
        provenance: this.provenance(input.ownerId, id),
        children: this.#children(input.ownerId, id, "archived").map(
          (child) => ({
            task: child,
            provenance: this.provenance(input.ownerId, child.id),
          }),
        ),
      };
    });
    const last = entries.at(-1)?.task;
    return {
      entries,
      total,
      nextCursor:
        rows.length > limit && last !== undefined
          ? encodeHistoryCursor({ sortKey: historySortKey(last), id: last.id })
          : null,
    };
  }

  provenance(
    ownerId: string,
    taskId: string,
  ): TaskArchiveProvenanceRecord | null {
    const row = this.db
      .prepare(
        "SELECT source_store, review_json FROM task_archive_provenance WHERE owner_id=? AND task_id=?",
      )
      .get(ownerId, taskId) as
      { source_store: string; review_json: string } | undefined;
    if (row === undefined) return null;
    const references = this.db
      .prepare(
        `SELECT reference_kind, source_id, reason FROM task_historical_references
         WHERE owner_id=? AND task_id=? ORDER BY position, reference_kind, source_id`,
      )
      .all(ownerId, taskId) as {
      reference_kind: HistoricalReference["kind"];
      source_id: string;
      reason: HistoricalReference["reason"];
    }[];
    return {
      source: "super_productivity",
      sourceStore:
        row.source_store as TaskArchiveProvenanceRecord["sourceStore"],
      review: JSON.parse(row.review_json) as TaskArchiveReviewReason[],
      historicalReferences: references.map((reference) => ({
        kind: reference.reference_kind,
        sourceId: reference.source_id,
        reason: reference.reason,
      })),
    };
  }

  /**
   * Import helper; runs inside the caller's transaction. Records why a source
   * record needs review and which source references stayed unresolved.
   */
  recordImportProvenance(
    ownerId: string,
    taskId: string,
    provenance: {
      readonly sourceStore: TaskArchiveProvenanceRecord["sourceStore"];
      readonly review: readonly TaskArchiveReviewReason[];
      readonly historicalReferences: readonly HistoricalReference[];
    },
    now: string,
  ): void {
    this.db
      .prepare(
        "INSERT INTO task_archive_provenance (task_id,owner_id,source_kind,source_store,review_json,recorded_at) VALUES (?,?,'super_productivity',?,?,?)",
      )
      .run(
        taskId,
        ownerId,
        provenance.sourceStore,
        JSON.stringify(provenance.review),
        now,
      );
    const insert = this.db.prepare(
      "INSERT OR IGNORE INTO task_historical_references (task_id,owner_id,reference_kind,source_id,reason,position) VALUES (?,?,?,?,?,?)",
    );
    provenance.historicalReferences.forEach((reference, position) =>
      insert.run(
        taskId,
        ownerId,
        reference.kind,
        reference.sourceId,
        reference.reason,
        position,
      ),
    );
  }

  /**
   * Import helper; runs inside the caller's transaction after the batch's
   * tasks and hierarchy exist. The create already emitted a sync change, and
   * sync presents a currently archived task as a removal, so no revision bump.
   */
  markImportedArchived(ownerId: string, taskId: string, now: string): void {
    const changed = this.db
      .prepare(
        "UPDATE tasks SET archived_at=? WHERE owner_id=? AND id=? AND archived_at IS NULL AND deleted_at IS NULL",
      )
      .run(now, ownerId, taskId).changes;
    if (changed !== 1) throw new Error("IMPORT_ARCHIVE_FAILED");
  }

  #setArchived(
    ownerId: string,
    task: TaskRecord,
    archivedAt: string | null,
    now: string,
  ): void {
    const changed = this.db
      .prepare(
        "UPDATE tasks SET archived_at=?,revision=revision+1,updated_at=? WHERE owner_id=? AND id=? AND revision=?",
      )
      .run(archivedAt, now, ownerId, task.id, task.revision).changes;
    if (changed !== 1) throw new Error("Conditional archive update was lost");
    this.deps.appendChange(
      ownerId,
      task.id,
      archivedAt === null ? "upsert" : "archived",
      task.revision + 1,
      now,
    );
  }

  #children(
    ownerId: string,
    parentId: string,
    state: "active" | "archived",
  ): readonly TaskRecord[] {
    return (
      this.db
        .prepare(
          `SELECT id FROM tasks WHERE owner_id=? AND parent_id=? AND deleted_at IS NULL
             AND archived_at IS ${state === "active" ? "" : "NOT "}NULL
           ORDER BY child_position, id`,
        )
        .all(ownerId, parentId) as { id: string }[]
    ).map(({ id }) => this.#required(ownerId, id));
  }

  #result(
    kind: "archived" | "restored",
    ownerId: string,
    taskId: string,
  ): TaskArchiveResult {
    return {
      kind,
      task: this.#required(ownerId, taskId),
      children: this.#children(
        ownerId,
        taskId,
        kind === "archived" ? "archived" : "active",
      ),
    };
  }

  #required(ownerId: string, taskId: string): TaskRecord {
    const task = this.deps.getTask(ownerId, taskId, true);
    if (task === undefined) throw new Error("Archived task disappeared");
    return task;
  }

  #transaction(name: string, body: () => TaskArchiveResult): TaskArchiveResult {
    this.db.exec(`SAVEPOINT ${name};`);
    try {
      const result = body();
      this.db.exec(`RELEASE SAVEPOINT ${name};`);
      return result;
    } catch (error) {
      this.db.exec(`ROLLBACK TO SAVEPOINT ${name}; RELEASE SAVEPOINT ${name};`);
      throw error;
    }
  }
}
