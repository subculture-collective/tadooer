import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  ConditionalTaskResult,
  IdempotentTaskCreateResult,
  SyncChangeRecord,
  TaskPatch,
  TaskRecord,
} from "./index.js";
import type { TaskStore } from "./stores.js";

export class SqliteTaskStore implements TaskStore {
  readonly #database: DatabaseSync;

  constructor(database: DatabaseSync) {
    this.#database = database;
  }

  // -----------------------------------------------------------------------
  // TaskStore interface — public
  // -----------------------------------------------------------------------

  createTaskIdempotently(
    ownerId: string,
    idempotencyKey: string,
    requestHash: string,
    task: Omit<
      TaskRecord,
      | "ownerId"
      | "completedAt"
      | "deletedAt"
      | "plannedStart"
      | "estimateMinutes"
    >,
  ): IdempotentTaskCreateResult {
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      const prior = this.#database
        .prepare(
          `SELECT request_hash, resource_id FROM idempotency_records
           WHERE owner_id = ? AND operation = 'task.create'
             AND idempotency_key = ?`,
        )
        .get(ownerId, idempotencyKey) as unknown as
        | { readonly request_hash: string; readonly resource_id: string }
        | undefined;
      if (prior !== undefined) {
        if (prior.request_hash !== requestHash) {
          this.#database.exec("COMMIT;");
          return { kind: "conflict" };
        }
        const replayed = this.#findTask(ownerId, prior.resource_id);
        if (replayed === undefined)
          throw new Error("Idempotency record refers to a missing task");
        this.#database.exec("COMMIT;");
        return { kind: "replayed", task: replayed };
      }

      const created: TaskRecord = {
        ownerId,
        ...task,
        completedAt: null,
        deletedAt: null,
        plannedStart: null,
        estimateMinutes: null,
        projectId: null,
        tagIds: [],
      };
      this.#database
        .prepare(
          `INSERT INTO tasks
            (id, owner_id, title, notes, status, revision, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          created.id,
          created.ownerId,
          created.title,
          created.notes,
          created.status,
          created.revision,
          created.createdAt,
          created.updatedAt,
        );
      const initialFieldVersion = this.#database.prepare(
        "INSERT INTO task_field_versions (task_id, field, version) VALUES (?, ?, 1)",
      );
      for (const field of [
        "title",
        "notes",
        "status",
        "estimateMinutes",
        "projectId",
        "tagIds",
      ])
        initialFieldVersion.run(created.id, field);
      this.#database
        .prepare(
          `INSERT INTO idempotency_records
            (owner_id, operation, idempotency_key, request_hash, resource_id, created_at)
           VALUES (?, 'task.create', ?, ?, ?, ?)`,
        )
        .run(
          ownerId,
          idempotencyKey,
          requestHash,
          created.id,
          created.createdAt,
        );
      this.#appendSyncChangeInTransaction(
        ownerId,
        "task",
        created.id,
        "upsert",
        created.revision,
        created.createdAt,
      );
      this.#database.exec("COMMIT;");
      return { kind: "created", task: created };
    } catch (error: unknown) {
      this.#database.exec("ROLLBACK;");
      throw error;
    }
  }

  listTasks(ownerId: string): readonly TaskRecord[] {
    const rows = this.#database
      .prepare(
        `SELECT id, owner_id, title, notes, status, revision, created_at, updated_at,
                completed_at, deleted_at, planned_start, estimate_minutes
         FROM tasks WHERE owner_id = ? AND deleted_at IS NULL
         ORDER BY created_at DESC, id DESC`,
      )
      .all(ownerId) as unknown as readonly {
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
    }[];
    return rows.map((row) => this.#withTaskTags(this.#taskFromRow(row)));
  }

  listRecoveryTasks(ownerId: string): readonly TaskRecord[] {
    const rows = this.#database
      .prepare(
        `SELECT id, owner_id, title, notes, status, revision, created_at, updated_at,
                completed_at, deleted_at, planned_start, estimate_minutes
         FROM tasks WHERE owner_id = ?
         ORDER BY created_at DESC, id DESC`,
      )
      .all(ownerId) as unknown as readonly {
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
    }[];
    return rows.map((row) => this.#withTaskTags(this.#taskFromRow(row)));
  }

  getTask(
    ownerId: string,
    taskId: string,
    includeDeleted = false,
  ): TaskRecord | undefined {
    const row = this.#database
      .prepare(
        `SELECT id, owner_id, title, notes, status, revision, created_at, updated_at,
                completed_at, deleted_at, planned_start, estimate_minutes
         FROM tasks WHERE owner_id = ? AND id = ?
           AND (? = 1 OR deleted_at IS NULL)`,
      )
      .get(ownerId, taskId, includeDeleted ? 1 : 0) as unknown as
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
    return row === undefined
      ? undefined
      : this.#withTaskTags(this.#taskFromRow(row));
  }

  patchTask(
    ownerId: string,
    taskId: string,
    expectedRevision: number,
    patch: TaskPatch,
    now: string,
  ): ConditionalTaskResult {
    return this.#conditionallyUpdateTask(
      ownerId,
      taskId,
      expectedRevision,
      false,
      (task) => ({
        ...task,
        ...(patch.title === undefined ? {} : { title: patch.title }),
        ...(patch.notes === undefined ? {} : { notes: patch.notes }),
        ...(patch.plannedStart === undefined
          ? {}
          : { plannedStart: patch.plannedStart }),
        ...(patch.estimateMinutes === undefined
          ? {}
          : { estimateMinutes: patch.estimateMinutes }),
      }),
      now,
    );
  }

  transitionTask(
    ownerId: string,
    taskId: string,
    expectedRevision: number,
    status: "open" | "completed",
    now: string,
  ): ConditionalTaskResult {
    return this.setTaskCompleted(
      ownerId,
      taskId,
      expectedRevision,
      status === "completed",
      now,
    );
  }

  softDeleteTask(
    ownerId: string,
    taskId: string,
    expectedRevision: number,
    now: string,
  ): ConditionalTaskResult {
    return this.deleteTask(ownerId, taskId, expectedRevision, now);
  }

  restoreTask(
    ownerId: string,
    taskId: string,
    expectedRevision: number,
    now: string,
  ): ConditionalTaskResult {
    return this.#conditionallyUpdateTask(
      ownerId,
      taskId,
      expectedRevision,
      true,
      (task) => ({ ...task, deletedAt: null }),
      now,
    );
  }

  searchTasks(
    ownerId: string,
    query: string,
    status?: "open" | "completed",
    projectId?: string,
    tagId?: string,
  ): readonly TaskRecord[] {
    const like = `%${query}%`;
    const conditions: string[] = ["t.owner_id = ?", "(t.title LIKE ? OR t.notes LIKE ?)"];
    const params: (string | null)[] = [ownerId, like, like];

    if (status !== undefined) {
      conditions.push("t.status = ?");
      params.push(status);
    }

    if (projectId !== undefined) {
      conditions.push("t.project_id = ?");
      params.push(projectId);
    }

    if (tagId !== undefined) {
      conditions.push(
        "EXISTS (SELECT 1 FROM task_tags tt WHERE tt.task_id = t.id AND tt.tag_id = ?)",
      );
      params.push(tagId);
    }

    conditions.push("t.deleted_at IS NULL");

    const sql = `SELECT t.id, t.owner_id, t.title, t.notes, t.status, t.revision,
                        t.created_at, t.updated_at, t.completed_at, t.deleted_at,
                        t.planned_start, t.estimate_minutes
                 FROM tasks t
                 WHERE ${conditions.join(" AND ")}
                 ORDER BY t.created_at DESC, t.id DESC`;

    const rows = this.#database
      .prepare(sql)
      .all(...params) as unknown as readonly {
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
    }[];

    return rows.map((row) => this.#withTaskTags(this.#taskFromRow(row)));
  }

  // -----------------------------------------------------------------------
  // Additional public helpers (called by transitionTask / softDeleteTask)
  // -----------------------------------------------------------------------

  setTaskCompleted(
    ownerId: string,
    taskId: string,
    expectedRevision: number,
    completed: boolean,
    now: string,
  ): ConditionalTaskResult {
    return this.#conditionallyUpdateTask(
      ownerId,
      taskId,
      expectedRevision,
      false,
      (task) => ({
        ...task,
        status: completed ? "completed" : "open",
        completedAt: completed ? now : null,
      }),
      now,
    );
  }

  deleteTask(
    ownerId: string,
    taskId: string,
    expectedRevision: number,
    now: string,
  ): ConditionalTaskResult {
    return this.#conditionallyUpdateTask(
      ownerId,
      taskId,
      expectedRevision,
      false,
      (task) => ({ ...task, deletedAt: now }),
      now,
    );
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

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

  #conditionallyUpdateTask(
    ownerId: string,
    taskId: string,
    expectedRevision: number,
    requireDeleted: boolean,
    update: (task: TaskRecord) => TaskRecord,
    now: string,
  ): ConditionalTaskResult {
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      const current = this.getTask(ownerId, taskId, true);
      if (
        current === undefined ||
        (requireDeleted
          ? current.deletedAt === null
          : current.deletedAt !== null)
      ) {
        this.#database.exec("COMMIT;");
        return { kind: "not-found" };
      }
      if (current.revision !== expectedRevision) {
        this.#database.exec("COMMIT;");
        return { kind: "precondition-failed", task: current };
      }
      const next = {
        ...update(current),
        revision: current.revision + 1,
        updatedAt: now,
      };
      const changed = this.#database
        .prepare(
          `UPDATE tasks SET title = ?, notes = ?, status = ?, revision = ?,
             updated_at = ?, completed_at = ?, deleted_at = ?,
             planned_start = ?, estimate_minutes = ?
           WHERE owner_id = ? AND id = ? AND revision = ?`,
        )
        .run(
          next.title,
          next.notes,
          next.status,
          next.revision,
          next.updatedAt,
          next.completedAt,
          next.deletedAt,
          next.plannedStart,
          next.estimateMinutes,
          ownerId,
          taskId,
          expectedRevision,
        ).changes;
      if (changed !== 1) throw new Error("Conditional task update was lost");
      const fieldVersions = this.#database.prepare(
        "INSERT INTO task_field_versions (task_id,field,version) VALUES (?,?,?) ON CONFLICT(task_id,field) DO UPDATE SET version=excluded.version",
      );
      for (const field of [
        "title",
        "notes",
        "status",
        "estimateMinutes",
      ] as const) {
        if (current[field] !== next[field])
          fieldVersions.run(taskId, field, next.revision);
      }
      this.#appendSyncChangeInTransaction(
        ownerId,
        "task",
        taskId,
        next.deletedAt === null ? "upsert" : "deleted",
        next.revision,
        now,
      );
      this.#database.exec("COMMIT;");
      return { kind: "updated", task: next };
    } catch (error: unknown) {
      this.#database.exec("ROLLBACK;");
      throw error;
    }
  }

  #findTask(ownerId: string, taskId: string): TaskRecord | undefined {
    const row = this.#database
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
    return row === undefined
      ? undefined
      : this.#withTaskTags(this.#taskFromRow(row));
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
}
