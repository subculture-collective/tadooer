import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { ProjectRecord, SyncChangeRecord, TaskRecord } from "./index.js";
import type { ProjectStore } from "./stores.js";

export class SqliteProjectStore implements ProjectStore {
  readonly #database: DatabaseSync;

  constructor(database: DatabaseSync) {
    this.#database = database;
  }

  // -----------------------------------------------------------------------
  // Private helpers (copied verbatim from SuiteDatabase in index.ts)
  // -----------------------------------------------------------------------

  #projectFromRow(row: Record<string, string | number | null>): ProjectRecord {
    return {
      id: String(row.id),
      ownerId: String(row.owner_id),
      title: String(row.title),
      revision: Number(row.revision),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      archivedAt: row.archived_at === null ? null : String(row.archived_at),
    };
  }

  #project(ownerId: string, id: string): ProjectRecord | undefined {
    const row = this.#database
      .prepare("SELECT * FROM projects WHERE owner_id = ? AND id = ?")
      .get(ownerId, id) as unknown as
      Record<string, string | number | null> | undefined;
    return row === undefined ? undefined : this.#projectFromRow(row);
  }

  #taskFromRow(row: {
    readonly id: string;
    readonly owner_id: string;
    readonly title: string;
    readonly notes: string;
    readonly status: "open" | "completed";
    readonly revision: number;
    readonly created_at: string;
    readonly updated_at: string;
    readonly completed_at: string | null;
    readonly deleted_at: string | null;
    readonly planned_start: string | null;
    readonly estimate_minutes: number | null;
  }): TaskRecord {
    return {
      id: row.id,
      ownerId: row.owner_id,
      title: row.title,
      notes: row.notes,
      status: row.status,
      revision: row.revision,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      completedAt: row.completed_at,
      deletedAt: row.deleted_at,
      plannedStart: row.planned_start,
      estimateMinutes: row.estimate_minutes,
    };
  }

  #withTaskTags(task: TaskRecord): TaskRecord {
    const project = this.#database
      .prepare("SELECT project_id FROM tasks WHERE owner_id = ? AND id = ?")
      .get(task.ownerId, task.id) as unknown as
      { project_id: string | null } | undefined;
    const tags = this.#database
      .prepare("SELECT tag_id FROM task_tags WHERE task_id = ? ORDER BY tag_id")
      .all(task.id) as unknown as readonly { tag_id: string }[];
    return {
      ...task,
      projectId: project?.project_id ?? null,
      tagIds: tags.map((tag) => tag.tag_id),
    };
  }

  #appendSyncChangeInTransaction(
    ownerId: string,
    entityType: string,
    entityId: string,
    kind: string,
    revision: number,
    now: string,
  ): SyncChangeRecord {
    let state = this.#database
      .prepare(
        "SELECT epoch, next_sequence FROM sync_owner_state WHERE owner_id = ?",
      )
      .get(ownerId) as unknown as
      { epoch: string; next_sequence: number } | undefined;
    if (state === undefined) {
      state = { epoch: randomUUID(), next_sequence: 1 };
      this.#database
        .prepare(
          "INSERT INTO sync_owner_state (owner_id, epoch, next_sequence, updated_at) VALUES (?, ?, ?, ?)",
        )
        .run(ownerId, state.epoch, 1, now);
    }
    const change: SyncChangeRecord = {
      ownerId,
      epoch: state.epoch,
      sequence: state.next_sequence,
      entityType,
      entityId,
      kind,
      revision,
      createdAt: now,
    };
    this.#database
      .prepare(
        "INSERT INTO sync_changes (owner_id, epoch, sequence, entity_type, entity_id, kind, revision, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        ownerId,
        change.epoch,
        change.sequence,
        entityType,
        entityId,
        kind,
        revision,
        now,
      );
    this.#database
      .prepare(
        "UPDATE sync_owner_state SET next_sequence = ?, updated_at = ? WHERE owner_id = ?",
      )
      .run(change.sequence + 1, now, ownerId);
    return change;
  }

  // -----------------------------------------------------------------------
  // ProjectStore interface methods
  // -----------------------------------------------------------------------

  createProject(record: ProjectRecord): void {
    this.#database
      .prepare(
        "INSERT INTO projects (id, owner_id, title, revision, created_at, updated_at, archived_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        record.id,
        record.ownerId,
        record.title,
        record.revision,
        record.createdAt,
        record.updatedAt,
        record.archivedAt,
      );
  }

  archiveProject(
    ownerId: string,
    projectId: string,
    now: string,
  ): ProjectRecord | undefined {
    const result = this.#database
      .prepare(
        "UPDATE projects SET archived_at = ?, revision = revision + 1, updated_at = ? WHERE owner_id = ? AND id = ? AND archived_at IS NULL",
      )
      .run(now, now, ownerId, projectId);
    return result.changes === 1 ? this.#project(ownerId, projectId) : undefined;
  }

  listProjects(ownerId: string): readonly ProjectRecord[] {
    return (
      this.#database
        .prepare(
          "SELECT * FROM projects WHERE owner_id = ? ORDER BY archived_at IS NOT NULL, title COLLATE NOCASE, id",
        )
        .all(ownerId) as unknown as readonly Record<
        string,
        string | number | null
      >[]
    ).map((row) => this.#projectFromRow(row));
  }

  renameProject(
    ownerId: string,
    id: string,
    expectedRevision: number,
    title: string,
    now: string,
  ): ProjectRecord | undefined {
    const result = this.#database
      .prepare(
        "UPDATE projects SET title=?,revision=revision+1,updated_at=? WHERE owner_id=? AND id=? AND revision=?",
      )
      .run(title, now, ownerId, id, expectedRevision);
    return result.changes === 1 ? this.#project(ownerId, id) : undefined;
  }

  getProject(ownerId: string, projectId: string): ProjectRecord | undefined {
    return this.#project(ownerId, projectId);
  }

  patchProject(
    ownerId: string,
    projectId: string,
    title: string,
    now: string,
  ): ProjectRecord | undefined {
    const result = this.#database
      .prepare(
        "UPDATE projects SET title=?,revision=revision+1,updated_at=? WHERE owner_id=? AND id=?",
      )
      .run(title, now, ownerId, projectId);
    return result.changes === 1 ? this.#project(ownerId, projectId) : undefined;
  }

  // -----------------------------------------------------------------------
  // assignTaskProject — copied verbatim from SuiteDatabase with getTask inlined
  // -----------------------------------------------------------------------

  assignTaskProject(
    ownerId: string,
    taskId: string,
    projectId: string | null,
    expectedRevision: number,
    now: string,
  ): TaskRecord | undefined {
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      const valid =
        projectId === null ||
        this.#database
          .prepare(
            "SELECT 1 FROM projects WHERE id=? AND owner_id=? AND archived_at IS NULL",
          )
          .get(projectId, ownerId) !== undefined;
      if (!valid) {
        this.#database.exec("ROLLBACK;");
        return undefined;
      }
      const changed = this.#database
        .prepare(
          "UPDATE tasks SET project_id=?,revision=revision+1,updated_at=? WHERE owner_id=? AND id=? AND revision=?",
        )
        .run(projectId, now, ownerId, taskId, expectedRevision).changes;
      if (changed !== 1) {
        this.#database.exec("COMMIT;");
        return undefined;
      }
      const taskRow = this.#database
        .prepare(
          `SELECT id, owner_id, title, notes, status, revision, created_at, updated_at,
                  completed_at, deleted_at, planned_start, estimate_minutes
           FROM tasks WHERE owner_id = ? AND id = ? AND deleted_at IS NULL`,
        )
        .get(ownerId, taskId) as unknown as
        | {
            readonly id: string;
            readonly owner_id: string;
            readonly title: string;
            readonly notes: string;
            readonly status: "open" | "completed";
            readonly revision: number;
            readonly created_at: string;
            readonly updated_at: string;
            readonly completed_at: string | null;
            readonly deleted_at: string | null;
            readonly planned_start: string | null;
            readonly estimate_minutes: number | null;
          }
        | undefined;
      const task =
        taskRow === undefined
          ? undefined
          : this.#withTaskTags(this.#taskFromRow(taskRow));
      if (task === undefined) throw new Error("Assigned task disappeared");
      this.#database
        .prepare(
          "INSERT INTO task_field_versions (task_id,field,version) VALUES (?, 'projectId', ?) ON CONFLICT(task_id,field) DO UPDATE SET version=excluded.version",
        )
        .run(taskId, task.revision);
      this.#appendSyncChangeInTransaction(
        ownerId,
        "task",
        taskId,
        "upsert",
        task.revision,
        now,
      );
      this.#database.exec("COMMIT;");
      return task;
    } catch (error) {
      this.#database.exec("ROLLBACK;");
      throw error;
    }
  }
}
