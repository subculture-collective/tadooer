import type { DatabaseSync } from "node:sqlite";
import type { SubtaskRecord } from "./index.js";
import type { SubtaskStore } from "./stores.js";

export class SqliteSubtaskStore implements SubtaskStore {
  readonly #database: DatabaseSync;

  constructor(database: DatabaseSync) {
    this.#database = database;
  }

  createSubtask(record: SubtaskRecord): void {
    this.#database
      .prepare(
        "INSERT INTO subtasks (id, owner_id, task_id, title, completed, position, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        record.id,
        record.ownerId,
        record.taskId,
        record.title,
        record.completed ? 1 : 0,
        record.position,
        record.revision,
        record.createdAt,
        record.updatedAt,
      );
  }

  listSubtasks(ownerId: string, taskId: string): readonly SubtaskRecord[] {
    return (
      this.#database
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

  updateSubtask(
    ownerId: string,
    id: string,
    expectedRevision: number,
    patch: Partial<Pick<SubtaskRecord, "title" | "completed" | "position">>,
    now: string,
  ): SubtaskRecord | undefined {
    const current = this.#database
      .prepare("SELECT * FROM subtasks WHERE owner_id=? AND id=?")
      .get(ownerId, id) as unknown as
      Record<string, string | number> | undefined;
    if (current === undefined || Number(current.revision) !== expectedRevision)
      return undefined;
    const next = {
      title: patch.title ?? String(current.title),
      completed: patch.completed ?? Number(current.completed) === 1,
      position: patch.position ?? Number(current.position),
    };
    const changed = this.#database
      .prepare(
        "UPDATE subtasks SET title=?,completed=?,position=?,revision=revision+1,updated_at=? WHERE owner_id=? AND id=? AND revision=?",
      )
      .run(
        next.title,
        next.completed ? 1 : 0,
        next.position,
        now,
        ownerId,
        id,
        expectedRevision,
      ).changes;
    if (changed !== 1) return undefined;
    return this.listSubtasks(ownerId, String(current.task_id)).find(
      (item) => item.id === id,
    );
  }

  deleteSubtask(ownerId: string, id: string): boolean {
    return (
      this.#database
        .prepare(
          "DELETE FROM subtasks WHERE owner_id=? AND id=?",
        )
        .run(ownerId, id).changes === 1
    );
  }

  patchSubtask(
    ownerId: string,
    subtaskId: string,
    title: string,
    completed: boolean,
    now: string,
  ): SubtaskRecord | undefined {
    const changed = this.#database
      .prepare(
        "UPDATE subtasks SET title=?,completed=?,revision=revision+1,updated_at=? WHERE owner_id=? AND id=?",
      )
      .run(
        title,
        completed ? 1 : 0,
        now,
        ownerId,
        subtaskId,
      ).changes;
    if (changed !== 1) return undefined;
    const row = this.#database
      .prepare(
        "SELECT * FROM subtasks WHERE owner_id=? AND id=?",
      )
      .get(ownerId, subtaskId) as unknown as Record<
      string,
      string | number
    > | undefined;
    if (row === undefined) return undefined;
    return {
      id: String(row.id),
      ownerId: String(row.owner_id),
      taskId: String(row.task_id),
      title: String(row.title),
      completed: Number(row.completed) === 1,
      position: Number(row.position),
      revision: Number(row.revision),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }
}
