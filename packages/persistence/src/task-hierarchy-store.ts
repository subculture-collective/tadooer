import type { DatabaseSync } from "node:sqlite";
import {
  compareChildren,
  planChildPosition,
  validateTaskParent,
  type TaskHierarchyViolation,
} from "@suite/domain";
import type { TaskRecord } from "./index.ts";

/** Hierarchy writes are revisioned task writes; see docs/adr/0018-task-hierarchy.md. */
export type TaskHierarchyMoveResult =
  | { readonly kind: "moved"; readonly task: TaskRecord }
  | { readonly kind: "not-found" }
  | { readonly kind: "precondition-failed"; readonly task: TaskRecord }
  | {
      readonly kind: "invalid";
      readonly code: TaskHierarchyViolation;
      readonly task: TaskRecord;
    };

export type TaskHierarchyReorderResult =
  | { readonly kind: "reordered"; readonly children: readonly TaskRecord[] }
  | { readonly kind: "not-found" }
  | { readonly kind: "precondition-failed" };

export type TaskHierarchyCreateResult =
  | { readonly kind: "created" | "replayed"; readonly task: TaskRecord }
  | { readonly kind: "conflict" }
  | { readonly kind: "invalid"; readonly code: TaskHierarchyViolation };

export interface TaskHierarchySyncResult {
  readonly kind: "applied" | "replayed" | "conflict" | "idempotency-conflict";
  readonly task?: TaskRecord;
  readonly fields?: readonly string[];
}

export interface TaskHierarchyDependencies {
  readonly getTask: (
    ownerId: string,
    taskId: string,
    includeDeleted?: boolean,
  ) => TaskRecord | undefined;
  readonly appendChange: (
    ownerId: string,
    entityId: string,
    kind: "upsert" | "deleted",
    revision: number,
    now: string,
  ) => void;
}

export class TaskHierarchyError extends Error {
  constructor(readonly code: "TASK_CHILD_DELETE_BLOCKED") {
    super(code);
  }
}

export class SqliteTaskHierarchyStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly deps: TaskHierarchyDependencies,
  ) {}

  /** Current parent version; clients send it as the base for a structural move. */
  parentVersion(ownerId: string, taskId: string): number | undefined {
    const row = this.db
      .prepare("SELECT hierarchy_version FROM tasks WHERE owner_id=? AND id=?")
      .get(ownerId, taskId) as { hierarchy_version: number } | undefined;
    return row?.hierarchy_version;
  }

  childIds(
    ownerId: string,
    parentId: string,
    includeDeleted = false,
  ): string[] {
    return (
      this.db
        .prepare(
          `SELECT id FROM tasks WHERE owner_id=? AND parent_id=?
             AND (?=1 OR deleted_at IS NULL)
           ORDER BY child_position, id`,
        )
        .all(ownerId, parentId, includeDeleted ? 1 : 0) as { id: string }[]
    ).map(({ id }) => id);
  }

  listChildren(
    ownerId: string,
    parentId: string,
    includeDeleted = false,
  ): readonly TaskRecord[] {
    return this.childIds(ownerId, parentId, includeDeleted)
      .map((id) => this.deps.getTask(ownerId, id, true))
      .filter((task): task is TaskRecord => task !== undefined)
      .toSorted(compareChildren);
  }

  /** The task and every active child that a soft delete would remove together. */
  deletionScope(ownerId: string, taskId: string): readonly string[] {
    return [taskId, ...this.childIds(ownerId, taskId)];
  }

  /** Child IDs holding an active focus session or calendar block. */
  blockedChildIds(ownerId: string, taskId: string): readonly string[] {
    return (
      this.db
        .prepare(
          `SELECT c.id FROM tasks c WHERE c.owner_id=? AND c.parent_id=? AND c.deleted_at IS NULL
             AND (EXISTS (SELECT 1 FROM active_sessions s WHERE s.task_id=c.id AND s.ended_at IS NULL)
               OR EXISTS (SELECT 1 FROM task_calendar_blocks b WHERE b.task_id=c.id))
           ORDER BY c.id`,
        )
        .all(ownerId, taskId) as { id: string }[]
    ).map(({ id }) => id);
  }

  /**
   * Moves a task under `parentId` at `index`, or to top level when `parentId`
   * is null. Either the expected revision or the expected parent version must
   * match; a mismatch changes nothing.
   */
  move(input: {
    readonly ownerId: string;
    readonly taskId: string;
    readonly parentId: string | null;
    readonly index?: number | null;
    readonly expectedRevision?: number;
    readonly expectedParentVersion?: number;
    readonly now: string;
  }): TaskHierarchyMoveResult {
    this.db.exec("SAVEPOINT task_hierarchy_move;");
    try {
      const result = this.#move(input);
      this.db.exec("RELEASE SAVEPOINT task_hierarchy_move;");
      return result;
    } catch (error) {
      this.db.exec(
        "ROLLBACK TO SAVEPOINT task_hierarchy_move; RELEASE SAVEPOINT task_hierarchy_move;",
      );
      throw error;
    }
  }

  /** Replaces the full child order. Every active child and revision must be listed. */
  reorder(input: {
    readonly ownerId: string;
    readonly parentId: string;
    readonly items: readonly {
      readonly id: string;
      readonly revision: number;
    }[];
    readonly now: string;
  }): TaskHierarchyReorderResult {
    this.db.exec("SAVEPOINT task_hierarchy_reorder;");
    try {
      const parent = this.deps.getTask(input.ownerId, input.parentId);
      if (parent === undefined) {
        this.db.exec("RELEASE SAVEPOINT task_hierarchy_reorder;");
        return { kind: "not-found" };
      }
      const current = this.listChildren(input.ownerId, input.parentId);
      const byId = new Map(current.map((child) => [child.id, child]));
      if (
        input.items.length !== current.length ||
        new Set(input.items.map(({ id }) => id)).size !== input.items.length ||
        input.items.some(
          ({ id, revision }) => byId.get(id)?.revision !== revision,
        )
      ) {
        this.db.exec("RELEASE SAVEPOINT task_hierarchy_reorder;");
        return { kind: "precondition-failed" };
      }
      for (const [index, item] of input.items.entries()) {
        const position = (index + 1) * 1024;
        if (byId.get(item.id)?.childPosition === position) continue;
        this.#writePlacement(
          input.ownerId,
          item.id,
          item.revision,
          input.parentId,
          position,
          input.now,
        );
      }
      const children = this.listChildren(input.ownerId, input.parentId);
      this.db.exec("RELEASE SAVEPOINT task_hierarchy_reorder;");
      return { kind: "reordered", children };
    } catch (error) {
      this.db.exec(
        "ROLLBACK TO SAVEPOINT task_hierarchy_reorder; RELEASE SAVEPOINT task_hierarchy_reorder;",
      );
      throw error;
    }
  }

  /**
   * Creates a task and places it under a parent in one transaction. A replayed
   * create returns the stored task and never moves it again.
   */
  createChild(input: {
    readonly ownerId: string;
    readonly parentId: string;
    readonly index?: number | null;
    readonly now: string;
    readonly create: () =>
      | { readonly kind: "created" | "replayed"; readonly task: TaskRecord }
      | { readonly kind: "conflict" };
  }): TaskHierarchyCreateResult {
    this.db.exec("SAVEPOINT task_hierarchy_create;");
    try {
      const created = input.create();
      if (created.kind !== "created") {
        this.db.exec("RELEASE SAVEPOINT task_hierarchy_create;");
        return created;
      }
      const moved = this.#move({
        ownerId: input.ownerId,
        taskId: created.task.id,
        parentId: input.parentId,
        index: input.index ?? null,
        expectedRevision: created.task.revision,
        now: input.now,
      });
      if (moved.kind !== "moved") {
        this.db.exec(
          "ROLLBACK TO SAVEPOINT task_hierarchy_create; RELEASE SAVEPOINT task_hierarchy_create;",
        );
        return {
          kind: "invalid",
          code: moved.kind === "invalid" ? moved.code : "parent_missing",
        };
      }
      this.db.exec("RELEASE SAVEPOINT task_hierarchy_create;");
      return { kind: "created", task: moved.task };
    } catch (error) {
      this.db.exec(
        "ROLLBACK TO SAVEPOINT task_hierarchy_create; RELEASE SAVEPOINT task_hierarchy_create;",
      );
      throw error;
    }
  }

  /** Offline `task.move` replay; outcomes are stored like other sync operations. */
  applyMoveSync(input: {
    readonly ownerId: string;
    readonly clientId: string;
    readonly operationId: string;
    readonly requestHash: string;
    readonly taskId: string;
    readonly parentId: string | null;
    readonly index: number | null;
    readonly baseParentVersion: number;
    readonly now: string;
  }): TaskHierarchySyncResult {
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const previous = this.db
        .prepare(
          "SELECT request_hash,state,entity_id,conflict_fields FROM sync_operation_outcomes WHERE owner_id=? AND client_id=? AND operation_id=?",
        )
        .get(input.ownerId, input.clientId, input.operationId) as
        | {
            request_hash: string;
            state: string;
            entity_id: string | null;
            conflict_fields: string | null;
          }
        | undefined;
      if (previous !== undefined) {
        this.db.exec("COMMIT;");
        if (previous.request_hash !== input.requestHash)
          return { kind: "idempotency-conflict" };
        const task =
          previous.entity_id === null
            ? undefined
            : this.deps.getTask(input.ownerId, previous.entity_id, true);
        return {
          kind: previous.state === "conflict" ? "conflict" : "replayed",
          ...(task === undefined ? {} : { task }),
          ...(previous.state === "conflict"
            ? {
                fields: JSON.parse(
                  previous.conflict_fields ?? "[]",
                ) as string[],
              }
            : {}),
        };
      }
      const result = this.#move({
        ownerId: input.ownerId,
        taskId: input.taskId,
        parentId: input.parentId,
        index: input.index,
        expectedParentVersion: input.baseParentVersion,
        now: input.now,
      });
      const task =
        result.kind === "moved" ||
        result.kind === "precondition-failed" ||
        result.kind === "invalid"
          ? result.task
          : this.deps.getTask(input.ownerId, input.taskId, true);
      const conflict = result.kind !== "moved";
      this.db
        .prepare(
          "INSERT INTO sync_operation_outcomes (owner_id,client_id,operation_id,request_hash,state,entity_id,revision,conflict_fields,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
        )
        .run(
          input.ownerId,
          input.clientId,
          input.operationId,
          input.requestHash,
          conflict ? "conflict" : "applied",
          input.taskId,
          task?.revision ?? null,
          conflict ? JSON.stringify(["parent"]) : null,
          input.now,
        );
      this.db.exec("COMMIT;");
      return {
        kind: conflict ? "conflict" : "applied",
        ...(task === undefined ? {} : { task }),
        ...(conflict ? { fields: ["parent"] } : {}),
      };
    } catch (error) {
      this.db.exec("ROLLBACK;");
      throw error;
    }
  }

  /** Soft-deletes active children with the parent's deletion timestamp. */
  cascadeDelete(
    ownerId: string,
    parentId: string,
    deletedAt: string,
    now: string,
  ): void {
    if (this.blockedChildIds(ownerId, parentId).length > 0)
      throw new TaskHierarchyError("TASK_CHILD_DELETE_BLOCKED");
    for (const child of this.listChildren(ownerId, parentId)) {
      this.db
        .prepare(
          "UPDATE tasks SET deleted_at=?,revision=revision+1,updated_at=? WHERE owner_id=? AND id=? AND revision=?",
        )
        .run(deletedAt, now, ownerId, child.id, child.revision);
      this.deps.appendChange(
        ownerId,
        child.id,
        "deleted",
        child.revision + 1,
        now,
      );
    }
  }

  /**
   * After a task restore: detach it if its parent is still deleted, then
   * restore the children that were deleted together with it.
   */
  afterRestore(
    ownerId: string,
    taskId: string,
    previousDeletedAt: string | null,
    now: string,
  ): void {
    const restored = this.deps.getTask(ownerId, taskId);
    if (restored === undefined) return;
    if (restored.parentId != null) {
      const parent = this.deps.getTask(ownerId, restored.parentId);
      if (parent === undefined)
        this.db
          .prepare(
            "UPDATE tasks SET parent_id=NULL,child_position=NULL,hierarchy_version=revision WHERE owner_id=? AND id=?",
          )
          .run(ownerId, taskId);
    }
    if (previousDeletedAt === null) return;
    for (const child of this.listChildren(ownerId, taskId, true)) {
      if (child.deletedAt !== previousDeletedAt) continue;
      this.db
        .prepare(
          "UPDATE tasks SET deleted_at=NULL,revision=revision+1,updated_at=? WHERE owner_id=? AND id=? AND revision=?",
        )
        .run(now, ownerId, child.id, child.revision);
      this.deps.appendChange(
        ownerId,
        child.id,
        "upsert",
        child.revision + 1,
        now,
      );
    }
  }

  #move(input: {
    readonly ownerId: string;
    readonly taskId: string;
    readonly parentId: string | null;
    readonly index?: number | null;
    readonly expectedRevision?: number;
    readonly expectedParentVersion?: number;
    readonly now: string;
  }): TaskHierarchyMoveResult {
    const task = this.deps.getTask(input.ownerId, input.taskId);
    if (task === undefined) return { kind: "not-found" };
    const version = this.parentVersion(input.ownerId, task.id);
    if (
      (input.expectedRevision !== undefined &&
        task.revision !== input.expectedRevision) ||
      (input.expectedParentVersion !== undefined &&
        version !== input.expectedParentVersion) ||
      (input.expectedRevision === undefined &&
        input.expectedParentVersion === undefined)
    )
      return { kind: "precondition-failed", task };
    if (input.parentId === null) {
      if (task.parentId == null) return { kind: "moved", task };
      this.#writePlacement(
        input.ownerId,
        task.id,
        task.revision,
        null,
        null,
        input.now,
      );
      return { kind: "moved", task: this.#required(input.ownerId, task.id) };
    }
    const violation = validateTaskParent({
      taskId: task.id,
      parent: this.deps.getTask(input.ownerId, input.parentId, true),
      taskHasActiveChildren: this.childIds(input.ownerId, task.id).length > 0,
    });
    if (violation !== null) return { kind: "invalid", code: violation, task };
    // Deleted children of a task that becomes a child stay recoverable as
    // top-level tasks rather than forming a third level.
    for (const deletedChild of this.listChildren(input.ownerId, task.id, true))
      this.#writePlacement(
        input.ownerId,
        deletedChild.id,
        deletedChild.revision,
        null,
        null,
        input.now,
        "deleted",
      );
    const siblings = this.listChildren(input.ownerId, input.parentId).filter(
      ({ id }) => id !== task.id,
    );
    const plan = planChildPosition(
      siblings.map(({ childPosition }) => childPosition ?? 0),
      input.index,
    );
    if (plan.kind === "renumber")
      for (const [index, sibling] of siblings.entries()) {
        const position = plan.siblingPositions[index];
        if (position === undefined || sibling.childPosition === position)
          continue;
        this.#writePlacement(
          input.ownerId,
          sibling.id,
          sibling.revision,
          input.parentId,
          position,
          input.now,
        );
      }
    this.#writePlacement(
      input.ownerId,
      task.id,
      task.revision,
      input.parentId,
      plan.position,
      input.now,
    );
    return { kind: "moved", task: this.#required(input.ownerId, task.id) };
  }

  #writePlacement(
    ownerId: string,
    taskId: string,
    revision: number,
    parentId: string | null,
    position: number | null,
    now: string,
    changeKind: "upsert" | "deleted" = "upsert",
  ): void {
    const changed = this.db
      .prepare(
        `UPDATE tasks SET parent_id=?,child_position=?,revision=revision+1,
           hierarchy_version=revision+1,updated_at=?
         WHERE owner_id=? AND id=? AND revision=?`,
      )
      .run(parentId, position, now, ownerId, taskId, revision).changes;
    if (changed !== 1) throw new Error("Conditional hierarchy update was lost");
    this.deps.appendChange(ownerId, taskId, changeKind, revision + 1, now);
  }

  #required(ownerId: string, taskId: string): TaskRecord {
    const task = this.deps.getTask(ownerId, taskId, true);
    if (task === undefined) throw new Error("Hierarchy task disappeared");
    return task;
  }
}
