import type {
  AutomationAuditRecord,
  AutomationOutcomeRecord,
  AutomationPreviewRecord,
  AutomationTokenRecord,
  BaikalConnectorRecord,
  CalendarEventProjectionRecord,
  CalendarFeedCapabilityRecord,
  CalendarImportItemRecord,
  CalendarImportJobRecord,
  CalendarWriteOperationRecord,
  CalendarWriteReservationResult,
  ChoicePoolHistoryRecord,
  ChoicePoolItemRecord,
  ChoicePoolRecord,
  ConditionalTaskResult,
  DatabaseState,
  GoogleCalendarSyncRecord,
  GoogleConnectorRecord,
  IdempotentTaskCreateResult,
  NotificationDeliveryRecord,
  NotificationPreferencesRecord,
  OwnedCalendarRecord,
  OwnerRecord,
  PlanningPlaceholderRecord,
  PlanningPlaceholderResolutionResult,
  PlanningPreferencesRecord,
  ProjectRecord,
  SessionRecord,
  SubtaskRecord,
  SyncChangeRecord,
  SyncClientRecord,
  TagRecord,
  TaskCalendarBlockRecord,
  TaskPatch,
  TaskRecord,
  TaskTemplateRecord,
  TemplateInstantiationResult,
  TemplatePoolSlotRecord,
  TemplateSetMemberRecord,
  TemplateSetRecord,
  TemplateSubtaskBlueprintRecord,
} from "./index.js";

// ---------------------------------------------------------------------------
// MetadataStore
// ---------------------------------------------------------------------------

export interface MetadataStore {
  state(): DatabaseState;
  isSetupComplete(): boolean;
  claimInstallation(opts: {
    readonly username: string;
    readonly displayName: string;
    readonly passwordHash: string;
  }): OwnerRecord;
}

// ---------------------------------------------------------------------------
// OwnerStore
// ---------------------------------------------------------------------------

export interface OwnerStore {
  createOwner(record: OwnerRecord): boolean;
  getOwner(): string | undefined;
  getOwnerByUsername(username: string): OwnerRecord | undefined;
}

// ---------------------------------------------------------------------------
// SessionStore
// ---------------------------------------------------------------------------

export interface SessionStore {
  insertSession(
    record: SessionRecord & { readonly issuedAt: string },
  ): void;
  getSession(tokenHash: string): SessionRecord | undefined;
  updateCsrf(tokenHash: string, csrfHash: string): void;
  revokeSession(tokenHash: string, revokedAt: string): boolean;
  purgeExpiredSessions(): void;
}

// ---------------------------------------------------------------------------
// CredentialStore
// ---------------------------------------------------------------------------

export interface CredentialStore {
  getBaikalConnector(ownerId: string): BaikalConnectorRecord | undefined;
  upsertBaikalConnector(
    record: BaikalConnectorRecord & { readonly updatedAt: string },
  ): void;
  deleteBaikalConnector(ownerId: string): void;
  upsertGoogleConnector(record: GoogleConnectorRecord): void;
  getGoogleConnector(ownerId: string): GoogleConnectorRecord | undefined;
  deleteGoogleConnector(ownerId: string): boolean;
  upsertGoogleCalendarSync(record: GoogleCalendarSyncRecord): void;
  listGoogleCalendarSync(ownerId: string): readonly GoogleCalendarSyncRecord[];
  clearGoogleCalendarSync(ownerId: string): void;
}

// ---------------------------------------------------------------------------
// PlanningPreferencesStore
// ---------------------------------------------------------------------------

export interface PlanningPreferencesStore {
  getPlanningPreferences(ownerId: string): PlanningPreferencesRecord;
  upsertPlanningPreferences(
    ownerId: string,
    record: PlanningPreferencesRecord,
  ): PlanningPreferencesRecord;
}

// ---------------------------------------------------------------------------
// NotificationPreferencesStore
// ---------------------------------------------------------------------------

export interface NotificationPreferencesStore {
  getNotificationPreferences(ownerId: string): NotificationPreferencesRecord;
  upsertNotificationPreferences(
    ownerId: string,
    record: NotificationPreferencesRecord,
  ): NotificationPreferencesRecord;
}

