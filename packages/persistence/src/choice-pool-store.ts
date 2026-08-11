import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  ChoicePoolHistoryRecord,
  ChoicePoolItemRecord,
  ChoicePoolRecord,
  PlanningPlaceholderRecord,
  PlanningPlaceholderResolutionRecord,
  PlanningPlaceholderResolutionResult,
  SubtaskRecord,
  SyncChangeRecord,
  TaskRecord,
  TaskTemplateRecord,
  TemplatePoolSlotRecord,
} from "./index.js";
import type { ChoicePoolStore } from "./stores.js";

export class SqliteChoicePoolStore implements ChoicePoolStore {
  constructor(private readonly db: DatabaseSync) {}

  // -----------------------------------------------------------------------
  // createChoicePool
  // -----------------------------------------------------------------------

  createChoicePool(
    pool: ChoicePoolRecord,
  ): ChoicePoolRecord {
    // Note: The original method accepted items separately, but the store
    // interface has items embedded in the record. We use a compatible
    // parameter but here items come in via the update path.
    // This follows the pattern where items are managed via updateChoicePool.
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      if (
        pool.policy === "cooldown" && pool.cooldownSeconds === null
      )
        throw new Error(
          "Choice pool with cooldown policy must specify cooldownSeconds",
        );
      this.db
        .prepare(
          "INSERT INTO choice_pools (id,owner_id,title,policy,pick_count,cooldown_seconds,revision,created_at,updated_at,archived_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          pool.id,
          pool.ownerId,
          pool.title,
          pool.policy,
          pool.pickCount,
          pool.cooldownSeconds,
          pool.revision,
          pool.createdAt,
          pool.updatedAt,
          pool.archivedAt,
        );
      this.#appendSyncChangeInTransaction(
        pool.ownerId,
        "choice_pool",
        pool.id,
        "upsert",
        pool.revision,
        pool.createdAt,
      );
      this.db.exec("COMMIT;");
      return pool;
    } catch (error) {
      this.db.exec("ROLLBACK;");
      throw error;
    }
  }

  // -----------------------------------------------------------------------
  // getChoicePool
  // -----------------------------------------------------------------------

  getChoicePool(
    ownerId: string,
    id: string,
    includeArchived = false,
  ): ChoicePoolRecord | undefined {
    const row = this.db
      .prepare(
        "SELECT * FROM choice_pools WHERE owner_id=? AND id=? AND (?=1 OR archived_at IS NULL)",
      )
      .get(ownerId, id, includeArchived ? 1 : 0) as unknown as
      Record<string, string | number | null> | undefined;
    return row === undefined ? undefined : this.#choicePoolFromRow(row);
  }

  // -----------------------------------------------------------------------
  // listChoicePools
  // -----------------------------------------------------------------------

  listChoicePools(
    ownerId: string,
    includeArchived = false,
  ): readonly ChoicePoolRecord[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM choice_pools WHERE owner_id=? AND (?=1 OR archived_at IS NULL) ORDER BY archived_at IS NOT NULL,title COLLATE NOCASE,id",
        )
        .all(ownerId, includeArchived ? 1 : 0) as unknown as readonly Record<
        string,
        string | number | null
      >[]
    ).map((row) => this.#choicePoolFromRow(row));
  }

  // -----------------------------------------------------------------------
  // updateChoicePool
  // -----------------------------------------------------------------------

  updateChoicePool(
    ownerId: string,
    poolId: string,
    patch: {
      readonly title: string;
      readonly policy: ChoicePoolRecord["policy"];
      readonly pickCount: number;
      readonly cooldownSeconds: number | null;
      readonly items: readonly { readonly id?: string; readonly title: string }[];
    },
    now: string,
  ): ChoicePoolRecord | undefined {
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const current = this.getChoicePool(ownerId, poolId);
      if (
        current === undefined ||
        patch.items.length < patch.pickCount
      ) {
        this.db.exec("COMMIT;");
        return undefined;
      }
      const existing = this.listChoicePoolItems(poolId, true);
      const existingById = new Map(existing.map((item) => [item.id, item]));
      const existingByTitle = new Map(
        existing
          .filter(({ archivedAt }) => archivedAt === null)
          .map((item) => [item.title.toLocaleLowerCase(), item]),
      );
      this.db
        .prepare(
          "UPDATE choice_pool_items SET position=position+10000 WHERE pool_id=?",
        )
        .run(poolId);
      const retained = new Set<string>();
      const update = this.db.prepare(
        "UPDATE choice_pool_items SET title=?,position=?,revision=revision+1,updated_at=?,archived_at=NULL WHERE id=? AND pool_id=?",
      );
      const insert = this.db.prepare(
        "INSERT INTO choice_pool_items (id,pool_id,title,position,revision,created_at,updated_at,archived_at) VALUES (?,?,?,?,1,?,?,NULL)",
      );
      for (const [position, candidate] of patch.items.entries()) {
        const matched =
          (candidate.id === undefined
            ? undefined
            : existingById.get(candidate.id)) ??
          existingByTitle.get(candidate.title.toLocaleLowerCase());
        if (matched === undefined)
          insert.run(
            randomUUID(),
            poolId,
            candidate.title,
            position,
            now,
            now,
          );
        else {
          retained.add(matched.id);
          update.run(
            candidate.title,
            position,
            now,
            matched.id,
            poolId,
          );
        }
      }
      const archive = this.db.prepare(
        "UPDATE choice_pool_items SET archived_at=?,updated_at=?,revision=revision+1 WHERE id=? AND pool_id=? AND archived_at IS NULL",
      );
      for (const item of existing)
        if (!retained.has(item.id))
          archive.run(now, now, item.id, poolId);
      this.db
        .prepare(
          "UPDATE choice_pools SET title=?,policy=?,pick_count=?,cooldown_seconds=?,revision=revision+1,updated_at=? WHERE owner_id=? AND id=?",
        )
        .run(
          patch.title,
          patch.policy,
          patch.pickCount,
          patch.cooldownSeconds,
          now,
          ownerId,
          poolId,
        );
      this.#appendSyncChangeInTransaction(
        ownerId,
        "choice_pool",
        poolId,
        "upsert",
        current.revision + 1,
        now,
      );
      this.db.exec("COMMIT;");
      return this.getChoicePool(ownerId, poolId, true);
    } catch (error) {
      this.db.exec("ROLLBACK;");
      throw error;
    }
  }

  // -----------------------------------------------------------------------
  // createChoicePoolItem
  // -----------------------------------------------------------------------

  createChoicePoolItem(
    record: ChoicePoolItemRecord,
  ): void {
    this.db
      .prepare(
        "INSERT INTO choice_pool_items (id,pool_id,title,position,revision,created_at,updated_at,archived_at) VALUES (?,?,?,?,?,?,?,?)",
      )
      .run(
        record.id,
        record.poolId,
        record.title,
        record.position,
        record.revision,
        record.createdAt,
        record.updatedAt,
        record.archivedAt,
      );
  }

  // -----------------------------------------------------------------------
  // listChoicePoolItems
  // -----------------------------------------------------------------------

  listChoicePoolItems(
    poolId: string,
    includeArchived = true,
  ): readonly ChoicePoolItemRecord[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM choice_pool_items WHERE pool_id=? AND (?=1 OR archived_at IS NULL) ORDER BY position,id",
        )
        .all(poolId, includeArchived ? 1 : 0) as unknown as readonly Record<
        string,
        string | number | null
      >[]
    ).map((row) => this.#choicePoolItemFromRow(row));
  }

  // -----------------------------------------------------------------------
  // recordChoicePoolCompletion
  // -----------------------------------------------------------------------

  recordChoicePoolCompletion(
    ownerId: string,
    poolId: string,
    itemId: string,
    now: string,
  ): ChoicePoolHistoryRecord | undefined {
    const pool = this.getChoicePool(ownerId, poolId, true);
    const item = this.listChoicePoolItems(poolId, true).find(
      ({ id }) => id === itemId,
    );
    if (pool === undefined || item === undefined) return undefined;
    const selections = this.listChoicePoolHistory(poolId).filter(
      ({ itemId: hid, kind }) => hid === itemId && kind === "selected",
    );
    const event: ChoicePoolHistoryRecord = {
      id: randomUUID(),
      poolId,
      itemId,
      placeholderId: null,
      kind: "completed",
      cycle: selections.at(-1)?.cycle ?? 1,
      overridden: false,
      occurredAt: now,
    };
    this.db
      .prepare(
        "INSERT INTO choice_pool_history (id,pool_id,item_id,placeholder_id,kind,cycle,overridden,occurred_at) VALUES (?,?,?,?,?,?,0,?)",
      )
      .run(
        event.id,
        event.poolId,
        event.itemId,
        event.placeholderId,
        event.kind,
        event.cycle,
        event.occurredAt,
      );
    this.appendSyncChange(
      ownerId,
      "choice_pool",
      poolId,
      "upsert",
      pool.revision,
      now,
    );
    return event;
  }

  // -----------------------------------------------------------------------
  // getChoicePoolHistory
  // -----------------------------------------------------------------------

  getChoicePoolHistory(poolId: string): readonly ChoicePoolHistoryRecord[] {
    return this.listChoicePoolHistory(poolId);
  }

  listChoicePoolHistory(poolId: string): readonly ChoicePoolHistoryRecord[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM choice_pool_history WHERE pool_id=? ORDER BY occurred_at,id",
        )
        .all(poolId) as unknown as readonly Record<
        string,
        string | number | null
      >[]
    ).map((row) => this.#choicePoolHistoryFromRow(row));
  }

  // -----------------------------------------------------------------------
  // createPlanningPlaceholder
  // -----------------------------------------------------------------------

  createPlanningPlaceholder(
    record: PlanningPlaceholderRecord,
  ): PlanningPlaceholderRecord | undefined {
    if (
      this.getChoicePool(record.ownerId, record.poolId) === undefined ||
      this.#getTask(record.ownerId, record.taskId) === undefined ||
      this.listChoicePoolItems(record.poolId, false).length < record.pickCount
    )
      return undefined;
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      this.db
        .prepare(
          "INSERT INTO planning_placeholders (id,owner_id,task_id,pool_id,pick_count,position,state,revision,created_at,updated_at,resolved_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          record.id,
          record.ownerId,
          record.taskId,
          record.poolId,
          record.pickCount,
          record.position,
          record.state,
          record.revision,
          record.createdAt,
          record.updatedAt,
          record.resolvedAt,
        );
      this.#appendSyncChangeInTransaction(
        record.ownerId,
        "planning_placeholder",
        record.id,
        "upsert",
        record.revision,
        record.createdAt,
      );
      this.db.exec("COMMIT;");
      return record;
    } catch (error) {
      this.db.exec("ROLLBACK;");
      throw error;
    }
  }

  // -----------------------------------------------------------------------
  // getPlanningPlaceholder
  // -----------------------------------------------------------------------

  getPlanningPlaceholder(
    ownerId: string,
    id: string,
  ): PlanningPlaceholderRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM planning_placeholders WHERE owner_id=? AND id=?")
      .get(ownerId, id) as unknown as
      Record<string, string | number | null> | undefined;
    return row === undefined ? undefined : this.#placeholderFromRow(row);
  }

  // -----------------------------------------------------------------------
  // listPlanningPlaceholders
  // -----------------------------------------------------------------------

  listPlanningPlaceholders(
    ownerId: string,
  ): readonly PlanningPlaceholderRecord[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM planning_placeholders WHERE owner_id=? ORDER BY created_at,id",
        )
        .all(ownerId) as unknown as readonly Record<
        string,
        string | number | null
      >[]
    ).map((row) => this.#placeholderFromRow(row));
  }

  // -----------------------------------------------------------------------
  // resolvePlanningPlaceholderIdempotently
  // -----------------------------------------------------------------------

  resolvePlanningPlaceholderIdempotently(input: {
    readonly ownerId: string;
    readonly placeholderId: string;
    readonly expectedRevision: number;
    readonly selectedItemIds: readonly string[];
    readonly logicalTime: string;
    readonly cycle: number;
    readonly overridden: boolean;
    readonly idempotencyKey: string;
    readonly requestHash: string;
    readonly now: string;
  }): PlanningPlaceholderResolutionResult {
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const prior = this.db
        .prepare(
          "SELECT * FROM planning_placeholder_resolutions WHERE owner_id=? AND placeholder_id=? AND idempotency_key=?",
        )
        .get(
          input.ownerId,
          input.placeholderId,
          input.idempotencyKey,
        ) as unknown as Record<string, string | number> | undefined;
      if (prior !== undefined) {
        this.db.exec("COMMIT;");
        if (String(prior.request_hash) !== input.requestHash)
          return { kind: "conflict" };
        return this.#resolvedPlaceholderResult(
          input.ownerId,
          this.#resolutionFromRow(prior),
          "replayed",
        );
      }
      const placeholder = this.getPlanningPlaceholder(
        input.ownerId,
        input.placeholderId,
      );
      if (placeholder === undefined) {
        this.db.exec("COMMIT;");
        return { kind: "not-found" };
      }
      if (
        placeholder.state !== "unresolved" ||
        placeholder.revision !== input.expectedRevision
      ) {
        this.db.exec("COMMIT;");
        return { kind: "stale" };
      }
      if (
        input.selectedItemIds.length !== placeholder.pickCount ||
        new Set(input.selectedItemIds).size !== input.selectedItemIds.length
      ) {
        this.db.exec("COMMIT;");
        return { kind: "conflict" };
      }
      const itemRows = input.selectedItemIds.map((id) =>
        this.db
          .prepare(
            "SELECT * FROM choice_pool_items WHERE id=? AND pool_id=? AND archived_at IS NULL",
          )
          .get(id, placeholder.poolId),
      );
      if (itemRows.some((row) => row === undefined)) {
        this.db.exec("COMMIT;");
        return { kind: "conflict" };
      }
      const items = itemRows.map((row) =>
        this.#choicePoolItemFromRow(
          row as unknown as Record<string, string | number | null>,
        ),
      );
      const resolutionId = randomUUID();
      const existingSubtasks = this.#listSubtasks(
        input.ownerId,
        placeholder.taskId,
      );
      const subtaskIds: string[] = [];
      const historyIds: string[] = [];
      const insertSubtask = this.db.prepare(
        "INSERT INTO subtasks (id,owner_id,task_id,title,completed,position,revision,created_at,updated_at) VALUES (?,?,?,?,0,?,?,?,?)",
      );
      const insertHistory = this.db.prepare(
        "INSERT INTO choice_pool_history (id,pool_id,item_id,placeholder_id,kind,cycle,overridden,occurred_at) VALUES (?,?,?,?,?,?,?,?)",
      );
      for (const [index, item] of items.entries()) {
        const subtaskId = randomUUID();
        const historyId = randomUUID();
        subtaskIds.push(subtaskId);
        historyIds.push(historyId);
        insertSubtask.run(
          subtaskId,
          input.ownerId,
          placeholder.taskId,
          item.title,
          existingSubtasks.length + index,
          1,
          input.now,
          input.now,
        );
        insertHistory.run(
          historyId,
          placeholder.poolId,
          item.id,
          placeholder.id,
          "selected",
          input.cycle,
          input.overridden ? 1 : 0,
          input.logicalTime,
        );
        this.#appendSyncChangeInTransaction(
          input.ownerId,
          "subtask",
          subtaskId,
          "upsert",
          1,
          input.now,
        );
      }
      const pool = this.getChoicePool(input.ownerId, placeholder.poolId);
      if (pool?.policy === "one_shot") {
        const archive = this.db.prepare(
          "UPDATE choice_pool_items SET archived_at=?,updated_at=?,revision=revision+1 WHERE id=? AND archived_at IS NULL",
        );
        for (const item of items)
          archive.run(input.logicalTime, input.now, item.id);
      }
      this.db
        .prepare(
          "UPDATE planning_placeholders SET state='resolved',revision=revision+1,updated_at=?,resolved_at=? WHERE id=?",
        )
        .run(input.now, input.logicalTime, placeholder.id);
      this.db
        .prepare(
          "INSERT INTO planning_placeholder_resolutions (id,owner_id,placeholder_id,idempotency_key,request_hash,selected_item_ids_json,subtask_ids_json,history_ids_json,logical_time,overridden,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          resolutionId,
          input.ownerId,
          placeholder.id,
          input.idempotencyKey,
          input.requestHash,
          JSON.stringify(input.selectedItemIds),
          JSON.stringify(subtaskIds),
          JSON.stringify(historyIds),
          input.logicalTime,
          input.overridden ? 1 : 0,
          input.now,
        );
      this.#appendSyncChangeInTransaction(
        input.ownerId,
        "planning_placeholder",
        placeholder.id,
        "upsert",
        placeholder.revision + 1,
        input.now,
      );
      this.#appendSyncChangeInTransaction(
        input.ownerId,
        "choice_pool",
        placeholder.poolId,
        "upsert",
        pool?.revision ?? 1,
        input.now,
      );
      this.db.exec("COMMIT;");
      return this.#resolvedPlaceholderResult(
        input.ownerId,
        {
          id: resolutionId,
          placeholderId: placeholder.id,
          selectedItemIds: input.selectedItemIds,
          subtaskIds,
          historyIds,
          logicalTime: input.logicalTime,
          overridden: input.overridden,
          createdAt: input.now,
        },
        "created",
      );
    } catch (error) {
      this.db.exec("ROLLBACK;");
      throw error;
    }
  }

  // -----------------------------------------------------------------------
  // createTemplatePoolSlot
  // -----------------------------------------------------------------------

  createTemplatePoolSlot(
    record: TemplatePoolSlotRecord,
  ): TemplatePoolSlotRecord | undefined {
    const ownerId = this.#getTemplateOwnerId(record.templateId);
    if (
      ownerId === undefined ||
      this.#getTemplate(ownerId, record.templateId) === undefined ||
      this.getChoicePool(ownerId, record.poolId) === undefined ||
      this.listChoicePoolItems(record.poolId, false).length < record.pickCount
    )
      return undefined;
    try {
      this.db
        .prepare(
          "INSERT INTO template_pool_slots (id,template_id,pool_id,pick_count,position,created_at) VALUES (?,?,?,?,?,?)",
        )
        .run(
          record.id,
          record.templateId,
          record.poolId,
          record.pickCount,
          record.position,
          record.createdAt,
        );
      const template = this.#getTemplate(ownerId, record.templateId);
      if (template !== undefined)
        this.appendSyncChange(
          ownerId,
          "template",
          record.templateId,
          "upsert",
          template.revision,
          record.createdAt,
        );
      return record;
    } catch {
      return undefined;
    }
  }

  // -----------------------------------------------------------------------
  // listTemplatePoolSlots
  // -----------------------------------------------------------------------

  listTemplatePoolSlots(templateId: string): readonly TemplatePoolSlotRecord[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM template_pool_slots WHERE template_id=? ORDER BY position,id",
        )
        .all(templateId) as unknown as readonly Record<
        string,
        string | number
      >[]
    ).map((row) => ({
      id: String(row.id),
      templateId: String(row.template_id),
      poolId: String(row.pool_id),
      pickCount: Number(row.pick_count),
      position: Number(row.position),
      createdAt: String(row.created_at),
    }));
  }

  // -----------------------------------------------------------------------
  // Public sync helper
  // -----------------------------------------------------------------------

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

  #choicePoolFromRow(
    row: Record<string, string | number | null>,
  ): ChoicePoolRecord {
    return {
      id: String(row.id),
      ownerId: String(row.owner_id),
      title: String(row.title),
      policy: String(row.policy) as ChoicePoolRecord["policy"],
      pickCount: Number(row.pick_count),
      cooldownSeconds:
        row.cooldown_seconds === null ? null : Number(row.cooldown_seconds),
      revision: Number(row.revision),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      archivedAt: row.archived_at === null ? null : String(row.archived_at),
    };
  }

  #choicePoolItemFromRow(
    row: Record<string, string | number | null>,
  ): ChoicePoolItemRecord {
    return {
      id: String(row.id),
      poolId: String(row.pool_id),
      title: String(row.title),
      position: Number(row.position),
      revision: Number(row.revision),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      archivedAt: row.archived_at === null ? null : String(row.archived_at),
    };
  }

  #choicePoolHistoryFromRow(
    row: Record<string, string | number | null>,
  ): ChoicePoolHistoryRecord {
    return {
      id: String(row.id),
      poolId: String(row.pool_id),
      itemId: String(row.item_id),
      placeholderId:
        row.placeholder_id === null ? null : String(row.placeholder_id),
      kind: String(row.kind) as ChoicePoolHistoryRecord["kind"],
      cycle: Number(row.cycle),
      overridden: Number(row.overridden) === 1,
      occurredAt: String(row.occurred_at),
    };
  }

  #placeholderFromRow(
    row: Record<string, string | number | null>,
  ): PlanningPlaceholderRecord {
    return {
      id: String(row.id),
      ownerId: String(row.owner_id),
      taskId: String(row.task_id),
      poolId: String(row.pool_id),
      pickCount: Number(row.pick_count),
      position: Number(row.position),
      state: String(row.state) as PlanningPlaceholderRecord["state"],
      revision: Number(row.revision),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      resolvedAt: row.resolved_at === null ? null : String(row.resolved_at),
    };
  }

  #resolutionFromRow(
    row: Record<string, string | number>,
  ): PlanningPlaceholderResolutionRecord {
    return {
      id: String(row.id),
      placeholderId: String(row.placeholder_id),
      selectedItemIds: JSON.parse(
        String(row.selected_item_ids_json),
      ) as string[],
      subtaskIds: JSON.parse(String(row.subtask_ids_json)) as string[],
      historyIds: JSON.parse(String(row.history_ids_json)) as string[],
      logicalTime: String(row.logical_time),
      overridden: Number(row.overridden) === 1,
      createdAt: String(row.created_at),
    };
  }

  #resolvedPlaceholderResult(
    ownerId: string,
    resolution: PlanningPlaceholderResolutionRecord,
    kind: "created" | "replayed",
  ): PlanningPlaceholderResolutionResult {
    const placeholder = this.getPlanningPlaceholder(
      ownerId,
      resolution.placeholderId,
    );
    if (placeholder === undefined)
      throw new Error("Resolved placeholder could not be read");
    const subtasks = this.#listSubtasks(ownerId, placeholder.taskId).filter(
      ({ id }) => resolution.subtaskIds.includes(id),
    );
    const historyById = new Map(
      this.listChoicePoolHistory(placeholder.poolId).map((event) => [
        event.id,
        event,
      ]),
    );
    return {
      kind,
      placeholder,
      resolution,
      subtasks,
      history: resolution.historyIds.map((id) => {
        const event = historyById.get(id);
        if (event === undefined)
          throw new Error("Resolution history could not be read");
        return event;
      }),
    };
  }

  #getTask(
    ownerId: string,
    taskId: string,
  ): TaskRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT id, owner_id, title, notes, status, revision, created_at, updated_at,
                completed_at, deleted_at, planned_start, estimate_minutes
         FROM tasks WHERE owner_id = ? AND id = ? AND deleted_at IS NULL`,
      )
      .get(ownerId, taskId) as unknown as Record<string, string | number | null> | undefined;
    if (row === undefined) return undefined;
    const task: TaskRecord = {
      id: String(row.id),
      ownerId: String(row.owner_id),
      title: String(row.title),
      notes: String(row.notes),
      status: String(row.status) as "open" | "completed",
      revision: Number(row.revision),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      completedAt: row.completed_at === null ? null : String(row.completed_at),
      deletedAt: row.deleted_at === null ? null : String(row.deleted_at),
      plannedStart: row.planned_start === null ? null : String(row.planned_start),
      estimateMinutes: row.estimate_minutes === null ? null : Number(row.estimate_minutes),
    };
    const project = this.db
      .prepare("SELECT project_id FROM tasks WHERE owner_id = ? AND id = ?")
      .get(ownerId, taskId) as unknown as
      { project_id: string | null } | undefined;
    const tags = this.db
      .prepare("SELECT tag_id FROM task_tags WHERE task_id = ? ORDER BY tag_id")
      .all(taskId) as unknown as readonly { tag_id: string }[];
    return {
      ...task,
      projectId: project?.project_id ?? null,
      tagIds: tags.map((tag) => tag.tag_id),
    };
  }

  #listSubtasks(ownerId: string, taskId: string): readonly SubtaskRecord[] {
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

  #getTemplate(ownerId: string, id: string): TaskTemplateRecord | undefined {
    const row = this.db
      .prepare(
        "SELECT * FROM task_templates WHERE owner_id=? AND id=? AND archived_at IS NULL",
      )
      .get(ownerId, id) as unknown as
      Record<string, string | number | null> | undefined;
    if (row === undefined) return undefined;
    const tid = String(row.id);
    const tags = this.db
      .prepare(
        "SELECT tag_id FROM task_template_tags WHERE template_id=? ORDER BY tag_id",
      )
      .all(tid) as unknown as readonly { tag_id: string }[];
    return {
      id: tid,
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
  }

  #getTemplateOwnerId(templateId: string): string | undefined {
    const row = this.db
      .prepare("SELECT owner_id FROM task_templates WHERE id=?")
      .get(templateId) as unknown as { owner_id: string } | undefined;
    return row?.owner_id;
  }
}
