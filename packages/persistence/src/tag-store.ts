import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { TagRecord } from "./index.js";
import type { TagStore } from "./stores.js";

export class SqliteTagStore implements TagStore {
  readonly #database: DatabaseSync;

  constructor(database: DatabaseSync) {
    this.#database = database;
  }

  // ---------------------------------------------------------------------------
  // Private helpers (copied exactly from SuiteDatabase in index.ts)
  // ---------------------------------------------------------------------------

  #projectFromRow(row: Record<string, string | number | null>): {
    readonly id: string;
    readonly ownerId: string;
    readonly title: string;
    readonly revision: number;
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly archivedAt: string | null;
  } {
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

  #tag(ownerId: string, id: string): TagRecord | undefined {
    const row = this.#database
      .prepare("SELECT * FROM tags WHERE owner_id=? AND id=?")
      .get(ownerId, id) as unknown as
      Record<string, string | number | null> | undefined;
    return row === undefined
      ? undefined
      : {
          ...this.#projectFromRow({ ...row, title: String(row.display_name) }),
          normalizedName: String(row.normalized_name),
        };
  }

  #appendSyncChangeInTransaction(
    ownerId: string,
    entityType: string,
    entityId: string,
    kind: string,
    revision: number,
    now: string,
  ) {
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
    const change = {
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

  // ---------------------------------------------------------------------------
  // Public methods (bodies copied verbatim from SuiteDatabase)
  // ---------------------------------------------------------------------------

  createTag(record: TagRecord): void {
    this.#database
      .prepare(
        "INSERT INTO tags (id, owner_id, display_name, normalized_name, revision, created_at, updated_at, archived_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        record.id,
        record.ownerId,
        record.title,
        record.normalizedName,
        record.revision,
        record.createdAt,
        record.updatedAt,
        record.archivedAt,
      );
  }

  archiveTag(ownerId: string, id: string, now: string): TagRecord | undefined {
    const result = this.#database
      .prepare(
        "UPDATE tags SET archived_at = ?, revision = revision + 1, updated_at = ? WHERE owner_id = ? AND id = ? AND archived_at IS NULL",
      )
      .run(now, now, ownerId, id);
    return result.changes === 1 ? this.#tag(ownerId, id) : undefined;
  }

  listTags(ownerId: string): readonly TagRecord[] {
    return (
      this.#database
        .prepare(
          "SELECT * FROM tags WHERE owner_id=? ORDER BY archived_at IS NOT NULL,display_name COLLATE NOCASE,id",
        )
        .all(ownerId) as unknown as readonly Record<
        string,
        string | number | null
      >[]
    ).map((row) => ({
      ...this.#projectFromRow({ ...row, title: String(row.display_name) }),
      normalizedName: String(row.normalized_name),
    }));
  }

  renameTag(
    ownerId: string,
    id: string,
    expectedRevision: number,
    title: string,
    normalizedName: string,
    now: string,
  ): TagRecord | undefined {
    const result = this.#database
      .prepare(
        "UPDATE tags SET display_name=?,normalized_name=?,revision=revision+1,updated_at=? WHERE owner_id=? AND id=? AND revision=?",
      )
      .run(title, normalizedName, now, ownerId, id, expectedRevision);
    return result.changes === 1 ? this.#tag(ownerId, id) : undefined;
  }

  setTaskTags(
    ownerId: string,
    taskId: string,
    tagIds: readonly string[],
    expectedRevision?: number,
    now = new Date().toISOString(),
  ): boolean {
    if (tagIds.length > 25 || new Set(tagIds).size !== tagIds.length)
      return false;
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      const current = this.#database
        .prepare(
          "SELECT revision FROM tasks WHERE owner_id = ? AND id = ? AND deleted_at IS NULL",
        )
        .get(ownerId, taskId) as unknown as { revision: number } | undefined;
      if (
        current === undefined ||
        (expectedRevision !== undefined &&
          current.revision !== expectedRevision)
      ) {
        this.#database.exec("ROLLBACK;");
        return false;
      }
      const valid = this.#database
        .prepare(
          `SELECT count(*) AS count FROM tags WHERE owner_id = ? AND archived_at IS NULL AND id IN (${tagIds.map(() => "?").join(",") || "NULL"})`,
        )
        .get(ownerId, ...tagIds) as unknown as { count: number };
      if (valid.count !== tagIds.length) {
        this.#database.exec("ROLLBACK;");
        return false;
      }
      this.#database
        .prepare("DELETE FROM task_tags WHERE task_id = ?")
        .run(taskId);
      const insert = this.#database.prepare(
        "INSERT INTO task_tags (task_id, tag_id) VALUES (?, ?)",
      );
      for (const tagId of tagIds) insert.run(taskId, tagId);
      const nextRevision = current.revision + 1;
      const changed = this.#database
        .prepare(
          "UPDATE tasks SET revision=?,updated_at=? WHERE owner_id=? AND id=? AND revision=?",
        )
        .run(nextRevision, now, ownerId, taskId, current.revision).changes;
      if (changed !== 1)
        throw new Error("Conditional task tag update was lost");
      this.#database
        .prepare(
          "INSERT INTO task_field_versions (task_id,field,version) VALUES (?, 'tagIds', ?) ON CONFLICT(task_id,field) DO UPDATE SET version=excluded.version",
        )
        .run(taskId, nextRevision);
      this.#appendSyncChangeInTransaction(
        ownerId,
        "task",
        taskId,
        "upsert",
        nextRevision,
        now,
      );
      this.#database.exec("COMMIT;");
      return true;
    } catch (error) {
      this.#database.exec("ROLLBACK;");
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // New methods (TagStore interface requires)
  // ---------------------------------------------------------------------------

  getTag(ownerId: string, tagId: string): TagRecord | undefined {
    return this.#tag(ownerId, tagId);
  }

  patchTag(
    ownerId: string,
    tagId: string,
    displayName: string,
    now: string,
  ): TagRecord | undefined {
    const normalizedName = displayName.trim().toLocaleLowerCase();
    const result = this.#database
      .prepare(
        "UPDATE tags SET display_name = ?, normalized_name = LOWER(?), revision = revision + 1, updated_at = ? WHERE owner_id = ? AND id = ? AND archived_at IS NULL",
      )
      .run(displayName, normalizedName, now, ownerId, tagId);
    return result.changes === 1 ? this.#tag(ownerId, tagId) : undefined;
  }
}
