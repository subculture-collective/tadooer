import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  ProjectRecord,
  SubtaskRecord,
  SyncChangeRecord,
  SyncClientRecord,
  TagRecord,
  TaskRecord,
  TaskTemplateRecord,
  TemplateSetRecord,
  TemplateSubtaskBlueprintRecord,
} from "./index.js";
import type {
  SyncStore,
  TaskCreateSyncResult,
  TaskDeletionSyncResult,
  TaskFieldSyncResult,
} from "./stores.js";

export class SqliteSyncStore implements SyncStore {
  constructor(private readonly db: DatabaseSync) {}

  // ---------------------------------------------------------------------------
  // Client registration and authentication
  // ---------------------------------------------------------------------------

  registerSyncClient(
    input: SyncClientRecord,
  ): "registered" | "already-registered" {
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const existing = this.db
        .prepare(
          "SELECT credential_hash FROM client_identities WHERE id = ? AND owner_id = ?",
        )
        .get(input.id, input.ownerId) as unknown as
        { credential_hash: string | null } | undefined;
      if (existing !== undefined) {
        this.db.exec("COMMIT;");
        return existing.credential_hash === input.credentialHash
          ? "already-registered"
          : "registered";
      }
      this.db
        .prepare(
          `INSERT INTO client_identities (id, owner_id, label, credential_hash, created_at, last_seen_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, NULL)`,
        )
        .run(
          input.id,
          input.ownerId,
          input.label,
          input.credentialHash,
          input.createdAt,
          input.lastSeenAt,
        );
      this.db.exec("COMMIT;");
      return "registered";
    } catch (error) {
      this.db.exec("ROLLBACK;");
      throw error;
    }
  }

  authenticateSyncClient(
    ownerId: string,
    clientId: string,
    credentialHash: string,
    now: string,
  ): SyncClientRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM client_identities WHERE id = ? AND owner_id = ? AND credential_hash = ? AND revoked_at IS NULL`,
      )
      .get(clientId, ownerId, credentialHash) as unknown as
      Record<string, string | null> | undefined;
    if (row === undefined) return undefined;
    this.db
      .prepare("UPDATE client_identities SET last_seen_at = ? WHERE id = ?")
      .run(now, clientId);
    return {
      id: String(row.id),
      ownerId: String(row.owner_id),
      label: String(row.label),
      credentialHash: String(row.credential_hash),
      createdAt: String(row.created_at),
      lastSeenAt: now,
      revokedAt: null,
    };
  }

  listSyncClients(ownerId: string): readonly SyncClientRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM client_identities WHERE owner_id = ? AND credential_hash IS NOT NULL
         AND label NOT LIKE 'automation:%' ORDER BY created_at, id`,
      )
      .all(ownerId) as unknown as readonly Record<string, string | null>[];
    return rows.map((row) => ({
      id: String(row.id),
      ownerId: String(row.owner_id),
      label: String(row.label),
      credentialHash: String(row.credential_hash),
      createdAt: String(row.created_at),
      lastSeenAt: String(row.last_seen_at),
      revokedAt: row.revoked_at === null ? null : String(row.revoked_at),
    }));
  }

  revokeSyncClient(ownerId: string, clientId: string, now: string): boolean {
    return (
      this.db
        .prepare(
          "UPDATE client_identities SET revoked_at = ? WHERE owner_id = ? AND id = ? AND revoked_at IS NULL",
        )
        .run(now, ownerId, clientId).changes === 1
    );
  }

  // ---------------------------------------------------------------------------
  // Sync change stream
  // ---------------------------------------------------------------------------

  appendSyncChange(
    ownerId: string,
    entityType: string,
    entityId: string,
    kind: string,
    revision: number,
    now: string,
  ): SyncChangeRecord {
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const change = this.#appendSyncChangeInTransaction(
        ownerId,
        entityType,
        entityId,
        kind,
        revision,
        now,
      );
      this.db.exec("COMMIT;");
      return change;
    } catch (error) {
      this.db.exec("ROLLBACK;");
      throw error;
    }
  }

  #appendSyncChangeInTransaction(
    ownerId: string,
    entityType: string,
    entityId: string,
    kind: string,
    revision: number,
    now: string,
  ): SyncChangeRecord {
    let state = this.db
      .prepare(
        "SELECT epoch, next_sequence FROM sync_owner_state WHERE owner_id = ?",
      )
      .get(ownerId) as unknown as
      { epoch: string; next_sequence: number } | undefined;
    if (state === undefined) {
      state = { epoch: randomUUID(), next_sequence: 1 };
      this.db
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
    this.db
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
    this.db
      .prepare(
        "UPDATE sync_owner_state SET next_sequence = ?, updated_at = ? WHERE owner_id = ?",
      )
      .run(change.sequence + 1, now, ownerId);
    return change;
  }

  listSyncChanges(
    ownerId: string,
    epoch: string,
    afterSequence: number,
  ): readonly SyncChangeRecord[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM sync_changes WHERE owner_id = ? AND epoch = ? AND sequence > ? ORDER BY sequence`,
        )
        .all(ownerId, epoch, afterSequence) as unknown as readonly Record<
        string,
        string | number
      >[]
    ).map((row) => ({
      ownerId: String(row.owner_id),
      epoch: String(row.epoch),
      sequence: Number(row.sequence),
      entityType: String(row.entity_type),
      entityId: String(row.entity_id),
      kind: String(row.kind),
      revision: Number(row.revision),
      createdAt: String(row.created_at),
    }));
  }

  getSyncState(ownerId: string): {
    readonly epoch: string;
    readonly cursor: number;
  } {
    const row = this.db
      .prepare(
        "SELECT epoch, next_sequence FROM sync_owner_state WHERE owner_id=?",
      )
      .get(ownerId) as unknown as
      { epoch: string; next_sequence: number } | undefined;
    if (row !== undefined)
      return { epoch: row.epoch, cursor: row.next_sequence - 1 };
    const now = new Date().toISOString();
    const epoch = randomUUID();
    this.db
      .prepare(
        "INSERT INTO sync_owner_state (owner_id,epoch,next_sequence,updated_at) VALUES (?,?,1,?)",
      )
      .run(ownerId, epoch, now);
    return { epoch, cursor: 0 };
  }

  pageSyncChanges(
    ownerId: string,
    epoch: string,
    afterSequence: number,
    limit = 100,
  ): {
    readonly resetRequired: boolean;
    readonly changes: readonly SyncChangeRecord[];
    readonly cursor: number;
  } {
    const state = this.getSyncState(ownerId);
    if (
      state.epoch !== epoch ||
      afterSequence < 0 ||
      afterSequence > state.cursor
    )
      return { resetRequired: true, changes: [], cursor: state.cursor };
    const changes = this.listSyncChanges(ownerId, epoch, afterSequence).slice(
      0,
      Math.max(1, Math.min(limit, 500)),
    );
    return {
      resetRequired: false,
      changes,
      cursor: changes.at(-1)?.sequence ?? afterSequence,
    };
  }

  // ---------------------------------------------------------------------------
  // Field versions
  // ---------------------------------------------------------------------------

  getTaskFieldVersions(
    ownerId: string,
    taskId: string,
  ): Readonly<Record<string, number>> {
    if (this.#getTask(ownerId, taskId, true) === undefined) return {};
    const rows = this.db
      .prepare("SELECT field,version FROM task_field_versions WHERE task_id=?")
      .all(taskId) as unknown as readonly { field: string; version: number }[];
    return Object.fromEntries(rows.map((row) => [row.field, row.version]));
  }

  // ---------------------------------------------------------------------------
  // Full sync snapshot
  // ---------------------------------------------------------------------------

  fullSyncSnapshot(ownerId: string): {
    readonly tasks: readonly TaskRecord[];
    readonly projects: readonly ProjectRecord[];
    readonly tags: readonly TagRecord[];
    readonly subtasks: readonly SubtaskRecord[];
    readonly templates: readonly TaskTemplateRecord[];
    readonly templateBlueprints: readonly TemplateSubtaskBlueprintRecord[];
    readonly templateSets: readonly TemplateSetRecord[];
    readonly cursor: { readonly epoch: string; readonly cursor: number };
  } {
    const tasks = this.#listTasks(ownerId);
    const subtasks = tasks.flatMap((task) =>
      this.#listSubtasks(ownerId, task.id),
    );
    const templates = this.#listTaskTemplates(ownerId, "", true);
    return {
      tasks,
      projects: this.#listProjects(ownerId),
      tags: this.#listTags(ownerId),
      subtasks,
      templates,
      templateBlueprints: templates.flatMap((template) =>
        this.#listTemplateSubtaskBlueprints(template.id),
      ),
      templateSets: this.#listTemplateSets(ownerId, true),
      cursor: this.getSyncState(ownerId),
    };
  }

  // ---------------------------------------------------------------------------
  // Sync operation methods
  // ---------------------------------------------------------------------------

  applyTaskFieldSync(input: {
    readonly ownerId: string;
    readonly clientId: string;
    readonly operationId: string;
    readonly requestHash: string;
    readonly taskId: string;
    readonly baseVersions: Readonly<
      Partial<Record<"title" | "notes" | "status" | "estimateMinutes", number>>
    >;
    readonly patch: Partial<
      Pick<TaskRecord, "title" | "notes" | "status" | "estimateMinutes">
    >;
    readonly now: string;
  }): TaskFieldSyncResult {
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const previous = this.db
        .prepare(
          "SELECT * FROM sync_operation_outcomes WHERE owner_id=? AND client_id=? AND operation_id=?",
        )
        .get(input.ownerId, input.clientId, input.operationId) as unknown as
        Record<string, string | number | null> | undefined;
      if (previous !== undefined) {
        this.db.exec("COMMIT;");
        if (String(previous.request_hash) !== input.requestHash)
          return { kind: "idempotency-conflict" };
        const task =
          previous.entity_id === null
            ? undefined
            : this.#getTask(input.ownerId, String(previous.entity_id), true);
        return { kind: "replayed", ...(task === undefined ? {} : { task }) };
      }
      const task = this.#getTask(input.ownerId, input.taskId, true);
      if (task === undefined) {
        this.db.exec("COMMIT;");
        return { kind: "conflict", fields: ["task"] };
      }
      const fields = Object.keys(
        input.patch,
      ) as (keyof typeof input.baseVersions)[];
      const rows = this.db
        .prepare(
          "SELECT field, version FROM task_field_versions WHERE task_id = ?",
        )
        .all(input.taskId) as unknown as readonly {
        field: keyof typeof input.baseVersions;
        version: number;
      }[];
      const versions = new Map(rows.map((row) => [row.field, row.version]));
      const conflicts = fields.filter(
        (field) => versions.get(field) !== input.baseVersions[field],
      );
      if (conflicts.length > 0) {
        this.db
          .prepare(
            "INSERT INTO sync_operation_outcomes (owner_id,client_id,operation_id,request_hash,state,entity_id,revision,conflict_fields,created_at) VALUES (?,?,?,?, 'conflict',?,?,?,?)",
          )
          .run(
            input.ownerId,
            input.clientId,
            input.operationId,
            input.requestHash,
            input.taskId,
            task.revision,
            JSON.stringify(conflicts),
            input.now,
          );
        this.db.exec("COMMIT;");
        return { kind: "conflict", task, fields: conflicts };
      }
      const next = {
        ...task,
        ...input.patch,
        ...(input.patch.status === undefined
          ? {}
          : {
              completedAt:
                input.patch.status === "completed" ? input.now : null,
            }),
        revision: task.revision + 1,
        updatedAt: input.now,
      };
      this.db
        .prepare(
          "UPDATE tasks SET title=?,notes=?,status=?,completed_at=?,estimate_minutes=?,revision=?,updated_at=? WHERE owner_id=? AND id=?",
        )
        .run(
          next.title,
          next.notes,
          next.status,
          next.completedAt,
          next.estimateMinutes,
          next.revision,
          next.updatedAt,
          input.ownerId,
          input.taskId,
        );
      const update = this.db.prepare(
        "INSERT INTO task_field_versions (task_id,field,version) VALUES (?,?,?) ON CONFLICT(task_id,field) DO UPDATE SET version=excluded.version",
      );
      for (const field of fields)
        update.run(input.taskId, field, next.revision);
      this.db
        .prepare(
          "INSERT INTO sync_operation_outcomes (owner_id,client_id,operation_id,request_hash,state,entity_id,revision,created_at) VALUES (?,?,?,?, 'applied',?,?,?)",
        )
        .run(
          input.ownerId,
          input.clientId,
          input.operationId,
          input.requestHash,
          input.taskId,
          next.revision,
          input.now,
        );
      let sync = this.db
        .prepare(
          "SELECT epoch,next_sequence FROM sync_owner_state WHERE owner_id=?",
        )
        .get(input.ownerId) as unknown as
        { epoch: string; next_sequence: number } | undefined;
      if (sync === undefined) {
        sync = { epoch: randomUUID(), next_sequence: 1 };
        this.db
          .prepare(
            "INSERT INTO sync_owner_state (owner_id,epoch,next_sequence,updated_at) VALUES (?,?,?,?)",
          )
          .run(input.ownerId, sync.epoch, 1, input.now);
      }
      this.db
        .prepare(
          "INSERT INTO sync_changes (owner_id,epoch,sequence,entity_type,entity_id,kind,revision,created_at) VALUES (?,?,?,?,?,?,?,?)",
        )
        .run(
          input.ownerId,
          sync.epoch,
          sync.next_sequence,
          "task",
          input.taskId,
          "task.patch",
          next.revision,
          input.now,
        );
      this.db
        .prepare(
          "UPDATE sync_owner_state SET next_sequence=?,updated_at=? WHERE owner_id=?",
        )
        .run(sync.next_sequence + 1, input.now, input.ownerId);
      this.db.exec("COMMIT;");
      return { kind: "applied", task: next };
    } catch (error) {
      this.db.exec("ROLLBACK;");
      throw error;
    }
  }

  applyTaskCompletionSync(input: {
    readonly ownerId: string;
    readonly clientId: string;
    readonly operationId: string;
    readonly requestHash: string;
    readonly taskId: string;
    readonly baseStatusVersion: number;
    readonly completed: boolean;
    readonly now: string;
  }): TaskFieldSyncResult {
    return this.applyTaskFieldSync({
      ownerId: input.ownerId,
      clientId: input.clientId,
      operationId: input.operationId,
      requestHash: input.requestHash,
      taskId: input.taskId,
      baseVersions: { status: input.baseStatusVersion },
      patch: { status: input.completed ? "completed" : "open" },
      now: input.now,
    });
  }

  applyTaskCreateSync(input: {
    readonly ownerId: string;
    readonly clientId: string;
    readonly operationId: string;
    readonly requestHash: string;
    readonly now: string;
    readonly task: Omit<
      TaskRecord,
      | "ownerId"
      | "completedAt"
      | "deletedAt"
      | "plannedStart"
      | "projectId"
      | "tagIds"
    >;
  }): TaskCreateSyncResult {
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const previous = this.db
        .prepare(
          "SELECT request_hash,entity_id FROM sync_operation_outcomes WHERE owner_id=? AND client_id=? AND operation_id=?",
        )
        .get(input.ownerId, input.clientId, input.operationId) as unknown as
        Record<string, string | null> | undefined;
      if (previous !== undefined) {
        this.db.exec("COMMIT;");
        if (previous.request_hash !== input.requestHash)
          return { kind: "idempotency-conflict" };
        const task =
          typeof previous.entity_id !== "string"
            ? undefined
            : this.#getTask(input.ownerId, previous.entity_id, true);
        return { kind: "replayed", ...(task === undefined ? {} : { task }) };
      }
      const existing = this.#getTask(input.ownerId, input.task.id, true);
      if (existing !== undefined) {
        this.db
          .prepare(
            "INSERT INTO sync_operation_outcomes (owner_id,client_id,operation_id,request_hash,state,entity_id,revision,conflict_fields,created_at) VALUES (?,?,?,?, 'conflict',?,?,?,?)",
          )
          .run(
            input.ownerId,
            input.clientId,
            input.operationId,
            input.requestHash,
            input.task.id,
            existing.revision,
            JSON.stringify(["task"]),
            input.now,
          );
        this.db.exec("COMMIT;");
        return { kind: "conflict", task: existing };
      }
      const task: TaskRecord = {
        ...input.task,
        createdAt: input.now,
        updatedAt: input.now,
        ownerId: input.ownerId,
        completedAt: null,
        deletedAt: null,
        plannedStart: null,
        projectId: null,
        tagIds: [],
      };
      this.db
        .prepare(
          "INSERT INTO tasks (id,owner_id,title,notes,status,revision,created_at,updated_at,estimate_minutes) VALUES (?,?,?,?,?,?,?,?,?)",
        )
        .run(
          task.id,
          task.ownerId,
          task.title,
          task.notes,
          task.status,
          task.revision,
          input.now,
          task.updatedAt,
          task.estimateMinutes,
        );
      const field = this.db.prepare(
        "INSERT INTO task_field_versions (task_id,field,version) VALUES (?,?,?)",
      );
      for (const name of [
        "title",
        "notes",
        "status",
        "estimateMinutes",
        "projectId",
        "tagIds",
      ])
        field.run(task.id, name, task.revision);
      this.db
        .prepare(
          "INSERT INTO sync_operation_outcomes (owner_id,client_id,operation_id,request_hash,state,entity_id,revision,created_at) VALUES (?,?,?,?, 'applied',?,?,?)",
        )
        .run(
          input.ownerId,
          input.clientId,
          input.operationId,
          input.requestHash,
          task.id,
          task.revision,
          task.createdAt,
        );
      this.#appendSyncChangeInTransaction(
        input.ownerId,
        "task",
        task.id,
        "upsert",
        task.revision,
        input.now,
      );
      this.db.exec("COMMIT;");
      return { kind: "applied", task };
    } catch (error) {
      this.db.exec("ROLLBACK;");
      throw error;
    }
  }

  applyTaskDeletionSync(input: {
    readonly ownerId: string;
    readonly clientId: string;
    readonly operationId: string;
    readonly requestHash: string;
    readonly taskId: string;
    readonly baseRevision: number;
    readonly restore: boolean;
    readonly now: string;
  }): TaskDeletionSyncResult {
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const previous = this.db
        .prepare(
          "SELECT request_hash,entity_id FROM sync_operation_outcomes WHERE owner_id=? AND client_id=? AND operation_id=?",
        )
        .get(input.ownerId, input.clientId, input.operationId) as unknown as
        Record<string, string | null> | undefined;
      if (previous !== undefined) {
        this.db.exec("COMMIT;");
        if (previous.request_hash !== input.requestHash)
          return { kind: "idempotency-conflict" };
        const task =
          typeof previous.entity_id !== "string"
            ? undefined
            : this.#getTask(input.ownerId, previous.entity_id, true);
        return { kind: "replayed", ...(task === undefined ? {} : { task }) };
      }
      const task = this.#getTask(input.ownerId, input.taskId, true);
      const activeSession = input.restore
        ? undefined
        : this.#getActiveSession(input.ownerId);
      if (
        task?.revision !== input.baseRevision ||
        (input.restore ? task.deletedAt === null : task.deletedAt !== null) ||
        (activeSession?.endedAt === null &&
          activeSession.taskId === input.taskId)
      ) {
        this.db
          .prepare(
            "INSERT INTO sync_operation_outcomes (owner_id,client_id,operation_id,request_hash,state,entity_id,revision,conflict_fields,created_at) VALUES (?,?,?,?, 'conflict',?,?,?,?)",
          )
          .run(
            input.ownerId,
            input.clientId,
            input.operationId,
            input.requestHash,
            input.taskId,
            task?.revision ?? null,
            JSON.stringify(["deletedAt"]),
            input.now,
          );
        this.db.exec("COMMIT;");
        return { kind: "conflict", ...(task === undefined ? {} : { task }) };
      }
      const nextRevision = task.revision + 1;
      this.db
        .prepare(
          "UPDATE tasks SET deleted_at=?,revision=?,updated_at=? WHERE owner_id=? AND id=? AND revision=?",
        )
        .run(
          input.restore ? null : input.now,
          nextRevision,
          input.now,
          input.ownerId,
          input.taskId,
          task.revision,
        );
      const next = this.#getTask(input.ownerId, input.taskId, true);
      if (next === undefined) throw new Error("Deleted task disappeared");
      this.db
        .prepare(
          "INSERT INTO sync_operation_outcomes (owner_id,client_id,operation_id,request_hash,state,entity_id,revision,created_at) VALUES (?,?,?,?, 'applied',?,?,?)",
        )
        .run(
          input.ownerId,
          input.clientId,
          input.operationId,
          input.requestHash,
          input.taskId,
          nextRevision,
          input.now,
        );
      this.#appendSyncChangeInTransaction(
        input.ownerId,
        "task",
        input.taskId,
        input.restore ? "upsert" : "deleted",
        nextRevision,
        input.now,
      );
      this.db.exec("COMMIT;");
      return { kind: "applied", task: next };
    } catch (error) {
      this.db.exec("ROLLBACK;");
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // Private task helpers
  // ---------------------------------------------------------------------------

  #getTask(
    ownerId: string,
    taskId: string,
    includeDeleted: boolean,
  ): TaskRecord | undefined {
    const row = this.db
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
    if (row === undefined) return undefined;
    const task: TaskRecord = {
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
    return this.#withTaskTags(task);
  }

  #withTaskTags(task: TaskRecord): TaskRecord {
    const project = this.db
      .prepare("SELECT project_id FROM tasks WHERE owner_id = ? AND id = ?")
      .get(task.ownerId, task.id) as unknown as
      { project_id: string | null } | undefined;
    const tags = this.db
      .prepare("SELECT tag_id FROM task_tags WHERE task_id = ? ORDER BY tag_id")
      .all(task.id) as unknown as readonly { tag_id: string }[];
    return {
      ...task,
      projectId: project?.project_id ?? null,
      tagIds: tags.map((tag) => tag.tag_id),
    };
  }

  #getActiveSession(ownerId: string):
    | {
        readonly id: string;
        readonly taskId: string;
        readonly revision: number;
        readonly endedAt: string | null;
      }
    | undefined {
    const row = this.db
      .prepare(
        "SELECT id, task_id, revision, ended_at FROM active_sessions WHERE owner_id = ? ORDER BY ended_at IS NULL DESC, created_at DESC LIMIT 1",
      )
      .get(ownerId) as unknown as
      Record<string, string | number | null> | undefined;
    return row === undefined
      ? undefined
      : {
          id: String(row.id),
          taskId: String(row.task_id),
          revision: Number(row.revision),
          endedAt: row.ended_at === null ? null : String(row.ended_at),
        };
  }

  // ---------------------------------------------------------------------------
  // Private query helpers for fullSyncSnapshot
  // ---------------------------------------------------------------------------

  #listTasks(ownerId: string): TaskRecord[] {
    const rows = this.db
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

  #listSubtasks(ownerId: string, taskId: string): SubtaskRecord[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM subtasks WHERE owner_id = ? AND task_id = ? ORDER BY position, id",
        )
        .all(ownerId, taskId) as unknown as readonly Record<
        string,
        string | number
      >[]
    ).map((row) => ({
      id: String(row.id),
      ownerId: String(row.owner_id),
      taskId: String(row.task_id),
      title: String(row.title),
      completed: Number(row.completed) === 1,
      position: Number(row.position),
      revision: Number(row.revision),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    }));
  }

  #listProjects(ownerId: string): ProjectRecord[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM projects WHERE owner_id = ? ORDER BY archived_at IS NOT NULL, title COLLATE NOCASE, id",
        )
        .all(ownerId) as unknown as readonly Record<
        string,
        string | number | null
      >[]
    ).map((row) => ({
      id: String(row.id),
      ownerId: String(row.owner_id),
      title: String(row.title),
      revision: Number(row.revision),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      archivedAt: row.archived_at === null ? null : String(row.archived_at),
    }));
  }

  #listTags(ownerId: string): TagRecord[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM tags WHERE owner_id=? ORDER BY archived_at IS NOT NULL,display_name COLLATE NOCASE,id",
        )
        .all(ownerId) as unknown as readonly Record<
        string,
        string | number | null
      >[]
    ).map((row) => ({
      id: String(row.id),
      ownerId: String(row.owner_id),
      title: String(row.display_name),
      revision: Number(row.revision),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      archivedAt: row.archived_at === null ? null : String(row.archived_at),
      normalizedName: String(row.normalized_name),
    }));
  }

  #listTaskTemplates(
    ownerId: string,
    _query: string,
    includeArchived: boolean,
  ): TaskTemplateRecord[] {
    const search = `%${_query.replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
    return (
      this.db
        .prepare(
          "SELECT * FROM task_templates WHERE owner_id=? AND (?=1 OR archived_at IS NULL) AND (title LIKE ? ESCAPE '\\' OR notes LIKE ? ESCAPE '\\') ORDER BY archived_at IS NOT NULL,title COLLATE NOCASE,id",
        )
        .all(
          ownerId,
          includeArchived ? 1 : 0,
          search,
          search,
        ) as unknown as readonly Record<string, string | number | null>[]
    ).map((row) => {
      const id = String(row.id);
      const tags = this.db
        .prepare(
          "SELECT tag_id FROM task_template_tags WHERE template_id=? ORDER BY tag_id",
        )
        .all(id) as unknown as readonly { tag_id: string }[];
      return {
        id,
        ownerId: String(row.owner_id),
        title: String(row.title),
        notes: String(row.notes),
        estimateMinutes:
          row.estimate_minutes === null ? null : Number(row.estimate_minutes),
        suggestedProjectId:
          row.suggested_project_id === null
            ? null
            : String(row.suggested_project_id),
        tagIds: tags.map((tag) => tag.tag_id),
        revision: Number(row.revision),
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at),
        archivedAt: row.archived_at === null ? null : String(row.archived_at),
      };
    });
  }

  #listTemplateSubtaskBlueprints(
    templateId: string,
  ): TemplateSubtaskBlueprintRecord[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM template_subtask_blueprints WHERE template_id=? ORDER BY position,id",
        )
        .all(templateId) as unknown as readonly Record<
        string,
        string | number
      >[]
    ).map((row) => ({
      id: String(row.id),
      templateId: String(row.template_id),
      title: String(row.title),
      position: Number(row.position),
      revision: Number(row.revision),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    }));
  }

  #listTemplateSets(
    ownerId: string,
    includeArchived: boolean,
  ): TemplateSetRecord[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM template_sets WHERE owner_id=? AND (?=1 OR archived_at IS NULL) ORDER BY archived_at IS NOT NULL,title COLLATE NOCASE,id",
        )
        .all(ownerId, includeArchived ? 1 : 0) as unknown as readonly Record<
        string,
        string | number | null
      >[]
    ).map((row) => ({
      id: String(row.id),
      ownerId: String(row.owner_id),
      title: String(row.title),
      revision: Number(row.revision),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      archivedAt: row.archived_at === null ? null : String(row.archived_at),
    }));
  }
}
