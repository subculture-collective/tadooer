import {
  syncDiagnosticManifestSchema,
  isHabitSyncOperation,
  habitListResponseSchema,
  type HabitCommand,
  type HabitListResponse,
  syncEntitySnapshotSchema,
  syncFieldVersionKey,
  syncOperationEntity,
  syncOperationSchema,
  projectSchema,
  subtaskSchema,
  tagSchema,
  type ClientRegistrationResponse,
  type CoreTaskField,
  type Project,
  type Subtask,
  type SyncChange,
  type SyncDiagnosticManifest,
  type SyncEntityKind,
  type SyncOperation,
  type SyncRoundResponse,
  type SyncSnapshotResponse,
  type SyncTaskSnapshot,
  type Tag,
  type Task,
  type TaskFieldVersions,
  type PlanningPreferences,
  planningPreferencesSchema,
} from "@suite/contracts";
import { compareChildren, planChildPosition } from "@suite/domain";

const databaseName = "suite-local-v1";
const databaseVersion = 2;
const metadataKey = "local-state";
const planningPreferencesKey = "planning-preferences";
const entityStore = "entities";
const metadataStore = "metadata";
const outboxStore = "outbox";
const conflictStore = "conflicts";
const diagnosticStore = "diagnostics";

export type CachedEntityKind =
  | "habit"
  | "habit_occurrence"
  | "task"
  | "project"
  | "tag"
  | "subtask"
  | "template"
  | "template_set"
  | "choice_pool"
  | "planning_placeholder"
  | "active_session";

export interface CachedEntity {
  readonly entityKind: CachedEntityKind;
  readonly id: string;
  readonly value: unknown;
  readonly revision: number;
  readonly changeSequence: number;
}

export interface LocalClientIdentity {
  readonly installationId: string;
  readonly clientId: string;
  readonly clientCredential: string;
  readonly cursor: string | null;
}

export interface LocalConflict {
  readonly operationId: string;
  /** The conflicting entity's ID; a task unless `entityKind` says otherwise. */
  readonly taskId: string;
  readonly taskRevision: number;
  readonly conflictingFields: readonly CoreTaskField[] | null;
  readonly code: "SYNC_FIELD_CONFLICT" | "SYNC_RESOURCE_CONFLICT";
  /** ADR 0033: absent in conflicts recorded before structural writes. */
  readonly entityKind?: SyncEntityKind;
}

/** Task fields the outbox can patch (ADR 0010, 0017, 0033). */
export interface LocalTaskPatch {
  readonly title?: string;
  readonly notes?: string;
  readonly estimateMinutes?: number | null;
  readonly deadline?: Task["deadline"];
  readonly plannedStart?: string | null;
  readonly plannedDay?: string | null;
  readonly projectId?: string | null;
  readonly tagIds?: string[];
}

/** Project and tag fields the outbox can patch (ADR 0033). */
export interface LocalOrganizationPatch {
  readonly title?: string;
  readonly archived?: boolean;
  readonly completed?: boolean;
  readonly color?: string | null;
  readonly icon?: string | null;
}

export type LocalOutboxState =
  | "queued"
  | "sending"
  | "acknowledged"
  | "resolved"
  | "conflicted"
  | "rejected";

export interface LocalOutboxEntry {
  readonly operation: SyncOperation;
  readonly state: LocalOutboxState;
  readonly safeErrorCode: string | null;
  /** Local audit metadata retained with the immutable original operation. */
  readonly resolvedAt?: string;
  readonly resolutionChoice?: "keep-current" | "retry-local";
  readonly replacementOperationId?: string;
}

type TaskPatchOperation = Extract<
  SyncOperation,
  { readonly kind: "task.patch" }
>;

export interface TaskConflictReview {
  readonly conflict: LocalConflict;
  /** The server-authoritative task snapshot currently cached for review. */
  readonly canonical: SyncTaskSnapshot | null;
  /** The immutable fields requested by the original conflicted operation. */
  readonly attemptedFields: TaskPatchOperation["fields"] | null;
  /** Resource and non-patch conflicts stay visible but cannot be retried locally. */
  readonly retryLocalSupported: boolean;
  /** Why retry is unavailable, so the UI can distinguish an unsupported resource. */
  readonly retryLocalUnavailableReason:
    "pending-local-sync" | "unsupported" | null;
}

export interface ResolveTaskConflictInput {
  readonly operationId: string;
  readonly choice: "keep-current" | "retry-local";
  /** Revision displayed to the person resolving this conflict. */
  readonly reviewedTaskRevision: number;
  /** Field versions displayed to the person resolving this conflict. */
  readonly reviewedFieldVersions: Readonly<Partial<TaskFieldVersions>>;
}

interface LocalMetadata extends LocalClientIdentity {
  readonly nextClientSequence: number;
  readonly syncProtocolVersion: 2;
  readonly resetRequired: boolean;
}

type RegisterClient = () => Promise<ClientRegistrationResponse>;

const requestResult = <T>(request: IDBRequest<T>): Promise<T> =>
  new Promise((resolveRequest, rejectRequest) => {
    request.onsuccess = () => resolveRequest(request.result);
    request.onerror = () =>
      rejectRequest(request.error ?? new Error("IndexedDB request failed"));
  });

const transactionDone = (transaction: IDBTransaction): Promise<void> =>
  new Promise((resolveTransaction, rejectTransaction) => {
    transaction.oncomplete = () => resolveTransaction();
    transaction.onerror = () =>
      rejectTransaction(
        transaction.error ?? new Error("IndexedDB transaction failed"),
      );
    transaction.onabort = () =>
      rejectTransaction(
        transaction.error ?? new Error("IndexedDB transaction aborted"),
      );
  });

const stableJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

