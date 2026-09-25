import {
  syncDiagnosticManifestSchema,
  isHabitSyncOperation,
  habitListResponseSchema,
  type HabitCommand,
  type HabitListResponse,
  syncEntitySnapshotSchema,
  syncOperationSchema,
  type ClientRegistrationResponse,
  type CoreTaskField,
  type SyncChange,
  type SyncDiagnosticManifest,
  type SyncOperation,
  type SyncRoundResponse,
  type SyncSnapshotResponse,
  type SyncTaskSnapshot,
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
  readonly taskId: string;
  readonly taskRevision: number;
  readonly conflictingFields: readonly CoreTaskField[] | null;
  readonly code: "SYNC_FIELD_CONFLICT" | "SYNC_RESOURCE_CONFLICT";
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
});

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
        const cached = (await requestResult(
          entities.get(entityKey("task", conflict.taskId)),
        )) as CachedEntity | undefined;
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
    fields: {
      readonly title?: string;
      readonly notes?: string;
      readonly estimateMinutes?: number | null;
      readonly deadline?: Task["deadline"];
    },
  ): Promise<SyncOperation> {
    const snapshot = await this.#requiredTask(taskId);
    const changed = Object.keys(fields) as (
      "title" | "notes" | "estimateMinutes" | "deadline"
    )[];
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
    const task = { ...snapshot.task, ...fields, updatedAt: this.#now() };
    await this.#queueAndWriteTask(operation, { ...snapshot, task });
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
    entities.clear();
    for (const snapshot of response.snapshots) {
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
      const taskId =
        operation.kind === "task.create" ? operation.task.id : operation.taskId;
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
          : "taskId" in operation
            ? operation.taskId
            : operation.task.id,
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
    const fields = Object.keys(review.attemptedFields ?? {}) as CoreTaskField[];
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
      (Object.keys(fields) as CoreTaskField[]).map((field) => [
        field,
        canonical.fieldVersions[field],
      ]),
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