// ---------------------------------------------------------------------------
// NotificationDeliveryStore
// ---------------------------------------------------------------------------

export interface NotificationDeliveryStore {
  claimDelivery(
    ownerId: string,
    taskId: string,
    occurrenceStart: string,
    kind: "lead" | "at_start" | "test",
    claimedAt: string,
  ): NotificationDeliveryRecord | undefined;

  getPendingDeliveries(ownerId: string): readonly NotificationDeliveryRecord[];
  countDeliveriesByTask(
    ownerId: string,
    taskId: string,
  ): { readonly pendingCount: number; readonly failedCount: number };

  markDeliveryFailed(
    ownerId: string,
    deliveryId: string,
    now: string,
  ): void;

  cancelPendingDeliveries(
    ownerId: string,
    taskId: string,
    now: string,
  ): void;

  insertDelivery(record: NotificationDeliveryRecord): void;

  reconcile(input: {
    readonly ownerId: string;
    readonly tasks: readonly TaskRecord[];
    readonly preferences: NotificationPreferencesRecord;
    readonly now: string;
  }): void;
}

// ---------------------------------------------------------------------------
// TaskStore
// ---------------------------------------------------------------------------

export interface TaskStore {
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
  ): IdempotentTaskCreateResult;

  listTasks(ownerId: string): readonly TaskRecord[];

  listRecoveryTasks(ownerId: string): readonly TaskRecord[];

  getTask(
    ownerId: string,
    taskId: string,
    includeDeleted?: boolean,
  ): TaskRecord | undefined;

  patchTask(
    ownerId: string,
    taskId: string,
    expectedRevision: number,
    patch: TaskPatch,
    now: string,
  ): ConditionalTaskResult;

  transitionTask(
    ownerId: string,
    taskId: string,
    expectedRevision: number,
    status: "open" | "completed",
    now: string,
  ): ConditionalTaskResult;

  softDeleteTask(
    ownerId: string,
    taskId: string,
    expectedRevision: number,
    now: string,
  ): ConditionalTaskResult;

  restoreTask(
    ownerId: string,
    taskId: string,
    expectedRevision: number,
    now: string,
  ): ConditionalTaskResult;

  searchTasks(
    ownerId: string,
    query: string,
    status?: "open" | "completed",
    projectId?: string,
    tagId?: string,
  ): readonly TaskRecord[];
}

// ---------------------------------------------------------------------------
// ProjectStore
// ---------------------------------------------------------------------------

export interface ProjectStore {
  createProject(record: ProjectRecord): void;
  listProjects(ownerId: string): readonly ProjectRecord[];
  getProject(ownerId: string, projectId: string): ProjectRecord | undefined;
  patchProject(
    ownerId: string,
    projectId: string,
    title: string,
    now: string,
  ): ProjectRecord | undefined;
  archiveProject(
    ownerId: string,
    projectId: string,
    now: string,
  ): ProjectRecord | undefined;
}

// ---------------------------------------------------------------------------
// TagStore
// ---------------------------------------------------------------------------

export interface TagStore {
  createTag(record: TagRecord): void;
  listTags(ownerId: string): readonly TagRecord[];
  getTag(ownerId: string, tagId: string): TagRecord | undefined;
  patchTag(
    ownerId: string,
    tagId: string,
    displayName: string,
    now: string,
  ): TagRecord | undefined;
  archiveTag(
    ownerId: string,
    tagId: string,
    now: string,
  ): TagRecord | undefined;
}

// ---------------------------------------------------------------------------
// SubtaskStore
// ---------------------------------------------------------------------------

export interface SubtaskStore {
  createSubtask(record: SubtaskRecord): void;
  listSubtasks(ownerId: string, taskId: string): readonly SubtaskRecord[];
  patchSubtask(
    ownerId: string,
    subtaskId: string,
    title: string,
    completed: boolean,
    now: string,
  ): SubtaskRecord | undefined;
  deleteSubtask(ownerId: string, subtaskId: string): boolean;
}