const hash = async (value: unknown): Promise<string> => {
  const bytes = new TextEncoder().encode(stableJson(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
};

const entityKey = (
  entityKind: CachedEntityKind,
  id: string,
): [string, string] => [entityKind, id];

const taskFields: readonly CoreTaskField[] = [
  "title",
  "notes",
  "status",
  "estimateMinutes",
  "projectId",
  "tagIds",
  "deadline",
];

const initialFieldVersions = (): TaskFieldVersions => ({
  title: 1,
  notes: 1,
  status: 1,
  estimateMinutes: 1,
  projectId: 1,
  tagIds: 1,
  deadline: 1,
  parent: 1,
  plannedStart: 1,
});

/** The exclusive planned start / planned day slot (ADR 0020, 0033). */
const planningSlot = (
  task: Task,
  fields: {
    readonly plannedStart?: string | null | undefined;
    readonly plannedDay?: string | null | undefined;
  },
): Pick<Task, "plannedStart" | "plannedDay"> => {
  if (fields.plannedStart !== undefined)
    return {
      plannedStart: fields.plannedStart,
      plannedDay:
        fields.plannedStart === null
          ? (fields.plannedDay ?? task.plannedDay ?? null)
          : null,
    };
  if (fields.plannedDay !== undefined)
    return {
      plannedDay: fields.plannedDay,
      plannedStart:
        fields.plannedDay === null ? (task.plannedStart ?? null) : null,
    };
  return {
    plannedStart: task.plannedStart ?? null,
    plannedDay: task.plannedDay ?? null,
  };
};

const conflictEntityKind = (conflict: LocalConflict): SyncEntityKind =>
  conflict.entityKind ?? "task";

const isTaskSnapshot = (value: unknown): value is SyncTaskSnapshot =>
  value !== null &&
  typeof value === "object" &&
  "task" in value &&
  "fieldVersions" in value;

const taskIdForOperation = (operation: SyncOperation): string | null => {
  if (operation.kind === "task.create") return operation.task.id;
  if (operation.kind.startsWith("task.") && "taskId" in operation)
    return operation.taskId;
  return null;
};

const hasNewerActiveTaskMutation = (
  entries: readonly LocalOutboxEntry[],
  taskId: string,
  clientSequence: number,
): boolean =>
  entries.some(
    (entry) =>
      entry.operation.clientSequence > clientSequence &&
      (entry.state === "queued" || entry.state === "sending") &&
      taskIdForOperation(entry.operation) === taskId,
  );

const compareOrganization = (
  left: { readonly archivedAt: string | null; readonly position: number },
  right: { readonly archivedAt: string | null; readonly position: number },
): number =>
  Number(left.archivedAt !== null) - Number(right.archivedAt !== null) ||
  left.position - right.position;

const safeOutcomeCode = (value: unknown): string => {
  if (
    value !== null &&
    typeof value === "object" &&
    "code" in value &&
    typeof value.code === "string"
  ) {
    return value.code;
  }
  return "INVALID_SYNC_OPERATION";
};

export class LocalStore {
  readonly #indexedDb: IDBFactory;
  readonly #now: () => string;
  readonly #uuid: () => string;
  #database: IDBDatabase | undefined;
  #ensuringClient: Promise<LocalClientIdentity> | undefined;

  constructor(
    options: {
      readonly indexedDb?: IDBFactory;
      readonly now?: () => string;
      readonly uuid?: () => string;
    } = {},
  ) {
    this.#indexedDb = options.indexedDb ?? globalThis.indexedDB;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#uuid = options.uuid ?? (() => crypto.randomUUID());
  }

  async ensureClient(register: RegisterClient): Promise<LocalClientIdentity> {
    if (this.#ensuringClient !== undefined) return this.#ensuringClient;
    const pending = this.#ensureClient(register);
    this.#ensuringClient = pending;
    try {
      return await pending;
    } finally {
      if (this.#ensuringClient === pending) this.#ensuringClient = undefined;
    }
  }

  async #ensureClient(register: RegisterClient): Promise<LocalClientIdentity> {
    const existing = await this.#metadata();
    if (existing !== undefined && existing.clientId !== "") return existing;

    const registered = await register();
    const metadata: LocalMetadata = {
      installationId: existing?.installationId ?? this.#uuid(),
      clientId: registered.client.id,
      clientCredential: registered.clientCredential,
      cursor: registered.initialCursor,
      nextClientSequence: existing?.nextClientSequence ?? 1,
      syncProtocolVersion: 2,
      resetRequired: true,
    };
    const database = await this.#open();
    const transaction = database.transaction(metadataStore, "readwrite");
    transaction.objectStore(metadataStore).put(metadata, metadataKey);
    await transactionDone(transaction);
    return metadata;
  }

  async clientIdentity(): Promise<LocalClientIdentity | undefined> {
    return this.#metadata();
  }

  async requiresSnapshot(): Promise<boolean> {
    const metadata = await this.#metadata();
    return metadata?.syncProtocolVersion !== 2 || metadata.resetRequired;
  }

  async markResetRequired(): Promise<void> {
    const database = await this.#open();
    const transaction = database.transaction(metadataStore, "readwrite");
    const metadata = transaction.objectStore(metadataStore);
    const current = (await requestResult(metadata.get(metadataKey))) as
      LocalMetadata | undefined;
    if (current !== undefined)
      metadata.put({ ...current, resetRequired: true }, metadataKey);
    await transactionDone(transaction);
  }

  async savePlanningPreferences(
    preferences: PlanningPreferences,
  ): Promise<void> {
    const database = await this.#open();
    const transaction = database.transaction(metadataStore, "readwrite");
    transaction
      .objectStore(metadataStore)
      .put(
        planningPreferencesSchema.parse(preferences),
        planningPreferencesKey,
      );
    await transactionDone(transaction);
  }

  async loadPlanningPreferences(): Promise<PlanningPreferences | undefined> {
    const database = await this.#open();
    const transaction = database.transaction(metadataStore, "readonly");
    const value: unknown = await requestResult<unknown>(
      transaction.objectStore(metadataStore).get(planningPreferencesKey),
    );
    await transactionDone(transaction);
    return value === undefined
      ? undefined
      : planningPreferencesSchema.parse(value);
  }

  async loadCachedEntities(): Promise<readonly CachedEntity[]> {
    const database = await this.#open();
    const transaction = database.transaction(entityStore, "readonly");
    const records = (await requestResult(
      transaction.objectStore(entityStore).getAll(),
    )) as CachedEntity[];
    await transactionDone(transaction);
    return records;
  }

  async loadCachedHabits(): Promise<HabitListResponse> {
    const records = await this.loadCachedEntities();
    return habitListResponseSchema.parse({
      habits: records
        .filter(({ entityKind }) => entityKind === "habit")
        .map(({ value }) => value),
      occurrences: records
        .filter(({ entityKind }) => entityKind === "habit_occurrence")
        .map(({ value }) => value),
    });
  }

  async queueHabitCommand(command: HabitCommand): Promise<SyncOperation> {
    const { kind, ...payload } = command;
    const operation = await this.#operation(
      await this.#requiredMetadata(),
      kind,
      payload,
    );
    const database = await this.#open();
    const transaction = database.transaction(
      [metadataStore, outboxStore],
      "readwrite",
    );
    const metadataHandle = transaction.objectStore(metadataStore);
    const metadata = (await requestResult(
      metadataHandle.get(metadataKey),
    )) as LocalMetadata;
    metadataHandle.put(
      { ...metadata, nextClientSequence: metadata.nextClientSequence + 1 },
      metadataKey,
    );
    transaction.objectStore(outboxStore).put({
      operation,
      state: "queued",
      safeErrorCode: null,
    } satisfies LocalOutboxEntry);
    await transactionDone(transaction);
    // Habit completion is visible only after the server supplies the canonical occurrence.
    return operation;
  }

  async loadCachedTasks(
    options: { readonly includeDeleted?: boolean } = {},
  ): Promise<readonly SyncTaskSnapshot[]> {
    const records = await this.loadCachedEntities();
    return records
      .filter(
        (
          record,
        ): record is CachedEntity & { readonly value: SyncTaskSnapshot } =>
          record.entityKind === "task" && isTaskSnapshot(record.value),
      )
      .map((record) => record.value)
      .filter(
        ({ task }) => options.includeDeleted === true || task.deletedAt == null,
      )
      .sort((left, right) =>
        right.task.updatedAt.localeCompare(left.task.updatedAt),
      );
  }

  async loadOutbox(): Promise<readonly LocalOutboxEntry[]> {
    const database = await this.#open();
    const transaction = database.transaction(outboxStore, "readonly");
    const entries = (await requestResult(
      transaction.objectStore(outboxStore).getAll(),
    )) as LocalOutboxEntry[];
    await transactionDone(transaction);
    return entries.sort(
      (left, right) =>
        left.operation.clientSequence - right.operation.clientSequence,
    );
  }

  async loadCachedProjects(): Promise<readonly Project[]> {
    return (await this.loadCachedEntities())
      .filter(({ entityKind }) => entityKind === "project")
      .map(({ value }) => projectSchema.parse(value))
      .sort(compareOrganization);
  }

  async loadCachedTags(): Promise<readonly Tag[]> {
    return (await this.loadCachedEntities())
      .filter(({ entityKind }) => entityKind === "tag")
      .map(({ value }) => tagSchema.parse(value))
      .sort(compareOrganization);
  }

  async loadCachedSubtasks(): Promise<readonly Subtask[]> {
    return (await this.loadCachedEntities())
      .filter(({ entityKind }) => entityKind === "subtask")
      .map(({ value }) => subtaskSchema.parse(value))
      .sort(
        (left, right) =>
          left.position - right.position || left.id.localeCompare(right.id),
      );
  }

  /** Cache an acknowledged initial create without moving the sync cursor. */
  async cacheCreatedTask(task: Task): Promise<void> {
    if (task.revision !== 1) return;
    const database = await this.#open();
    const transaction = database.transaction(entityStore, "readwrite");
    const entities = transaction.objectStore(entityStore);
    const existing: unknown = await requestResult(
      entities.get(entityKey("task", task.id)),
    );
    // A replay must not overwrite subsequent offline edits or a newer snapshot.
    if (existing === undefined)
      entities.put({
        entityKind: "task",
        id: task.id,
        revision: 1,
        changeSequence: 0,
        value: {
          task,
          fieldVersions: initialFieldVersions(),
          changeSequence: 0,
        },
      } satisfies CachedEntity);
    await transactionDone(transaction);
  }

  async loadConflicts(): Promise<readonly LocalConflict[]> {
    const database = await this.#open();
    const transaction = database.transaction(conflictStore, "readonly");
    const conflicts = (await requestResult(
      transaction.objectStore(conflictStore).getAll(),
    )) as LocalConflict[];
    await transactionDone(transaction);
    return conflicts;
  }

  async loadConflictReviews(): Promise<readonly TaskConflictReview[]> {
    const database = await this.#open();
    const transaction = database.transaction(
      [entityStore, outboxStore, conflictStore],
      "readonly",
    );
    const conflicts = (await requestResult(
      transaction.objectStore(conflictStore).getAll(),
    )) as LocalConflict[];
    const outbox = transaction.objectStore(outboxStore);
    const entities = transaction.objectStore(entityStore);
    const allEntries = (await requestResult(
      outbox.getAll(),
    )) as LocalOutboxEntry[];
    const reviews = await Promise.all(
      conflicts.map(async (conflict): Promise<TaskConflictReview> => {
        const entry = (await requestResult(
          outbox.get(conflict.operationId),
        )) as LocalOutboxEntry | undefined;
        const cached =
          conflictEntityKind(conflict) === "task"
            ? ((await requestResult(
                entities.get(entityKey("task", conflict.taskId)),
              )) as CachedEntity | undefined)
            : undefined;
        const canonical =
          cached !== undefined && isTaskSnapshot(cached.value)
            ? cached.value
            : null;
        const attemptedFields =
          entry?.operation.kind === "task.patch"
            ? entry.operation.fields
            : null;
        const pendingLocalSync =
          entry !== undefined &&
          hasNewerActiveTaskMutation(
            allEntries,
            conflict.taskId,
            entry.operation.clientSequence,
          );
        const retrySupportedByConflict =
          canonical !== null &&
          attemptedFields !== null &&
          conflict.conflictingFields !== null &&
          conflict.conflictingFields.length > 0;
        return {
          conflict,
          canonical,
          attemptedFields,
          retryLocalSupported: retrySupportedByConflict && !pendingLocalSync,
          retryLocalUnavailableReason: pendingLocalSync
            ? "pending-local-sync"
            : retrySupportedByConflict
              ? null
              : "unsupported",
        };
      }),
    );
    await transactionDone(transaction);
    return reviews.sort((left, right) =>
      left.conflict.operationId.localeCompare(right.conflict.operationId),
    );
  }

  async resolveTaskConflict(
    input: ResolveTaskConflictInput,
  ): Promise<SyncOperation | null> {
    const review = (await this.loadConflictReviews()).find(
      ({ conflict }) => conflict.operationId === input.operationId,
    );
    if (review === undefined)
      throw new Error("Sync conflict is no longer available");
    if (conflictEntityKind(review.conflict) !== "task") {
      // ADR 0033: project, tag and checklist conflicts are dismissed once the
      // canonical record has been re-sent; nothing is retried locally.
      if (input.choice !== "keep-current")
        throw new Error("This sync conflict cannot be retried locally");
      if (input.reviewedTaskRevision !== review.conflict.taskRevision)
        throw new Error("The record changed; review the latest values");
      await this.#dismissConflict(input.operationId);
      return null;
    }
    if (review.canonical === null)
      throw new Error("The canonical task is no longer available for review");
    this.#assertConflictPreview(review, input);
    if (
      input.choice === "retry-local" &&
      review.retryLocalUnavailableReason === "pending-local-sync"
    )
      throw new Error(
        "A newer local change must finish syncing before retrying",
      );

    const metadata = await this.#requiredMetadata();
    const retry =
      input.choice === "retry-local"
        ? await this.#conflictRetryOperation(review, metadata)
        : null;
    const database = await this.#open();
    const transaction = database.transaction(
      [metadataStore, entityStore, outboxStore, conflictStore],
      "readwrite",
    );
    const metadataHandle = transaction.objectStore(metadataStore);
    const currentMetadata = (await requestResult(
      metadataHandle.get(metadataKey),
    )) as LocalMetadata | undefined;
    const conflicts = transaction.objectStore(conflictStore);
    const conflict = (await requestResult(conflicts.get(input.operationId))) as
      LocalConflict | undefined;
    const outbox = transaction.objectStore(outboxStore);
    const original = (await requestResult(outbox.get(input.operationId))) as
      LocalOutboxEntry | undefined;
    const allEntries = (await requestResult(
      outbox.getAll(),
    )) as LocalOutboxEntry[];
    const entities = transaction.objectStore(entityStore);
    const cached = (await requestResult(
      entities.get(entityKey("task", review.conflict.taskId)),
    )) as CachedEntity | undefined;
    if (
      currentMetadata === undefined ||
      conflict === undefined ||
      original === undefined ||
      cached === undefined ||
      !isTaskSnapshot(cached.value)
    ) {
      transaction.abort();
      throw new Error("Sync conflict changed before it could be resolved");
    }
    const currentReview: TaskConflictReview = {
      conflict,
      canonical: cached.value,
      attemptedFields:
        original.operation.kind === "task.patch"
          ? original.operation.fields
          : null,
      retryLocalSupported:
        original.operation.kind === "task.patch" &&
        conflict.conflictingFields !== null &&
        conflict.conflictingFields.length > 0,
      retryLocalUnavailableReason: null,
    };
    this.#assertConflictPreview(currentReview, input);
    if (
      input.choice === "retry-local" &&
      hasNewerActiveTaskMutation(
        allEntries,
        conflict.taskId,
        original.operation.clientSequence,
      )
    ) {
      transaction.abort();
      throw new Error(
        "A newer local change must finish syncing before retrying",
      );
    }
    if (
      retry !== null &&
      currentMetadata.nextClientSequence !== metadata.nextClientSequence
    ) {
      transaction.abort();
      throw new Error("A newer local change requires a fresh conflict review");
    }
    outbox.put({
      ...original,
      state: "resolved",
      resolvedAt: this.#now(),
      resolutionChoice: input.choice,
      ...(retry === null ? {} : { replacementOperationId: retry.operationId }),
    } satisfies LocalOutboxEntry);
    conflicts.delete(input.operationId);
    if (retry !== null) {
      const task = {
        ...cached.value.task,
        ...retry.fields,
        ...planningSlot(cached.value.task, retry.fields),
        updatedAt: this.#now(),
      };
      entities.put({
        ...cached,
        value: { ...cached.value, task },
      } satisfies CachedEntity);
      metadataHandle.put(
        {
          ...currentMetadata,
          nextClientSequence: currentMetadata.nextClientSequence + 1,
        },
        metadataKey,
      );
      outbox.put({
        operation: retry,
        state: "queued",
        safeErrorCode: null,
      } satisfies LocalOutboxEntry);
    }
    await transactionDone(transaction);
    return retry;
  }

  async queueTaskCreate(input: {
    readonly title: string;
    readonly notes?: string;
    readonly estimateMinutes?: number | null;
    readonly deadline?: Task["deadline"];
  }): Promise<SyncOperation> {
    const metadata = await this.#requiredMetadata();
    const taskId = this.#uuid();
    const createdAt = this.#now();
    const task: Task = {
      id: taskId,
      title: input.title,
      notes: input.notes ?? "",
      status: "open",
      revision: 1,
      createdAt,
      updatedAt: createdAt,
      completedAt: null,
      deletedAt: null,
      plannedStart: null,
      estimateMinutes: input.estimateMinutes ?? null,
      deadline: input.deadline ?? null,
      projectId: null,
      tagIds: [],
    };
    const operation = await this.#operation(metadata, "task.create", {
      task: {
        id: taskId,
        title: task.title,
        notes: task.notes,
        estimateMinutes: task.estimateMinutes ?? null,
        deadline: task.deadline ?? null,
      },
    });
    await this.#queueAndWriteTask(operation, {
      task,
      fieldVersions: initialFieldVersions(),
      changeSequence: 0,
    });
    return operation;
  }

  async queueTaskPatch(
    taskId: string,
    fields: LocalTaskPatch,
  ): Promise<SyncOperation> {
    const snapshot = await this.#requiredTask(taskId);
    const changed = [
      ...new Set(
        Object.keys(fields)
          .filter(
            (field) => fields[field as keyof LocalTaskPatch] !== undefined,
          )
          .map(syncFieldVersionKey),
      ),
    ] as CoreTaskField[];
    if (changed.length === 0)
      throw new Error("At least one task field is required");
    const metadata = await this.#requiredMetadata();
    const baseFieldVersions = Object.fromEntries(
      changed.map((field) => [
        field,
        (snapshot.fieldVersions as Partial<TaskFieldVersions>)[field] ??
          snapshot.task.revision,
      ]),
    );
    const operation = await this.#operation(metadata, "task.patch", {
      taskId,
      fields,
      baseFieldVersions,
    });
    const task = {
      ...snapshot.task,
      ...fields,
      ...planningSlot(snapshot.task, fields),
      updatedAt: this.#now(),
    };
    await this.#queueAndWriteTask(operation, { ...snapshot, task });
    return operation;
  }

  /** ADR 0033: create a project or tag offline with a client-generated ID. */
  async queueOrganizationCreate(
    kind: "project" | "tag",
    title: string,
  ): Promise<SyncOperation> {
    const metadata = await this.#requiredMetadata();
    const id = this.#uuid();
    const now = this.#now();
    const operation = await this.#operation(
      metadata,
      kind === "project" ? "project.create" : "tag.create",
      kind === "project" ? { project: { id, title } } : { tag: { id, title } },
    );
    const position = (
      kind === "project"
        ? await this.loadCachedProjects()
        : await this.loadCachedTags()
    ).reduce((max, record) => Math.max(max, record.position + 1), 0);
    const base = {
      id,
      ownerId: metadata.clientId,
      revision: 1,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      color: null,
      icon: null,
      position,
    };
    await this.#queueAndWriteEntity(operation, {
      entityKind: kind,
      id,
      revision: 1,
      changeSequence: 0,
      value:
        kind === "project"
          ? projectSchema.parse({ ...base, title })
          : tagSchema.parse({
              ...base,
              displayName: title,
              normalizedName: title.normalize("NFKC").toLocaleLowerCase(),
            }),
    });
    return operation;
  }

  /** ADR 0033: rename, archive, restore or recolour a cached project or tag. */
  async queueOrganizationPatch(
    kind: "project" | "tag",
    id: string,
    fields: LocalOrganizationPatch,
  ): Promise<SyncOperation> {
    const metadata = await this.#requiredMetadata();
    const cached = await this.#requiredEntity(kind, id);
    const current =
      kind === "project"
        ? projectSchema.parse(cached.value)
        : tagSchema.parse(cached.value);
    const operation = await this.#operation(
      metadata,
      kind === "project" ? "project.patch" : "tag.patch",
      {
        ...(kind === "project" ? { projectId: id } : { tagId: id }),
        fields,
        baseRevision: current.revision,
      },
    );
    const now = this.#now();
    const archivedAt =
      fields.archived === false || fields.completed === false
        ? null
        : fields.archived === true || fields.completed === true
          ? (current.archivedAt ?? now)
          : current.archivedAt;
    const next = {
      ...current,
      ...(fields.title === undefined
        ? {}
        : kind === "project"
          ? { title: fields.title }
          : {
              displayName: fields.title,
              normalizedName: fields.title
                .normalize("NFKC")
                .toLocaleLowerCase(),
            }),
      ...(fields.color === undefined ? {} : { color: fields.color }),
      ...(fields.icon === undefined ? {} : { icon: fields.icon }),
      archivedAt,
      ...("completedAt" in current
        ? {
            completedAt:
              fields.completed === true
                ? (current.completedAt ?? now)
                : fields.completed === false || fields.archived === false
                  ? null
                  : current.completedAt,
          }
        : {}),
      updatedAt: now,
    };
    await this.#queueAndWriteEntity(operation, { ...cached, value: next });
    return operation;
  }

  /** ADR 0033: add a checklist item to a cached task. */
  async queueSubtaskCreate(
    taskId: string,
    title: string,
    position: number,
  ): Promise<SyncOperation> {
    await this.#requiredTask(taskId);
    const metadata = await this.#requiredMetadata();
    const id = this.#uuid();
    const now = this.#now();
    const operation = await this.#operation(metadata, "subtask.create", {
      subtask: { id, taskId, title, position },
    });
    await this.#queueAndWriteEntity(operation, {
      entityKind: "subtask",
      id,
      revision: 1,
      changeSequence: 0,
      value: subtaskSchema.parse({
        id,
        taskId,
        title,
        completed: false,
        revision: 1,
        position,
        createdAt: now,
        updatedAt: now,
      }),
    });
    return operation;
  }

  async queueSubtaskPatch(
    subtaskId: string,
    fields: {
      readonly title?: string;
      readonly completed?: boolean;
      readonly position?: number;
    },
  ): Promise<SyncOperation> {
    const metadata = await this.#requiredMetadata();
    const cached = await this.#requiredEntity("subtask", subtaskId);
    const current = subtaskSchema.parse(cached.value);
    const operation = await this.#operation(metadata, "subtask.patch", {
      subtaskId,
      fields,
      baseRevision: current.revision,
    });
    await this.#queueAndWriteEntity(operation, {
      ...cached,
      value: { ...current, ...fields, updatedAt: this.#now() },
    });
    return operation;
  }

  async queueSubtaskDelete(subtaskId: string): Promise<SyncOperation> {
    const metadata = await this.#requiredMetadata();
    const cached = await this.#requiredEntity("subtask", subtaskId);
    const current = subtaskSchema.parse(cached.value);
    const operation = await this.#operation(metadata, "subtask.delete", {
      subtaskId,
      baseRevision: current.revision,
    });
    await this.#queueAndWriteEntity(operation, null, ["subtask", subtaskId]);
    return operation;
  }

  async queueTaskStatus(
    taskId: string,
    completed: boolean,
  ): Promise<SyncOperation> {
    const snapshot = await this.#requiredTask(taskId);
    const metadata = await this.#requiredMetadata();
    const operation = await this.#operation(
      metadata,
      completed ? "task.complete" : "task.reopen",
      { taskId, baseStatusVersion: snapshot.fieldVersions.status },
    );
    const now = this.#now();
    await this.#queueAndWriteTask(operation, {
      ...snapshot,
      task: {
        ...snapshot.task,
        status: completed ? "completed" : "open",
        completedAt: completed ? now : null,
        updatedAt: now,
      },
    });
    return operation;
  }

  /**
   * Queue a structural move (ADR 0018). `parentId` null makes the task
   * top-level. The server validates depth and cycles on replay; a rejected
   * move becomes a visible conflict and the canonical placement returns.
   */
  async queueTaskMove(
    taskId: string,
    parentId: string | null,
    index: number | null = null,
  ): Promise<SyncOperation> {
    const snapshot = await this.#requiredTask(taskId);
    const metadata = await this.#requiredMetadata();
    const siblings =
      parentId === null
        ? []
        : (await this.loadCachedTasks())
            .map(({ task }) => task)
            .filter((task) => task.parentId === parentId && task.id !== taskId)
            .toSorted(compareChildren);
    const operation = await this.#operation(metadata, "task.move", {
      taskId,
      parentId,
      index,
      baseParentVersion:
        snapshot.fieldVersions.parent ?? snapshot.task.revision,
    });
    await this.#queueAndWriteTask(operation, {
      ...snapshot,
      task: {
        ...snapshot.task,
        parentId,
        childPosition:
          parentId === null
            ? null
            : planChildPosition(
                siblings.map(({ childPosition }) => childPosition ?? 0),
                index,
              ).position,
        updatedAt: this.#now(),
      },
    });
    return operation;
  }

  async queueTaskDelete(taskId: string): Promise<SyncOperation> {
    return this.#queueStructuralTaskOperation(
      taskId,
      "task.delete",
      (task, now) => ({
        ...task,
        deletedAt: now,
        updatedAt: now,
      }),
    );
  }

  async queueTaskRestore(taskId: string): Promise<SyncOperation> {
    return this.#queueStructuralTaskOperation(
      taskId,
      "task.restore",
      (task, now) => ({
        ...task,
        deletedAt: null,
        updatedAt: now,
      }),
    );
  }

  async applySyncRound(response: SyncRoundResponse): Promise<void> {
    const database = await this.#open();
    const transaction = database.transaction(
      [metadataStore, entityStore, outboxStore, conflictStore, diagnosticStore],
      "readwrite",
    );
    const outbox = transaction.objectStore(outboxStore);
    const conflicts = transaction.objectStore(conflictStore);
    const entities = transaction.objectStore(entityStore);
    const metadataStoreHandle = transaction.objectStore(metadataStore);

    for (const outcome of response.outcomes) {
      const entry = (await requestResult(outbox.get(outcome.operationId))) as
        LocalOutboxEntry | undefined;
      if (entry === undefined) continue;
      if (outcome.kind === "applied" || outcome.kind === "replayed") {
        outbox.put({ ...entry, state: "acknowledged", safeErrorCode: null });
        conflicts.delete(outcome.operationId);
      } else if (outcome.kind === "conflict") {
        outbox.put({
          ...entry,
          state: "conflicted",
          safeErrorCode: outcome.code,
        });
        conflicts.put({
          operationId: outcome.operationId,
          taskId: outcome.taskId,
          taskRevision: outcome.taskRevision,
          conflictingFields: outcome.conflictingFields ?? null,
          code: outcome.code,
          entityKind: outcome.entityKind ?? "task",
        } satisfies LocalConflict);
      } else {
        outbox.put({
          ...entry,
          state: "rejected",
          safeErrorCode: safeOutcomeCode(outcome),
        });
      }
    }

    for (const change of response.changes) this.#applyChange(entities, change);

    const metadata = (await requestResult(
      metadataStoreHandle.get(metadataKey),
    )) as LocalMetadata | undefined;
    if (metadata === undefined) {
      transaction.abort();
      throw new Error("A registered client is required before applying sync");
    }
    metadataStoreHandle.put(
      {
        ...metadata,
        cursor: response.nextCursor,
      },
      metadataKey,
    );
    const diagnostics = transaction.objectStore(diagnosticStore);
    diagnostics.clear();
    diagnostics.add({
      at: response.serverTimestamp,
      outcomeCount: response.outcomes.length,
      changeCount: response.changes.length,
    });
    await transactionDone(transaction);
  }

  async replaceFromSnapshot(response: SyncSnapshotResponse): Promise<void> {
    if (response.hasMore)
      throw new Error(
        "A complete snapshot is required before cache replacement",
      );
    // Validate every page before opening a write transaction. Aggregated snapshots
    // may contain more than the wire page limit of 200 records.
    for (const snapshot of response.snapshots)
      syncEntitySnapshotSchema.parse(snapshot);
    const database = await this.#open();
    const transaction = database.transaction(
      [metadataStore, entityStore, outboxStore, conflictStore, diagnosticStore],
      "readwrite",
    );
    const entities = transaction.objectStore(entityStore);
    const metadataHandle = transaction.objectStore(metadataStore);
    const metadata = (await requestResult(metadataHandle.get(metadataKey))) as
      LocalMetadata | undefined;
    if (metadata === undefined) {
      transaction.abort();
      throw new Error("A registered client is required before resetting sync");
    }

    const outbox = (await requestResult(
      transaction.objectStore(outboxStore).getAll(),
    )) as LocalOutboxEntry[];
    const taskSnapshots = new Map<string, SyncTaskSnapshot>();
    const structural = new Map<string, CachedEntity>();
    entities.clear();
    for (const snapshot of response.snapshots) {
      if (
        snapshot.entityKind === "project" ||
        snapshot.entityKind === "tag" ||
        snapshot.entityKind === "subtask"
      )
        structural.set(`${snapshot.entityKind}:${snapshot.value.id}`, {
          entityKind: snapshot.entityKind,
          id: snapshot.value.id,
          value: snapshot.value,
          revision: snapshot.value.revision,
          changeSequence: 0,
        });
      if (snapshot.entityKind === "task") {
        const value = snapshot.value;
        taskSnapshots.set(value.task.id, value);
        entities.put({
          entityKind: "task",
          id: value.task.id,
          value,
          revision: value.task.revision,
          changeSequence: value.changeSequence,
        } satisfies CachedEntity);
      } else if (snapshot.entityKind === "template") {
        const value = snapshot.value;
        entities.put({
          entityKind: "template",
          id: value.template.id,
          value,
          revision: value.template.revision,
          changeSequence: 0,
        } satisfies CachedEntity);
      } else if (snapshot.entityKind === "template_set") {
        const value = snapshot.value;
        entities.put({
          entityKind: "template_set",
          id: value.set.id,
          value,
          revision: value.set.revision,
          changeSequence: 0,
        } satisfies CachedEntity);
      } else if (snapshot.entityKind === "choice_pool") {
        const value = snapshot.value;
        entities.put({
          entityKind: "choice_pool",
          id: value.pool.id,
          value,
          revision: value.pool.revision,
          changeSequence: 0,
        } satisfies CachedEntity);
      } else if (snapshot.entityKind === "planning_placeholder") {
        const value = snapshot.value;
        entities.put({
          entityKind: "planning_placeholder",
          id: value.placeholder.id,
          value,
          revision: value.placeholder.revision,
          changeSequence: 0,
        } satisfies CachedEntity);
      } else {
        const value = snapshot.value;
        entities.put({
          entityKind: snapshot.entityKind,
          id: value.id,
          value,
          revision: "revision" in value ? value.revision : 1,
          changeSequence: 0,
        } satisfies CachedEntity);
      }
    }

    for (const { operation } of outbox
      .filter(({ state }) => state === "queued" || state === "sending")
      .sort(
        (left, right) =>
          left.operation.clientSequence - right.operation.clientSequence,
      )) {
      if (isHabitSyncOperation(operation)) continue;
      const target = syncOperationEntity(operation);
      if (target === null) continue;
      if (target.entityKind !== "task") {
        // ADR 0033: structural writes replay over the canonical records.
        this.#replayStructuralOperation(entities, structural, operation);
        continue;
      }
      const taskId = target.entityId;
      let snapshot = taskSnapshots.get(taskId);
      if (operation.kind === "task.create") {
        const task: Task = {
          ...operation.task,
          status: "open",
          revision: 1,
          createdAt: operation.createdAt,
          updatedAt: operation.createdAt,
          completedAt: null,
          deletedAt: null,
          plannedStart: null,
          projectId: null,
          tagIds: [],
        };
        snapshot = {
          task,
          fieldVersions: initialFieldVersions(),
          changeSequence: 0,
        };
      } else if (snapshot !== undefined) {
        const now = operation.createdAt;
        const task: Task =
          operation.kind === "task.patch"
            ? {
                ...snapshot.task,
                ...(operation.fields.title === undefined
                  ? {}
                  : { title: operation.fields.title }),
                ...(operation.fields.notes === undefined
                  ? {}
                  : { notes: operation.fields.notes }),
                ...(operation.fields.estimateMinutes === undefined
                  ? {}
                  : { estimateMinutes: operation.fields.estimateMinutes }),
                ...(operation.fields.deadline === undefined
                  ? {}
                  : { deadline: operation.fields.deadline }),
                ...(operation.fields.projectId === undefined
                  ? {}
                  : { projectId: operation.fields.projectId }),
                ...(operation.fields.tagIds === undefined
                  ? {}
                  : { tagIds: operation.fields.tagIds }),
                ...planningSlot(snapshot.task, operation.fields),
                updatedAt: now,
              }
            : operation.kind === "task.move"
              ? {
                  ...snapshot.task,
                  parentId: operation.parentId,
                  // Pending until the server assigns the canonical key.
                  childPosition:
                    operation.parentId === null
                      ? null
                      : operation.parentId === snapshot.task.parentId
                        ? (snapshot.task.childPosition ?? null)
                        : Number.MAX_SAFE_INTEGER,
                  updatedAt: now,
                }
              : operation.kind === "task.complete" ||
                  operation.kind === "task.reopen"
                ? {
                    ...snapshot.task,
                    status:
                      operation.kind === "task.complete"
                        ? ("completed" as const)
                        : ("open" as const),
                    completedAt:
                      operation.kind === "task.complete" ? now : null,
                    updatedAt: now,
                  }
                : {
                    ...snapshot.task,
                    deletedAt: operation.kind === "task.delete" ? now : null,
                    updatedAt: now,
                  };
        snapshot = { ...snapshot, task };
      }
      if (snapshot !== undefined) {
        taskSnapshots.set(taskId, snapshot);
        entities.put({
          entityKind: "task",
          id: taskId,
          value: snapshot,
          revision: snapshot.task.revision,
          changeSequence: snapshot.changeSequence,
        } satisfies CachedEntity);
      }
    }

    metadataHandle.put(
      {
        ...metadata,
        cursor: response.nextCursor,
        syncProtocolVersion: 2,
        resetRequired: false,
      },
      metadataKey,
    );
    const diagnostics = transaction.objectStore(diagnosticStore);
    diagnostics.clear();
    diagnostics.add({
      at: response.serverTimestamp,
      snapshotCount: response.snapshots.length,
      reset: true,
    });
    await transactionDone(transaction);
  }

  async recoverySupportManifest(): Promise<SyncDiagnosticManifest> {
    const metadata = await this.#requiredMetadata();
    const outbox = await this.loadOutbox();
    const conflicts = await this.loadConflicts();
    return syncDiagnosticManifestSchema.parse({
      schemaVersion: "suite-sync-diagnostics-v1",
      exportedAt: this.#now(),
      installationId: metadata.installationId,
      clientId: metadata.clientId,
      cursor: metadata.cursor,
      pendingOperationCount: outbox.filter(
        ({ state }) => state === "queued" || state === "sending",
      ).length,
      conflictCount: conflicts.length,
      operations: outbox.map(({ operation, state, safeErrorCode }) => ({
        operationId: operation.operationId,
        entityId: isHabitSyncOperation(operation)
          ? operation.kind === "habit.create"
            ? operation.habit.id
            : operation.habitId
          : (syncOperationEntity(operation)?.entityId ?? null),
        kind: operation.kind,
        state,
        requestHash: operation.requestHash,
        baseRevision:
          "baseRevision" in operation ? operation.baseRevision : null,
        safeErrorCode,
      })),
    });
  }

  close(): Promise<void> {
    this.#database?.close();
    this.#database = undefined;
    return Promise.resolve();
  }

  async #dismissConflict(operationId: string): Promise<void> {
    const database = await this.#open();
    const transaction = database.transaction(
      [outboxStore, conflictStore],
      "readwrite",
    );
    const outbox = transaction.objectStore(outboxStore);
    const original = (await requestResult(outbox.get(operationId))) as
      LocalOutboxEntry | undefined;
    if (original !== undefined)
      outbox.put({
        ...original,
        state: "resolved",
        resolvedAt: this.#now(),
        resolutionChoice: "keep-current",
      } satisfies LocalOutboxEntry);
    transaction.objectStore(conflictStore).delete(operationId);
    await transactionDone(transaction);
  }

  async #queueStructuralTaskOperation(
    taskId: string,
    kind: "task.delete" | "task.restore",
    mutate: (task: Task, now: string) => Task,
  ): Promise<SyncOperation> {
    const snapshot = await this.#requiredTask(taskId);
    const metadata = await this.#requiredMetadata();
    const operation = await this.#operation(metadata, kind, {
      taskId,
      baseRevision: snapshot.task.revision,
    });
    await this.#queueAndWriteTask(operation, {
      ...snapshot,
      task: mutate(snapshot.task, this.#now()),
    });
    return operation;
  }

  async #operation(
    metadata: LocalMetadata,
    kind: SyncOperation["kind"],
    payload: Record<string, unknown>,
  ): Promise<SyncOperation> {
    const operationBase = {
      operationId: this.#uuid(),
      clientSequence: metadata.nextClientSequence,
      createdAt: this.#now(),
      kind,
      ...payload,
    };
    const normalized = syncOperationSchema.parse({
      ...operationBase,
      requestHash: "a".repeat(43),
    });
    const payloadToHash = Object.fromEntries(
      Object.entries(normalized).filter(([key]) => key !== "requestHash"),
    );
    return { ...normalized, requestHash: await hash(payloadToHash) };
  }

  #assertConflictPreview(
    review: TaskConflictReview,
    input: ResolveTaskConflictInput,
  ): void {
    if (review.canonical === null)
      throw new Error("The canonical task is no longer available for review");
    if (review.canonical.task.revision !== input.reviewedTaskRevision)
      throw new Error("The task changed; review the latest canonical values");
    const fields = Object.keys(review.attemptedFields ?? {}).map(
      syncFieldVersionKey,
    ) as CoreTaskField[];
    for (const field of fields) {
      if (
        input.reviewedFieldVersions[field] !==
        review.canonical.fieldVersions[field]
      )
        throw new Error(
          "A task field changed; review the latest canonical values",
        );
    }
  }

  async #conflictRetryOperation(
    review: TaskConflictReview,
    metadata: LocalMetadata,
  ): Promise<TaskPatchOperation> {
    if (!review.retryLocalSupported || review.canonical === null)
      throw new Error("This sync conflict cannot be retried locally");
    const canonical = review.canonical;
    const fields = review.attemptedFields;
    if (fields === null)
      throw new Error("The original task patch is unavailable");
    const baseFieldVersions = Object.fromEntries(
      (Object.keys(fields).map(syncFieldVersionKey) as CoreTaskField[]).map(
        (field) => [
          field,
          canonical.fieldVersions[field] ?? canonical.task.revision,
        ],
      ),
    );
    const operation = await this.#operation(metadata, "task.patch", {
      taskId: review.conflict.taskId,
      fields,
      baseFieldVersions,
    });
    if (operation.kind !== "task.patch")
      throw new Error("Expected a task patch conflict retry");
    return operation;
  }

  async #queueAndWriteTask(
    operation: SyncOperation,
    snapshot: SyncTaskSnapshot,
  ): Promise<void> {
    const database = await this.#open();
    const transaction = database.transaction(
      [metadataStore, entityStore, outboxStore, conflictStore],
      "readwrite",
    );
    const metadataHandle = transaction.objectStore(metadataStore);
    const metadata = (await requestResult(metadataHandle.get(metadataKey))) as
      LocalMetadata | undefined;
    if (metadata === undefined) {
      transaction.abort();
      throw new Error(
        "A registered client is required before queueing a task mutation",
      );
    }
    metadataHandle.put(
      { ...metadata, nextClientSequence: metadata.nextClientSequence + 1 },
      metadataKey,
    );
    transaction.objectStore(entityStore).put({
      entityKind: "task",
      id: snapshot.task.id,
      value: snapshot,
      revision: snapshot.task.revision,
      changeSequence: snapshot.changeSequence,
    } satisfies CachedEntity);
    const outbox = transaction.objectStore(outboxStore);
    outbox.put({
      operation,
      state: "queued",
      safeErrorCode: null,
    } satisfies LocalOutboxEntry);
    await transactionDone(transaction);
  }

  /** Queue one structural operation and apply it to the cache atomically. */
  async #queueAndWriteEntity(
    operation: SyncOperation,
    entity: CachedEntity | null,
    remove?: [CachedEntityKind, string],
  ): Promise<void> {
    const database = await this.#open();
    const transaction = database.transaction(
      [metadataStore, entityStore, outboxStore],
      "readwrite",
    );
    const metadataHandle = transaction.objectStore(metadataStore);
    const metadata = (await requestResult(metadataHandle.get(metadataKey))) as
      LocalMetadata | undefined;
    if (metadata === undefined) {
      transaction.abort();
      throw new Error("A registered client is required before queueing");
    }
    metadataHandle.put(
      { ...metadata, nextClientSequence: metadata.nextClientSequence + 1 },
      metadataKey,
    );
    const entities = transaction.objectStore(entityStore);
    if (entity !== null) entities.put(entity);
    if (remove !== undefined) entities.delete(entityKey(...remove));
    transaction.objectStore(outboxStore).put({
      operation,
      state: "queued",
      safeErrorCode: null,
    } satisfies LocalOutboxEntry);
    await transactionDone(transaction);
  }

  #replayStructuralOperation(
    entities: IDBObjectStore,
    records: Map<string, CachedEntity>,
    operation: SyncOperation,
  ): void {
    const target = syncOperationEntity(operation);
    if (target === null) return;
    const key = `${target.entityKind}:${target.entityId}`;
    const current = records.get(key);
    const now = operation.createdAt;
    const base = {
      revision: 1,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      color: null,
      icon: null,
      position: Number.MAX_SAFE_INTEGER,
    };
    let next: CachedEntity | null;
    switch (operation.kind) {
      case "project.create":
        next =
          current ??
          this.#structuralEntity("project", target.entityId, {
            ...base,
            id: target.entityId,
            ownerId: target.entityId,
            title: operation.project.title,
          });
        break;
      case "tag.create":
        next =
          current ??
          this.#structuralEntity("tag", target.entityId, {
            ...base,
            id: target.entityId,
            ownerId: target.entityId,
            displayName: operation.tag.title,
            normalizedName: operation.tag.title
              .normalize("NFKC")
              .toLocaleLowerCase(),
          });
        break;
      case "project.patch":
      case "tag.patch": {
        if (current === undefined) return;
        const { fields } = operation;
        const record = current.value as {
          readonly archivedAt: string | null;
          readonly completedAt?: string | null;
        };
        const archivedAt =
          fields.archived === false || fields.completed === false
            ? null
            : fields.archived === true || fields.completed === true
              ? (record.archivedAt ?? now)
              : record.archivedAt;
        next = {
          ...current,
          value: {
            ...(current.value as object),
            ...(fields.title === undefined
              ? {}
              : operation.kind === "project.patch"
                ? { title: fields.title }
                : {
                    displayName: fields.title,
                    normalizedName: fields.title
                      .normalize("NFKC")
                      .toLocaleLowerCase(),
                  }),
            ...(fields.color === undefined ? {} : { color: fields.color }),
            ...(fields.icon === undefined ? {} : { icon: fields.icon }),
            archivedAt,
            ...(operation.kind === "project.patch"
              ? {
                  completedAt:
                    fields.completed === true
                      ? (record.completedAt ?? now)
                      : fields.completed === false || fields.archived === false
                        ? null
                        : (record.completedAt ?? null),
                }
              : {}),
            updatedAt: now,
          },
        };
        break;
      }
      case "subtask.create":
        next =
          current ??
          this.#structuralEntity("subtask", target.entityId, {
            ...operation.subtask,
            completed: false,
            revision: 1,
            createdAt: now,
            updatedAt: now,
          });
        break;
      case "subtask.patch":
        if (current === undefined) return;
        next = {
          ...current,
          value: {
            ...(current.value as object),
            ...operation.fields,
            updatedAt: now,
          },
        };
        break;
      case "subtask.delete":
        next = null;
        break;
      default:
        return;
    }
    if (next === null) {
      records.delete(key);
      entities.delete(entityKey(target.entityKind, target.entityId));
      return;
    }
    records.set(key, next);
    entities.put(next);
  }

  #structuralEntity(
    entityKind: "project" | "tag" | "subtask",
    id: string,
    value: unknown,
  ): CachedEntity {
    return {
      entityKind,
      id,
      value:
        entityKind === "project"
          ? projectSchema.parse(value)
          : entityKind === "tag"
            ? tagSchema.parse(value)
            : subtaskSchema.parse(value),
      revision: 1,
      changeSequence: 0,
    };
  }

  async #requiredEntity(
    entityKind: CachedEntityKind,
    id: string,
  ): Promise<CachedEntity> {
    const database = await this.#open();
    const transaction = database.transaction(entityStore, "readonly");
    const record = (await requestResult(
      transaction.objectStore(entityStore).get(entityKey(entityKind, id)),
    )) as CachedEntity | undefined;
    await transactionDone(transaction);
    if (record === undefined)
      throw new Error("The record is not present in the local cache");
    return record;
  }

  #applyChange(store: IDBObjectStore, change: SyncChange): void {
    if (change.snapshot === null) {
      store.delete(entityKey(change.entityKind, change.entityId));
      return;
    }
    const snapshot = change.snapshot;
    store.put({
      entityKind: change.entityKind,
      id: change.entityId,
      value: snapshot.entityKind === "task" ? snapshot.value : snapshot.value,
      revision: change.entityRevision,
      changeSequence: change.sequence,
    } satisfies CachedEntity);
  }

  async #requiredTask(taskId: string): Promise<SyncTaskSnapshot> {
    const database = await this.#open();
    const transaction = database.transaction(entityStore, "readonly");
    const record = (await requestResult(
      transaction.objectStore(entityStore).get(entityKey("task", taskId)),
    )) as CachedEntity | undefined;
    await transactionDone(transaction);
    if (record === undefined || !isTaskSnapshot(record.value)) {
      throw new Error("Task is not present in the local cache");
    }
    return record.value;
  }

  async #requiredMetadata(): Promise<LocalMetadata> {
    const metadata = await this.#metadata();
    if (metadata === undefined || metadata.clientId === "") {
      throw new Error("A registered client is required");
    }
    return metadata;
  }

  async #metadata(): Promise<LocalMetadata | undefined> {
    const database = await this.#open();
    const transaction = database.transaction(metadataStore, "readonly");
    const metadata = (await requestResult(
      transaction.objectStore(metadataStore).get(metadataKey),
    )) as LocalMetadata | undefined;
    await transactionDone(transaction);
    return metadata;
  }

  async #open(): Promise<IDBDatabase> {
    if (this.#database !== undefined) return this.#database;
    const request = this.#indexedDb.open(databaseName, databaseVersion);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(metadataStore))
        database.createObjectStore(metadataStore);
      if (!database.objectStoreNames.contains(entityStore))
        database.createObjectStore(entityStore, {
          keyPath: ["entityKind", "id"],
        });
      if (!database.objectStoreNames.contains(outboxStore))
        database.createObjectStore(outboxStore, {
          keyPath: "operation.operationId",
        });
      if (!database.objectStoreNames.contains(conflictStore))
        database.createObjectStore(conflictStore, { keyPath: "operationId" });
      if (!database.objectStoreNames.contains(diagnosticStore))
        database.createObjectStore(diagnosticStore, { autoIncrement: true });
      const metadata = request.transaction?.objectStore(metadataStore);
      if (metadata !== undefined) {
        const previous = metadata.get(metadataKey);
        previous.onsuccess = () => {
          const value = previous.result as LocalMetadata | undefined;
          if (value !== undefined)
            metadata.put(
              { ...value, syncProtocolVersion: 2, resetRequired: true },
              metadataKey,
            );
        };
      }
    };
    this.#database = await requestResult(request);
    return this.#database;
  }
}

export const localTaskFields = taskFields;
