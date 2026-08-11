import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  ProjectRecord,
  SubtaskRecord,
  SyncChangeRecord,
  TagRecord,
  TaskRecord,
  TaskTemplateProvenanceRecord,
  TaskTemplateRecord,
  TemplateInstantiationResult,
  TemplatePoolSlotRecord,
  TemplateSetMemberRecord,
  TemplateSetRecord,
  TemplateSubtaskBlueprintRecord,
} from "./index.js";
import type { TemplateStore } from "./stores.js";

export class SqliteTemplateStore implements TemplateStore {
  constructor(private readonly db: DatabaseSync) {}

  // -----------------------------------------------------------------------
  // createTemplate
  // -----------------------------------------------------------------------

  createTemplate(
    input: Omit<TaskTemplateRecord, "tagIds"> & {
      readonly tagIds: readonly string[];
      readonly blueprints: readonly Omit<
        TemplateSubtaskBlueprintRecord,
        "templateId"
      >[];
    },
  ): TaskTemplateRecord {
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      if (
        input.suggestedProjectId !== null &&
        this.db
          .prepare(
            "SELECT 1 FROM projects WHERE id=? AND owner_id=? AND archived_at IS NULL",
          )
          .get(input.suggestedProjectId, input.ownerId) === undefined
      )
        throw new Error(
          "Template suggested project is not an active owner project",
        );
      if (
        new Set(input.tagIds).size !== input.tagIds.length ||
        (
          this.db
            .prepare(
              `SELECT count(*) AS count FROM tags WHERE owner_id=? AND archived_at IS NULL AND id IN (${input.tagIds.map(() => "?").join(",") || "NULL"})`,
            )
            .get(input.ownerId, ...input.tagIds) as unknown as { count: number }
        ).count !== input.tagIds.length
      )
        throw new Error("Template tags are not active owner tags");
      this.db
        .prepare(
          "INSERT INTO task_templates (id,owner_id,title,notes,estimate_minutes,suggested_project_id,revision,created_at,updated_at,archived_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          input.id,
          input.ownerId,
          input.title,
          input.notes,
          input.estimateMinutes,
          input.suggestedProjectId,
          input.revision,
          input.createdAt,
          input.updatedAt,
          input.archivedAt,
        );
      const tag = this.db.prepare(
        "INSERT INTO task_template_tags (template_id,tag_id) VALUES (?,?)",
      );
      for (const tagId of input.tagIds) tag.run(input.id, tagId);
      const blueprint = this.db.prepare(
        "INSERT INTO template_subtask_blueprints (id,template_id,title,position,revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
      );
      for (const item of input.blueprints)
        blueprint.run(
          item.id,
          input.id,
          item.title,
          item.position,
          item.revision,
          item.createdAt,
          item.updatedAt,
        );
      this.#appendSyncChangeInTransaction(
        input.ownerId,
        "template",
        input.id,
        "upsert",
        input.revision,
        input.createdAt,
      );
      this.db.exec("COMMIT;");
      const created = this.getTemplate(input.ownerId, input.id);
      if (created === undefined)
        throw new Error("Created task template could not be read");
      return created;
    } catch (error) {
      this.db.exec("ROLLBACK;");
      throw error;
    }
  }

  // -----------------------------------------------------------------------
  // getTemplate
  // -----------------------------------------------------------------------

  getTemplate(
    ownerId: string,
    id: string,
    includeArchived = false,
  ): TaskTemplateRecord | undefined {
    const row = this.db
      .prepare(
        "SELECT * FROM task_templates WHERE owner_id=? AND id=? AND (?=1 OR archived_at IS NULL)",
      )
      .get(ownerId, id, includeArchived ? 1 : 0) as unknown as
      Record<string, string | number | null> | undefined;
    return row === undefined ? undefined : this.#templateFromRow(row);
  }

  // -----------------------------------------------------------------------
  // listTemplates
  // -----------------------------------------------------------------------

  listTemplates(
    ownerId: string,
    includeArchived = false,
  ): readonly TaskTemplateRecord[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM task_templates WHERE owner_id=? AND (?=1 OR archived_at IS NULL) ORDER BY title COLLATE NOCASE,id",
        )
        .all(ownerId, includeArchived ? 1 : 0) as unknown as readonly Record<string, string | number | null>[]
    ).map((row) => this.#templateFromRow(row));
  }

  // -----------------------------------------------------------------------
  // archiveTemplate
  // -----------------------------------------------------------------------

  archiveTemplate(
    ownerId: string,
    id: string,
    expectedRevision: number,
    now: string,
  ): TaskTemplateRecord | undefined {
    const changed = this.db
      .prepare(
        "UPDATE task_templates SET archived_at=?,revision=revision+1,updated_at=? WHERE owner_id=? AND id=? AND revision=? AND archived_at IS NULL",
      )
      .run(now, now, ownerId, id, expectedRevision).changes;
    if (changed !== 1) return undefined;
    const template = this.getTemplate(ownerId, id, true);
    if (template === undefined)
      throw new Error("Archived task template could not be read");
    this.appendSyncChange(
      ownerId,
      "template",
      id,
      "upsert",
      template.revision,
      now,
    );
    return template;
  }

  // -----------------------------------------------------------------------
  // createTemplateFromTask
  // -----------------------------------------------------------------------

  createTemplateFromTask(
    ownerId: string,
    taskId: string,
    template: Omit<TaskTemplateRecord, "tagIds"> & {
      readonly blueprints: readonly Omit<
        TemplateSubtaskBlueprintRecord,
        "templateId"
      >[];
    },
  ): TaskTemplateRecord | undefined {
    const task = this.#getTask(ownerId, taskId);
    if (task === undefined) return undefined;
    const suggestedProject =
      task.projectId === undefined || task.projectId === null
        ? undefined
        : this.#project(ownerId, task.projectId);
    const activeTagIds = (task.tagIds ?? []).filter(
      (tagId) => this.#tag(ownerId, tagId)?.archivedAt === null,
    );
    return this.createTemplate({
      ...template,
      title: task.title,
      notes: task.notes,
      estimateMinutes: task.estimateMinutes,
      suggestedProjectId:
        suggestedProject?.archivedAt === null ? suggestedProject.id : null,
      tagIds: activeTagIds,
    });
  }

  // -----------------------------------------------------------------------
  // patchTemplate
  // -----------------------------------------------------------------------

  patchTemplate(input: {
    readonly ownerId: string;
    readonly id: string;
    readonly expectedRevision: number;
    readonly title: string;
    readonly notes: string;
    readonly estimateMinutes: number | null;
    readonly suggestedProjectId: string | null;
    readonly tagIds: readonly string[];
    readonly blueprints: readonly Omit<
      TemplateSubtaskBlueprintRecord,
      "templateId"
    >[];
    readonly now: string;
  }): TaskTemplateRecord | undefined {
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const current = this.getTemplate(input.ownerId, input.id);
      if (current?.revision !== input.expectedRevision) {
        this.db.exec("COMMIT;");
        return undefined;
      }
      if (
        input.suggestedProjectId !== null &&
        this.db
          .prepare(
            "SELECT 1 FROM projects WHERE id=? AND owner_id=? AND archived_at IS NULL",
          )
          .get(input.suggestedProjectId, input.ownerId) === undefined
      ) {
        this.db.exec("ROLLBACK;");
        return undefined;
      }
      if (
        new Set(input.tagIds).size !== input.tagIds.length ||
        (
          this.db
            .prepare(
              `SELECT count(*) AS count FROM tags WHERE owner_id=? AND archived_at IS NULL AND id IN (${input.tagIds.map(() => "?").join(",") || "NULL"})`,
            )
            .get(input.ownerId, ...input.tagIds) as unknown as { count: number }
        ).count !== input.tagIds.length
      ) {
        this.db.exec("ROLLBACK;");
        return undefined;
      }
      const revision = current.revision + 1;
      this.db
        .prepare(
          "UPDATE task_templates SET title=?,notes=?,estimate_minutes=?,suggested_project_id=?,revision=?,updated_at=? WHERE id=?",
        )
        .run(
          input.title,
          input.notes,
          input.estimateMinutes,
          input.suggestedProjectId,
          revision,
          input.now,
          input.id,
        );
      this.db
        .prepare("DELETE FROM task_template_tags WHERE template_id=?")
        .run(input.id);
      const tag = this.db.prepare(
        "INSERT INTO task_template_tags (template_id,tag_id) VALUES (?,?)",
      );
      for (const tagId of input.tagIds) tag.run(input.id, tagId);
      this.db
        .prepare("DELETE FROM template_subtask_blueprints WHERE template_id=?")
        .run(input.id);
      const blueprint = this.db.prepare(
        "INSERT INTO template_subtask_blueprints (id,template_id,title,position,revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
      );
      for (const item of input.blueprints)
        blueprint.run(
          item.id,
          input.id,
          item.title,
          item.position,
          item.revision,
          item.createdAt,
          item.updatedAt,
        );
      this.#appendSyncChangeInTransaction(
        input.ownerId,
        "template",
        input.id,
        "upsert",
        revision,
        input.now,
      );
      this.db.exec("COMMIT;");
      const updated = this.getTemplate(input.ownerId, input.id);
      if (updated === undefined)
        throw new Error("Updated task template could not be read");
      return updated;
    } catch (error) {
      this.db.exec("ROLLBACK;");
      throw error;
    }
  }

  // -----------------------------------------------------------------------
  // getTemplateSet
  // -----------------------------------------------------------------------

  getTemplateSet(
    ownerId: string,
    setId: string,
  ): TemplateSetRecord | undefined {
    const row = this.db
      .prepare(
        "SELECT * FROM template_sets WHERE owner_id=? AND id=?",
      )
      .get(ownerId, setId) as unknown as
      Record<string, string | number | null> | undefined;
    return row === undefined
      ? undefined
      : {
          id: String(row.id),
          ownerId: String(row.owner_id),
          title: String(row.title),
          revision: Number(row.revision),
          createdAt: String(row.created_at),
          updatedAt: String(row.updated_at),
          archivedAt:
            row.archived_at === null ? null : String(row.archived_at),
        };
  }

  // -----------------------------------------------------------------------
  // createTemplateSet
  // -----------------------------------------------------------------------

  createTemplateSet(
    ownerId: string,
    record: TemplateSetRecord,
    members: readonly TemplateSetMemberRecord[],
  ): void {
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      if (
        members.length === 0 ||
        new Set(members.map((member) => member.templateId)).size !==
          members.length ||
        new Set(members.map((member) => member.position)).size !==
          members.length
      )
        throw new Error(
          "Template set members must be nonempty and uniquely ordered",
        );
      for (const member of members)
        if (this.getTemplate(ownerId, member.templateId) === undefined)
          throw new Error(
            "Template set member is not an active owner template",
          );
      this.db
        .prepare(
          "INSERT INTO template_sets (id,owner_id,title,revision,created_at,updated_at,archived_at) VALUES (?,?,?,?,?,?,?)",
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
      const insert = this.db.prepare(
        "INSERT INTO template_set_members (set_id,template_id,position) VALUES (?,?,?)",
      );
      for (const member of members)
        insert.run(record.id, member.templateId, member.position);
      this.#appendSyncChangeInTransaction(
        record.ownerId,
        "template_set",
        record.id,
        "upsert",
        record.revision,
        record.createdAt,
      );
      this.db.exec("COMMIT;");
    } catch (error) {
      this.db.exec("ROLLBACK;");
      throw error;
    }
  }

  // -----------------------------------------------------------------------
  // listTemplateSets
  // -----------------------------------------------------------------------

  listTemplateSets(
    ownerId: string,
    includeArchived = false,
  ): readonly TemplateSetRecord[] {
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

  // -----------------------------------------------------------------------
  // archiveTemplateSet
  // -----------------------------------------------------------------------

  archiveTemplateSet(
    ownerId: string,
    id: string,
    expectedRevision: number,
    now: string,
  ): TemplateSetRecord | undefined {
    const changed = this.db
      .prepare(
        "UPDATE template_sets SET archived_at=?,revision=revision+1,updated_at=? WHERE owner_id=? AND id=? AND revision=? AND archived_at IS NULL",
      )
      .run(now, now, ownerId, id, expectedRevision).changes;
    if (changed !== 1) return undefined;
    const set = this.listTemplateSets(ownerId, true).find(
      (value) => value.id === id,
    );
    if (set === undefined)
      throw new Error("Archived template set could not be read");
    this.appendSyncChange(
      ownerId,
      "template_set",
      id,
      "upsert",
      set.revision,
      now,
    );
    return set;
  }

  // -----------------------------------------------------------------------
  // instantiateTemplateIdempotently
  // -----------------------------------------------------------------------

  instantiateTemplateIdempotently(
    ownerId: string,
    sourceKind: "template" | "set",
    sourceId: string,
    destinationProjectId: string,
    idempotencyKey: string,
    requestHash: string,
    now: string,
  ): TemplateInstantiationResult {
    return this.#instantiateTemplates({
      ownerId,
      sourceKind,
      sourceId,
      destinationProjectId,
      idempotencyKey,
      requestHash,
      now,
    });
  }

  // -----------------------------------------------------------------------
  // listTemplateSubtaskBlueprints
  // -----------------------------------------------------------------------

  listTemplateSubtaskBlueprints(
    templateId: string,
  ): readonly TemplateSubtaskBlueprintRecord[] {
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

  // -----------------------------------------------------------------------
  // getTaskTemplateProvenance
  // -----------------------------------------------------------------------

  getTaskTemplateProvenance(
    ownerId: string,
    taskId: string,
  ): TaskTemplateProvenanceRecord | undefined {
    const row = this.db
      .prepare(
        "SELECT p.* FROM task_template_provenance p JOIN tasks t ON t.id=p.task_id WHERE p.task_id=? AND t.owner_id=?",
      )
      .get(taskId, ownerId) as unknown as
      Record<string, string | number> | undefined;
    return row === undefined
      ? undefined
      : {
          taskId: String(row.task_id),
          templateId: String(row.template_id),
          templateRevision: Number(row.template_revision),
          instantiationId: String(row.instantiation_id),
          instantiatedAt: String(row.instantiated_at),
        };
  }

  // -----------------------------------------------------------------------
  // listTaskTemplateProvenance
  // -----------------------------------------------------------------------

  listTaskTemplateProvenance(
    ownerId: string,
  ): readonly TaskTemplateProvenanceRecord[] {
    const rows = this.db
      .prepare(
        "SELECT p.* FROM task_template_provenance p JOIN tasks t ON t.id=p.task_id WHERE t.owner_id=? ORDER BY p.instantiated_at,p.task_id",
      )
      .all(ownerId) as unknown as readonly Record<string, string | number>[];
    return rows.map((row) => ({
      taskId: String(row.task_id),
      templateId: String(row.template_id),
      templateRevision: Number(row.template_revision),
      instantiationId: String(row.instantiation_id),
      instantiatedAt: String(row.instantiated_at),
    }));
  }

  // -----------------------------------------------------------------------
  // Public helper: listTemplateSetMembers (used by instantiation)
  // -----------------------------------------------------------------------

  listTemplateSetMembers(setId: string): readonly TemplateSetMemberRecord[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM template_set_members WHERE set_id=? ORDER BY position,template_id",
        )
        .all(setId) as unknown as readonly Record<string, string | number>[]
    ).map((row) => ({
      setId: String(row.set_id),
      templateId: String(row.template_id),
      position: Number(row.position),
    }));
  }

  // -----------------------------------------------------------------------
  // Public sync helpers
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

  #templateFromRow(
    row: Record<string, string | number | null>,
  ): TaskTemplateRecord {
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
  }

  #instantiateTemplates(input: {
    readonly ownerId: string;
    readonly sourceKind: "template" | "set";
    readonly sourceId: string;
    readonly destinationProjectId: string;
    readonly idempotencyKey: string;
    readonly requestHash: string;
    readonly now: string;
  }): TemplateInstantiationResult {
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const prior = this.db
        .prepare(
          "SELECT * FROM template_instantiations WHERE owner_id=? AND source_kind=? AND source_id=? AND idempotency_key=?",
        )
        .get(
          input.ownerId,
          input.sourceKind,
          input.sourceId,
          input.idempotencyKey,
        ) as unknown as Record<string, string | number> | undefined;
      if (prior !== undefined) {
        this.db.exec("COMMIT;");
        if (String(prior.request_hash) !== input.requestHash)
          return { kind: "conflict" };
        const instantiationId = String(prior.id);
        const taskIds = JSON.parse(
          String(prior.result_task_ids_json),
        ) as string[];
        return {
          kind: "replayed",
          instantiationId,
          tasks: this.#instantiationTrees(
            input.ownerId,
            instantiationId,
            taskIds,
          ),
        };
      }
      if (
        this.db
          .prepare(
            "SELECT 1 FROM projects WHERE owner_id=? AND id=? AND archived_at IS NULL",
          )
          .get(input.ownerId, input.destinationProjectId) === undefined
      ) {
        this.db.exec("COMMIT;");
        return { kind: "project-not-found" };
      }
      const source =
        input.sourceKind === "template"
          ? this.getTemplate(input.ownerId, input.sourceId)
          : undefined;
      const set =
        input.sourceKind === "set"
          ? this.listTemplateSets(input.ownerId).find(
              (candidate) => candidate.id === input.sourceId,
            )
          : undefined;
      if (source === undefined && set === undefined) {
        this.db.exec("COMMIT;");
        return { kind: "not-found" };
      }
      const members =
        source === undefined ? this.listTemplateSetMembers(input.sourceId) : [];
      const templates =
        source === undefined
          ? members.map((member) =>
              this.getTemplate(input.ownerId, member.templateId),
            )
          : [source];
      if (
        templates.length === 0 ||
        templates.some((template) => template === undefined)
      ) {
        this.db.exec("COMMIT;");
        return { kind: "not-found" };
      }
      const resolvedTemplates = templates as TaskTemplateRecord[];
      const sourceRevision = source?.revision ?? set?.revision;
      if (sourceRevision === undefined)
        throw new Error("Template instantiation source revision is missing");
      const instantiationId = randomUUID();
      const snapshot = resolvedTemplates.map((template) => ({
        ...template,
        blueprints: this.listTemplateSubtaskBlueprints(template.id),
        poolSlots: this.#listTemplatePoolSlotsInternal(template.id),
      }));
      this.db
        .prepare(
          "INSERT INTO template_instantiations (id,owner_id,source_kind,source_id,source_revision,destination_project_id,idempotency_key,request_hash,snapshot_json,result_task_ids_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          instantiationId,
          input.ownerId,
          input.sourceKind,
          input.sourceId,
          sourceRevision,
          input.destinationProjectId,
          input.idempotencyKey,
          input.requestHash,
          JSON.stringify(snapshot),
          "[]",
          input.now,
        );
      const taskIds: string[] = [];
      const insertTask = this.db.prepare(
        "INSERT INTO tasks (id,owner_id,title,notes,status,revision,created_at,updated_at,estimate_minutes,project_id) VALUES (?,?,?,?,?,?,?,?,?,?)",
      );
      const insertField = this.db.prepare(
        "INSERT INTO task_field_versions (task_id,field,version) VALUES (?,?,1)",
      );
      const insertTag = this.db.prepare(
        "INSERT INTO task_tags (task_id,tag_id) VALUES (?,?)",
      );
      const insertSubtask = this.db.prepare(
        "INSERT INTO subtasks (id,owner_id,task_id,title,completed,position,revision,created_at,updated_at) VALUES (?,?,?,?,0,?,?,?,?)",
      );
      const insertProvenance = this.db.prepare(
        "INSERT INTO task_template_provenance (task_id,template_id,template_revision,instantiation_id,instantiated_at) VALUES (?,?,?,?,?)",
      );
      const insertPlaceholder = this.db.prepare(
        "INSERT INTO planning_placeholders (id,owner_id,task_id,pool_id,pick_count,position,state,revision,created_at,updated_at,resolved_at) VALUES (?,?,?,?,?,?,'unresolved',1,?,?,NULL)",
      );
      for (const template of resolvedTemplates) {
        const taskId = randomUUID();
        taskIds.push(taskId);
        insertTask.run(
          taskId,
          input.ownerId,
          template.title,
          template.notes,
          "open",
          1,
          input.now,
          input.now,
          template.estimateMinutes,
          input.destinationProjectId,
        );
        for (const field of [
          "title",
          "notes",
          "status",
          "estimateMinutes",
          "projectId",
          "tagIds",
        ])
          insertField.run(taskId, field);
        for (const tagId of template.tagIds) insertTag.run(taskId, tagId);
        for (const blueprint of this.listTemplateSubtaskBlueprints(
          template.id,
        )) {
          const subtaskId = randomUUID();
          insertSubtask.run(
            subtaskId,
            input.ownerId,
            taskId,
            blueprint.title,
            blueprint.position,
            1,
            input.now,
            input.now,
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
        for (const slot of this.#listTemplatePoolSlotsInternal(template.id)) {
          const placeholderId = randomUUID();
          insertPlaceholder.run(
            placeholderId,
            input.ownerId,
            taskId,
            slot.poolId,
            slot.pickCount,
            slot.position,
            input.now,
            input.now,
          );
          this.#appendSyncChangeInTransaction(
            input.ownerId,
            "planning_placeholder",
            placeholderId,
            "upsert",
            1,
            input.now,
          );
        }
        insertProvenance.run(
          taskId,
          template.id,
          template.revision,
          instantiationId,
          input.now,
        );
        this.#appendSyncChangeInTransaction(
          input.ownerId,
          "task",
          taskId,
          "upsert",
          1,
          input.now,
        );
      }
      this.db
        .prepare(
          "UPDATE template_instantiations SET result_task_ids_json=? WHERE id=?",
        )
        .run(JSON.stringify(taskIds), instantiationId);
      this.db.exec("COMMIT;");
      return {
        kind: "created",
        instantiationId,
        tasks: this.#instantiationTrees(
          input.ownerId,
          instantiationId,
          taskIds,
        ),
      };
    } catch (error) {
      this.db.exec("ROLLBACK;");
      throw error;
    }
  }

  #instantiationTrees(
    ownerId: string,
    instantiationId: string,
    taskIds: readonly string[],
  ): readonly {
    readonly task: TaskRecord;
    readonly subtasks: readonly SubtaskRecord[];
    readonly provenance: TaskTemplateProvenanceRecord;
  }[] {
    return taskIds.map((taskId) => {
      const task = this.#getTask(ownerId, taskId);
      if (task === undefined)
        throw new Error("Instantiated task could not be read");
      const row = this.db
        .prepare("SELECT * FROM task_template_provenance WHERE task_id=?")
        .get(taskId) as unknown as Record<string, string | number> | undefined;
      if (row === undefined)
        throw new Error("Instantiated task provenance could not be read");
      return {
        task,
        subtasks: this.#listSubtasks(ownerId, taskId),
        provenance: {
          taskId,
          templateId: String(row.template_id),
          templateRevision: Number(row.template_revision),
          instantiationId,
          instantiatedAt: String(row.instantiated_at),
        },
      };
    });
  }

  #listTemplatePoolSlotsInternal(templateId: string): readonly TemplatePoolSlotRecord[] {
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

  #project(ownerId: string, id: string): ProjectRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM projects WHERE owner_id = ? AND id = ?")
      .get(ownerId, id) as unknown as
      Record<string, string | number | null> | undefined;
    return row === undefined
      ? undefined
      : {
          id: String(row.id),
          ownerId: String(row.owner_id),
          title: String(row.title),
          revision: Number(row.revision),
          createdAt: String(row.created_at),
          updatedAt: String(row.updated_at),
          archivedAt:
            row.archived_at === null ? null : String(row.archived_at),
        };
  }

  #tag(ownerId: string, id: string): TagRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM tags WHERE owner_id=? AND id=?")
      .get(ownerId, id) as unknown as
      Record<string, string | number | null> | undefined;
    return row === undefined
      ? undefined
      : {
          id: String(row.id),
          ownerId: String(row.owner_id),
          title: String(row.display_name),
          normalizedName: String(row.normalized_name),
          revision: Number(row.revision),
          createdAt: String(row.created_at),
          updatedAt: String(row.updated_at),
          archivedAt:
            row.archived_at === null ? null : String(row.archived_at),
        };
  }
}