// ---------------------------------------------------------------------------
// CalendarProjectionStore
// ---------------------------------------------------------------------------

export interface CalendarProjectionStore {
  listProjectedEvents(
    ownerId: string,
    from: string,
    to: string,
  ): readonly CalendarEventProjectionRecord[];

  listOwnedCalendars(ownerId: string): readonly OwnedCalendarRecord[];

  upsertProjectionBatch(
    records: readonly Omit<
      CalendarEventProjectionRecord,
      "ownerId" | "providerKind" | "providerDisplayLabel" | "calendarName"
    >[],
  ): void;

  reserveCalendarWrite(input: {
    readonly ownerId: string;
    readonly taskId: string;
    readonly expectedTaskRevision: number;
    readonly idempotencyKey: string;
    readonly requestHash: string;
    readonly providerId: string;
    readonly calendarHref: string;
    readonly href: string;
    readonly uid: string;
    readonly now: string;
  }): CalendarWriteReservationResult;

  completeCalendarWrite(operationId: string): void;

  getCalendarWrite(
    ownerId: string,
    operationId: string,
  ): CalendarWriteOperationRecord | undefined;

  listTaskCalendarBlocks(
    ownerId: string,
    taskId: string,
  ): readonly TaskCalendarBlockRecord[];

  deleteTaskCalendarBlock(
    ownerId: string,
    blockId: string,
  ): void;

  listPublishedCalendarRaw(
    ownerId: string,
    calendarId: string,
  ): readonly string[];
}

// ---------------------------------------------------------------------------
// SyncStore
// ---------------------------------------------------------------------------

/** Field sync result for task-field / completion sync operations. */
export interface TaskFieldSyncResult {
  readonly kind: "applied" | "replayed" | "conflict" | "idempotency-conflict";
  readonly task?: TaskRecord;
  readonly fields?: readonly string[];
};

/** Task create sync result. */
export interface TaskCreateSyncResult {
  readonly kind: "applied" | "replayed" | "conflict" | "idempotency-conflict";
  readonly task?: TaskRecord;
};

/** Task deletion/restore sync result. */
export interface TaskDeletionSyncResult {
  readonly kind: "applied" | "replayed" | "conflict" | "idempotency-conflict";
  readonly task?: TaskRecord;
};

export interface SyncStore {
  registerSyncClient(
    input: SyncClientRecord,
  ): "registered" | "already-registered";

  authenticateSyncClient(
    ownerId: string,
    clientId: string,
    credentialHash: string,
    now: string,
  ): SyncClientRecord | undefined;

  listSyncClients(ownerId: string): readonly SyncClientRecord[];

  revokeSyncClient(
    ownerId: string,
    clientId: string,
    now: string,
  ): boolean;

  appendSyncChange(
    ownerId: string,
    entityType: string,
    entityId: string,
    kind: string,
    revision: number,
    now: string,
  ): SyncChangeRecord;

  listSyncChanges(
    ownerId: string,
    epoch: string,
    afterSequence: number,
  ): readonly SyncChangeRecord[];

  getSyncState(ownerId: string): {
    readonly epoch: string;
    readonly cursor: number;
  };

  pageSyncChanges(
    ownerId: string,
    epoch: string,
    afterSequence: number,
    limit?: number,
  ): {
    readonly resetRequired: boolean;
    readonly changes: readonly SyncChangeRecord[];
    readonly cursor: number;
  };

  getTaskFieldVersions(
    ownerId: string,
    taskId: string,
  ): Readonly<Record<string, number>>;

  fullSyncSnapshot(ownerId: string): {
    readonly tasks: readonly TaskRecord[];
    readonly projects: readonly ProjectRecord[];
    readonly tags: readonly TagRecord[];
    readonly subtasks: readonly SubtaskRecord[];
    readonly templates: readonly TaskTemplateRecord[];
    readonly templateBlueprints: readonly TemplateSubtaskBlueprintRecord[];
    readonly templateSets: readonly TemplateSetRecord[];
    readonly cursor: { readonly epoch: string; readonly cursor: number };
  };

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
  }): TaskFieldSyncResult;

  applyTaskCompletionSync(input: {
    readonly ownerId: string;
    readonly clientId: string;
    readonly operationId: string;
    readonly requestHash: string;
    readonly taskId: string;
    readonly baseStatusVersion: number;
    readonly completed: boolean;
    readonly now: string;
  }): TaskFieldSyncResult;

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
  }): TaskCreateSyncResult;

  applyTaskDeletionSync(input: {
    readonly ownerId: string;
    readonly clientId: string;
    readonly operationId: string;
    readonly requestHash: string;
    readonly taskId: string;
    readonly baseRevision: number;
    readonly restore: boolean;
    readonly now: string;
  }): TaskDeletionSyncResult;
}

// ---------------------------------------------------------------------------
// AutomationTokenStore
// ---------------------------------------------------------------------------

export interface AutomationTokenStore {
  createToken(record: AutomationTokenRecord): void;
  listTokens(ownerId: string): readonly AutomationTokenRecord[];
  getTokenByPrefix(prefix: string): AutomationTokenRecord | undefined;
  deleteToken(
    ownerId: string,
    tokenId: string,
    now: string,
  ): boolean;
}

// ---------------------------------------------------------------------------
// AutomationPreviewStore
// ---------------------------------------------------------------------------

export interface AutomationPreviewStore {
  insertPreview(record: AutomationPreviewRecord): void;
  getPreview(ownerId: string, previewId: string): AutomationPreviewRecord | undefined;
  consumePreview(
    ownerId: string,
    previewId: string,
    now: string,
  ): boolean;
}

// ---------------------------------------------------------------------------
// AutomationAuditStore
// ---------------------------------------------------------------------------

export interface AutomationAuditStore {
  insertOutcome(record: AutomationOutcomeRecord): void;
  insertAudit(record: AutomationAuditRecord): void;
  listAudit(ownerId: string): readonly AutomationAuditRecord[];
}

// ---------------------------------------------------------------------------
// TemplateStore
// ---------------------------------------------------------------------------

export interface TemplateStore {
  createTemplate(
    record: Omit<TaskTemplateRecord, "tagIds"> & {
      readonly tagIds: readonly string[];
      readonly blueprints: readonly Omit<
        TemplateSubtaskBlueprintRecord,
        "templateId"
      >[];
    },
  ): TaskTemplateRecord;

  listTemplates(
    ownerId: string,
  ): readonly TaskTemplateRecord[];

  getTemplate(
    ownerId: string,
    templateId: string,
    includeArchived?: boolean,
  ): TaskTemplateRecord | undefined;

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
  }): TaskTemplateRecord | undefined;

  archiveTemplate(
    ownerId: string,
    templateId: string,
    expectedRevision: number,
    now: string,
  ): TaskTemplateRecord | undefined;

  createTemplateFromTask(
    ownerId: string,
    taskId: string,
    templateRecord: Omit<TaskTemplateRecord, "tagIds"> & {
      readonly blueprints: readonly Omit<
        TemplateSubtaskBlueprintRecord,
        "templateId"
      >[];
    },
  ): TaskTemplateRecord | undefined;

  createTemplateSet(
    ownerId: string,
    setRecord: TemplateSetRecord,
    memberRecords: readonly TemplateSetMemberRecord[],
  ): void;

  listTemplateSets(
    ownerId: string,
    includeArchived?: boolean,
  ): readonly TemplateSetRecord[];

  getTemplateSet(
    ownerId: string,
    setId: string,
  ): TemplateSetRecord | undefined;

  instantiateTemplateIdempotently(
    ownerId: string,
    sourceKind: "template" | "set",
    sourceId: string,
    destinationProjectId: string,
    idempotencyKey: string,
    requestHash: string,
    now: string,
  ): TemplateInstantiationResult;
}

// ---------------------------------------------------------------------------
// ChoicePoolStore
// ---------------------------------------------------------------------------

export interface ChoicePoolStore {
  createChoicePool(
    record: ChoicePoolRecord,
  ): ChoicePoolRecord;

  listChoicePools(
    ownerId: string,
    includeArchived?: boolean,
  ): readonly ChoicePoolRecord[];

  getChoicePool(
    ownerId: string,
    poolId: string,
    includeArchived?: boolean,
  ): ChoicePoolRecord | undefined;

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
  ): ChoicePoolRecord | undefined;

  createChoicePoolItem(
    record: ChoicePoolItemRecord,
  ): void;

  listChoicePoolItems(
    poolId: string,
    includeArchived?: boolean,
  ): readonly ChoicePoolItemRecord[];

  recordChoicePoolCompletion(
    ownerId: string,
    poolId: string,
    itemId: string,
    now: string,
  ): ChoicePoolHistoryRecord | undefined;

  getChoicePoolHistory(
    poolId: string,
  ): readonly ChoicePoolHistoryRecord[];

  createPlanningPlaceholder(
    record: PlanningPlaceholderRecord,
  ): PlanningPlaceholderRecord | undefined;

  listPlanningPlaceholders(
    ownerId: string,
  ): readonly PlanningPlaceholderRecord[];

  getPlanningPlaceholder(
    ownerId: string,
    placeholderId: string,
  ): PlanningPlaceholderRecord | undefined;

  resolvePlanningPlaceholderIdempotently(options: {
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
  }): PlanningPlaceholderResolutionResult;

  createTemplatePoolSlot(
    record: TemplatePoolSlotRecord,
  ): TemplatePoolSlotRecord | undefined;

  listTemplatePoolSlots(
    templateId: string,
  ): readonly TemplatePoolSlotRecord[];
}

// ---------------------------------------------------------------------------
// CalendarImportStore
// ---------------------------------------------------------------------------

export interface CalendarImportStore {
  createImportJob(input: {
    readonly id: string;
    readonly ownerId: string;
    readonly calendarId: string;
    readonly source: "ics" | "google_ics";
    readonly inputHash: string;
    readonly report: unknown;
    readonly candidates: readonly {
      externalId: string;
      uid: string;
      rawIcs: string;
      href: string;
    }[];
    readonly createdAt: string;
  }): { readonly job: CalendarImportJobRecord; readonly replayed: boolean } | undefined;

  getImportJob(
    ownerId: string,
    jobId: string,
  ): CalendarImportJobRecord | undefined;

  createImportItem(
    record: CalendarImportItemRecord,
  ): void;

  listImportItems(
    jobId: string,
  ): readonly CalendarImportItemRecord[];

  applyImportItem(
    ownerId: string,
    itemId: string,
    href: string,
    now: string,
  ): void;
}

// ---------------------------------------------------------------------------
// CalendarFeedStore
// ---------------------------------------------------------------------------

export interface CalendarFeedStore {
  createFeedCapability(record: CalendarFeedCapabilityRecord): void;
  getCalendarFeedCapability(
    feedId: string,
  ): CalendarFeedCapabilityRecord | undefined;
  listCalendarFeeds(
    ownerId: string,
  ): readonly CalendarFeedCapabilityRecord[];
  revokeCalendarFeed(
    ownerId: string,
    feedId: string,
    now: string,
  ): boolean;
}

// ---------------------------------------------------------------------------
// ServerStores
// ---------------------------------------------------------------------------

export interface ServerStores {
  readonly metadata: MetadataStore;
  readonly owners: OwnerStore;
  readonly sessions: SessionStore;
  readonly credentials: CredentialStore;
  readonly planningPreferences: PlanningPreferencesStore;
  readonly notificationPreferences: NotificationPreferencesStore;
  readonly notificationDeliveries: NotificationDeliveryStore;
  readonly tasks: TaskStore;
  readonly projects: ProjectStore;
  readonly tags: TagStore;
  readonly subtasks: SubtaskStore;
  readonly calendarProjections: CalendarProjectionStore;
  readonly sync: SyncStore;
  readonly automationTokens: AutomationTokenStore;
  readonly automationPreviews: AutomationPreviewStore;
  readonly automationAudit: AutomationAuditStore;
  readonly templates: TemplateStore;
  readonly choicePools: ChoicePoolStore;
  readonly calendarImports: CalendarImportStore;
  readonly calendarFeeds: CalendarFeedStore;
}
