import {
  planningPreferencesSchema,
  notificationPreferencesSchema,
  checklistCommandSchema,
  organizationIconPattern,
  type ChecklistCommand,
} from "@suite/contracts";
import { StructuredCaptureError } from "@suite/domain";
import { SqliteHabitStore } from "./habit-store.ts";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SqliteCalendarProjectionStore } from "./calendar-projection-store.js";
import { SqliteCredentialStore } from "./credential-store.js";
import { SqlitePlanningPreferencesStore } from "./planning-preferences-store.js";
import { SqliteNoteStore } from "./note-store.ts";
export type { NoteMutationResult, NoteRecord } from "./note-store.ts";

interface Migration {
  readonly id: string;
  readonly sql: string;
}

interface MigrationRow {
  readonly id: string;
  readonly checksum: string;
}

interface InstallRow {
  readonly instance_id: string;
  readonly created_at: string;
}

export interface TaskDeadline {
  readonly kind: "date" | "instant";
  readonly value: string;
}

const deadlineColumns = (deadline: TaskDeadline | null) => ({
  deadlineDate: deadline?.kind === "date" ? deadline.value : null,
  deadlineAt: deadline?.kind === "instant" ? deadline.value : null,
});

interface TaskRow {
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
  readonly deadline_date: string | null;
  readonly deadline_at: string | null;
}

export interface InstallMetadata {
  readonly instanceId: string;
  readonly createdAt: string;
}

export interface DatabaseState {
  readonly install: InstallMetadata;
  readonly appliedMigrationCount: number;
  readonly expectedMigrationCount: number;
}

export interface OwnerRecord {
  readonly id: string;
  readonly username: string;
  readonly displayName: string;
  readonly passwordHash: string;
  readonly createdAt: string;
}

export interface SessionRecord {
  readonly tokenHash: string;
  readonly ownerId: string;
  readonly csrfHash: string;
  readonly idleExpiresAt: string;
  readonly absoluteExpiresAt: string;
  readonly revokedAt: string | null;
}

export interface BaikalConnectorRecord {
  readonly id: string;
  readonly ownerId: string;
  readonly endpoint: string;
  readonly username: string;
  readonly credentialKeyId: string;
  readonly credentialNonce: Uint8Array;
  readonly credentialCiphertext: Uint8Array;
  readonly credentialTag: Uint8Array;
  readonly verifiedAt: string;
}

export interface CalendarProviderRecord {
  readonly id: string;
  readonly ownerId: string;
  readonly kind: "baikal" | "caldav" | "google";
  readonly connectorId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CalendarCollectionRecord {
  readonly id: string;
  readonly providerId: string;
  readonly href: string;
  readonly displayName: string;
  readonly supportsEvents: boolean;
  readonly supportsTodos: boolean;
}

export interface TaskRecord {
  readonly id: string;
  readonly ownerId: string;
  readonly title: string;
  readonly notes: string;
  readonly status: "open" | "completed";
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
  readonly deletedAt: string | null;
  readonly plannedStart: string | null;
  readonly estimateMinutes: number | null;
  readonly deadlineDate?: string | null;
  readonly deadlineAt?: string | null;
  readonly projectId?: string | null;
  readonly tagIds?: readonly string[];
}

export interface TaskPatch {
  readonly title?: string;
  readonly notes?: string;
  readonly plannedStart?: string | null;
  readonly estimateMinutes?: number | null;
  readonly deadlineDate?: string | null;
  readonly deadlineAt?: string | null;
}

export interface HabitRecord {
  readonly id: string;
  readonly ownerId: string;
  readonly title: string;
  readonly cadence: unknown;
  readonly startedOn: string;
  readonly timeZone: string;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
}

export interface HabitOccurrenceRecord {
  readonly id: string;
  readonly habitId: string;
  readonly periodKey: string;
  readonly completedAt: string;
  readonly createdAt: string;
}

export type ConditionalTaskResult =
  | { readonly kind: "updated"; readonly task: TaskRecord }
  | { readonly kind: "not-found" }
  | { readonly kind: "precondition-failed"; readonly task: TaskRecord };

export interface CalendarEventProjectionRecord {
  readonly id: string;
  readonly ownerId: string;
  readonly providerId: string;
  readonly calendarId: string;
  readonly href: string;
  readonly uid: string;
  readonly etag: string;
  readonly rawIcs: string;
  readonly summary: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly allDay: boolean;
  readonly recurrence?: "none" | "instance";
  readonly freshness: "current" | "stale" | "unavailable" | "unsupported";
  readonly mutable: boolean;
  readonly revision: number;
  readonly projectedAt: string;
  readonly providerKind?: CalendarProviderRecord["kind"];
  readonly providerDisplayLabel?: string;
  readonly calendarName?: string;
}

export interface TaskCalendarBlockRecord {
  readonly id: string;
  readonly ownerId: string;
  readonly taskId: string;
  readonly providerId: string;
  readonly calendarId: string;
  readonly eventHref: string;
  readonly eventUid: string;
  readonly remoteEtag: string;
  readonly state: "active" | "conflict" | "needs_reconciliation";
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ActiveTaskCalendarEventLink {
  readonly providerId: string;
  readonly calendarId: string;
  readonly eventHref: string;
  readonly taskId: string;
}

export interface CalendarWriteOperationRecord {
  readonly ownerId: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly taskId: string;
  readonly providerId: string;
  readonly calendarId: string;
  readonly reservedHref: string;
  readonly reservedUid: string;
  readonly state: "pending_remote" | "completed" | "needs_reconciliation";
  readonly blockId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface OwnedCalendarRecord extends CalendarCollectionRecord {
  readonly ownerId: string;
  readonly kind: CalendarProviderRecord["kind"];
  readonly connectorId: string;
}

export type CalendarWriteReservationResult =
  | {
      readonly kind: "reserved";
      readonly operation: CalendarWriteOperationRecord;
    }
  | {
      readonly kind: "replayed";
      readonly operation: CalendarWriteOperationRecord;
    }
  | { readonly kind: "conflict" }
  | { readonly kind: "task-not-found" }
  | { readonly kind: "task-precondition-failed"; readonly task: TaskRecord }
  | { readonly kind: "calendar-not-found" };

export type IdempotentTaskCreateResult =
  | { readonly kind: "created"; readonly task: TaskRecord }
  | { readonly kind: "replayed"; readonly task: TaskRecord }
  | { readonly kind: "conflict" };

export interface SyncClientRecord {
  readonly id: string;
  readonly ownerId: string;
  readonly label: string;
  readonly credentialHash: string;
  readonly createdAt: string;
  readonly lastSeenAt: string;
  readonly revokedAt: string | null;
}

export interface AutomationTokenRecord {
  readonly id: string;
  readonly ownerId: string;
  readonly label: string;
  readonly secretHash: string;
  readonly scopes: readonly string[];
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
  readonly expiresAt: string | null;
  readonly revokedAt: string | null;
}

export interface AutomationPreviewRecord {
  readonly id: string;
  readonly ownerId: string;
  readonly tokenId: string;
  readonly operation: string;
  readonly inputHash: string;
  readonly input: unknown;
  readonly summary: string;
  readonly affectedIds: readonly string[];
  readonly baseRevisions: Readonly<Record<string, number>>;
  readonly expiresAt: string;
  readonly consumedAt: string | null;
  readonly createdAt: string;
}

export interface AutomationOutcomeRecord {
  readonly ownerId: string;
  readonly tokenId: string;
  readonly operation: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly previewId: string;
  readonly response: unknown;
  readonly createdAt: string;
}

export interface AutomationAuditRecord {
  readonly id: string;
  readonly ownerId: string;
  readonly tokenId: string;
  readonly operation: string;
  readonly phase: "resource_read" | "preview" | "confirm" | "execute";
  readonly outcome: "succeeded" | "replayed" | "denied" | "failed";
  readonly errorCode: string | null;
  readonly previewId: string | null;
  readonly affectedIds: readonly string[];
  readonly requestHash: string | null;
  readonly createdAt: string;
}

interface OrganizationRecordBase {
  readonly id: string;
  readonly ownerId: string;
  readonly title: string;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
  readonly color: string | null;
  readonly icon: string | null;
  readonly position: number;
}
export interface ProjectRecord extends OrganizationRecordBase {
  readonly hiddenFromMenu: boolean;
  /** Completion archives the project; reopen and restore clear both. */
  readonly completedAt: string | null;
  readonly backlogEnabled: boolean;
  /** Active, non-deleted tasks of this project held in its backlog, in order. */
  readonly backlogTaskIds: readonly string[];
}
export interface TagRecord extends OrganizationRecordBase {
  readonly normalizedName: string;
}
type OptionalOrganizationFields = "color" | "icon" | "position";
type OptionalProjectFields =
  | OptionalOrganizationFields
  | "hiddenFromMenu"
  | "completedAt"
  | "backlogEnabled"
  | "backlogTaskIds";
export type ProjectCreateRecord = Omit<ProjectRecord, OptionalProjectFields> &
  Partial<Omit<Pick<ProjectRecord, OptionalProjectFields>, "backlogTaskIds">>;
export type TagCreateRecord = Omit<TagRecord, OptionalOrganizationFields> &
  Partial<Pick<TagRecord, OptionalOrganizationFields>>;
/** Editable organization fields shared by browser and assistant writes. */
export interface OrganizationFields {
  readonly title?: string | undefined;
  readonly archived?: boolean | undefined;
  readonly completed?: boolean | undefined;
  readonly color?: string | null | undefined;
  readonly icon?: string | null | undefined;
  readonly hiddenFromMenu?: boolean | undefined;
  readonly backlogEnabled?: boolean | undefined;
}
const colorPattern = /^#[0-9a-f]{6}$/;
export interface SubtaskRecord {
  readonly id: string;
  readonly ownerId: string;
  readonly taskId: string;
  readonly title: string;
  readonly completed: boolean;
  readonly position: number;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}
export interface TaskTemplateRecord {
  readonly id: string;
  readonly ownerId: string;
  readonly title: string;
  readonly notes: string;
  readonly estimateMinutes: number | null;
  readonly suggestedProjectId: string | null;
  readonly tagIds: readonly string[];
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
}
export interface TemplateSubtaskBlueprintRecord {
  readonly id: string;
  readonly templateId: string;
  readonly title: string;
  readonly position: number;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}
export interface TemplatePoolSlotRecord {
  readonly id: string;
  readonly templateId: string;
  readonly poolId: string;
  readonly pickCount: number;
  readonly position: number;
  readonly createdAt: string;
}
export interface TemplateSetRecord {
  readonly id: string;
  readonly ownerId: string;
  readonly title: string;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
}
export interface TemplateSetMemberRecord {
  readonly setId: string;
  readonly templateId: string;
  readonly position: number;
}
export interface TaskTemplateProvenanceRecord {
  readonly taskId: string;
  readonly templateId: string;
  readonly templateRevision: number;
  readonly instantiationId: string;
  readonly instantiatedAt: string;
}
export interface TemplateInstantiationResult {
  readonly kind:
    "created" | "replayed" | "conflict" | "not-found" | "project-not-found";
  readonly instantiationId?: string;
  readonly tasks?: readonly {
    readonly task: TaskRecord;
    readonly subtasks: readonly SubtaskRecord[];
    readonly provenance: TaskTemplateProvenanceRecord;
  }[];
}
export interface ChoicePoolRecord {
  readonly id: string;
  readonly ownerId: string;
  readonly title: string;
  readonly policy: "none" | "cooldown" | "cycle" | "one_shot";
  readonly pickCount: number;
  readonly cooldownSeconds: number | null;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
}
export interface ChoicePoolItemRecord {
  readonly id: string;
  readonly poolId: string;
  readonly title: string;
  readonly position: number;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
}
export interface ChoicePoolHistoryRecord {
  readonly id: string;
  readonly poolId: string;
  readonly itemId: string;
  readonly placeholderId: string | null;
  readonly kind: "selected" | "completed";
  readonly cycle: number;
  readonly overridden: boolean;
  readonly occurredAt: string;
}
export interface PlanningPlaceholderRecord {
  readonly id: string;
  readonly ownerId: string;
  readonly taskId: string;
  readonly poolId: string;
  readonly pickCount: number;
  readonly position: number;
  readonly state: "unresolved" | "resolved";
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly resolvedAt: string | null;
}
export interface PlanningPlaceholderResolutionRecord {
  readonly id: string;
  readonly placeholderId: string;
  readonly selectedItemIds: readonly string[];
  readonly subtaskIds: readonly string[];
  readonly historyIds: readonly string[];
  readonly logicalTime: string;
  readonly overridden: boolean;
  readonly createdAt: string;
}
export interface PlanningPlaceholderResolutionResult {
  readonly kind: "created" | "replayed" | "conflict" | "stale" | "not-found";
  readonly placeholder?: PlanningPlaceholderRecord;
  readonly resolution?: PlanningPlaceholderResolutionRecord;
  readonly subtasks?: readonly SubtaskRecord[];
  readonly history?: readonly ChoicePoolHistoryRecord[];
}
export interface CalendarImportItemRecord {
  readonly externalId: string;
  readonly uid: string;
  readonly rawIcs: string;
  readonly href: string;
  readonly state: "pending" | "applied" | "reconciliation_required" | "skipped";
  readonly appliedAt: string | null;
}
export interface CalendarImportJobRecord {
  readonly id: string;
  readonly ownerId: string;
  readonly calendarId: string;
  readonly source: "ics" | "google_ics";
  readonly inputHash: string;
  readonly report: unknown;
  readonly state: "previewed" | "applied" | "partial";
  readonly createdAt: string;
  readonly appliedAt: string | null;
  readonly items: readonly CalendarImportItemRecord[];
}
export interface CalendarFeedCapabilityRecord {
  readonly id: string;
  readonly ownerId: string;
  readonly calendarId: string;
  readonly label: string;
  readonly secretHash: string;
  readonly createdAt: string;
  readonly revokedAt: string | null;
}
export interface GoogleConnectorRecord {
  readonly id: string;
  readonly ownerId: string;
  readonly credentialKeyId: string;
  readonly credentialNonce: Uint8Array;
  readonly credentialCiphertext: Uint8Array;
  readonly credentialTag: Uint8Array;
  readonly grantedScopes: readonly string[];
  readonly accountLabel: string | null;
  readonly state: "connected" | "reconnect_required" | "stale";
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly revokedAt: string | null;
}
export interface GoogleCalendarSyncRecord {
  readonly calendarId: string;
  readonly ownerId: string;
  readonly externalCalendarId: string;
  readonly syncToken: string | null;
  readonly state: "fresh" | "stale" | "unavailable";
  readonly lastSuccessfulSyncAt: string | null;
  readonly lastAttemptAt: string | null;
  readonly errorCode: string | null;
}
export interface PlanningPreferencesRecord {
  readonly workingDays: readonly number[];
  readonly workdayStart: string;
  readonly workdayEnd: string;
  readonly breakStart: string | null;
  readonly breakEnd: string | null;
  readonly timeZone: string;
}
export interface NotificationPreferencesRecord {
  readonly enabled: boolean;
  readonly leadReminderEnabled: boolean;
  readonly atStartReminderEnabled: boolean;
  readonly detailedContentEnabled: boolean;
}
export interface NotificationDeliveryRecord {
  readonly id: string;
  readonly ownerId: string;
  readonly taskId: string | null;
  readonly occurrenceStart: string;
  readonly kind: "lead" | "at_start" | "test";
  readonly taskRevision: number | null;
  readonly state:
    | "pending"
    | "sending"
    | "retry"
    | "delivered"
    | "suppressed"
    | "cancelled"
    | "failed";
  readonly dueAt: string;
  readonly nextAttemptAt: string;
  readonly attemptCount: number;
  readonly errorCode: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deliveredAt: string | null;
}
export interface SyncChangeRecord {
  readonly ownerId: string;
  readonly epoch: string;
  readonly sequence: number;
  readonly entityType: string;
  readonly entityId: string;
  readonly kind: string;
  readonly revision: number;
  readonly createdAt: string;
}
export interface ActiveSessionRecord {
  readonly id: string;
  readonly ownerId: string;
  readonly taskId: string;
  readonly controllerClientId: string | null;
  readonly state: "running" | "paused" | "completed" | "expired";
  readonly phase: "focus" | "break";
  readonly revision: number;
  readonly startedAt: string;
  readonly leaseExpiresAt: string | null;
  readonly hardExpiresAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly endedAt: string | null;
}

export interface ActiveSessionIntervalRecord {
  readonly id: string;
  readonly ordinal: number;
  readonly phase: "focus" | "break";
  readonly taskId: string | null;
  readonly controllerClientId: string;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly closedBy: string | null;
}

export interface ActiveSessionEventRecord {
  readonly kind: string;
  readonly revision: number;
  readonly actorClientId: string | null;
  readonly createdAt: string;
}

export interface ActiveSessionPersistenceSnapshot {
  readonly session: ActiveSessionRecord;
  readonly intervals: readonly ActiveSessionIntervalRecord[];
  readonly events: readonly ActiveSessionEventRecord[];
}

const migrations: readonly Migration[] = [
  {
    id: "0001_install_metadata",
    sql: `
      CREATE TABLE install_metadata (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        instance_id TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      ) STRICT;
    `,
  },
  {
    id: "0002_owner_accounts",
    sql: `
      CREATE TABLE owner_accounts (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        display_name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        disabled_at TEXT
      ) STRICT;

      CREATE UNIQUE INDEX one_active_owner
        ON owner_accounts ((1)) WHERE disabled_at IS NULL;
    `,
  },
  {
    id: "0003_web_sessions",
    sql: `
      CREATE TABLE web_sessions (
        token_hash TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL REFERENCES owner_accounts(id) ON DELETE CASCADE,
        csrf_hash TEXT NOT NULL,
        issued_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        idle_expires_at TEXT NOT NULL,
        absolute_expires_at TEXT NOT NULL,
        revoked_at TEXT
      ) STRICT;

      CREATE INDEX web_sessions_by_owner ON web_sessions(owner_id);
      CREATE INDEX web_sessions_by_expiry ON web_sessions(absolute_expires_at);
    `,
  },
  {
    id: "0004_baikal_connectors",
    sql: `
      CREATE TABLE baikal_connectors (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL UNIQUE REFERENCES owner_accounts(id) ON DELETE CASCADE,
        endpoint TEXT NOT NULL,
        username TEXT NOT NULL,
        credential_key_id TEXT NOT NULL,
        credential_nonce BLOB NOT NULL,
        credential_ciphertext BLOB NOT NULL,
        credential_tag BLOB NOT NULL,
        verified_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
    `,
  },
  {
    id: "0005_phase_0c_identities_and_tasks",
    sql: `
      CREATE TABLE calendar_providers (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL REFERENCES owner_accounts(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('baikal', 'caldav', 'google')),
        connector_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (owner_id, kind, connector_id)
      ) STRICT;

      CREATE TABLE calendar_collections (
        id TEXT PRIMARY KEY,
        provider_id TEXT NOT NULL REFERENCES calendar_providers(id) ON DELETE CASCADE,
        href TEXT NOT NULL,
        display_name TEXT NOT NULL,
        supports_events INTEGER NOT NULL CHECK (supports_events IN (0, 1)),
        supports_todos INTEGER NOT NULL CHECK (supports_todos IN (0, 1)),
        last_discovered_at TEXT NOT NULL,
        UNIQUE (provider_id, href)
      ) STRICT;

      CREATE TABLE client_identities (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL REFERENCES owner_accounts(id) ON DELETE CASCADE,
        label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 100),
        created_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        revoked_at TEXT
      ) STRICT;

      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL REFERENCES owner_accounts(id) ON DELETE CASCADE,
        title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 240),
        notes TEXT NOT NULL CHECK (length(notes) <= 20000),
        status TEXT NOT NULL CHECK (status IN ('open', 'completed')),
        revision INTEGER NOT NULL CHECK (revision > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      ) STRICT;

      CREATE INDEX tasks_by_owner_updated
        ON tasks(owner_id, updated_at DESC) WHERE deleted_at IS NULL;

      CREATE TABLE idempotency_records (
        owner_id TEXT NOT NULL REFERENCES owner_accounts(id) ON DELETE CASCADE,
        operation TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (owner_id, operation, idempotency_key)
      ) STRICT;
    `,
  },
  {
    id: "0006_phase_1_planning",
    sql: `
      ALTER TABLE tasks ADD COLUMN planned_start TEXT;
      ALTER TABLE tasks ADD COLUMN estimate_minutes INTEGER
        CHECK (estimate_minutes IS NULL OR estimate_minutes BETWEEN 1 AND 1440);
      ALTER TABLE tasks ADD COLUMN completed_at TEXT;

      CREATE TABLE calendar_event_projections (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL REFERENCES owner_accounts(id) ON DELETE CASCADE,
        provider_id TEXT NOT NULL REFERENCES calendar_providers(id) ON DELETE CASCADE,
        calendar_id TEXT NOT NULL REFERENCES calendar_collections(id) ON DELETE CASCADE,
        href TEXT NOT NULL,
        uid TEXT NOT NULL,
        etag TEXT NOT NULL,
        raw_ics TEXT NOT NULL,
        summary TEXT NOT NULL,
        starts_at TEXT NOT NULL,
        ends_at TEXT NOT NULL,
        all_day INTEGER NOT NULL CHECK (all_day IN (0, 1)),
        freshness TEXT NOT NULL
          CHECK (freshness IN ('current', 'stale', 'unavailable', 'unsupported')),
        mutable INTEGER NOT NULL CHECK (mutable IN (0, 1)),
        revision INTEGER NOT NULL CHECK (revision > 0),
        projected_at TEXT NOT NULL,
        UNIQUE (calendar_id, href)
      ) STRICT;

      CREATE INDEX calendar_events_by_owner_time
        ON calendar_event_projections(owner_id, starts_at, ends_at);

      CREATE TABLE task_calendar_blocks (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL REFERENCES owner_accounts(id) ON DELETE CASCADE,
        task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE CASCADE,
        provider_id TEXT NOT NULL REFERENCES calendar_providers(id) ON DELETE CASCADE,
        calendar_id TEXT NOT NULL REFERENCES calendar_collections(id) ON DELETE CASCADE,
        event_href TEXT NOT NULL,
        event_uid TEXT NOT NULL,
        remote_etag TEXT NOT NULL,
        state TEXT NOT NULL
          CHECK (state IN ('active', 'conflict', 'needs_reconciliation')),
        revision INTEGER NOT NULL CHECK (revision > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (calendar_id, event_href)
      ) STRICT;

      CREATE TABLE calendar_write_operations (
        owner_id TEXT NOT NULL REFERENCES owner_accounts(id) ON DELETE CASCADE,
        idempotency_key TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        provider_id TEXT NOT NULL REFERENCES calendar_providers(id) ON DELETE CASCADE,
        calendar_id TEXT NOT NULL REFERENCES calendar_collections(id) ON DELETE CASCADE,
        reserved_href TEXT NOT NULL,
        reserved_uid TEXT NOT NULL,
        state TEXT NOT NULL
          CHECK (state IN ('pending_remote', 'completed', 'needs_reconciliation')),
        block_id TEXT REFERENCES task_calendar_blocks(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (owner_id, idempotency_key)
      ) STRICT;
    `,
  },
  {
    id: "0007_phase_2_local_sync_and_sessions",
    sql: `
      ALTER TABLE client_identities ADD COLUMN credential_hash TEXT;
      CREATE UNIQUE INDEX client_credentials_unique ON client_identities(credential_hash)
        WHERE credential_hash IS NOT NULL;

      CREATE TABLE sync_owner_state (
        owner_id TEXT PRIMARY KEY REFERENCES owner_accounts(id) ON DELETE CASCADE,
        epoch TEXT NOT NULL, next_sequence INTEGER NOT NULL CHECK (next_sequence > 0),
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE sync_changes (
        owner_id TEXT NOT NULL REFERENCES owner_accounts(id) ON DELETE CASCADE,
        epoch TEXT NOT NULL, sequence INTEGER NOT NULL CHECK (sequence > 0),
        entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, kind TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision > 0), created_at TEXT NOT NULL,
        PRIMARY KEY(owner_id, epoch, sequence)
      ) STRICT;
      CREATE TABLE sync_operation_outcomes (
        owner_id TEXT NOT NULL REFERENCES owner_accounts(id) ON DELETE CASCADE,
        client_id TEXT NOT NULL REFERENCES client_identities(id) ON DELETE CASCADE,
        operation_id TEXT NOT NULL, request_hash TEXT NOT NULL, state TEXT NOT NULL
          CHECK(state IN ('applied','replayed','conflict','invalid')),
        entity_id TEXT, revision INTEGER, conflict_fields TEXT, created_at TEXT NOT NULL,
        PRIMARY KEY(owner_id, client_id, operation_id)
      ) STRICT;
      CREATE TABLE task_field_versions (
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        field TEXT NOT NULL CHECK(field IN ('title','notes','status','estimateMinutes','projectId','tagIds')),
        version INTEGER NOT NULL CHECK(version > 0), PRIMARY KEY(task_id, field)
      ) STRICT;
      INSERT INTO task_field_versions (task_id, field, version)
        SELECT id, 'title', revision FROM tasks;
      INSERT INTO task_field_versions (task_id, field, version)
        SELECT id, 'notes', revision FROM tasks;
      INSERT INTO task_field_versions (task_id, field, version)
        SELECT id, 'status', revision FROM tasks;
      INSERT INTO task_field_versions (task_id, field, version)
        SELECT id, 'estimateMinutes', revision FROM tasks;
      INSERT INTO task_field_versions (task_id, field, version)
        SELECT id, 'projectId', revision FROM tasks;
      INSERT INTO task_field_versions (task_id, field, version)
        SELECT id, 'tagIds', revision FROM tasks;

      CREATE TABLE projects (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES owner_accounts(id) ON DELETE CASCADE,
        title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 240), revision INTEGER NOT NULL CHECK(revision > 0),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived_at TEXT
      ) STRICT;
      CREATE TABLE tags (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES owner_accounts(id) ON DELETE CASCADE,
        display_name TEXT NOT NULL CHECK(length(display_name) BETWEEN 1 AND 100), normalized_name TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK(revision > 0), created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived_at TEXT,
        UNIQUE(owner_id, normalized_name)
      ) STRICT;
      ALTER TABLE tasks ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE SET NULL;
      CREATE TABLE task_tags (
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE RESTRICT, PRIMARY KEY(task_id, tag_id)
      ) STRICT;
      CREATE TABLE subtasks (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES owner_accounts(id) ON DELETE CASCADE,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 240), completed INTEGER NOT NULL CHECK(completed IN (0,1)),
        position INTEGER NOT NULL, revision INTEGER NOT NULL CHECK(revision > 0), created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX subtasks_by_task ON subtasks(owner_id, task_id, position, id);

      CREATE TABLE active_sessions (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES owner_accounts(id) ON DELETE CASCADE,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
        controller_client_id TEXT REFERENCES client_identities(id) ON DELETE RESTRICT,
        state TEXT NOT NULL CHECK(state IN ('running','paused','completed','expired')),
        phase TEXT NOT NULL CHECK(phase IN ('focus','break')),
        revision INTEGER NOT NULL CHECK(revision > 0), started_at TEXT NOT NULL,
        lease_expires_at TEXT, hard_expires_at TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, ended_at TEXT
      ) STRICT;
      CREATE UNIQUE INDEX one_nonterminal_active_session ON active_sessions(owner_id)
        WHERE ended_at IS NULL;
      CREATE TABLE active_session_intervals (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES active_sessions(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL CHECK(ordinal > 0), phase TEXT NOT NULL CHECK(phase IN ('focus','break')),
        task_id TEXT, controller_client_id TEXT NOT NULL REFERENCES client_identities(id) ON DELETE RESTRICT,
        started_at TEXT NOT NULL, ended_at TEXT, closed_by TEXT, UNIQUE(session_id, ordinal)
      ) STRICT;
      CREATE UNIQUE INDEX one_open_session_interval ON active_session_intervals(session_id) WHERE ended_at IS NULL;
      CREATE TABLE active_session_events (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES active_sessions(id) ON DELETE CASCADE,
        kind TEXT NOT NULL, revision INTEGER NOT NULL, actor_client_id TEXT,
        created_at TEXT NOT NULL, UNIQUE(session_id, revision)
      ) STRICT;
      CREATE TABLE active_session_operation_outcomes (
        owner_id TEXT NOT NULL REFERENCES owner_accounts(id) ON DELETE CASCADE,
        client_id TEXT NOT NULL REFERENCES client_identities(id) ON DELETE CASCADE,
        idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL, session_id TEXT NOT NULL,
        revision INTEGER NOT NULL, response_json TEXT NOT NULL, created_at TEXT NOT NULL,
        PRIMARY KEY(owner_id, client_id, idempotency_key)
      ) STRICT;
    `,
  },
  {
    id: "0008_phase_4_automation",
    sql: `
      CREATE TABLE automation_tokens (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES owner_accounts(id) ON DELETE CASCADE,
        label TEXT NOT NULL CHECK(length(label) BETWEEN 1 AND 100), secret_hash TEXT NOT NULL UNIQUE,
        scopes_json TEXT NOT NULL, created_at TEXT NOT NULL, last_used_at TEXT,
        expires_at TEXT, revoked_at TEXT
      ) STRICT;
      CREATE INDEX automation_tokens_by_owner ON automation_tokens(owner_id, created_at, id);
      CREATE TABLE automation_previews (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES owner_accounts(id) ON DELETE CASCADE,
        token_id TEXT NOT NULL REFERENCES automation_tokens(id) ON DELETE RESTRICT,
        operation TEXT NOT NULL, input_hash TEXT NOT NULL, input_json TEXT NOT NULL,
        summary TEXT NOT NULL, affected_ids_json TEXT NOT NULL, base_revisions_json TEXT NOT NULL,
        expires_at TEXT NOT NULL, consumed_at TEXT, created_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE automation_operation_outcomes (
        owner_id TEXT NOT NULL REFERENCES owner_accounts(id) ON DELETE CASCADE,
        token_id TEXT NOT NULL REFERENCES automation_tokens(id) ON DELETE RESTRICT,
        operation TEXT NOT NULL, idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL,
        preview_id TEXT NOT NULL REFERENCES automation_previews(id) ON DELETE RESTRICT,
        response_json TEXT NOT NULL, created_at TEXT NOT NULL,
        PRIMARY KEY(owner_id, token_id, operation, idempotency_key)
      ) STRICT;
      CREATE TABLE automation_audit_log (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES owner_accounts(id) ON DELETE CASCADE,
        token_id TEXT NOT NULL REFERENCES automation_tokens(id) ON DELETE RESTRICT,
        operation TEXT NOT NULL, phase TEXT NOT NULL
          CHECK(phase IN ('resource_read','preview','confirm','execute')),
        outcome TEXT NOT NULL CHECK(outcome IN ('succeeded','replayed','denied','failed')),
        error_code TEXT, preview_id TEXT, affected_ids_json TEXT NOT NULL,
        request_hash TEXT, created_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX automation_audit_by_owner ON automation_audit_log(owner_id, created_at, id);
    `,
  },
  {
    id: "0009_phase_5_reusable_work",
    sql: `
      CREATE TABLE task_templates (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES owner_accounts(id) ON DELETE CASCADE,
        title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 240), notes TEXT NOT NULL CHECK(length(notes) <= 20000),
        estimate_minutes INTEGER CHECK(estimate_minutes IS NULL OR estimate_minutes BETWEEN 1 AND 720),
        suggested_project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
        revision INTEGER NOT NULL CHECK(revision > 0), created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived_at TEXT
      ) STRICT;
      CREATE INDEX task_templates_by_owner ON task_templates(owner_id, archived_at, title COLLATE NOCASE, id);
      CREATE TABLE task_template_tags (
        template_id TEXT NOT NULL REFERENCES task_templates(id) ON DELETE CASCADE,
        tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE RESTRICT, PRIMARY KEY(template_id, tag_id)
      ) STRICT;
      CREATE TABLE template_subtask_blueprints (
        id TEXT PRIMARY KEY, template_id TEXT NOT NULL REFERENCES task_templates(id) ON DELETE CASCADE,
        title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 240), position INTEGER NOT NULL CHECK(position >= 0),
        revision INTEGER NOT NULL CHECK(revision > 0), created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX template_blueprints_by_template ON template_subtask_blueprints(template_id, position, id);
      CREATE TABLE template_sets (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES owner_accounts(id) ON DELETE CASCADE,
        title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 240), revision INTEGER NOT NULL CHECK(revision > 0),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived_at TEXT
      ) STRICT;
      CREATE TABLE template_set_members (
        set_id TEXT NOT NULL REFERENCES template_sets(id) ON DELETE CASCADE,
        template_id TEXT NOT NULL REFERENCES task_templates(id) ON DELETE RESTRICT,
        position INTEGER NOT NULL CHECK(position >= 0), PRIMARY KEY(set_id, template_id), UNIQUE(set_id, position)
      ) STRICT;
      CREATE TABLE template_instantiations (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES owner_accounts(id) ON DELETE CASCADE,
        source_kind TEXT NOT NULL CHECK(source_kind IN ('template','set')), source_id TEXT NOT NULL,
        source_revision INTEGER NOT NULL CHECK(source_revision > 0), destination_project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
        idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL, snapshot_json TEXT NOT NULL, result_task_ids_json TEXT NOT NULL,
        created_at TEXT NOT NULL, UNIQUE(owner_id, source_kind, source_id, idempotency_key)
      ) STRICT;
      CREATE TABLE task_template_provenance (
        task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
        template_id TEXT NOT NULL REFERENCES task_templates(id) ON DELETE RESTRICT,
        template_revision INTEGER NOT NULL CHECK(template_revision > 0),
        instantiation_id TEXT NOT NULL REFERENCES template_instantiations(id) ON DELETE RESTRICT,
        instantiated_at TEXT NOT NULL
      ) STRICT;
    `,
  },
  {
    id: "0010_phase_6_choice_pools",
    sql: `
      CREATE TABLE choice_pools (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES owner_accounts(id) ON DELETE CASCADE,
        title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 240),
        policy TEXT NOT NULL CHECK(policy IN ('none','cooldown','cycle','one_shot')),
        pick_count INTEGER NOT NULL CHECK(pick_count BETWEEN 1 AND 25),
        cooldown_seconds INTEGER CHECK(cooldown_seconds IS NULL OR cooldown_seconds BETWEEN 1 AND 31536000),
        revision INTEGER NOT NULL CHECK(revision > 0), created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived_at TEXT,
        CHECK((policy='cooldown' AND cooldown_seconds IS NOT NULL) OR (policy!='cooldown' AND cooldown_seconds IS NULL))
      ) STRICT;
      CREATE INDEX choice_pools_by_owner ON choice_pools(owner_id, archived_at, title COLLATE NOCASE, id);
      CREATE TABLE choice_pool_items (
        id TEXT PRIMARY KEY, pool_id TEXT NOT NULL REFERENCES choice_pools(id) ON DELETE CASCADE,
        title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 240), position INTEGER NOT NULL CHECK(position >= 0),
        revision INTEGER NOT NULL CHECK(revision > 0), created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived_at TEXT,
        UNIQUE(pool_id, position)
      ) STRICT;
      CREATE INDEX choice_pool_items_by_pool ON choice_pool_items(pool_id, archived_at, position, id);
      CREATE TABLE planning_placeholders (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES owner_accounts(id) ON DELETE CASCADE,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        pool_id TEXT NOT NULL REFERENCES choice_pools(id) ON DELETE RESTRICT,
        pick_count INTEGER NOT NULL CHECK(pick_count BETWEEN 1 AND 25), position INTEGER NOT NULL CHECK(position >= 0),
        state TEXT NOT NULL CHECK(state IN ('unresolved','resolved')),
        revision INTEGER NOT NULL CHECK(revision > 0), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        resolved_at TEXT, CHECK((state='unresolved' AND resolved_at IS NULL) OR (state='resolved' AND resolved_at IS NOT NULL))
      ) STRICT;
      CREATE INDEX planning_placeholders_by_owner ON planning_placeholders(owner_id, state, created_at, id);
      CREATE TABLE choice_pool_history (
        id TEXT PRIMARY KEY, pool_id TEXT NOT NULL REFERENCES choice_pools(id) ON DELETE RESTRICT,
        item_id TEXT NOT NULL REFERENCES choice_pool_items(id) ON DELETE RESTRICT,
        placeholder_id TEXT REFERENCES planning_placeholders(id) ON DELETE SET NULL,
        kind TEXT NOT NULL CHECK(kind IN ('selected','completed')),
        cycle INTEGER NOT NULL CHECK(cycle > 0), overridden INTEGER NOT NULL CHECK(overridden IN (0,1)), occurred_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX choice_pool_history_by_pool ON choice_pool_history(pool_id, occurred_at, id);
      CREATE TABLE planning_placeholder_resolutions (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES owner_accounts(id) ON DELETE CASCADE,
        placeholder_id TEXT NOT NULL REFERENCES planning_placeholders(id) ON DELETE RESTRICT,
        idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL,
        selected_item_ids_json TEXT NOT NULL, subtask_ids_json TEXT NOT NULL, history_ids_json TEXT NOT NULL,
        logical_time TEXT NOT NULL, overridden INTEGER NOT NULL CHECK(overridden IN (0,1)), created_at TEXT NOT NULL,
        UNIQUE(owner_id, placeholder_id, idempotency_key), UNIQUE(placeholder_id)
      ) STRICT;
      CREATE TABLE template_pool_slots (
        id TEXT PRIMARY KEY, template_id TEXT NOT NULL REFERENCES task_templates(id) ON DELETE CASCADE,
        pool_id TEXT NOT NULL REFERENCES choice_pools(id) ON DELETE RESTRICT,
        pick_count INTEGER NOT NULL CHECK(pick_count BETWEEN 1 AND 25), position INTEGER NOT NULL CHECK(position >= 0),
        created_at TEXT NOT NULL, UNIQUE(template_id, position)
      ) STRICT;
    `,
  },
  {
    id: "0011_phase_7_calendar_import_publication",
    sql: `
      CREATE TABLE calendar_import_jobs (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES owner_accounts(id) ON DELETE CASCADE,
        calendar_id TEXT NOT NULL REFERENCES calendar_collections(id) ON DELETE RESTRICT,
        source_kind TEXT NOT NULL CHECK(source_kind IN ('ics','google_ics')),
        input_hash TEXT NOT NULL, report_json TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('previewed','applied','partial')),
        created_at TEXT NOT NULL, applied_at TEXT,
        UNIQUE(owner_id, calendar_id, source_kind, input_hash)
      ) STRICT;
      CREATE TABLE calendar_import_items (
        job_id TEXT NOT NULL REFERENCES calendar_import_jobs(id) ON DELETE CASCADE,
        external_id TEXT NOT NULL, uid TEXT NOT NULL, raw_ics TEXT NOT NULL, href TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('pending','applied','reconciliation_required','skipped')),
        applied_at TEXT, PRIMARY KEY(job_id, external_id), UNIQUE(job_id, href)
      ) STRICT;
      CREATE TABLE calendar_feed_capabilities (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES owner_accounts(id) ON DELETE CASCADE,
        calendar_id TEXT NOT NULL REFERENCES calendar_collections(id) ON DELETE CASCADE,
        label TEXT NOT NULL CHECK(length(label) BETWEEN 1 AND 100), secret_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL, revoked_at TEXT
      ) STRICT;
      CREATE INDEX calendar_feeds_by_owner ON calendar_feed_capabilities(owner_id, created_at, id);
    `,
  },
  {
    id: "0012_phase_3_google_federation",
    sql: `
      ALTER TABLE calendar_event_projections ADD COLUMN recurrence TEXT NOT NULL DEFAULT 'none'
        CHECK(recurrence IN ('none','instance'));
      CREATE TABLE google_oauth_states (
        state_hash TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES owner_accounts(id) ON DELETE CASCADE,
        expires_at TEXT NOT NULL, consumed_at TEXT, created_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE google_connectors (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL UNIQUE REFERENCES owner_accounts(id) ON DELETE CASCADE,
        credential_key_id TEXT NOT NULL, credential_nonce BLOB NOT NULL, credential_ciphertext BLOB NOT NULL,
        credential_tag BLOB NOT NULL, granted_scopes_json TEXT NOT NULL, account_label TEXT,
        state TEXT NOT NULL CHECK(state IN ('connected','reconnect_required','stale')),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, revoked_at TEXT
      ) STRICT;
      CREATE TABLE google_calendar_sync (
        calendar_id TEXT PRIMARY KEY REFERENCES calendar_collections(id) ON DELETE CASCADE,
        owner_id TEXT NOT NULL REFERENCES owner_accounts(id) ON DELETE CASCADE,
        external_calendar_id TEXT NOT NULL, sync_token TEXT,
        state TEXT NOT NULL CHECK(state IN ('fresh','stale','unavailable')),
        last_successful_sync_at TEXT, last_attempt_at TEXT, error_code TEXT,
        UNIQUE(owner_id, external_calendar_id)
      ) STRICT;
      CREATE TABLE owner_planning_preferences (
        owner_id TEXT PRIMARY KEY REFERENCES owner_accounts(id) ON DELETE CASCADE,
        working_days_json TEXT NOT NULL, workday_start TEXT NOT NULL, workday_end TEXT NOT NULL,
        break_start TEXT, break_end TEXT, time_zone TEXT NOT NULL CHECK(time_zone='UTC'), updated_at TEXT NOT NULL
      ) STRICT;
    `,
  },
  {
    id: "0013_phase_10_iana_time_zones",
    sql: `
      CREATE TABLE owner_planning_preferences_v2 (
        owner_id TEXT PRIMARY KEY REFERENCES owner_accounts(id) ON DELETE CASCADE,
        working_days_json TEXT NOT NULL, workday_start TEXT NOT NULL, workday_end TEXT NOT NULL,
        break_start TEXT, break_end TEXT, time_zone TEXT NOT NULL, updated_at TEXT NOT NULL
      ) STRICT;
      INSERT INTO owner_planning_preferences_v2
        (owner_id,working_days_json,workday_start,workday_end,break_start,break_end,time_zone,updated_at)
        SELECT owner_id,working_days_json,workday_start,workday_end,break_start,break_end,time_zone,updated_at
        FROM owner_planning_preferences;
      DROP TABLE owner_planning_preferences;
      ALTER TABLE owner_planning_preferences_v2 RENAME TO owner_planning_preferences;
    `,
  },
  {
    id: "0014_phase_11_notifications",
    sql: `
      CREATE TABLE owner_notification_preferences (
        owner_id TEXT PRIMARY KEY REFERENCES owner_accounts(id) ON DELETE CASCADE,
        enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
        lead_reminder_enabled INTEGER NOT NULL CHECK(lead_reminder_enabled IN (0,1)),
        at_start_reminder_enabled INTEGER NOT NULL CHECK(at_start_reminder_enabled IN (0,1)),
        detailed_content_enabled INTEGER NOT NULL CHECK(detailed_content_enabled IN (0,1)),
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE notification_deliveries (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL REFERENCES owner_accounts(id) ON DELETE CASCADE,
        task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
        occurrence_start TEXT NOT NULL,
        reminder_kind TEXT NOT NULL CHECK(reminder_kind IN ('lead','at_start','test')),
        task_revision INTEGER CHECK(task_revision IS NULL OR task_revision > 0),
        state TEXT NOT NULL CHECK(state IN ('pending','sending','retry','delivered','suppressed','cancelled','failed')),
        due_at TEXT NOT NULL, next_attempt_at TEXT NOT NULL,
        attempt_count INTEGER NOT NULL CHECK(attempt_count >= 0),
        error_code TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, delivered_at TEXT
      ) STRICT;
      CREATE UNIQUE INDEX notification_delivery_occurrence
        ON notification_deliveries(owner_id,task_id,occurrence_start,reminder_kind)
        WHERE task_id IS NOT NULL;
      CREATE INDEX notification_delivery_due
        ON notification_deliveries(state,next_attempt_at,owner_id);
      CREATE INDEX notification_delivery_status
        ON notification_deliveries(owner_id,updated_at DESC,id);
    `,
  },
  {
    id: "0015_task_deadlines",
    sql: `
      ALTER TABLE tasks ADD COLUMN deadline_date TEXT;
      ALTER TABLE tasks ADD COLUMN deadline_at TEXT;
      CREATE INDEX tasks_deadline_date ON tasks(owner_id,deadline_date)
        WHERE deadline_date IS NOT NULL;
      CREATE INDEX tasks_deadline_at ON tasks(owner_id,deadline_at)
        WHERE deadline_at IS NOT NULL;
      CREATE TRIGGER tasks_deadline_insert_valid
      BEFORE INSERT ON tasks
      WHEN NEW.deadline_date IS NOT NULL AND NEW.deadline_at IS NOT NULL
      BEGIN
        SELECT RAISE(ABORT, 'task deadline must be a date or instant');
      END;
      CREATE TRIGGER tasks_deadline_update_valid
      BEFORE UPDATE OF deadline_date, deadline_at ON tasks
      WHEN NEW.deadline_date IS NOT NULL AND NEW.deadline_at IS NOT NULL
      BEGIN
        SELECT RAISE(ABORT, 'task deadline must be a date or instant');
      END;
    `,
  },
  {
    id: "0016_habits",
    sql: `
      CREATE TABLE habits (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL REFERENCES owner_accounts(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        cadence_json TEXT NOT NULL,
        started_on TEXT NOT NULL,
        time_zone TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK(revision > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        archived_at TEXT
      ) STRICT;
      CREATE TABLE habit_occurrences (
        id TEXT PRIMARY KEY,
        habit_id TEXT NOT NULL REFERENCES habits(id) ON DELETE CASCADE,
        period_key TEXT NOT NULL,
        completed_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(habit_id, period_key)
      ) STRICT;
      CREATE INDEX habit_owner_active ON habits(owner_id, archived_at, created_at DESC);
      CREATE INDEX habit_occurrence_period ON habit_occurrences(habit_id, period_key);
    `,
  },
  {
    id: "0017_sync_v2_deadline_epoch_reset",
    sql: `
      CREATE TABLE task_field_versions_v2 (
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        field TEXT NOT NULL CHECK(field IN ('title','notes','status','deadline','estimateMinutes','projectId','tagIds')),
        version INTEGER NOT NULL CHECK(version > 0), PRIMARY KEY(task_id, field)
      ) STRICT;
      INSERT INTO task_field_versions_v2 (task_id,field,version)
        SELECT task_id,field,version FROM task_field_versions;
      INSERT INTO task_field_versions_v2 (task_id,field,version)
        SELECT id,'deadline',revision FROM tasks;
      DROP TABLE task_field_versions;
      ALTER TABLE task_field_versions_v2 RENAME TO task_field_versions;
      DELETE FROM sync_changes;
      UPDATE sync_owner_state
        SET epoch=lower(hex(randomblob(16))),next_sequence=1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now');
    `,
  },
  {
    id: "0018_missing_deadline_field_versions",
    sql: `
      INSERT INTO task_field_versions (task_id,field,version)
        SELECT id,'deadline',revision FROM tasks
        WHERE id NOT IN (SELECT task_id FROM task_field_versions WHERE field='deadline');
    `,
  },
  {
    id: "0019_habit_operation_outcomes",
    sql: `CREATE TABLE habit_operation_outcomes (
      owner_id TEXT NOT NULL REFERENCES owner_accounts(id) ON DELETE CASCADE,
      actor_id TEXT NOT NULL, operation_id TEXT NOT NULL, request_hash TEXT NOT NULL,
      response_json TEXT NOT NULL, PRIMARY KEY(owner_id,actor_id,operation_id)
    ) STRICT;`,
  },
  {
    id: "0020_task_import_identity",
    sql: `CREATE TABLE task_import_sources (
      owner_id TEXT NOT NULL REFERENCES owner_accounts(id) ON DELETE CASCADE,
      source_kind TEXT NOT NULL, entity_kind TEXT NOT NULL,
      source_id TEXT NOT NULL, target_id TEXT NOT NULL,
      source_hash TEXT NOT NULL, source_json TEXT NOT NULL, imported_at TEXT NOT NULL,
      PRIMARY KEY(owner_id,source_kind,entity_kind,source_id)
    ) STRICT;`,
  },
  {
    id: "0021_preference_revisions",
    sql: `
      CREATE TABLE owner_preference_revisions (
        owner_id TEXT NOT NULL REFERENCES owner_accounts(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK(kind IN ('planning','notifications')),
        revision INTEGER NOT NULL CHECK(revision > 0),
        PRIMARY KEY(owner_id,kind)
      ) STRICT;
      INSERT INTO owner_preference_revisions SELECT owner_id,'planning',1 FROM owner_planning_preferences;
      INSERT INTO owner_preference_revisions SELECT owner_id,'notifications',1 FROM owner_notification_preferences;
      CREATE TRIGGER planning_preference_insert AFTER INSERT ON owner_planning_preferences BEGIN
        INSERT INTO owner_preference_revisions VALUES (NEW.owner_id,'planning',1)
        ON CONFLICT(owner_id,kind) DO UPDATE SET revision=revision+1;
      END;
      CREATE TRIGGER planning_preference_update AFTER UPDATE ON owner_planning_preferences BEGIN
        INSERT INTO owner_preference_revisions VALUES (NEW.owner_id,'planning',1)
        ON CONFLICT(owner_id,kind) DO UPDATE SET revision=revision+1;
      END;
      CREATE TRIGGER notification_preference_insert AFTER INSERT ON owner_notification_preferences BEGIN
        INSERT INTO owner_preference_revisions VALUES (NEW.owner_id,'notifications',1)
        ON CONFLICT(owner_id,kind) DO UPDATE SET revision=revision+1;
      END;
      CREATE TRIGGER notification_preference_update AFTER UPDATE ON owner_notification_preferences BEGIN
        INSERT INTO owner_preference_revisions VALUES (NEW.owner_id,'notifications',1)
        ON CONFLICT(owner_id,kind) DO UPDATE SET revision=revision+1;
      END;
    `,
  },
  {
    id: "0022_organization_parity",
    sql: `
      ALTER TABLE projects ADD COLUMN color TEXT;
      ALTER TABLE projects ADD COLUMN icon TEXT;
      ALTER TABLE projects ADD COLUMN position INTEGER NOT NULL DEFAULT 0 CHECK(position >= 0);
      ALTER TABLE projects ADD COLUMN hidden_from_menu INTEGER NOT NULL DEFAULT 0 CHECK(hidden_from_menu IN (0,1));
      ALTER TABLE projects ADD COLUMN completed_at TEXT;
      ALTER TABLE projects ADD COLUMN backlog_enabled INTEGER NOT NULL DEFAULT 0 CHECK(backlog_enabled IN (0,1));
      ALTER TABLE tags ADD COLUMN color TEXT;
      ALTER TABLE tags ADD COLUMN icon TEXT;
      ALTER TABLE tags ADD COLUMN position INTEGER NOT NULL DEFAULT 0 CHECK(position >= 0);
      UPDATE projects SET position = (
        SELECT count(*) FROM projects AS earlier
        WHERE earlier.owner_id = projects.owner_id
          AND (earlier.title < projects.title COLLATE NOCASE
            OR (earlier.title = projects.title COLLATE NOCASE AND earlier.id < projects.id))
      );
      UPDATE tags SET position = (
        SELECT count(*) FROM tags AS earlier
        WHERE earlier.owner_id = tags.owner_id
          AND (earlier.display_name < tags.display_name COLLATE NOCASE
            OR (earlier.display_name = tags.display_name COLLATE NOCASE AND earlier.id < tags.id))
      );
      CREATE TABLE project_backlog_tasks (
        owner_id TEXT NOT NULL REFERENCES owner_accounts(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
        position INTEGER NOT NULL CHECK(position >= 0)
      ) STRICT;
      CREATE INDEX project_backlog_by_project ON project_backlog_tasks(owner_id, project_id, position, task_id);
      CREATE TABLE notes (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES owner_accounts(id) ON DELETE CASCADE,
        project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
        tag_id TEXT REFERENCES tags(id) ON DELETE SET NULL,
        content TEXT NOT NULL CHECK(length(content) <= 20000),
        pinned_to_today INTEGER NOT NULL CHECK(pinned_to_today IN (0,1)),
        position INTEGER NOT NULL CHECK(position >= 0),
        revision INTEGER NOT NULL CHECK(revision > 0),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        CHECK(project_id IS NULL OR tag_id IS NULL)
      ) STRICT;
      CREATE INDEX notes_by_owner ON notes(owner_id, position, id);
    `,
  },
];

const checksum = (sql: string): string =>
  createHash("sha256").update(sql).digest("hex");

const escapeSqliteString = (value: string): string =>
  value.replaceAll("'", "''");

export class SuiteDatabase {
  readonly #database: DatabaseSync;
  readonly credentials: SqliteCredentialStore;
  readonly habits: SqliteHabitStore;
  readonly calendarProjections: SqliteCalendarProjectionStore;
  readonly planningPreferences: SqlitePlanningPreferencesStore;
  readonly notes: SqliteNoteStore;

  private constructor(database: DatabaseSync) {
    this.#database = database;
    this.notes = new SqliteNoteStore(database);
    this.habits = new SqliteHabitStore(
      database,
      (ownerId, kind, id, revision, now) => {
        this.#appendSyncChangeInTransaction(
          ownerId,
          kind,
          id,
          "upsert",
          revision,
          now,
        );
      },
    );
    this.credentials = new SqliteCredentialStore(this.#database);
    this.calendarProjections = new SqliteCalendarProjectionStore(
      this.#database,
    );
    this.planningPreferences = new SqlitePlanningPreferencesStore(
      this.#database,
    );
  }

  static open(path: string): SuiteDatabase {
    mkdirSync(dirname(path), { recursive: true });
    const database = new DatabaseSync(path);
    database.exec("PRAGMA journal_mode = WAL;");
    database.exec("PRAGMA foreign_keys = ON;");
    database.exec("PRAGMA busy_timeout = 5000;");

    const suiteDatabase = new SuiteDatabase(database);
    suiteDatabase.#migrate();
    suiteDatabase.#ensureInstallMetadata();
    return suiteDatabase;
  }

  close(): void {
    this.#database.close();
  }

  state(): DatabaseState {
    const install = this.#database
      .prepare(
        "SELECT instance_id, created_at FROM install_metadata WHERE singleton = 1",
      )
      .get() as unknown as InstallRow | undefined;

    if (install === undefined) {
      throw new Error("Installation metadata is missing");
    }

    const migrationCount = this.#database
      .prepare("SELECT COUNT(*) AS count FROM schema_migrations")
      .get() as unknown as { readonly count: number };

    return {
      install: {
        instanceId: install.instance_id,
        createdAt: install.created_at,
      },
      appliedMigrationCount: migrationCount.count,
      expectedMigrationCount: migrations.length,
    };
  }

  check(): void {
    this.#database.prepare("SELECT 1").get();
  }

  backup(destination: string): void {
    mkdirSync(dirname(destination), { recursive: true });
    this.#database.exec(`VACUUM INTO '${escapeSqliteString(destination)}'`);
  }

  setupRequired(): boolean {
    return (
      this.#database
        .prepare("SELECT 1 FROM owner_accounts WHERE disabled_at IS NULL")
        .get() === undefined
    );
  }

  getActiveOwnerId(): string | undefined {
    const row = this.#database
      .prepare(
        "SELECT id FROM owner_accounts WHERE disabled_at IS NULL ORDER BY created_at LIMIT 1",
      )
      .get() as unknown as { readonly id: string } | undefined;
    return row?.id;
  }

  createOwner(owner: OwnerRecord): boolean {
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      if (!this.setupRequired()) {
        this.#database.exec("ROLLBACK;");
        return false;
      }
      this.#database
        .prepare(
          `INSERT INTO owner_accounts
            (id, username, display_name, password_hash, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          owner.id,
          owner.username,
          owner.displayName,
          owner.passwordHash,
          owner.createdAt,
        );
      this.#database.exec("COMMIT;");
      return true;
    } catch (error: unknown) {
      this.#database.exec("ROLLBACK;");
      throw error;
    }
  }

  findOwnerByUsername(username: string): OwnerRecord | undefined {
    const row = this.#database
      .prepare(
        `SELECT id, username, display_name, password_hash, created_at
         FROM owner_accounts WHERE username = ? COLLATE NOCASE AND disabled_at IS NULL`,
      )
      .get(username) as unknown as
      | {
          readonly id: string;
          readonly username: string;
          readonly display_name: string;
          readonly password_hash: string;
          readonly created_at: string;
        }
      | undefined;
    return row === undefined
      ? undefined
      : {
          id: row.id,
          username: row.username,
          displayName: row.display_name,
          passwordHash: row.password_hash,
          createdAt: row.created_at,
        };
  }

  findOwnerById(
    ownerId: string,
  ): Omit<OwnerRecord, "passwordHash"> | undefined {
    const row = this.#database
      .prepare(
        `SELECT id, username, display_name, created_at
         FROM owner_accounts WHERE id = ? AND disabled_at IS NULL`,
      )
      .get(ownerId) as unknown as
      | {
          readonly id: string;
          readonly username: string;
          readonly display_name: string;
          readonly created_at: string;
        }
      | undefined;
    return row === undefined
      ? undefined
      : {
          id: row.id,
          username: row.username,
          displayName: row.display_name,
          createdAt: row.created_at,
        };
  }

  createSession(session: SessionRecord & { readonly issuedAt: string }): void {
    this.#database
      .prepare(
        `INSERT INTO web_sessions
          (token_hash, owner_id, csrf_hash, issued_at, last_seen_at,
           idle_expires_at, absolute_expires_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(
        session.tokenHash,
        session.ownerId,
        session.csrfHash,
        session.issuedAt,
        session.issuedAt,
        session.idleExpiresAt,
        session.absoluteExpiresAt,
      );
  }

  findSession(tokenHash: string): SessionRecord | undefined {
    const row = this.#database
      .prepare(
        `SELECT token_hash, owner_id, csrf_hash, idle_expires_at,
                absolute_expires_at, revoked_at
         FROM web_sessions WHERE token_hash = ?`,
      )
      .get(tokenHash) as unknown as
      | {
          readonly token_hash: string;
          readonly owner_id: string;
          readonly csrf_hash: string;
          readonly idle_expires_at: string;
          readonly absolute_expires_at: string;
          readonly revoked_at: string | null;
        }
      | undefined;
    return row === undefined
      ? undefined
      : {
          tokenHash: row.token_hash,
          ownerId: row.owner_id,
          csrfHash: row.csrf_hash,
          idleExpiresAt: row.idle_expires_at,
          absoluteExpiresAt: row.absolute_expires_at,
          revokedAt: row.revoked_at,
        };
  }

  refreshSession(
    tokenHash: string,
    lastSeenAt: string,
    idleExpiresAt: string,
  ): void {
    this.#database
      .prepare(
        `UPDATE web_sessions SET last_seen_at = ?, idle_expires_at = ?
         WHERE token_hash = ? AND revoked_at IS NULL`,
      )
      .run(lastSeenAt, idleExpiresAt, tokenHash);
  }

  rotateSessionCsrf(tokenHash: string, csrfHash: string): void {
    this.#database
      .prepare(
        "UPDATE web_sessions SET csrf_hash = ? WHERE token_hash = ? AND revoked_at IS NULL",
      )
      .run(csrfHash, tokenHash);
  }

  revokeSession(tokenHash: string, revokedAt: string): boolean {
    return (
      this.#database
        .prepare(
          `UPDATE web_sessions SET revoked_at = ?
           WHERE token_hash = ? AND revoked_at IS NULL`,
        )
        .run(revokedAt, tokenHash).changes === 1
    );
  }

  deleteExpiredSessions(now: string): void {
    this.#database
      .prepare(
        "DELETE FROM web_sessions WHERE absolute_expires_at <= ? OR revoked_at IS NOT NULL",
      )
      .run(now);
  }

  putBaikalConnector(
    connector: BaikalConnectorRecord & { readonly updatedAt: string },
  ): void {
    this.credentials.upsertBaikalConnector(connector);
  }

  getBaikalConnector(ownerId: string): BaikalConnectorRecord | undefined {
    return this.credentials.getBaikalConnector(ownerId);
  }

  ensureCalendarProvider(
    ownerId: string,
    kind: CalendarProviderRecord["kind"],
    connectorId: string,
    now: string,
  ): CalendarProviderRecord {
    return this.calendarProjections.ensureCalendarProvider(
      ownerId,
      kind,
      connectorId,
      now,
    );
  }

  putCalendarCollections(
    providerId: string,
    collections: readonly Omit<CalendarCollectionRecord, "id" | "providerId">[],
    discoveredAt: string,
  ): readonly CalendarCollectionRecord[] {
    return this.calendarProjections.putCalendarCollections(
      providerId,
      collections,
      discoveredAt,
    );
  }

  getOwnedCalendar(
    ownerId: string,
    calendarId: string,
  ): OwnedCalendarRecord | undefined {
    return this.calendarProjections.getOwnedCalendar(ownerId, calendarId);
  }

  listOwnedCalendars(
    ownerId: string,
    kind?: CalendarProviderRecord["kind"],
  ): readonly OwnedCalendarRecord[] {
    const all = this.calendarProjections.listOwnedCalendars(ownerId);
    return kind === undefined
      ? all
      : all.filter((calendar: OwnedCalendarRecord) => calendar.kind === kind);
  }

  pruneGoogleCalendars(
    ownerId: string,
    providerId: string,
    activeExternalCalendarIds: readonly string[],
  ): void {
    this.calendarProjections.pruneGoogleCalendars(
      ownerId,
      providerId,
      activeExternalCalendarIds,
    );
  }

  createCalendarImportPreview(input: {
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
  }):
    | { readonly job: CalendarImportJobRecord; readonly replayed: boolean }
    | undefined {
    if (this.getOwnedCalendar(input.ownerId, input.calendarId) === undefined)
      return undefined;
    const prior = this.#database
      .prepare(
        `SELECT id FROM calendar_import_jobs WHERE owner_id=? AND calendar_id=? AND source_kind=? AND input_hash=?`,
      )
      .get(
        input.ownerId,
        input.calendarId,
        input.source,
        input.inputHash,
      ) as unknown as { id: string } | undefined;
    if (prior !== undefined) {
      const job = this.getCalendarImportJob(input.ownerId, prior.id);
      if (job === undefined)
        throw new Error("Calendar import replay disappeared");
      return { job, replayed: true };
    }
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      this.#database
        .prepare(
          `INSERT INTO calendar_import_jobs (id,owner_id,calendar_id,source_kind,input_hash,report_json,state,created_at,applied_at)
         VALUES (?,?,?,?,?,?,'previewed',?,NULL)`,
        )
        .run(
          input.id,
          input.ownerId,
          input.calendarId,
          input.source,
          input.inputHash,
          JSON.stringify(input.report),
          input.createdAt,
        );
      const insert = this.#database.prepare(
        `INSERT INTO calendar_import_items (job_id,external_id,uid,raw_ics,href,state,applied_at)
         VALUES (?,?,?,?,?,'pending',NULL)`,
      );
      for (const item of input.candidates)
        insert.run(input.id, item.externalId, item.uid, item.rawIcs, item.href);
      this.#database.exec("COMMIT;");
    } catch (error: unknown) {
      this.#database.exec("ROLLBACK;");
      throw error;
    }
    const job = this.getCalendarImportJob(input.ownerId, input.id);
    if (job === undefined)
      throw new Error("Calendar import preview disappeared");
    return { job, replayed: false };
  }

  getCalendarImportJob(
    ownerId: string,
    jobId: string,
  ): CalendarImportJobRecord | undefined {
    const row = this.#database
      .prepare("SELECT * FROM calendar_import_jobs WHERE owner_id=? AND id=?")
      .get(ownerId, jobId) as unknown as
      Record<string, string | null> | undefined;
    if (row === undefined) return undefined;
    const items = this.#database
      .prepare(
        "SELECT * FROM calendar_import_items WHERE job_id=? ORDER BY external_id",
      )
      .all(jobId) as unknown as readonly Record<string, string | null>[];
    return {
      id: String(row.id),
      ownerId: String(row.owner_id),
      calendarId: String(row.calendar_id),
      source: String(row.source_kind) as CalendarImportJobRecord["source"],
      inputHash: String(row.input_hash),
      report: JSON.parse(String(row.report_json)) as unknown,
      state: String(row.state) as CalendarImportJobRecord["state"],
      createdAt: String(row.created_at),
      appliedAt: row.applied_at === null ? null : String(row.applied_at),
      items: items.map((item) => ({
        externalId: String(item.external_id),
        uid: String(item.uid),
        rawIcs: String(item.raw_ics),
        href: String(item.href),
        state: String(item.state) as CalendarImportItemRecord["state"],
        appliedAt: item.applied_at === null ? null : String(item.applied_at),
      })),
    };
  }

  markCalendarImportItem(
    ownerId: string,
    jobId: string,
    externalId: string,
    state: "applied" | "reconciliation_required",
    now: string,
  ): void {
    this.#database
      .prepare(
        `UPDATE calendar_import_items SET state=?, applied_at=? WHERE job_id IN
       (SELECT id FROM calendar_import_jobs WHERE id=? AND owner_id=?) AND external_id=?`,
      )
      .run(state, state === "applied" ? now : null, jobId, ownerId, externalId);
  }

  finishCalendarImport(
    ownerId: string,
    jobId: string,
    now: string,
  ): CalendarImportJobRecord | undefined {
    const job = this.getCalendarImportJob(ownerId, jobId);
    if (job === undefined) return undefined;
    const partial = job.items.some(({ state }) => state !== "applied");
    this.#database
      .prepare(
        "UPDATE calendar_import_jobs SET state=?, applied_at=? WHERE owner_id=? AND id=?",
      )
      .run(partial ? "partial" : "applied", now, ownerId, jobId);
    return this.getCalendarImportJob(ownerId, jobId);
  }

  listPublishedCalendarRaw(
    ownerId: string,
    calendarId: string,
  ): readonly string[] {
    if (this.getOwnedCalendar(ownerId, calendarId) === undefined) return [];
    return this.calendarProjections.listPublishedCalendarRaw(
      ownerId,
      calendarId,
    );
  }

  createCalendarFeedCapability(record: CalendarFeedCapabilityRecord): void {
    if (this.getOwnedCalendar(record.ownerId, record.calendarId) === undefined)
      throw new Error("Calendar not found");
    this.#database
      .prepare(
        `INSERT INTO calendar_feed_capabilities (id,owner_id,calendar_id,label,secret_hash,created_at,revoked_at) VALUES (?,?,?,?,?,?,?)`,
      )
      .run(
        record.id,
        record.ownerId,
        record.calendarId,
        record.label,
        record.secretHash,
        record.createdAt,
        record.revokedAt,
      );
  }

  listCalendarFeedCapabilities(
    ownerId: string,
  ): readonly CalendarFeedCapabilityRecord[] {
    return (
      this.#database
        .prepare(
          "SELECT * FROM calendar_feed_capabilities WHERE owner_id=? ORDER BY created_at,id",
        )
        .all(ownerId) as unknown as readonly Record<string, string | null>[]
    ).map((row) => this.#calendarFeedFromRow(row));
  }

  getCalendarFeedCapability(
    id: string,
  ): CalendarFeedCapabilityRecord | undefined {
    const row = this.#database
      .prepare("SELECT * FROM calendar_feed_capabilities WHERE id=?")
      .get(id) as unknown as Record<string, string | null> | undefined;
    return row === undefined ? undefined : this.#calendarFeedFromRow(row);
  }

  revokeCalendarFeedCapability(
    ownerId: string,
    id: string,
    now: string,
  ): boolean {
    return (
      this.#database
        .prepare(
          "UPDATE calendar_feed_capabilities SET revoked_at=? WHERE owner_id=? AND id=? AND revoked_at IS NULL",
        )
        .run(now, ownerId, id).changes === 1
    );
  }

  #calendarFeedFromRow(
    row: Record<string, string | null>,
  ): CalendarFeedCapabilityRecord {
    return {
      id: String(row.id),
      ownerId: String(row.owner_id),
      calendarId: String(row.calendar_id),
      label: String(row.label),
      secretHash: String(row.secret_hash),
      createdAt: String(row.created_at),
      revokedAt: row.revoked_at === null ? null : String(row.revoked_at),
    };
  }

  createGoogleOAuthState(record: {
    readonly stateHash: string;
    readonly ownerId: string;
    readonly expiresAt: string;
    readonly createdAt: string;
  }): void {
    this.credentials.createGoogleOAuthState(record);
  }

  consumeGoogleOAuthState(stateHash: string, now: string): string | undefined {
    return this.credentials.consumeGoogleOAuthState(stateHash, now);
  }

  putGoogleConnector(record: GoogleConnectorRecord): void {
    this.credentials.upsertGoogleConnector(record);
  }

  getGoogleConnector(ownerId: string): GoogleConnectorRecord | undefined {
    return this.credentials.getGoogleConnector(ownerId);
  }

  markGoogleConnectorState(
    ownerId: string,
    state: GoogleConnectorRecord["state"],
    now: string,
  ): void {
    this.credentials.markGoogleConnectorState(ownerId, state, now);
  }

  putGoogleCalendarSync(record: GoogleCalendarSyncRecord): void {
    this.credentials.upsertGoogleCalendarSync(record);
  }

  listGoogleCalendarSync(ownerId: string): readonly GoogleCalendarSyncRecord[] {
    return this.credentials.listGoogleCalendarSync(ownerId);
  }

  applyGoogleEventSync(input: {
    readonly ownerId: string;
    readonly calendarId: string;
    readonly externalCalendarId: string;
    readonly providerId: string;
    readonly syncToken: string;
    readonly reset: boolean;
    readonly events: readonly {
      id: string;
      uid: string;
      etag: string;
      summary: string;
      startsAt: string;
      endsAt: string;
      allDay: boolean;
      recurrence: "none" | "instance";
      deleted: boolean;
      rawIcs: string;
    }[];
    readonly now: string;
  }): void {
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      if (input.reset)
        this.#database
          .prepare(
            "DELETE FROM calendar_event_projections WHERE owner_id=? AND calendar_id=?",
          )
          .run(input.ownerId, input.calendarId);
      for (const event of input.events) {
        if (event.deleted)
          this.#database
            .prepare(
              "DELETE FROM calendar_event_projections WHERE owner_id=? AND calendar_id=? AND href=?",
            )
            .run(input.ownerId, input.calendarId, event.id);
        else
          this.#putCalendarEvent(input.ownerId, {
            id: randomUUID(),
            providerId: input.providerId,
            calendarId: input.calendarId,
            href: event.id,
            uid: event.uid,
            etag: event.etag,
            rawIcs: event.rawIcs,
            summary: event.summary,
            startsAt: event.startsAt,
            endsAt: event.endsAt,
            allDay: event.allDay,
            recurrence: event.recurrence,
            freshness: "current",
            mutable: false,
            revision: 1,
            projectedAt: input.now,
          });
      }
      this.putGoogleCalendarSync({
        calendarId: input.calendarId,
        ownerId: input.ownerId,
        externalCalendarId: input.externalCalendarId,
        syncToken: input.syncToken,
        state: "fresh",
        lastSuccessfulSyncAt: input.now,
        lastAttemptAt: input.now,
        errorCode: null,
      });
      this.#database.exec("COMMIT;");
    } catch (error: unknown) {
      this.#database.exec("ROLLBACK;");
      throw error;
    }
  }

  markGoogleCalendarSyncFailure(
    ownerId: string,
    calendarId: string,
    state: "stale" | "unavailable",
    errorCode: string,
    now: string,
  ): void {
    this.calendarProjections.markGoogleCalendarSyncFailure(
      ownerId,
      calendarId,
      state,
      errorCode,
      now,
    );
  }

  disconnectGoogle(ownerId: string): boolean {
    const connector = this.credentials.getGoogleConnector(ownerId);
    if (connector === undefined) return false;
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      this.#database
        .prepare(
          "DELETE FROM calendar_providers WHERE owner_id=? AND kind='google' AND connector_id=?",
        )
        .run(ownerId, connector.id);
      this.#database
        .prepare("DELETE FROM google_connectors WHERE owner_id=?")
        .run(ownerId);
      this.#database.exec("COMMIT;");
      return true;
    } catch (error: unknown) {
      this.#database.exec("ROLLBACK;");
      throw error;
    }
  }

  getPreferenceRevision(
    ownerId: string,
    kind: "planning" | "notifications",
  ): number {
    const row = this.#database
      .prepare(
        "SELECT revision FROM owner_preference_revisions WHERE owner_id=? AND kind=?",
      )
      .get(ownerId, kind) as { revision: number } | undefined;
    return row?.revision ?? 0;
  }

  #mutatePreferences(
    ownerId: string,
    kind: "planning" | "notifications",
    expectedRevision: number,
    apply: () => void,
  ): boolean {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
      return false;
    this.#database.exec("SAVEPOINT preference_mutation;");
    try {
      if (this.getPreferenceRevision(ownerId, kind) !== expectedRevision) {
        this.#database.exec("RELEASE SAVEPOINT preference_mutation;");
        return false;
      }
      apply();
      this.#database.exec("RELEASE SAVEPOINT preference_mutation;");
      return true;
    } catch (error) {
      this.#database.exec(
        "ROLLBACK TO SAVEPOINT preference_mutation; RELEASE SAVEPOINT preference_mutation;",
      );
      throw error;
    }
  }

  mutatePlanningPreferences(
    ownerId: string,
    expectedRevision: number,
    preferences: PlanningPreferencesRecord,
    now: string,
  ): PlanningPreferencesRecord | undefined {
    const parsed = planningPreferencesSchema.safeParse(preferences);
    if (!parsed.success) return undefined;
    return this.#mutatePreferences(
      ownerId,
      "planning",
      expectedRevision,
      () => {
        this.putPlanningPreferences(ownerId, parsed.data, now);
      },
    )
      ? this.getPlanningPreferences(ownerId)
      : undefined;
  }

  mutateNotificationPreferences(
    ownerId: string,
    expectedRevision: number,
    preferences: NotificationPreferencesRecord,
    now: string,
  ): NotificationPreferencesRecord | undefined {
    const parsed = notificationPreferencesSchema.safeParse(preferences);
    if (!parsed.success) return undefined;
    return this.#mutatePreferences(
      ownerId,
      "notifications",
      expectedRevision,
      () => {
        this.putNotificationPreferences(ownerId, parsed.data, now);
      },
    )
      ? this.getNotificationPreferences(ownerId)
      : undefined;
  }

  getPlanningPreferences(ownerId: string): PlanningPreferencesRecord {
    return this.planningPreferences.getPlanningPreferences(ownerId);
  }

  putPlanningPreferences(
    ownerId: string,
    preferences: PlanningPreferencesRecord,
    now: string,
  ): PlanningPreferencesRecord {
    void now;
    return this.planningPreferences.upsertPlanningPreferences(
      ownerId,
      preferences,
    );
  }

  getNotificationPreferences(ownerId: string): NotificationPreferencesRecord {
    const row = this.#database
      .prepare("SELECT * FROM owner_notification_preferences WHERE owner_id=?")
      .get(ownerId) as unknown as Record<string, number> | undefined;
    return row === undefined
      ? {
          enabled: false,
          leadReminderEnabled: true,
          atStartReminderEnabled: true,
          detailedContentEnabled: true,
        }
      : {
          enabled: Number(row.enabled) === 1,
          leadReminderEnabled: Number(row.lead_reminder_enabled) === 1,
          atStartReminderEnabled: Number(row.at_start_reminder_enabled) === 1,
          detailedContentEnabled: Number(row.detailed_content_enabled) === 1,
        };
  }

  putNotificationPreferences(
    ownerId: string,
    preferences: NotificationPreferencesRecord,
    now: string,
  ): NotificationPreferencesRecord {
    this.#database
      .prepare(
        `INSERT INTO owner_notification_preferences
          (owner_id,enabled,lead_reminder_enabled,at_start_reminder_enabled,detailed_content_enabled,updated_at)
         VALUES (?,?,?,?,?,?) ON CONFLICT(owner_id) DO UPDATE SET
          enabled=excluded.enabled,lead_reminder_enabled=excluded.lead_reminder_enabled,
          at_start_reminder_enabled=excluded.at_start_reminder_enabled,
          detailed_content_enabled=excluded.detailed_content_enabled,updated_at=excluded.updated_at`,
      )
      .run(
        ownerId,
        preferences.enabled ? 1 : 0,
        preferences.leadReminderEnabled ? 1 : 0,
        preferences.atStartReminderEnabled ? 1 : 0,
        preferences.detailedContentEnabled ? 1 : 0,
        now,
      );
    return this.getNotificationPreferences(ownerId);
  }

  reconcileNotificationDeliveries(input: {
    readonly ownerId: string;
    readonly tasks: readonly TaskRecord[];
    readonly preferences: NotificationPreferencesRecord;
    readonly now: string;
  }): void {
    const scheduled = input.preferences.enabled
      ? input.tasks.filter(
          (task) =>
            task.status === "open" &&
            task.deletedAt === null &&
            task.plannedStart !== null,
        )
      : [];
    const desired = new Set<string>();
    const kinds: readonly ("lead" | "at_start")[] = [
      ...(input.preferences.leadReminderEnabled ? (["lead"] as const) : []),
      ...(input.preferences.atStartReminderEnabled
        ? (["at_start"] as const)
        : []),
    ];
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      for (const task of scheduled) {
        if (task.plannedStart === null) continue;
        for (const kind of kinds) {
          const occurrenceStart = task.plannedStart;
          desired.add(`${task.id}\n${occurrenceStart}\n${kind}`);
          const dueAt = new Date(
            Date.parse(occurrenceStart) - (kind === "lead" ? 15 * 60_000 : 0),
          ).toISOString();
          this.#database
            .prepare(
              `INSERT OR IGNORE INTO notification_deliveries
                (id,owner_id,task_id,occurrence_start,reminder_kind,task_revision,state,due_at,next_attempt_at,attempt_count,error_code,created_at,updated_at,delivered_at)
               VALUES (?,?,?,?,?,?,'pending',?,?,0,NULL,?,?,NULL)`,
            )
            .run(
              randomUUID(),
              input.ownerId,
              task.id,
              occurrenceStart,
              kind,
              task.revision,
              dueAt,
              dueAt,
              input.now,
              input.now,
            );
        }
      }
      const active = this.#database
        .prepare(
          `SELECT id,task_id,occurrence_start,reminder_kind
           FROM notification_deliveries
           WHERE owner_id=? AND task_id IS NOT NULL AND state IN ('pending','retry')`,
        )
        .all(input.ownerId) as unknown as readonly {
        readonly id: string;
        readonly task_id: string;
        readonly occurrence_start: string;
        readonly reminder_kind: "lead" | "at_start";
      }[];
      for (const delivery of active) {
        const key = `${delivery.task_id}\n${delivery.occurrence_start}\n${delivery.reminder_kind}`;
        if (!desired.has(key))
          this.#database
            .prepare(
              "UPDATE notification_deliveries SET state='cancelled',error_code='OBSOLETE',updated_at=? WHERE id=?",
            )
            .run(input.now, delivery.id);
      }
      this.#database.exec("COMMIT;");
    } catch (error: unknown) {
      this.#database.exec("ROLLBACK;");
      throw error;
    }
  }

  listDueNotificationDeliveries(
    now: string,
    limit = 25,
  ): readonly NotificationDeliveryRecord[] {
    const rows = this.#database
      .prepare(
        `SELECT * FROM notification_deliveries
         WHERE state IN ('pending','retry') AND next_attempt_at<=?
         ORDER BY next_attempt_at,id LIMIT ?`,
      )
      .all(now, limit) as unknown as readonly Record<
      string,
      string | number | null
    >[];
    return rows.map((row) => this.#notificationDeliveryFromRow(row));
  }

  claimNotificationDelivery(
    id: string,
    now: string,
  ): NotificationDeliveryRecord | undefined {
    const updated = this.#database
      .prepare(
        `UPDATE notification_deliveries SET state='sending',attempt_count=attempt_count+1,updated_at=?
         WHERE id=? AND state IN ('pending','retry')`,
      )
      .run(now, id);
    return Number(updated.changes) === 1
      ? this.getNotificationDelivery(id)
      : undefined;
  }

  getNotificationDelivery(id: string): NotificationDeliveryRecord | undefined {
    const row = this.#database
      .prepare("SELECT * FROM notification_deliveries WHERE id=?")
      .get(id) as unknown as Record<string, string | number | null> | undefined;
    return row === undefined
      ? undefined
      : this.#notificationDeliveryFromRow(row);
  }

  deferNotificationDelivery(
    id: string,
    nextAttemptAt: string,
    errorCode: string,
    now: string,
  ): void {
    this.#database
      .prepare(
        `UPDATE notification_deliveries SET state='retry',next_attempt_at=?,error_code=?,updated_at=?
         WHERE id=? AND state='sending'`,
      )
      .run(nextAttemptAt, errorCode, now, id);
  }

  finishNotificationDelivery(
    id: string,
    state: "delivered" | "suppressed" | "cancelled" | "failed",
    errorCode: string | null,
    now: string,
  ): void {
    this.#database
      .prepare(
        `UPDATE notification_deliveries SET state=?,error_code=?,updated_at=?,delivered_at=?
         WHERE id=? AND state='sending'`,
      )
      .run(state, errorCode, now, state === "delivered" ? now : null, id);
  }

  failUncertainNotificationDeliveries(now: string): number {
    const result = this.#database
      .prepare(
        `UPDATE notification_deliveries SET state='failed',error_code='DELIVERY_UNCERTAIN',updated_at=?
         WHERE state='sending'`,
      )
      .run(now);
    return Number(result.changes);
  }

  queueNotificationTest(
    ownerId: string,
    id: string,
    now: string,
  ): NotificationDeliveryRecord {
    this.#database
      .prepare(
        `INSERT INTO notification_deliveries
       (id,owner_id,task_id,occurrence_start,reminder_kind,task_revision,state,due_at,next_attempt_at,attempt_count,error_code,created_at,updated_at,delivered_at)
       VALUES (?,?,NULL,?,'test',NULL,'pending',?,?,0,NULL,?,?,NULL)`,
      )
      .run(id, ownerId, now, now, now, now, now);
    const delivery = this.getNotificationDelivery(id);
    if (delivery === undefined)
      throw new Error("Queued notification is missing");
    return delivery;
  }

  listDueNotificationTests(
    ownerId: string,
    now: string,
  ): readonly NotificationDeliveryRecord[] {
    const rows = this.#database
      .prepare(
        `SELECT * FROM notification_deliveries WHERE owner_id=? AND reminder_kind='test'
       AND state IN ('pending','retry') AND next_attempt_at<=? ORDER BY next_attempt_at,id LIMIT 25`,
      )
      .all(ownerId, now) as unknown as readonly Record<
      string,
      string | number | null
    >[];
    return rows.map((row) => this.#notificationDeliveryFromRow(row));
  }

  recordNotificationTest(
    ownerId: string,
    delivered: boolean,
    errorCode: string | null,
    now: string,
  ): void {
    this.#database
      .prepare(
        `INSERT INTO notification_deliveries
          (id,owner_id,task_id,occurrence_start,reminder_kind,task_revision,state,due_at,next_attempt_at,attempt_count,error_code,created_at,updated_at,delivered_at)
         VALUES (?,?,NULL,?,'test',NULL,?,?,?,?,?,?,?,?)`,
      )
      .run(
        randomUUID(),
        ownerId,
        now,
        delivered ? "delivered" : "failed",
        now,
        now,
        1,
        errorCode,
        now,
        now,
        delivered ? now : null,
      );
  }

  getNotificationDeliveryStatus(ownerId: string): {
    readonly pendingCount: number;
    readonly failedCount: number;
    readonly lastDelivery: NotificationDeliveryRecord | null;
  } {
    const counts = this.#database
      .prepare(
        `SELECT
          SUM(CASE WHEN state IN ('pending','retry','sending') THEN 1 ELSE 0 END) AS pending_count,
          SUM(CASE WHEN state='failed' THEN 1 ELSE 0 END) AS failed_count
         FROM notification_deliveries WHERE owner_id=?`,
      )
      .get(ownerId) as unknown as {
      readonly pending_count: number | null;
      readonly failed_count: number | null;
    };
    const last = this.#database
      .prepare(
        "SELECT * FROM notification_deliveries WHERE owner_id=? ORDER BY updated_at DESC,id DESC LIMIT 1",
      )
      .get(ownerId) as unknown as
      Record<string, string | number | null> | undefined;
    return {
      pendingCount: counts.pending_count ?? 0,
      failedCount: counts.failed_count ?? 0,
      lastDelivery:
        last === undefined ? null : this.#notificationDeliveryFromRow(last),
    };
  }

  replaceCalendarEventWindow(
    ownerId: string,
    calendarId: string,
    from: string,
    to: string,
    events: readonly Omit<
      CalendarEventProjectionRecord,
      "ownerId" | "providerKind" | "providerDisplayLabel" | "calendarName"
    >[],
  ): void {
    this.calendarProjections.replaceCalendarEventWindow(
      ownerId,
      calendarId,
      from,
      to,
      events,
    );
  }

  listCalendarEvents(
    ownerId: string,
    from: string,
    to: string,
  ): readonly CalendarEventProjectionRecord[] {
    return this.calendarProjections.listProjectedEvents(ownerId, from, to);
  }

  listActiveTaskCalendarEventLinks(
    ownerId: string,
  ): readonly ActiveTaskCalendarEventLink[] {
    return this.#database
      .prepare(
        `SELECT b.provider_id,b.calendar_id,b.event_href,b.task_id
         FROM task_calendar_blocks b
         JOIN tasks t ON t.id=b.task_id AND t.owner_id=b.owner_id
         WHERE b.owner_id=? AND b.state='active' AND t.deleted_at IS NULL`,
      )
      .all(ownerId)
      .map((row) => {
        const link = row as {
          provider_id: string;
          calendar_id: string;
          event_href: string;
          task_id: string;
        };
        return {
          providerId: link.provider_id,
          calendarId: link.calendar_id,
          eventHref: link.event_href,
          taskId: link.task_id,
        };
      });
  }

  getTaskCalendarBlock(
    ownerId: string,
    taskId: string,
  ): TaskCalendarBlockRecord | undefined {
    return this.calendarProjections.getTaskCalendarBlock(ownerId, taskId);
  }

  releaseTaskCalendarBlock(input: {
    readonly ownerId: string;
    readonly taskId: string;
    readonly expectedTaskRevision: number;
    readonly expectedBlockRevision: number;
    readonly now: string;
  }): TaskRecord | undefined {
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      const task = this.getTask(input.ownerId, input.taskId);
      const block = this.getTaskCalendarBlock(input.ownerId, input.taskId);
      if (
        task === undefined ||
        block === undefined ||
        task.revision !== input.expectedTaskRevision ||
        block.revision !== input.expectedBlockRevision
      ) {
        this.#database.exec("COMMIT;");
        return undefined;
      }
      this.#database
        .prepare(
          `DELETE FROM calendar_event_projections
           WHERE owner_id = ? AND calendar_id = ? AND href = ?`,
        )
        .run(input.ownerId, block.calendarId, block.eventHref);
      this.#database
        .prepare(
          "DELETE FROM task_calendar_blocks WHERE owner_id = ? AND task_id = ?",
        )
        .run(input.ownerId, input.taskId);
      const released: TaskRecord = {
        ...task,
        plannedStart: null,
        estimateMinutes: null,
        revision: task.revision + 1,
        updatedAt: input.now,
      };
      this.#database
        .prepare(
          `UPDATE tasks SET planned_start = NULL, estimate_minutes = NULL,
             revision = ?, updated_at = ? WHERE owner_id = ? AND id = ?`,
        )
        .run(
          released.revision,
          released.updatedAt,
          released.ownerId,
          released.id,
        );
      this.#database
        .prepare(
          "INSERT INTO task_field_versions (task_id,field,version) VALUES (?, 'estimateMinutes', ?) ON CONFLICT(task_id,field) DO UPDATE SET version=excluded.version",
        )
        .run(released.id, released.revision);
      this.#appendSyncChangeInTransaction(
        input.ownerId,
        "task",
        released.id,
        "upsert",
        released.revision,
        input.now,
      );
      this.#database.exec("COMMIT;");
      return released;
    } catch (error: unknown) {
      this.#database.exec("ROLLBACK;");
      throw error;
    }
  }

  markTaskCalendarBlockState(
    ownerId: string,
    taskId: string,
    state: "conflict" | "needs_reconciliation",
    now: string,
  ): void {
    this.calendarProjections.markTaskCalendarBlockState(
      ownerId,
      taskId,
      state,
      now,
    );
  }

  reserveCalendarWrite(input: {
    readonly ownerId: string;
    readonly taskId: string;
    readonly expectedTaskRevision: number;
    readonly idempotencyKey: string;
    readonly requestHash: string;
    readonly calendarId: string;
    readonly reservedHref: string;
    readonly reservedUid: string;
    readonly now: string;
  }): CalendarWriteReservationResult {
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      const prior = this.#getCalendarWriteOperation(
        input.ownerId,
        input.idempotencyKey,
      );
      if (prior !== undefined) {
        this.#database.exec("COMMIT;");
        return prior.requestHash === input.requestHash
          ? { kind: "replayed", operation: prior }
          : { kind: "conflict" };
      }
      const task = this.getTask(input.ownerId, input.taskId);
      if (task === undefined) {
        this.#database.exec("COMMIT;");
        return { kind: "task-not-found" };
      }
      if (task.revision !== input.expectedTaskRevision) {
        this.#database.exec("COMMIT;");
        return { kind: "task-precondition-failed", task };
      }
      const calendar = this.getOwnedCalendar(input.ownerId, input.calendarId);
      if (calendar?.supportsEvents !== true) {
        this.#database.exec("COMMIT;");
        return { kind: "calendar-not-found" };
      }
      const operation: CalendarWriteOperationRecord = {
        ownerId: input.ownerId,
        idempotencyKey: input.idempotencyKey,
        requestHash: input.requestHash,
        taskId: input.taskId,
        providerId: calendar.providerId,
        calendarId: calendar.id,
        reservedHref: input.reservedHref,
        reservedUid: input.reservedUid,
        state: "pending_remote",
        blockId: null,
        createdAt: input.now,
        updatedAt: input.now,
      };
      this.#database
        .prepare(
          `INSERT INTO calendar_write_operations
            (owner_id, idempotency_key, request_hash, task_id, provider_id,
             calendar_id, reserved_href, reserved_uid, state, block_id,
             created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
        )
        .run(
          operation.ownerId,
          operation.idempotencyKey,
          operation.requestHash,
          operation.taskId,
          operation.providerId,
          operation.calendarId,
          operation.reservedHref,
          operation.reservedUid,
          operation.state,
          operation.createdAt,
          operation.updatedAt,
        );
      this.#database.exec("COMMIT;");
      return { kind: "reserved", operation };
    } catch (error: unknown) {
      this.#database.exec("ROLLBACK;");
      throw error;
    }
  }

  completeCalendarWrite(input: {
    readonly ownerId: string;
    readonly idempotencyKey: string;
    readonly event: Omit<CalendarEventProjectionRecord, "ownerId">;
    readonly plannedStart: string;
    readonly estimateMinutes: number;
    readonly now: string;
  }):
    | {
        readonly task: TaskRecord;
        readonly block: TaskCalendarBlockRecord;
        readonly event: CalendarEventProjectionRecord;
      }
    | undefined {
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      const operation = this.#getCalendarWriteOperation(
        input.ownerId,
        input.idempotencyKey,
      );
      if (operation === undefined) {
        this.#database.exec("COMMIT;");
        return undefined;
      }
      const currentTask = this.getTask(input.ownerId, operation.taskId);
      if (currentTask === undefined)
        throw new Error("Planning task is missing");
      const event: CalendarEventProjectionRecord = {
        ownerId: input.ownerId,
        ...input.event,
      };
      this.#putCalendarEvent(input.ownerId, input.event);
      const existing = this.getTaskCalendarBlock(
        input.ownerId,
        operation.taskId,
      );
      const block: TaskCalendarBlockRecord = {
        id: existing?.id ?? randomUUID(),
        ownerId: input.ownerId,
        taskId: operation.taskId,
        providerId: operation.providerId,
        calendarId: operation.calendarId,
        eventHref: event.href,
        eventUid: event.uid,
        remoteEtag: event.etag,
        state: "active",
        revision: (existing?.revision ?? 0) + 1,
        createdAt: existing?.createdAt ?? input.now,
        updatedAt: input.now,
      };
      this.#database
        .prepare(
          `INSERT INTO task_calendar_blocks
            (id, owner_id, task_id, provider_id, calendar_id, event_href,
             event_uid, remote_etag, state, revision, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(task_id) DO UPDATE SET
             provider_id = excluded.provider_id,
             calendar_id = excluded.calendar_id,
             event_href = excluded.event_href,
             event_uid = excluded.event_uid,
             remote_etag = excluded.remote_etag,
             state = excluded.state,
             revision = excluded.revision,
             updated_at = excluded.updated_at`,
        )
        .run(
          block.id,
          block.ownerId,
          block.taskId,
          block.providerId,
          block.calendarId,
          block.eventHref,
          block.eventUid,
          block.remoteEtag,
          block.state,
          block.revision,
          block.createdAt,
          block.updatedAt,
        );
      this.#database
        .prepare(
          `UPDATE calendar_write_operations
           SET state = 'completed', block_id = ?, updated_at = ?
           WHERE owner_id = ? AND idempotency_key = ?`,
        )
        .run(block.id, input.now, input.ownerId, input.idempotencyKey);
      const task: TaskRecord = {
        ...currentTask,
        plannedStart: input.plannedStart,
        estimateMinutes: input.estimateMinutes,
        revision: currentTask.revision + 1,
        updatedAt: input.now,
      };
      this.#database
        .prepare(
          `UPDATE tasks SET planned_start = ?, estimate_minutes = ?,
             revision = ?, updated_at = ? WHERE owner_id = ? AND id = ?`,
        )
        .run(
          task.plannedStart,
          task.estimateMinutes,
          task.revision,
          task.updatedAt,
          task.ownerId,
          task.id,
        );
      this.#database
        .prepare(
          "INSERT INTO task_field_versions (task_id,field,version) VALUES (?, 'estimateMinutes', ?) ON CONFLICT(task_id,field) DO UPDATE SET version=excluded.version",
        )
        .run(task.id, task.revision);
      this.#appendSyncChangeInTransaction(
        input.ownerId,
        "task",
        task.id,
        "upsert",
        task.revision,
        input.now,
      );
      this.#database.exec("COMMIT;");
      return { task, block, event };
    } catch (error: unknown) {
      this.#database.exec("ROLLBACK;");
      throw error;
    }
  }

  markCalendarWriteConflict(
    ownerId: string,
    idempotencyKey: string,
    now: string,
  ): void {
    this.calendarProjections.markCalendarWriteConflict(
      ownerId,
      idempotencyKey,
      now,
    );
  }

  getCalendarWriteOperation(
    ownerId: string,
    idempotencyKey: string,
  ): CalendarWriteOperationRecord | undefined {
    return this.calendarProjections.getCalendarWrite(ownerId, idempotencyKey);
  }

  #putCalendarEvent(
    ownerId: string,
    event: Omit<CalendarEventProjectionRecord, "ownerId">,
  ): void {
    this.#database
      .prepare(
        `INSERT INTO calendar_event_projections
          (id, owner_id, provider_id, calendar_id, href, uid, etag, raw_ics,
           summary, starts_at, ends_at, all_day, recurrence, freshness, mutable, revision,
           projected_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(calendar_id, href) DO UPDATE SET
           uid = excluded.uid, etag = excluded.etag, raw_ics = excluded.raw_ics,
           summary = excluded.summary, starts_at = excluded.starts_at,
           ends_at = excluded.ends_at, all_day = excluded.all_day, recurrence = excluded.recurrence,
           freshness = excluded.freshness, mutable = excluded.mutable,
           revision = calendar_event_projections.revision + 1,
           projected_at = excluded.projected_at`,
      )
      .run(
        event.id,
        ownerId,
        event.providerId,
        event.calendarId,
        event.href,
        event.uid,
        event.etag,
        event.rawIcs,
        event.summary,
        event.startsAt,
        event.endsAt,
        event.allDay ? 1 : 0,
        event.recurrence ?? "none",
        event.freshness,
        event.mutable ? 1 : 0,
        event.revision,
        event.projectedAt,
      );
  }

  #getCalendarWriteOperation(
    ownerId: string,
    idempotencyKey: string,
  ): CalendarWriteOperationRecord | undefined {
    const row = this.#database
      .prepare(
        `SELECT * FROM calendar_write_operations
         WHERE owner_id = ? AND idempotency_key = ?`,
      )
      .get(ownerId, idempotencyKey) as unknown as
      Record<string, string | null> | undefined;
    return row === undefined
      ? undefined
      : {
          ownerId: String(row.owner_id),
          idempotencyKey: String(row.idempotency_key),
          requestHash: String(row.request_hash),
          taskId: String(row.task_id),
          providerId: String(row.provider_id),
          calendarId: String(row.calendar_id),
          reservedHref: String(row.reserved_href),
          reservedUid: String(row.reserved_uid),
          state: row.state as CalendarWriteOperationRecord["state"],
          blockId: row.block_id === null ? null : String(row.block_id),
          createdAt: String(row.created_at),
          updatedAt: String(row.updated_at),
        };
  }

  #notificationDeliveryFromRow(
    row: Record<string, string | number | null>,
  ): NotificationDeliveryRecord {
    return {
      id: String(row.id),
      ownerId: String(row.owner_id),
      taskId: row.task_id === null ? null : String(row.task_id),
      occurrenceStart: String(row.occurrence_start),
      kind: String(row.reminder_kind) as NotificationDeliveryRecord["kind"],
      taskRevision:
        row.task_revision === null ? null : Number(row.task_revision),
      state: String(row.state) as NotificationDeliveryRecord["state"],
      dueAt: String(row.due_at),
      nextAttemptAt: String(row.next_attempt_at),
      attemptCount: Number(row.attempt_count),
      errorCode: row.error_code === null ? null : String(row.error_code),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      deliveredAt: row.delivered_at === null ? null : String(row.delivered_at),
    };
  }

  importTaskRecords(
    ownerId: string,
    records: readonly {
      kind: "project" | "tag" | "task" | "note";
      sourceId: string;
      sourceHash: string;
      sourceJson: string;
      title: string;
      /** Task notes, or the Markdown content of a note record. */
      notes: string;
      projectId: string | null;
      tagIds: readonly string[];
      plannedStart: string | null;
      deadlineDate: string | null;
      deadlineAt: string | null;
      estimateMinutes: number | null;
      completedAt: string | null;
      createdAt: string | null;
      // Organization parity (ADR 0019); records arrive in their display order.
      /** Archived at import time unless completion supplies the time. */
      archived?: boolean;
      color?: string | null;
      icon?: string | null;
      hiddenFromMenu?: boolean;
      backlogEnabled?: boolean;
      /** Source task IDs, applied after the batch's tasks exist. */
      backlogTaskIds?: readonly string[];
      pinnedToToday?: boolean;
    }[],
    now: string,
  ): { created: number; existing: number } {
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      const targets = new Map<string, string>();
      const backlogs: {
        projectId: string;
        sourceTaskIds: readonly string[];
      }[] = [];
      let created = 0;
      let existing = 0;
      for (const record of records) {
        const prior = this.#database
          .prepare(
            "SELECT target_id,source_hash FROM task_import_sources WHERE owner_id=? AND source_kind='super_productivity' AND entity_kind=? AND source_id=?",
          )
          .get(ownerId, record.kind, record.sourceId) as
          { target_id: string; source_hash: string } | undefined;
        if (prior !== undefined && prior.source_hash !== record.sourceHash)
          throw new Error("IMPORT_SOURCE_CHANGED");
        const id = prior?.target_id ?? randomUUID();
        targets.set(`${record.kind}:${record.sourceId}`, id);
        if (prior !== undefined) {
          existing++;
          continue;
        }
        const createdAt = record.createdAt ?? now;
        if (record.kind === "note") {
          const projectId =
            record.projectId === null
              ? null
              : targets.get(`project:${record.projectId}`);
          if (projectId === undefined)
            throw new Error("IMPORT_REFERENCE_MISSING");
          this.notes.insert(ownerId, {
            id,
            content: record.notes,
            projectId,
            tagId: null,
            pinnedToToday: record.pinnedToToday === true,
            createdAt,
            updatedAt: now,
          });
        } else if (record.kind === "project") {
          this.createProject({
            id,
            ownerId,
            title: record.title,
            revision: 1,
            createdAt,
            updatedAt: now,
            // Completing a Super Productivity project also archives it.
            archivedAt:
              record.completedAt ?? (record.archived === true ? now : null),
            completedAt: record.completedAt,
            color: record.color ?? null,
            icon: record.icon ?? null,
            hiddenFromMenu: record.hiddenFromMenu === true,
            backlogEnabled: record.backlogEnabled === true,
          });
          if ((record.backlogTaskIds ?? []).length > 0)
            backlogs.push({
              projectId: id,
              sourceTaskIds: record.backlogTaskIds ?? [],
            });
          this.#appendSyncChangeInTransaction(
            ownerId,
            "project",
            id,
            "upsert",
            1,
            now,
          );
        } else if (record.kind === "tag") {
          this.createTag({
            id,
            ownerId,
            title: record.title,
            normalizedName: record.title.normalize("NFKC").toLocaleLowerCase(),
            revision: 1,
            createdAt,
            updatedAt: now,
            archivedAt: record.archived === true ? now : null,
            color: record.color ?? null,
            icon: record.icon ?? null,
          });
          this.#appendSyncChangeInTransaction(
            ownerId,
            "tag",
            id,
            "upsert",
            1,
            now,
          );
        } else {
          const mapped = (kind: string, sourceId: string) => {
            const value = targets.get(`${kind}:${sourceId}`);
            if (value === undefined)
              throw new Error("IMPORT_REFERENCE_MISSING");
            return value;
          };
          const result = this.createTaskIdempotently(
            ownerId,
            `sp-import:${id}`,
            record.sourceHash,
            {
              id,
              title: record.title,
              notes: record.notes,
              status: record.completedAt === null ? "open" : "completed",
              revision: 1,
              createdAt,
              updatedAt: now,
              plannedStart: record.plannedStart,
              deadlineDate: record.deadlineDate,
              deadlineAt: record.deadlineAt,
              estimateMinutes: record.estimateMinutes,
              projectId:
                record.projectId === null
                  ? null
                  : mapped("project", record.projectId),
              tagIds: record.tagIds.map((sourceId) => mapped("tag", sourceId)),
            },
          );
          if (result.kind !== "created")
            throw new Error("IMPORT_CREATE_CONFLICT");
          this.#database
            .prepare(
              "UPDATE tasks SET completed_at=? WHERE owner_id=? AND id=?",
            )
            .run(record.completedAt, ownerId, id);
        }
        this.#database
          .prepare(
            "INSERT INTO task_import_sources (owner_id,source_kind,entity_kind,source_id,target_id,source_hash,source_json,imported_at) VALUES (?,'super_productivity',?,?,?,?,?,?)",
          )
          .run(
            ownerId,
            record.kind,
            record.sourceId,
            id,
            record.sourceHash,
            record.sourceJson,
            now,
          );
        created++;
      }
      const addToBacklog = this.#database.prepare(
        "INSERT INTO project_backlog_tasks (owner_id,project_id,task_id,position) SELECT ?,?,id,? FROM tasks WHERE owner_id=? AND id=? AND project_id=?",
      );
      for (const backlog of backlogs)
        backlog.sourceTaskIds.forEach((sourceId, position) => {
          const taskId = targets.get(`task:${sourceId}`);
          if (taskId === undefined) throw new Error("IMPORT_REFERENCE_MISSING");
          if (
            addToBacklog.run(
              ownerId,
              backlog.projectId,
              position,
              ownerId,
              taskId,
              backlog.projectId,
            ).changes !== 1
          )
            throw new Error("IMPORT_REFERENCE_MISSING");
        });
      this.#database.exec("COMMIT;");
      return { created, existing };
    } catch (error) {
      this.#database.exec("ROLLBACK;");
      throw error;
    }
  }

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
    > &
      Partial<Pick<TaskRecord, "plannedStart" | "estimateMinutes">>,
    resolve?: () => Partial<
      Pick<
        TaskRecord,
        | "title"
        | "plannedStart"
        | "deadlineDate"
        | "deadlineAt"
        | "projectId"
        | "tagIds"
      >
    >,
  ): IdempotentTaskCreateResult {
    this.#database.exec("SAVEPOINT create_task;");
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
          this.#database.exec("RELEASE SAVEPOINT create_task;");
          return { kind: "conflict" };
        }
        const replayed = this.#findTask(ownerId, prior.resource_id);
        if (replayed === undefined)
          throw new Error("Idempotency record refers to a missing task");
        this.#database.exec("RELEASE SAVEPOINT create_task;");
        return { kind: "replayed", task: replayed };
      }

      task = { ...task, ...resolve?.() };
      if (
        task.projectId != null &&
        this.#database
          .prepare(
            "SELECT 1 FROM projects WHERE id=? AND owner_id=? AND archived_at IS NULL",
          )
          .get(task.projectId, ownerId) === undefined
      )
        throw new StructuredCaptureError("Project is unknown or archived");
      if (
        (task.tagIds?.length ?? 0) > 25 ||
        new Set(task.tagIds ?? []).size !== (task.tagIds?.length ?? 0)
      )
        throw new StructuredCaptureError(
          "Task tags must be unique and limited to 25",
        );
      for (const tagId of task.tagIds ?? []) {
        if (
          this.#database
            .prepare(
              "SELECT 1 FROM tags WHERE id=? AND owner_id=? AND archived_at IS NULL",
            )
            .get(tagId, ownerId) === undefined
        )
          throw new StructuredCaptureError("Tag is unknown or archived");
      }
      const created: TaskRecord = {
        ownerId,
        ...task,
        completedAt: null,
        deletedAt: null,
        plannedStart: task.plannedStart ?? null,
        estimateMinutes: task.estimateMinutes ?? null,
        deadlineDate: task.deadlineDate ?? null,
        deadlineAt: task.deadlineAt ?? null,
        projectId: task.projectId ?? null,
        tagIds: task.tagIds ?? [],
      };
      this.#database
        .prepare(
          `INSERT INTO tasks
            (id, owner_id, title, notes, status, revision, created_at, updated_at, planned_start, project_id, deadline_date, deadline_at, estimate_minutes)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          created.plannedStart,
          created.projectId ?? null,
          created.deadlineDate ?? null,
          created.deadlineAt ?? null,
          created.estimateMinutes,
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
        "deadline",
      ])
        initialFieldVersion.run(created.id, field);
      const insertTag = this.#database.prepare(
        "INSERT INTO task_tags (task_id, tag_id) VALUES (?, ?)",
      );
      for (const tagId of created.tagIds ?? [])
        insertTag.run(created.id, tagId);
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
      this.#database.exec("RELEASE SAVEPOINT create_task;");
      return { kind: "created", task: created };
    } catch (error: unknown) {
      this.#database.exec(
        "ROLLBACK TO SAVEPOINT create_task; RELEASE SAVEPOINT create_task;",
      );
      throw error;
    }
  }

  listTasks(ownerId: string): readonly TaskRecord[] {
    const rows = this.#database
      .prepare(
        `SELECT id, owner_id, title, notes, status, revision, created_at, updated_at,
                completed_at, deleted_at, planned_start, estimate_minutes, deadline_date, deadline_at
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

  createHabit(record: HabitRecord): void {
    this.#database
      .prepare(
        `INSERT INTO habits
          (id,owner_id,title,cadence_json,started_on,time_zone,revision,created_at,updated_at,archived_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        record.id,
        record.ownerId,
        record.title,
        JSON.stringify(record.cadence),
        record.startedOn,
        record.timeZone,
        record.revision,
        record.createdAt,
        record.updatedAt,
        record.archivedAt,
      );
  }

  listHabits(ownerId: string): readonly HabitRecord[] {
    const rows = this.#database
      .prepare(
        "SELECT * FROM habits WHERE owner_id=? ORDER BY archived_at IS NOT NULL,created_at DESC,id DESC",
      )
      .all(ownerId) as unknown as readonly Record<
      string,
      string | number | null
    >[];
    return rows.map((row) => ({
      id: String(row.id),
      ownerId: String(row.owner_id),
      title: String(row.title),
      cadence: JSON.parse(String(row.cadence_json)) as unknown,
      startedOn: String(row.started_on),
      timeZone: String(row.time_zone),
      revision: Number(row.revision),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      archivedAt: row.archived_at === null ? null : String(row.archived_at),
    }));
  }

  recordHabitOccurrence(record: HabitOccurrenceRecord): boolean {
    return (
      this.#database
        .prepare(
          `INSERT INTO habit_occurrences (id,habit_id,period_key,completed_at,created_at)
           VALUES (?,?,?,?,?) ON CONFLICT(habit_id,period_key) DO NOTHING`,
        )
        .run(
          record.id,
          record.habitId,
          record.periodKey,
          record.completedAt,
          record.createdAt,
        ).changes === 1
    );
  }

  listHabitOccurrences(habitId: string): readonly HabitOccurrenceRecord[] {
    const rows = this.#database
      .prepare(
        "SELECT * FROM habit_occurrences WHERE habit_id=? ORDER BY period_key,id",
      )
      .all(habitId) as unknown as readonly Record<string, string>[];
    return rows.map((row) => ({
      id: String(row.id),
      habitId: String(row.habit_id),
      periodKey: String(row.period_key),
      completedAt: String(row.completed_at),
      createdAt: String(row.created_at),
    }));
  }

  listDeletedTasks(ownerId: string): readonly TaskRecord[] {
    const rows = this.#database
      .prepare(
        `SELECT id, owner_id, title, notes, status, revision, created_at, updated_at,
                completed_at, deleted_at, planned_start, estimate_minutes, deadline_date, deadline_at
         FROM tasks WHERE owner_id = ? AND deleted_at IS NOT NULL
         ORDER BY deleted_at DESC, id DESC`,
      )
      .all(ownerId) as unknown as readonly TaskRow[];
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
                completed_at, deleted_at, planned_start, estimate_minutes, deadline_date, deadline_at
         FROM tasks WHERE owner_id = ? AND id = ?
           AND (? = 1 OR deleted_at IS NULL)`,
      )
      .get(ownerId, taskId, includeDeleted ? 1 : 0) as unknown as
      TaskRow | undefined;
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
        ...(patch.deadlineDate === undefined
          ? {}
          : { deadlineDate: patch.deadlineDate }),
        ...(patch.deadlineAt === undefined
          ? {}
          : { deadlineAt: patch.deadlineAt }),
      }),
      now,
    );
  }

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

  registerSyncClient(
    input: SyncClientRecord,
  ): "registered" | "already-registered" {
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      const existing = this.#database
        .prepare(
          "SELECT credential_hash FROM client_identities WHERE id = ? AND owner_id = ?",
        )
        .get(input.id, input.ownerId) as unknown as
        { credential_hash: string | null } | undefined;
      if (existing !== undefined) {
        this.#database.exec("COMMIT;");
        return existing.credential_hash === input.credentialHash
          ? "already-registered"
          : "registered";
      }
      this.#database
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
      this.#database.exec("COMMIT;");
      return "registered";
    } catch (error) {
      this.#database.exec("ROLLBACK;");
      throw error;
    }
  }

  authenticateSyncClient(
    ownerId: string,
    clientId: string,
    credentialHash: string,
    now: string,
  ): SyncClientRecord | undefined {
    const row = this.#database
      .prepare(
        `SELECT * FROM client_identities WHERE id = ? AND owner_id = ? AND credential_hash = ? AND revoked_at IS NULL`,
      )
      .get(clientId, ownerId, credentialHash) as unknown as
      Record<string, string | null> | undefined;
    if (row === undefined) return undefined;
    this.#database
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
    const rows = this.#database
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
      this.#database
        .prepare(
          "UPDATE client_identities SET revoked_at = ? WHERE owner_id = ? AND id = ? AND revoked_at IS NULL",
        )
        .run(now, ownerId, clientId).changes === 1
    );
  }

  createAutomationToken(record: AutomationTokenRecord): void {
    this.#database
      .prepare(
        `INSERT INTO automation_tokens
          (id,owner_id,label,secret_hash,scopes_json,created_at,last_used_at,expires_at,revoked_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        record.id,
        record.ownerId,
        record.label,
        record.secretHash,
        JSON.stringify([...record.scopes].sort()),
        record.createdAt,
        record.lastUsedAt,
        record.expiresAt,
        record.revokedAt,
      );
  }

  createAutomationTokenWithController(
    record: AutomationTokenRecord,
    controllerCredentialHash: string,
  ): void {
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      this.createAutomationToken(record);
      this.#database
        .prepare(
          `INSERT INTO client_identities
            (id,owner_id,label,credential_hash,created_at,last_seen_at,revoked_at)
           VALUES (?,?,?,?,?,?,NULL)`,
        )
        .run(
          record.id,
          record.ownerId,
          `automation:${record.label}`,
          controllerCredentialHash,
          record.createdAt,
          record.createdAt,
        );
      this.#database.exec("COMMIT;");
    } catch (error) {
      this.#database.exec("ROLLBACK;");
      throw error;
    }
  }

  listAutomationTokens(ownerId: string): readonly AutomationTokenRecord[] {
    const rows = this.#database
      .prepare(
        "SELECT * FROM automation_tokens WHERE owner_id=? ORDER BY created_at,id",
      )
      .all(ownerId) as unknown as readonly Record<string, string | null>[];
    return rows.map((row) => this.#automationTokenFromRow(row));
  }

  authenticateAutomationToken(
    tokenId: string,
    secretHash: string,
    now: string,
  ): AutomationTokenRecord | undefined {
    const row = this.#database
      .prepare(
        `SELECT * FROM automation_tokens WHERE id=? AND secret_hash=?
         AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)`,
      )
      .get(tokenId, secretHash, now) as unknown as
      Record<string, string | null> | undefined;
    if (row === undefined) return undefined;
    this.#database
      .prepare("UPDATE automation_tokens SET last_used_at=? WHERE id=?")
      .run(now, tokenId);
    return { ...this.#automationTokenFromRow(row), lastUsedAt: now };
  }

  revokeAutomationToken(
    ownerId: string,
    tokenId: string,
    now: string,
  ): boolean {
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      const revoked = this.#database
        .prepare(
          "UPDATE automation_tokens SET revoked_at=? WHERE owner_id=? AND id=? AND revoked_at IS NULL",
        )
        .run(now, ownerId, tokenId).changes;
      if (revoked !== 1) {
        this.#database.exec("ROLLBACK;");
        return false;
      }
      this.#database
        .prepare(
          "UPDATE client_identities SET revoked_at=? WHERE owner_id=? AND id=? AND revoked_at IS NULL",
        )
        .run(now, ownerId, tokenId);
      const active = this.#database
        .prepare(
          `SELECT id,revision FROM active_sessions
           WHERE owner_id=? AND controller_client_id=? AND ended_at IS NULL`,
        )
        .get(ownerId, tokenId) as unknown as
        { readonly id: string; readonly revision: number } | undefined;
      if (active !== undefined) {
        const revision = active.revision + 1;
        this.#database
          .prepare(
            `UPDATE active_session_intervals SET ended_at=?,closed_by='expiry'
             WHERE session_id=? AND ended_at IS NULL`,
          )
          .run(now, active.id);
        this.#database
          .prepare(
            `UPDATE active_sessions SET controller_client_id=NULL,state='expired',
             revision=?,lease_expires_at=NULL,hard_expires_at=NULL,updated_at=?,ended_at=?
             WHERE id=? AND revision=?`,
          )
          .run(revision, now, now, active.id, active.revision);
        this.#database
          .prepare(
            `INSERT INTO active_session_events
              (id,session_id,kind,revision,actor_client_id,created_at)
             VALUES (?,?,'automation-revoked',?,NULL,?)`,
          )
          .run(randomUUID(), active.id, revision, now);
        this.#appendSyncChangeInTransaction(
          ownerId,
          "active_session",
          active.id,
          "upsert",
          revision,
          now,
        );
      }
      this.#database.exec("COMMIT;");
      return true;
    } catch (error) {
      this.#database.exec("ROLLBACK;");
      throw error;
    }
  }

  createAutomationPreview(record: AutomationPreviewRecord): void {
    this.#database
      .prepare(
        `INSERT INTO automation_previews
          (id,owner_id,token_id,operation,input_hash,input_json,summary,affected_ids_json,
           base_revisions_json,expires_at,consumed_at,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        record.id,
        record.ownerId,
        record.tokenId,
        record.operation,
        record.inputHash,
        JSON.stringify(record.input),
        record.summary,
        JSON.stringify(record.affectedIds),
        JSON.stringify(record.baseRevisions),
        record.expiresAt,
        record.consumedAt,
        record.createdAt,
      );
  }

  getAutomationPreview(previewId: string): AutomationPreviewRecord | undefined {
    const row = this.#database
      .prepare("SELECT * FROM automation_previews WHERE id=?")
      .get(previewId) as unknown as Record<string, string | null> | undefined;
    if (row === undefined) return undefined;
    return {
      id: String(row.id),
      ownerId: String(row.owner_id),
      tokenId: String(row.token_id),
      operation: String(row.operation),
      inputHash: String(row.input_hash),
      input: JSON.parse(String(row.input_json)) as unknown,
      summary: String(row.summary),
      affectedIds: JSON.parse(String(row.affected_ids_json)) as string[],
      baseRevisions: JSON.parse(String(row.base_revisions_json)) as Record<
        string,
        number
      >,
      expiresAt: String(row.expires_at),
      consumedAt: row.consumed_at ?? null,
      createdAt: String(row.created_at),
    };
  }

  consumeAutomationPreview(previewId: string, now: string): boolean {
    return (
      this.#database
        .prepare(
          "UPDATE automation_previews SET consumed_at=? WHERE id=? AND consumed_at IS NULL AND expires_at>?",
        )
        .run(now, previewId, now).changes === 1
    );
  }

  getAutomationOutcome(
    ownerId: string,
    tokenId: string,
    operation: string,
    idempotencyKey: string,
  ): AutomationOutcomeRecord | undefined {
    const row = this.#database
      .prepare(
        `SELECT * FROM automation_operation_outcomes
         WHERE owner_id=? AND token_id=? AND operation=? AND idempotency_key=?`,
      )
      .get(ownerId, tokenId, operation, idempotencyKey) as unknown as
      Record<string, string> | undefined;
    return row === undefined
      ? undefined
      : {
          ownerId: String(row.owner_id),
          tokenId: String(row.token_id),
          operation: String(row.operation),
          idempotencyKey: String(row.idempotency_key),
          requestHash: String(row.request_hash),
          previewId: String(row.preview_id),
          response: JSON.parse(String(row.response_json)) as unknown,
          createdAt: String(row.created_at),
        };
  }

  putAutomationOutcome(record: AutomationOutcomeRecord): void {
    this.#database
      .prepare(
        `INSERT INTO automation_operation_outcomes
          (owner_id,token_id,operation,idempotency_key,request_hash,preview_id,response_json,created_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(
        record.ownerId,
        record.tokenId,
        record.operation,
        record.idempotencyKey,
        record.requestHash,
        record.previewId,
        JSON.stringify(record.response),
        record.createdAt,
      );
  }

  completeAutomationConfirmation(
    previewId: string,
    outcome: AutomationOutcomeRecord,
    audit: AutomationAuditRecord,
    now: string,
    prepareResponse?: () => unknown,
  ): boolean {
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      const consumed = this.#database
        .prepare(
          "UPDATE automation_previews SET consumed_at=? WHERE id=? AND consumed_at IS NULL AND expires_at>?",
        )
        .run(now, previewId, now).changes;
      if (consumed !== 1) {
        this.#database.exec("ROLLBACK;");
        return false;
      }
      const response =
        prepareResponse === undefined ? outcome.response : prepareResponse();
      this.#database
        .prepare(
          `INSERT INTO automation_operation_outcomes
            (owner_id,token_id,operation,idempotency_key,request_hash,preview_id,response_json,created_at)
           VALUES (?,?,?,?,?,?,?,?)`,
        )
        .run(
          outcome.ownerId,
          outcome.tokenId,
          outcome.operation,
          outcome.idempotencyKey,
          outcome.requestHash,
          outcome.previewId,
          JSON.stringify(response),
          outcome.createdAt,
        );
      this.#database
        .prepare(
          `INSERT INTO automation_audit_log
            (id,owner_id,token_id,operation,phase,outcome,error_code,preview_id,
             affected_ids_json,request_hash,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          audit.id,
          audit.ownerId,
          audit.tokenId,
          audit.operation,
          audit.phase,
          audit.outcome,
          audit.errorCode,
          audit.previewId,
          JSON.stringify(audit.affectedIds),
          audit.requestHash,
          audit.createdAt,
        );
      this.#database.exec("COMMIT;");
      return true;
    } catch (error) {
      this.#database.exec("ROLLBACK;");
      throw error;
    }
  }

  appendAutomationAudit(record: AutomationAuditRecord): void {
    this.#database
      .prepare(
        `INSERT INTO automation_audit_log
          (id,owner_id,token_id,operation,phase,outcome,error_code,preview_id,
           affected_ids_json,request_hash,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        record.id,
        record.ownerId,
        record.tokenId,
        record.operation,
        record.phase,
        record.outcome,
        record.errorCode,
        record.previewId,
        JSON.stringify(record.affectedIds),
        record.requestHash,
        record.createdAt,
      );
  }

  listAutomationAudit(ownerId: string): readonly AutomationAuditRecord[] {
    const rows = this.#database
      .prepare(
        "SELECT * FROM automation_audit_log WHERE owner_id=? ORDER BY created_at,id",
      )
      .all(ownerId) as unknown as readonly Record<string, string | null>[];
    return rows.map((row) => ({
      id: String(row.id),
      ownerId: String(row.owner_id),
      tokenId: String(row.token_id),
      operation: String(row.operation),
      phase: String(row.phase) as AutomationAuditRecord["phase"],
      outcome: String(row.outcome) as AutomationAuditRecord["outcome"],
      errorCode: row.error_code ?? null,
      previewId: row.preview_id ?? null,
      affectedIds: JSON.parse(String(row.affected_ids_json)) as string[],
      requestHash: row.request_hash ?? null,
      createdAt: String(row.created_at),
    }));
  }

  #automationTokenFromRow(
    row: Record<string, string | null>,
  ): AutomationTokenRecord {
    return {
      id: String(row.id),
      ownerId: String(row.owner_id),
      label: String(row.label),
      secretHash: String(row.secret_hash),
      scopes: JSON.parse(String(row.scopes_json)) as string[],
      createdAt: String(row.created_at),
      lastUsedAt: row.last_used_at ?? null,
      expiresAt: row.expires_at ?? null,
      revokedAt: row.revoked_at ?? null,
    };
  }

  appendSyncChange(
    ownerId: string,
    entityType: string,
    entityId: string,
    kind: string,
    revision: number,
    now: string,
  ): SyncChangeRecord {
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      const change = this.#appendSyncChangeInTransaction(
        ownerId,
        entityType,
        entityId,
        kind,
        revision,
        now,
      );
      this.#database.exec("COMMIT;");
      return change;
    } catch (error) {
      this.#database.exec("ROLLBACK;");
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

  listSyncChanges(
    ownerId: string,
    epoch: string,
    afterSequence: number,
  ): readonly SyncChangeRecord[] {
    return (
      this.#database
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
    const row = this.#database
      .prepare(
        "SELECT epoch, next_sequence FROM sync_owner_state WHERE owner_id=?",
      )
      .get(ownerId) as unknown as
      { epoch: string; next_sequence: number } | undefined;
    if (row !== undefined)
      return { epoch: row.epoch, cursor: row.next_sequence - 1 };
    const now = new Date().toISOString();
    const epoch = randomUUID();
    this.#database
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

  getTaskFieldVersions(
    ownerId: string,
    taskId: string,
  ): Readonly<Record<string, number>> {
    if (this.getTask(ownerId, taskId, true) === undefined) return {};
    const rows = this.#database
      .prepare("SELECT field,version FROM task_field_versions WHERE task_id=?")
      .all(taskId) as unknown as readonly { field: string; version: number }[];
    return Object.fromEntries(rows.map((row) => [row.field, row.version]));
  }

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
    const tasks = this.listTasks(ownerId);
    const subtasks = tasks.flatMap((task) =>
      this.listSubtasks(ownerId, task.id),
    );
    const templates = this.listTaskTemplates(ownerId, "", true);
    return {
      tasks,
      projects: this.listProjects(ownerId),
      tags: this.listTags(ownerId),
      subtasks,
      templates,
      templateBlueprints: templates.flatMap((template) =>
        this.listTemplateSubtaskBlueprints(template.id),
      ),
      templateSets: this.listTemplateSets(ownerId, true),
      cursor: this.getSyncState(ownerId),
    };
  }

  /** Shared HTTP/assistant lifecycle boundary; safe inside confirmation transactions. */
  mutateOrganization(
    kind: "project" | "tag",
    ownerId: string,
    id: string,
    expectedRevision: number | null,
    fields: OrganizationFields,
    now: string,
  ): ProjectRecord | TagRecord | undefined {
    const title = fields.title?.trim();
    const color =
      typeof fields.color === "string"
        ? fields.color.toLowerCase()
        : fields.color;
    const projectOnly = [
      fields.completed,
      fields.hiddenFromMenu,
      fields.backlogEnabled,
    ];
    if (
      (title !== undefined &&
        (title.length === 0 ||
          title.length > (kind === "project" ? 240 : 100))) ||
      (fields.archived !== undefined && typeof fields.archived !== "boolean") ||
      (fields.completed !== undefined &&
        typeof fields.completed !== "boolean") ||
      (fields.archived !== undefined && fields.completed !== undefined) ||
      (kind === "tag" && projectOnly.some((value) => value !== undefined)) ||
      (typeof color === "string" && !colorPattern.test(color)) ||
      (typeof fields.icon === "string" &&
        !organizationIconPattern.test(fields.icon)) ||
      Object.values(fields).every((value) => value === undefined)
    )
      return undefined;
    this.#database.exec("SAVEPOINT organization_mutation;");
    try {
      const current =
        kind === "project"
          ? this.#project(ownerId, id)
          : this.#tag(ownerId, id);
      if (
        (expectedRevision === null &&
          (current !== undefined ||
            title === undefined ||
            fields.archived !== undefined ||
            fields.completed !== undefined)) ||
        (expectedRevision !== null && current?.revision !== expectedRevision)
      ) {
        this.#database.exec("RELEASE SAVEPOINT organization_mutation;");
        return undefined;
      }
      if (expectedRevision === null) {
        const record = {
          id,
          ownerId,
          title: title ?? "",
          revision: 1,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          color: color ?? null,
          icon: fields.icon ?? null,
          position: this.#nextOrganizationPosition(kind, ownerId),
        };
        if (kind === "project")
          this.createProject({
            ...record,
            hiddenFromMenu: fields.hiddenFromMenu ?? false,
            backlogEnabled: fields.backlogEnabled ?? false,
          });
        else
          this.createTag({
            ...record,
            normalizedName: record.title.normalize("NFKC").toLocaleLowerCase(),
          });
      } else {
        if (current === undefined) throw new Error("Organization disappeared");
        const nextTitle = title ?? current.title;
        let archivedAt = current.archivedAt;
        let completedAt = "completedAt" in current ? current.completedAt : null;
        if (fields.archived === true) archivedAt = current.archivedAt ?? now;
        // Restoring an archive also reopens a completed project (SP 19.1.0).
        if (fields.archived === false || fields.completed === false) {
          archivedAt = null;
          completedAt = null;
        }
        if (fields.completed === true) {
          completedAt = completedAt ?? now;
          archivedAt = current.archivedAt ?? now;
        }
        const nextColor = color === undefined ? current.color : color;
        const nextIcon = fields.icon === undefined ? current.icon : fields.icon;
        if (kind === "project" && "completedAt" in current) {
          this.#database
            .prepare(
              "UPDATE projects SET title=?, archived_at=?, completed_at=?, color=?, icon=?, hidden_from_menu=?, backlog_enabled=?, revision=revision+1, updated_at=? WHERE owner_id=? AND id=? AND revision=?",
            )
            .run(
              nextTitle,
              archivedAt,
              completedAt,
              nextColor,
              nextIcon,
              (fields.hiddenFromMenu ?? current.hiddenFromMenu) ? 1 : 0,
              (fields.backlogEnabled ?? current.backlogEnabled) ? 1 : 0,
              now,
              ownerId,
              id,
              expectedRevision,
            );
          // Disabling a backlog returns its tasks to the regular list (SP 19.1.0).
          if (fields.backlogEnabled === false)
            this.#database
              .prepare(
                "DELETE FROM project_backlog_tasks WHERE owner_id=? AND project_id=?",
              )
              .run(ownerId, id);
        } else {
          this.#database
            .prepare(
              "UPDATE tags SET display_name=?, normalized_name=?, archived_at=?, color=?, icon=?, revision=revision+1, updated_at=? WHERE owner_id=? AND id=? AND revision=?",
            )
            .run(
              nextTitle,
              nextTitle.normalize("NFKC").toLocaleLowerCase(),
              archivedAt,
              nextColor,
              nextIcon,
              now,
              ownerId,
              id,
              expectedRevision,
            );
        }
      }
      const result =
        kind === "project"
          ? this.#project(ownerId, id)
          : this.#tag(ownerId, id);
      if (result === undefined) throw new Error("Organization result missing");
      this.#appendSyncChangeInTransaction(
        ownerId,
        kind,
        id,
        "upsert",
        result.revision,
        now,
      );
      this.#database.exec("RELEASE SAVEPOINT organization_mutation;");
      return result;
    } catch (error) {
      this.#database.exec(
        "ROLLBACK TO SAVEPOINT organization_mutation; RELEASE SAVEPOINT organization_mutation;",
      );
      throw error;
    }
  }

  /**
   * Replaces the owner's complete project or tag order. Every record must be
   * listed with its current revision; only moved records gain a revision.
   */
  reorderOrganization(
    kind: "project" | "tag",
    ownerId: string,
    items: readonly { readonly id: string; readonly revision: number }[],
    now: string,
  ): readonly (ProjectRecord | TagRecord)[] | undefined {
    this.#database.exec("SAVEPOINT organization_order;");
    try {
      const current: readonly (ProjectRecord | TagRecord)[] =
        kind === "project"
          ? this.listProjects(ownerId)
          : this.listTags(ownerId);
      if (
        current.length !== items.length ||
        new Set(items.map(({ id }) => id)).size !== items.length ||
        items.some(
          (item) =>
            current.find(({ id }) => id === item.id)?.revision !==
            item.revision,
        )
      ) {
        this.#database.exec("RELEASE SAVEPOINT organization_order;");
        return undefined;
      }
      const update = this.#database.prepare(
        `UPDATE ${kind === "project" ? "projects" : "tags"} SET position=?, revision=revision+1, updated_at=? WHERE owner_id=? AND id=?`,
      );
      items.forEach((item, position) => {
        const before = current.find(({ id }) => id === item.id);
        if (before === undefined || before.position === position) return;
        update.run(position, now, ownerId, item.id);
        this.#appendSyncChangeInTransaction(
          ownerId,
          kind,
          item.id,
          "upsert",
          before.revision + 1,
          now,
        );
      });
      const result =
        kind === "project"
          ? this.listProjects(ownerId)
          : this.listTags(ownerId);
      this.#database.exec("RELEASE SAVEPOINT organization_order;");
      return result;
    } catch (error) {
      this.#database.exec(
        "ROLLBACK TO SAVEPOINT organization_order; RELEASE SAVEPOINT organization_order;",
      );
      throw error;
    }
  }

  /**
   * Moves one active task of an unarchived, backlog-enabled project into or out
   * of that project's backlog. Membership belongs to the project record.
   */
  setProjectBacklog(
    ownerId: string,
    projectId: string,
    expectedRevision: number,
    taskId: string,
    inBacklog: boolean,
    now: string,
  ):
    | { readonly kind: "applied"; readonly project: ProjectRecord }
    | { readonly kind: "conflict" | "invalid" } {
    this.#database.exec("SAVEPOINT project_backlog;");
    try {
      const project = this.#project(ownerId, projectId);
      if (project?.revision !== expectedRevision) {
        this.#database.exec("RELEASE SAVEPOINT project_backlog;");
        return { kind: "conflict" };
      }
      const task = this.getTask(ownerId, taskId);
      if (
        !project.backlogEnabled ||
        project.archivedAt !== null ||
        task?.projectId !== projectId ||
        project.backlogTaskIds.includes(taskId) === inBacklog
      ) {
        this.#database.exec("RELEASE SAVEPOINT project_backlog;");
        return { kind: "invalid" };
      }
      if (inBacklog)
        this.#database
          .prepare(
            "INSERT INTO project_backlog_tasks (owner_id,project_id,task_id,position) VALUES (?,?,?,(SELECT coalesce(max(position)+1,0) FROM project_backlog_tasks WHERE owner_id=? AND project_id=?)) ON CONFLICT(task_id) DO UPDATE SET project_id=excluded.project_id, position=excluded.position",
          )
          .run(ownerId, projectId, taskId, ownerId, projectId);
      else
        this.#database
          .prepare(
            "DELETE FROM project_backlog_tasks WHERE owner_id=? AND task_id=?",
          )
          .run(ownerId, taskId);
      this.#database
        .prepare(
          "UPDATE projects SET revision=revision+1, updated_at=? WHERE owner_id=? AND id=?",
        )
        .run(now, ownerId, projectId);
      const updated = this.#project(ownerId, projectId);
      if (updated === undefined) throw new Error("Backlog project missing");
      this.#appendSyncChangeInTransaction(
        ownerId,
        "project",
        projectId,
        "upsert",
        updated.revision,
        now,
      );
      this.#database.exec("RELEASE SAVEPOINT project_backlog;");
      return { kind: "applied", project: updated };
    } catch (error) {
      this.#database.exec(
        "ROLLBACK TO SAVEPOINT project_backlog; RELEASE SAVEPOINT project_backlog;",
      );
      throw error;
    }
  }

  #nextOrganizationPosition(kind: "project" | "tag", ownerId: string): number {
    return Number(
      (
        this.#database
          .prepare(
            `SELECT coalesce(max(position) + 1, 0) AS next FROM ${kind === "project" ? "projects" : "tags"} WHERE owner_id=?`,
          )
          .get(ownerId) as { next: unknown }
      ).next,
    );
  }

  createProject(record: ProjectCreateRecord): void {
    this.#database
      .prepare(
        "INSERT INTO projects (id, owner_id, title, revision, created_at, updated_at, archived_at, color, icon, position, hidden_from_menu, completed_at, backlog_enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        record.id,
        record.ownerId,
        record.title,
        record.revision,
        record.createdAt,
        record.updatedAt,
        record.archivedAt,
        record.color ?? null,
        record.icon ?? null,
        record.position ??
          this.#nextOrganizationPosition("project", record.ownerId),
        record.hiddenFromMenu === true ? 1 : 0,
        record.completedAt ?? null,
        record.backlogEnabled === true ? 1 : 0,
      );
  }
  archiveProject(
    ownerId: string,
    id: string,
    expectedRevision: number,
    now: string,
  ): ProjectRecord | undefined {
    const result = this.#database
      .prepare(
        "UPDATE projects SET archived_at = ?, revision = revision + 1, updated_at = ? WHERE owner_id = ? AND id = ? AND revision = ? AND archived_at IS NULL",
      )
      .run(now, now, ownerId, id, expectedRevision);
    return result.changes === 1 ? this.#project(ownerId, id) : undefined;
  }
  listProjects(ownerId: string): readonly ProjectRecord[] {
    return (
      this.#database
        .prepare(
          "SELECT * FROM projects WHERE owner_id = ? ORDER BY archived_at IS NOT NULL, position, title COLLATE NOCASE, id",
        )
        .all(ownerId) as unknown as readonly Record<
        string,
        string | number | null
      >[]
    ).map((row) => this.#projectFromRow(row, this.#backlogTaskIds(ownerId)));
  }
  renameProject(
    ownerId: string,
    id: string,
    expectedRevision: number,
    title: string,
    now: string,
  ): ProjectRecord | undefined {
    const result = this.#database
      .prepare(
        "UPDATE projects SET title=?,revision=revision+1,updated_at=? WHERE owner_id=? AND id=? AND revision=?",
      )
      .run(title, now, ownerId, id, expectedRevision);
    return result.changes === 1 ? this.#project(ownerId, id) : undefined;
  }
  createTag(record: TagCreateRecord): void {
    this.#database
      .prepare(
        "INSERT INTO tags (id, owner_id, display_name, normalized_name, revision, created_at, updated_at, archived_at, color, icon, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
        record.color ?? null,
        record.icon ?? null,
        record.position ??
          this.#nextOrganizationPosition("tag", record.ownerId),
      );
  }
  archiveTag(
    ownerId: string,
    id: string,
    expectedRevision: number,
    now: string,
  ): TagRecord | undefined {
    const result = this.#database
      .prepare(
        "UPDATE tags SET archived_at = ?, revision = revision + 1, updated_at = ? WHERE owner_id = ? AND id = ? AND revision = ? AND archived_at IS NULL",
      )
      .run(now, now, ownerId, id, expectedRevision);
    return result.changes === 1 ? this.#tag(ownerId, id) : undefined;
  }
  listTags(ownerId: string): readonly TagRecord[] {
    return (
      this.#database
        .prepare(
          "SELECT * FROM tags WHERE owner_id=? ORDER BY archived_at IS NOT NULL,position,display_name COLLATE NOCASE,id",
        )
        .all(ownerId) as unknown as readonly Record<
        string,
        string | number | null
      >[]
    ).map((row) => this.#tagFromRow(row));
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
  assignTaskProject(
    ownerId: string,
    taskId: string,
    projectId: string | null,
    expectedRevision: number,
    now: string,
  ): TaskRecord | undefined {
    this.#database.exec("SAVEPOINT task_project;");
    try {
      const valid =
        projectId === null ||
        this.#database
          .prepare(
            "SELECT 1 FROM projects WHERE id=? AND owner_id=? AND archived_at IS NULL",
          )
          .get(projectId, ownerId) !== undefined;
      if (!valid) {
        this.#database.exec(
          "ROLLBACK TO SAVEPOINT task_project; RELEASE SAVEPOINT task_project;",
        );
        return undefined;
      }
      const changed = this.#database
        .prepare(
          "UPDATE tasks SET project_id=?,revision=revision+1,updated_at=? WHERE owner_id=? AND id=? AND revision=? AND deleted_at IS NULL",
        )
        .run(projectId, now, ownerId, taskId, expectedRevision).changes;
      if (changed !== 1) {
        this.#database.exec("RELEASE SAVEPOINT task_project;");
        return undefined;
      }
      const task = this.getTask(ownerId, taskId);
      if (task === undefined) throw new Error("Assigned task disappeared");
      this.#database
        .prepare(
          "INSERT INTO task_field_versions (task_id,field,version) VALUES (?, 'projectId', ?) ON CONFLICT(task_id,field) DO UPDATE SET version=excluded.version",
        )
        .run(taskId, task.revision);
      this.#appendSyncChangeInTransaction(
        ownerId,
        "task",
        taskId,
        "upsert",
        task.revision,
        now,
      );
      // Leaving a project also leaves that project's backlog.
      const backlog = this.#database
        .prepare(
          "SELECT project_id FROM project_backlog_tasks WHERE owner_id=? AND task_id=?",
        )
        .get(ownerId, taskId) as { project_id: string } | undefined;
      if (backlog !== undefined && backlog.project_id !== projectId) {
        this.#database
          .prepare(
            "DELETE FROM project_backlog_tasks WHERE owner_id=? AND task_id=?",
          )
          .run(ownerId, taskId);
        this.#database
          .prepare(
            "UPDATE projects SET revision=revision+1, updated_at=? WHERE owner_id=? AND id=?",
          )
          .run(now, ownerId, backlog.project_id);
        const previous = this.#project(ownerId, backlog.project_id);
        if (previous !== undefined)
          this.#appendSyncChangeInTransaction(
            ownerId,
            "project",
            previous.id,
            "upsert",
            previous.revision,
            now,
          );
      }
      this.#database.exec("RELEASE SAVEPOINT task_project;");
      return task;
    } catch (error) {
      this.#database.exec(
        "ROLLBACK TO SAVEPOINT task_project; RELEASE SAVEPOINT task_project;",
      );
      throw error;
    }
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
    this.#database.exec("SAVEPOINT task_tags;");
    try {
      const current = this.getTask(ownerId, taskId);
      if (
        current === undefined ||
        (expectedRevision !== undefined &&
          current.revision !== expectedRevision)
      ) {
        this.#database.exec(
          "ROLLBACK TO SAVEPOINT task_tags; RELEASE SAVEPOINT task_tags;",
        );
        return false;
      }
      const valid = this.#database
        .prepare(
          `SELECT count(*) AS count FROM tags WHERE owner_id = ? AND archived_at IS NULL AND id IN (${tagIds.map(() => "?").join(",") || "NULL"})`,
        )
        .get(ownerId, ...tagIds) as unknown as { count: number };
      if (valid.count !== tagIds.length) {
        this.#database.exec(
          "ROLLBACK TO SAVEPOINT task_tags; RELEASE SAVEPOINT task_tags;",
        );
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
      this.#database.exec("RELEASE SAVEPOINT task_tags;");
      return true;
    } catch (error) {
      this.#database.exec(
        "ROLLBACK TO SAVEPOINT task_tags; RELEASE SAVEPOINT task_tags;",
      );
      throw error;
    }
  }
  getSubtask(ownerId: string, id: string): SubtaskRecord | undefined {
    const row = this.#database
      .prepare("SELECT task_id FROM subtasks WHERE owner_id=? AND id=?")
      .get(ownerId, id) as { task_id: string } | undefined;
    if (row === undefined || this.getTask(ownerId, row.task_id) === undefined)
      return undefined;
    return this.listSubtasks(ownerId, row.task_id).find(
      (item) => item.id === id,
    );
  }

  mutateChecklist(
    ownerId: string,
    command: ChecklistCommand,
    now: string,
    expectedTaskRevision?: number,
  ): readonly SubtaskRecord[] | undefined {
    const parsed = checklistCommandSchema.safeParse(command);
    if (!parsed.success) return undefined;
    command = parsed.data;
    this.#database.exec("SAVEPOINT checklist_mutation;");
    try {
      const task = this.getTask(ownerId, command.taskId);
      if (
        task === undefined ||
        (expectedTaskRevision !== undefined &&
          task.revision !== expectedTaskRevision)
      ) {
        this.#database.exec("RELEASE SAVEPOINT checklist_mutation;");
        return undefined;
      }
      if (command.action === "reorder") {
        if (
          this.reorderSubtasks(ownerId, command.taskId, command.items, now) ===
          undefined
        ) {
          this.#database.exec("RELEASE SAVEPOINT checklist_mutation;");
          return undefined;
        }
      } else {
        const current = this.getSubtask(ownerId, command.id);
        if (
          command.action === "create"
            ? current !== undefined
            : current?.taskId !== command.taskId ||
              current.revision !== command.expectedRevision
        ) {
          this.#database.exec("RELEASE SAVEPOINT checklist_mutation;");
          return undefined;
        }
        let revision = 1;
        if (command.action === "create") {
          this.createSubtask({
            id: command.id,
            ownerId,
            taskId: command.taskId,
            title: command.title,
            position: command.position,
            completed: false,
            revision,
            createdAt: now,
            updatedAt: now,
          });
        } else if (command.action === "update") {
          const { title, completed, position } = command.patch;
          const updated = this.updateSubtask(
            ownerId,
            command.id,
            command.expectedRevision,
            {
              ...(title === undefined ? {} : { title }),
              ...(completed === undefined ? {} : { completed }),
              ...(position === undefined ? {} : { position }),
            },
            now,
          );
          if (updated === undefined)
            throw new Error("Checklist changed during atomic update");
          revision = updated.revision;
        } else {
          if (
            !this.deleteSubtask(ownerId, command.id, command.expectedRevision)
          )
            throw new Error("Checklist changed during atomic delete");
          revision = command.expectedRevision + 1;
        }
        this.#appendSyncChangeInTransaction(
          ownerId,
          "subtask",
          command.id,
          command.action === "delete" ? "deleted" : "upsert",
          revision,
          now,
        );
      }
      const result = this.listSubtasks(ownerId, command.taskId);
      this.#database.exec("RELEASE SAVEPOINT checklist_mutation;");
      return result;
    } catch (error) {
      this.#database.exec(
        "ROLLBACK TO SAVEPOINT checklist_mutation; RELEASE SAVEPOINT checklist_mutation;",
      );
      throw error;
    }
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
  reorderSubtasks(
    ownerId: string,
    taskId: string,
    items: readonly { readonly id: string; readonly revision: number }[],
    now: string,
  ): readonly SubtaskRecord[] | undefined {
    this.#database.exec("SAVEPOINT checklist_order;");
    try {
      const current = this.listSubtasks(ownerId, taskId);
      const currentById = new Map(current.map((item) => [item.id, item]));
      if (
        items.length !== current.length ||
        new Set(items.map(({ id }) => id)).size !== items.length ||
        items.some(
          ({ id, revision }) => currentById.get(id)?.revision !== revision,
        )
      ) {
        this.#database.exec("RELEASE SAVEPOINT checklist_order;");
        return undefined;
      }
      const update = this.#database.prepare(
        "UPDATE subtasks SET position=?,revision=revision+1,updated_at=? WHERE owner_id=? AND task_id=? AND id=? AND revision=?",
      );
      for (const [position, item] of items.entries()) {
        if (
          update.run(position, now, ownerId, taskId, item.id, item.revision)
            .changes !== 1
        ) {
          this.#database.exec(
            "ROLLBACK TO SAVEPOINT checklist_order; RELEASE SAVEPOINT checklist_order;",
          );
          return undefined;
        }
        this.#appendSyncChangeInTransaction(
          ownerId,
          "subtask",
          item.id,
          "upsert",
          item.revision + 1,
          now,
        );
      }
      this.#database.exec("RELEASE SAVEPOINT checklist_order;");
      return this.listSubtasks(ownerId, taskId);
    } catch (error: unknown) {
      this.#database.exec(
        "ROLLBACK TO SAVEPOINT checklist_order; RELEASE SAVEPOINT checklist_order;",
      );
      throw error;
    }
  }
  deleteSubtask(
    ownerId: string,
    id: string,
    expectedRevision: number,
  ): boolean {
    return (
      this.#database
        .prepare(
          "DELETE FROM subtasks WHERE owner_id=? AND id=? AND revision=?",
        )
        .run(ownerId, id, expectedRevision).changes === 1
    );
  }

  createTaskTemplate(
    input: Omit<TaskTemplateRecord, "tagIds"> & {
      readonly tagIds: readonly string[];
      readonly blueprints: readonly Omit<
        TemplateSubtaskBlueprintRecord,
        "templateId"
      >[];
    },
  ): TaskTemplateRecord {
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      if (
        input.suggestedProjectId !== null &&
        this.#database
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
          this.#database
            .prepare(
              `SELECT count(*) AS count FROM tags WHERE owner_id=? AND archived_at IS NULL AND id IN (${input.tagIds.map(() => "?").join(",") || "NULL"})`,
            )
            .get(input.ownerId, ...input.tagIds) as unknown as { count: number }
        ).count !== input.tagIds.length
      )
        throw new Error("Template tags are not active owner tags");
      this.#database
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
      const tag = this.#database.prepare(
        "INSERT INTO task_template_tags (template_id,tag_id) VALUES (?,?)",
      );
      for (const tagId of input.tagIds) tag.run(input.id, tagId);
      const blueprint = this.#database.prepare(
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
      this.#database.exec("COMMIT;");
      const created = this.getTaskTemplate(input.ownerId, input.id);
      if (created === undefined)
        throw new Error("Created task template could not be read");
      return created;
    } catch (error) {
      this.#database.exec("ROLLBACK;");
      throw error;
    }
  }
  getTaskTemplate(
    ownerId: string,
    id: string,
    includeArchived = false,
  ): TaskTemplateRecord | undefined {
    const row = this.#database
      .prepare(
        "SELECT * FROM task_templates WHERE owner_id=? AND id=? AND (?=1 OR archived_at IS NULL)",
      )
      .get(ownerId, id, includeArchived ? 1 : 0) as unknown as
      Record<string, string | number | null> | undefined;
    return row === undefined ? undefined : this.#templateFromRow(row);
  }
  listTaskTemplates(
    ownerId: string,
    query = "",
    includeArchived = false,
  ): readonly TaskTemplateRecord[] {
    const search = `%${query.replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
    return (
      this.#database
        .prepare(
          "SELECT * FROM task_templates WHERE owner_id=? AND (?=1 OR archived_at IS NULL) AND (title LIKE ? ESCAPE '\\' OR notes LIKE ? ESCAPE '\\') ORDER BY archived_at IS NOT NULL,title COLLATE NOCASE,id",
        )
        .all(
          ownerId,
          includeArchived ? 1 : 0,
          search,
          search,
        ) as unknown as readonly Record<string, string | number | null>[]
    ).map((row) => this.#templateFromRow(row));
  }
  archiveTaskTemplate(
    ownerId: string,
    id: string,
    expectedRevision: number,
    now: string,
  ): TaskTemplateRecord | undefined {
    const changed = this.#database
      .prepare(
        "UPDATE task_templates SET archived_at=?,revision=revision+1,updated_at=? WHERE owner_id=? AND id=? AND revision=? AND archived_at IS NULL",
      )
      .run(now, now, ownerId, id, expectedRevision).changes;
    if (changed !== 1) return undefined;
    const template = this.getTaskTemplate(ownerId, id, true);
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
  createTaskTemplateFromTask(
    ownerId: string,
    taskId: string,
    template: Omit<TaskTemplateRecord, "tagIds"> & {
      readonly blueprints: readonly Omit<
        TemplateSubtaskBlueprintRecord,
        "templateId"
      >[];
    },
  ): TaskTemplateRecord | undefined {
    const task = this.getTask(ownerId, taskId);
    if (task === undefined) return undefined;
    const suggestedProject =
      task.projectId === undefined || task.projectId === null
        ? undefined
        : this.#project(ownerId, task.projectId);
    const activeTagIds = (task.tagIds ?? []).filter(
      (tagId) => this.#tag(ownerId, tagId)?.archivedAt === null,
    );
    return this.createTaskTemplate({
      ...template,
      title: task.title,
      notes: task.notes,
      estimateMinutes: task.estimateMinutes,
      suggestedProjectId:
        suggestedProject?.archivedAt === null ? suggestedProject.id : null,
      tagIds: activeTagIds,
    });
  }
  updateTaskTemplate(input: {
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
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      const current = this.getTaskTemplate(input.ownerId, input.id);
      if (current?.revision !== input.expectedRevision) {
        this.#database.exec("COMMIT;");
        return undefined;
      }
      if (
        input.suggestedProjectId !== null &&
        this.#database
          .prepare(
            "SELECT 1 FROM projects WHERE id=? AND owner_id=? AND archived_at IS NULL",
          )
          .get(input.suggestedProjectId, input.ownerId) === undefined
      ) {
        this.#database.exec("ROLLBACK;");
        return undefined;
      }
      if (
        new Set(input.tagIds).size !== input.tagIds.length ||
        (
          this.#database
            .prepare(
              `SELECT count(*) AS count FROM tags WHERE owner_id=? AND archived_at IS NULL AND id IN (${input.tagIds.map(() => "?").join(",") || "NULL"})`,
            )
            .get(input.ownerId, ...input.tagIds) as unknown as { count: number }
        ).count !== input.tagIds.length
      ) {
        this.#database.exec("ROLLBACK;");
        return undefined;
      }
      const revision = current.revision + 1;
      this.#database
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
      this.#database
        .prepare("DELETE FROM task_template_tags WHERE template_id=?")
        .run(input.id);
      const tag = this.#database.prepare(
        "INSERT INTO task_template_tags (template_id,tag_id) VALUES (?,?)",
      );
      for (const tagId of input.tagIds) tag.run(input.id, tagId);
      this.#database
        .prepare("DELETE FROM template_subtask_blueprints WHERE template_id=?")
        .run(input.id);
      const blueprint = this.#database.prepare(
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
      this.#database.exec("COMMIT;");
      const updated = this.getTaskTemplate(input.ownerId, input.id);
      if (updated === undefined)
        throw new Error("Updated task template could not be read");
      return updated;
    } catch (error) {
      this.#database.exec("ROLLBACK;");
      throw error;
    }
  }
  getTaskTemplateProvenance(
    ownerId: string,
    taskId: string,
  ): TaskTemplateProvenanceRecord | undefined {
    const row = this.#database
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
  listTaskTemplateProvenance(
    ownerId: string,
  ): readonly TaskTemplateProvenanceRecord[] {
    const rows = this.#database
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
  listTemplateSubtaskBlueprints(
    templateId: string,
  ): readonly TemplateSubtaskBlueprintRecord[] {
    return (
      this.#database
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
  createTemplatePoolSlot(
    ownerId: string,
    slot: TemplatePoolSlotRecord,
  ): TemplatePoolSlotRecord | undefined {
    if (
      this.getTaskTemplate(ownerId, slot.templateId) === undefined ||
      this.getChoicePool(ownerId, slot.poolId) === undefined ||
      this.listChoicePoolItems(slot.poolId, false).length < slot.pickCount
    )
      return undefined;
    try {
      this.#database
        .prepare(
          "INSERT INTO template_pool_slots (id,template_id,pool_id,pick_count,position,created_at) VALUES (?,?,?,?,?,?)",
        )
        .run(
          slot.id,
          slot.templateId,
          slot.poolId,
          slot.pickCount,
          slot.position,
          slot.createdAt,
        );
      const template = this.getTaskTemplate(ownerId, slot.templateId);
      if (template !== undefined)
        this.appendSyncChange(
          ownerId,
          "template",
          slot.templateId,
          "upsert",
          template.revision,
          slot.createdAt,
        );
      return slot;
    } catch {
      return undefined;
    }
  }
  listTemplatePoolSlots(templateId: string): readonly TemplatePoolSlotRecord[] {
    return (
      this.#database
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
  createTemplateSet(
    record: TemplateSetRecord,
    members: readonly TemplateSetMemberRecord[],
  ): void {
    this.#database.exec("BEGIN IMMEDIATE;");
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
        if (
          this.getTaskTemplate(record.ownerId, member.templateId) === undefined
        )
          throw new Error(
            "Template set member is not an active owner template",
          );
      this.#database
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
      const insert = this.#database.prepare(
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
      this.#database.exec("COMMIT;");
    } catch (error) {
      this.#database.exec("ROLLBACK;");
      throw error;
    }
  }
  listTemplateSets(
    ownerId: string,
    includeArchived = false,
  ): readonly TemplateSetRecord[] {
    return (
      this.#database
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
  archiveTemplateSet(
    ownerId: string,
    id: string,
    expectedRevision: number,
    now: string,
  ): TemplateSetRecord | undefined {
    const changed = this.#database
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
  listTemplateSetMembers(setId: string): readonly TemplateSetMemberRecord[] {
    return (
      this.#database
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
  instantiateTemplateIdempotently(input: {
    readonly ownerId: string;
    readonly templateId: string;
    readonly destinationProjectId: string;
    readonly idempotencyKey: string;
    readonly requestHash: string;
    readonly now: string;
  }): TemplateInstantiationResult {
    return this.#instantiateTemplates({
      ...input,
      sourceKind: "template",
      sourceId: input.templateId,
    });
  }
  instantiateTemplateSetIdempotently(input: {
    readonly ownerId: string;
    readonly setId: string;
    readonly destinationProjectId: string;
    readonly idempotencyKey: string;
    readonly requestHash: string;
    readonly now: string;
  }): TemplateInstantiationResult {
    return this.#instantiateTemplates({
      ...input,
      sourceKind: "set",
      sourceId: input.setId,
    });
  }

  putActiveSession(record: ActiveSessionRecord): void {
    this.#database
      .prepare(
        `INSERT INTO active_sessions (id, owner_id, task_id, controller_client_id, state, phase, revision, started_at, lease_expires_at, hard_expires_at, created_at, updated_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET controller_client_id=excluded.controller_client_id,state=excluded.state,phase=excluded.phase,revision=excluded.revision,started_at=excluded.started_at,lease_expires_at=excluded.lease_expires_at,hard_expires_at=excluded.hard_expires_at,updated_at=excluded.updated_at,ended_at=excluded.ended_at`,
      )
      .run(
        record.id,
        record.ownerId,
        record.taskId,
        record.controllerClientId,
        record.state,
        record.phase,
        record.revision,
        record.startedAt,
        record.leaseExpiresAt,
        record.hardExpiresAt,
        record.createdAt,
        record.updatedAt,
        record.endedAt,
      );
  }
  getActiveSession(ownerId: string): ActiveSessionRecord | undefined {
    const row = this.#database
      .prepare(
        "SELECT * FROM active_sessions WHERE owner_id = ? ORDER BY ended_at IS NULL DESC, created_at DESC LIMIT 1",
      )
      .get(ownerId) as unknown as
      Record<string, string | number | null> | undefined;
    return row === undefined
      ? undefined
      : {
          id: String(row.id),
          ownerId: String(row.owner_id),
          taskId: String(row.task_id),
          controllerClientId:
            row.controller_client_id === null
              ? null
              : String(row.controller_client_id),
          state: row.state as ActiveSessionRecord["state"],
          phase: row.phase as ActiveSessionRecord["phase"],
          revision: Number(row.revision),
          startedAt: String(row.started_at),
          leaseExpiresAt:
            row.lease_expires_at === null ? null : String(row.lease_expires_at),
          hardExpiresAt:
            row.hard_expires_at === null ? null : String(row.hard_expires_at),
          createdAt: String(row.created_at),
          updatedAt: String(row.updated_at),
          endedAt: row.ended_at === null ? null : String(row.ended_at),
        };
  }
  applyActiveSessionTransition(input: {
    readonly session: ActiveSessionRecord;
    readonly expectedRevision: number | null;
    readonly clientId: string;
    readonly idempotencyKey: string;
    readonly requestHash: string;
    readonly intervals: readonly ActiveSessionIntervalRecord[];
    readonly events: readonly ActiveSessionEventRecord[];
    readonly now: string;
  }): {
    readonly kind: "applied" | "replayed" | "conflict" | "stale";
    readonly session?: ActiveSessionRecord;
    readonly intervals?: readonly ActiveSessionIntervalRecord[];
    readonly events?: readonly ActiveSessionEventRecord[];
  } {
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      const prior = this.#database
        .prepare(
          "SELECT request_hash,response_json FROM active_session_operation_outcomes WHERE owner_id=? AND client_id=? AND idempotency_key=?",
        )
        .get(
          input.session.ownerId,
          input.clientId,
          input.idempotencyKey,
        ) as unknown as
        { request_hash: string; response_json: string } | undefined;
      if (prior !== undefined) {
        this.#database.exec("COMMIT;");
        return prior.request_hash === input.requestHash
          ? {
              kind: "replayed",
              ...(JSON.parse(
                prior.response_json,
              ) as ActiveSessionPersistenceSnapshot),
            }
          : { kind: "conflict" };
      }
      const current = this.getActiveSession(input.session.ownerId);
      if (input.expectedRevision === null) {
        if (current?.endedAt === null) {
          this.#database.exec("COMMIT;");
          return { kind: "conflict", session: current };
        }
      } else if (
        current?.id !== input.session.id ||
        current.revision !== input.expectedRevision
      ) {
        this.#database.exec("COMMIT;");
        return {
          kind: "stale",
          ...(current === undefined ? {} : { session: current }),
        };
      }
      this.putActiveSession(input.session);
      const intervalStatement = this.#database.prepare(
        `INSERT INTO active_session_intervals (id,session_id,ordinal,phase,task_id,controller_client_id,started_at,ended_at,closed_by) VALUES (?,?,?,?,?,?,?,?,?)
         ON CONFLICT(session_id,ordinal) DO UPDATE SET phase=excluded.phase,task_id=excluded.task_id,controller_client_id=excluded.controller_client_id,started_at=excluded.started_at,ended_at=excluded.ended_at,closed_by=excluded.closed_by`,
      );
      for (const interval of input.intervals)
        intervalStatement.run(
          interval.id,
          input.session.id,
          interval.ordinal,
          interval.phase,
          interval.taskId,
          interval.controllerClientId,
          interval.startedAt,
          interval.endedAt,
          interval.closedBy,
        );
      const eventStatement = this.#database.prepare(
        `INSERT INTO active_session_events (id,session_id,kind,revision,actor_client_id,created_at) VALUES (?,?,?,?,?,?)
         ON CONFLICT(session_id,revision) DO NOTHING`,
      );
      for (const event of input.events)
        eventStatement.run(
          randomUUID(),
          input.session.id,
          event.kind,
          event.revision,
          event.actorClientId,
          event.createdAt,
        );
      this.#database
        .prepare(
          "INSERT INTO active_session_operation_outcomes (owner_id,client_id,idempotency_key,request_hash,session_id,revision,response_json,created_at) VALUES (?,?,?,?,?,?,?,?)",
        )
        .run(
          input.session.ownerId,
          input.clientId,
          input.idempotencyKey,
          input.requestHash,
          input.session.id,
          input.session.revision,
          JSON.stringify({
            session: input.session,
            intervals: input.intervals,
            events: input.events,
          } satisfies ActiveSessionPersistenceSnapshot),
          input.now,
        );
      this.#appendSyncChangeInTransaction(
        input.session.ownerId,
        "active_session",
        input.session.id,
        "session_changed",
        input.session.revision,
        input.now,
      );
      this.#database.exec("COMMIT;");
      return {
        kind: "applied",
        session: input.session,
        intervals: input.intervals,
        events: input.events,
      };
    } catch (error) {
      this.#database.exec("ROLLBACK;");
      throw error;
    }
  }
  listActiveSessionIntervals(
    sessionId: string,
  ): readonly ActiveSessionIntervalRecord[] {
    return (
      this.#database
        .prepare(
          "SELECT * FROM active_session_intervals WHERE session_id=? ORDER BY ordinal",
        )
        .all(sessionId) as unknown as readonly Record<
        string,
        string | number | null
      >[]
    ).map((row) => ({
      id: String(row.id),
      ordinal: Number(row.ordinal),
      phase: row.phase as ActiveSessionIntervalRecord["phase"],
      taskId: row.task_id === null ? null : String(row.task_id),
      controllerClientId: String(row.controller_client_id),
      startedAt: String(row.started_at),
      endedAt: row.ended_at === null ? null : String(row.ended_at),
      closedBy: row.closed_by === null ? null : String(row.closed_by),
    }));
  }
  listActiveSessionEvents(sessionId: string): readonly {
    readonly id: string;
    readonly kind: string;
    readonly revision: number;
    readonly actorClientId: string | null;
    readonly createdAt: string;
  }[] {
    return (
      this.#database
        .prepare(
          "SELECT * FROM active_session_events WHERE session_id=? ORDER BY created_at,id",
        )
        .all(sessionId) as unknown as readonly Record<
        string,
        string | number | null
      >[]
    ).map((row) => ({
      id: String(row.id),
      kind: String(row.kind),
      revision: Number(row.revision),
      actorClientId:
        row.actor_client_id === null ? null : String(row.actor_client_id),
      createdAt: String(row.created_at),
    }));
  }
  getActiveSessionOperationOutcome(
    ownerId: string,
    clientId: string,
    idempotencyKey: string,
  ):
    | {
        readonly sessionId: string;
        readonly revision: number;
        readonly requestHash: string;
        readonly snapshot: ActiveSessionPersistenceSnapshot;
      }
    | undefined {
    const row = this.#database
      .prepare(
        "SELECT session_id,revision,request_hash,response_json FROM active_session_operation_outcomes WHERE owner_id=? AND client_id=? AND idempotency_key=?",
      )
      .get(ownerId, clientId, idempotencyKey) as unknown as
      Record<string, string | number> | undefined;
    return row === undefined
      ? undefined
      : {
          sessionId: String(row.session_id),
          revision: Number(row.revision),
          requestHash: String(row.request_hash),
          snapshot: JSON.parse(
            String(row.response_json),
          ) as ActiveSessionPersistenceSnapshot,
        };
  }

  applyTaskFieldSync(input: {
    readonly ownerId: string;
    readonly clientId: string;
    readonly operationId: string;
    readonly requestHash: string;
    readonly taskId: string;
    readonly baseVersions: Readonly<
      Partial<
        Record<
          "title" | "notes" | "status" | "estimateMinutes" | "deadline",
          number
        >
      >
    >;
    readonly patch: Partial<
      Pick<TaskRecord, "title" | "notes" | "status" | "estimateMinutes">
    > & { readonly deadline?: TaskDeadline | null };
    readonly now: string;
  }): {
    readonly kind: "applied" | "replayed" | "conflict" | "idempotency-conflict";
    readonly task?: TaskRecord;
    readonly fields?: readonly string[];
  } {
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      const previous = this.#database
        .prepare(
          "SELECT * FROM sync_operation_outcomes WHERE owner_id=? AND client_id=? AND operation_id=?",
        )
        .get(input.ownerId, input.clientId, input.operationId) as unknown as
        Record<string, string | number | null> | undefined;
      if (previous !== undefined) {
        this.#database.exec("COMMIT;");
        if (String(previous.request_hash) !== input.requestHash)
          return { kind: "idempotency-conflict" };
        const task =
          previous.entity_id === null
            ? undefined
            : this.getTask(input.ownerId, String(previous.entity_id), true);
        if (previous.state === "conflict") {
          const fields = JSON.parse(
            String(previous.conflict_fields ?? "[]"),
          ) as string[];
          return {
            kind: "conflict",
            fields,
            ...(task === undefined ? {} : { task }),
          };
        }
        return { kind: "replayed", ...(task === undefined ? {} : { task }) };
      }
      const task = this.getTask(input.ownerId, input.taskId, true);
      if (task === undefined) {
        this.#database.exec("COMMIT;");
        return { kind: "conflict", fields: ["task"] };
      }
      const fields = Object.keys(
        input.patch,
      ) as (keyof typeof input.baseVersions)[];
      const rows = this.#database
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
        this.#database
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
        this.#database.exec("COMMIT;");
        return { kind: "conflict", task, fields: conflicts };
      }
      const next = {
        ...task,
        ...input.patch,
        ...(input.patch.deadline === undefined
          ? {}
          : deadlineColumns(input.patch.deadline)),
        ...(input.patch.status === undefined
          ? {}
          : {
              completedAt:
                input.patch.status === "completed" ? input.now : null,
            }),
        revision: task.revision + 1,
        updatedAt: input.now,
      };
      this.#database
        .prepare(
          "UPDATE tasks SET title=?,notes=?,status=?,completed_at=?,estimate_minutes=?,deadline_date=?,deadline_at=?,revision=?,updated_at=? WHERE owner_id=? AND id=?",
        )
        .run(
          next.title,
          next.notes,
          next.status,
          next.completedAt,
          next.estimateMinutes,
          next.deadlineDate ?? null,
          next.deadlineAt ?? null,
          next.revision,
          next.updatedAt,
          input.ownerId,
          input.taskId,
        );
      const update = this.#database.prepare(
        "INSERT INTO task_field_versions (task_id,field,version) VALUES (?,?,?) ON CONFLICT(task_id,field) DO UPDATE SET version=excluded.version",
      );
      for (const field of fields)
        update.run(input.taskId, field, next.revision);
      this.#database
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
      let sync = this.#database
        .prepare(
          "SELECT epoch,next_sequence FROM sync_owner_state WHERE owner_id=?",
        )
        .get(input.ownerId) as unknown as
        { epoch: string; next_sequence: number } | undefined;
      if (sync === undefined) {
        sync = { epoch: randomUUID(), next_sequence: 1 };
        this.#database
          .prepare(
            "INSERT INTO sync_owner_state (owner_id,epoch,next_sequence,updated_at) VALUES (?,?,?,?)",
          )
          .run(input.ownerId, sync.epoch, 1, input.now);
      }
      this.#database
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
      this.#database
        .prepare(
          "UPDATE sync_owner_state SET next_sequence=?,updated_at=? WHERE owner_id=?",
        )
        .run(sync.next_sequence + 1, input.now, input.ownerId);
      this.#database.exec("COMMIT;");
      return { kind: "applied", task: next };
    } catch (error) {
      this.#database.exec("ROLLBACK;");
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
  }): {
    readonly kind: "applied" | "replayed" | "conflict" | "idempotency-conflict";
    readonly task?: TaskRecord;
    readonly fields?: readonly string[];
  } {
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
    > & { readonly deadline?: TaskDeadline | null };
  }): {
    readonly kind: "applied" | "replayed" | "conflict" | "idempotency-conflict";
    readonly task?: TaskRecord;
  } {
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      const previous = this.#database
        .prepare(
          "SELECT request_hash,entity_id FROM sync_operation_outcomes WHERE owner_id=? AND client_id=? AND operation_id=?",
        )
        .get(input.ownerId, input.clientId, input.operationId) as unknown as
        Record<string, string | null> | undefined;
      if (previous !== undefined) {
        this.#database.exec("COMMIT;");
        if (previous.request_hash !== input.requestHash)
          return { kind: "idempotency-conflict" };
        const task =
          typeof previous.entity_id !== "string"
            ? undefined
            : this.getTask(input.ownerId, previous.entity_id, true);
        return { kind: "replayed", ...(task === undefined ? {} : { task }) };
      }
      const existing = this.getTask(input.ownerId, input.task.id, true);
      if (existing !== undefined) {
        this.#database
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
        this.#database.exec("COMMIT;");
        return { kind: "conflict", task: existing };
      }
      const task: TaskRecord = {
        ...input.task,
        ...deadlineColumns(input.task.deadline ?? null),
        createdAt: input.now,
        updatedAt: input.now,
        ownerId: input.ownerId,
        completedAt: null,
        deletedAt: null,
        plannedStart: null,
        projectId: null,
        tagIds: [],
      };
      this.#database
        .prepare(
          "INSERT INTO tasks (id,owner_id,title,notes,status,revision,created_at,updated_at,estimate_minutes,deadline_date,deadline_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
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
          task.deadlineDate ?? null,
          task.deadlineAt ?? null,
        );
      const field = this.#database.prepare(
        "INSERT INTO task_field_versions (task_id,field,version) VALUES (?,?,?)",
      );
      for (const name of [
        "title",
        "notes",
        "status",
        "estimateMinutes",
        "projectId",
        "tagIds",
        "deadline",
      ])
        field.run(task.id, name, task.revision);
      this.#database
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
      this.#database.exec("COMMIT;");
      return { kind: "applied", task };
    } catch (error) {
      this.#database.exec("ROLLBACK;");
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
  }): {
    readonly kind: "applied" | "replayed" | "conflict" | "idempotency-conflict";
    readonly task?: TaskRecord;
  } {
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      const previous = this.#database
        .prepare(
          "SELECT request_hash,entity_id FROM sync_operation_outcomes WHERE owner_id=? AND client_id=? AND operation_id=?",
        )
        .get(input.ownerId, input.clientId, input.operationId) as unknown as
        Record<string, string | null> | undefined;
      if (previous !== undefined) {
        this.#database.exec("COMMIT;");
        if (previous.request_hash !== input.requestHash)
          return { kind: "idempotency-conflict" };
        const task =
          typeof previous.entity_id !== "string"
            ? undefined
            : this.getTask(input.ownerId, previous.entity_id, true);
        return { kind: "replayed", ...(task === undefined ? {} : { task }) };
      }
      const task = this.getTask(input.ownerId, input.taskId, true);
      const activeSession = input.restore
        ? undefined
        : this.getActiveSession(input.ownerId);
      if (
        task?.revision !== input.baseRevision ||
        (input.restore ? task.deletedAt === null : task.deletedAt !== null) ||
        (activeSession?.endedAt === null &&
          activeSession.taskId === input.taskId)
      ) {
        this.#database
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
        this.#database.exec("COMMIT;");
        return { kind: "conflict", ...(task === undefined ? {} : { task }) };
      }
      const nextRevision = task.revision + 1;
      this.#database
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
      const next = this.getTask(input.ownerId, input.taskId, true);
      if (next === undefined) throw new Error("Deleted task disappeared");
      this.#database
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
      this.#database.exec("COMMIT;");
      return { kind: "applied", task: next };
    } catch (error) {
      this.#database.exec("ROLLBACK;");
      throw error;
    }
  }

  #conditionallyUpdateTask(
    ownerId: string,
    taskId: string,
    expectedRevision: number,
    requireDeleted: boolean,
    update: (task: TaskRecord) => TaskRecord,
    now: string,
  ): ConditionalTaskResult {
    this.#database.exec("SAVEPOINT conditional_task;");
    try {
      const current = this.getTask(ownerId, taskId, true);
      if (
        current === undefined ||
        (requireDeleted
          ? current.deletedAt === null
          : current.deletedAt !== null)
      ) {
        this.#database.exec("RELEASE SAVEPOINT conditional_task;");
        return { kind: "not-found" };
      }
      if (current.revision !== expectedRevision) {
        this.#database.exec("RELEASE SAVEPOINT conditional_task;");
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
              planned_start = ?, estimate_minutes = ?, deadline_date = ?, deadline_at = ?
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
          next.deadlineDate ?? null,
          next.deadlineAt ?? null,
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
      if (
        current.deadlineDate !== next.deadlineDate ||
        current.deadlineAt !== next.deadlineAt
      )
        fieldVersions.run(taskId, "deadline", next.revision);
      this.#appendSyncChangeInTransaction(
        ownerId,
        "task",
        taskId,
        next.deletedAt === null ? "upsert" : "deleted",
        next.revision,
        now,
      );
      this.#database.exec("RELEASE SAVEPOINT conditional_task;");
      return { kind: "updated", task: next };
    } catch (error: unknown) {
      this.#database.exec(
        "ROLLBACK TO SAVEPOINT conditional_task; RELEASE SAVEPOINT conditional_task;",
      );
      throw error;
    }
  }

  #findTask(ownerId: string, taskId: string): TaskRecord | undefined {
    const row = this.#database
      .prepare(
        `SELECT id, owner_id, title, notes, status, revision, created_at, updated_at,
                completed_at, deleted_at, planned_start, estimate_minutes, deadline_date, deadline_at
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
    readonly deadline_date?: string | null;
    readonly deadline_at?: string | null;
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
      deadlineDate: "deadline_date" in row ? row.deadline_date : null,
      deadlineAt: "deadline_at" in row ? row.deadline_at : null,
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

  #project(ownerId: string, id: string): ProjectRecord | undefined {
    const row = this.#database
      .prepare("SELECT * FROM projects WHERE owner_id = ? AND id = ?")
      .get(ownerId, id) as unknown as
      Record<string, string | number | null> | undefined;
    return row === undefined
      ? undefined
      : this.#projectFromRow(row, this.#backlogTaskIds(ownerId, id));
  }
  /** Backlog task IDs by project, excluding deleted or reassigned tasks. */
  #backlogTaskIds(
    ownerId: string,
    projectId?: string,
  ): ReadonlyMap<string, readonly string[]> {
    const rows = this.#database
      .prepare(
        `SELECT b.project_id, b.task_id FROM project_backlog_tasks b
         JOIN tasks t ON t.id = b.task_id AND t.owner_id = b.owner_id
         WHERE b.owner_id = ? AND t.deleted_at IS NULL AND t.project_id = b.project_id
           ${projectId === undefined ? "" : "AND b.project_id = ?"}
         ORDER BY b.project_id, b.position, b.task_id`,
      )
      .all(
        ...(projectId === undefined ? [ownerId] : [ownerId, projectId]),
      ) as unknown as readonly { project_id: string; task_id: string }[];
    const grouped = new Map<string, string[]>();
    for (const row of rows)
      grouped.set(row.project_id, [
        ...(grouped.get(row.project_id) ?? []),
        row.task_id,
      ]);
    return grouped;
  }
  #templateFromRow(
    row: Record<string, string | number | null>,
  ): TaskTemplateRecord {
    const id = String(row.id);
    const tags = this.#database
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
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      const prior = this.#database
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
        this.#database.exec("COMMIT;");
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
        this.#database
          .prepare(
            "SELECT 1 FROM projects WHERE owner_id=? AND id=? AND archived_at IS NULL",
          )
          .get(input.ownerId, input.destinationProjectId) === undefined
      ) {
        this.#database.exec("COMMIT;");
        return { kind: "project-not-found" };
      }
      const source =
        input.sourceKind === "template"
          ? this.getTaskTemplate(input.ownerId, input.sourceId)
          : undefined;
      const set =
        input.sourceKind === "set"
          ? this.listTemplateSets(input.ownerId).find(
              (candidate) => candidate.id === input.sourceId,
            )
          : undefined;
      if (source === undefined && set === undefined) {
        this.#database.exec("COMMIT;");
        return { kind: "not-found" };
      }
      const members =
        source === undefined ? this.listTemplateSetMembers(input.sourceId) : [];
      const templates =
        source === undefined
          ? members.map((member) =>
              this.getTaskTemplate(input.ownerId, member.templateId),
            )
          : [source];
      if (
        templates.length === 0 ||
        templates.some((template) => template === undefined)
      ) {
        this.#database.exec("COMMIT;");
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
        poolSlots: this.listTemplatePoolSlots(template.id),
      }));
      this.#database
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
      const insertTask = this.#database.prepare(
        "INSERT INTO tasks (id,owner_id,title,notes,status,revision,created_at,updated_at,estimate_minutes,project_id) VALUES (?,?,?,?,?,?,?,?,?,?)",
      );
      const insertField = this.#database.prepare(
        "INSERT INTO task_field_versions (task_id,field,version) VALUES (?,?,1)",
      );
      const insertTag = this.#database.prepare(
        "INSERT INTO task_tags (task_id,tag_id) VALUES (?,?)",
      );
      const insertSubtask = this.#database.prepare(
        "INSERT INTO subtasks (id,owner_id,task_id,title,completed,position,revision,created_at,updated_at) VALUES (?,?,?,?,0,?,?,?,?)",
      );
      const insertProvenance = this.#database.prepare(
        "INSERT INTO task_template_provenance (task_id,template_id,template_revision,instantiation_id,instantiated_at) VALUES (?,?,?,?,?)",
      );
      const insertPlaceholder = this.#database.prepare(
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
          "deadline",
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
        for (const slot of this.listTemplatePoolSlots(template.id)) {
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
      this.#database
        .prepare(
          "UPDATE template_instantiations SET result_task_ids_json=? WHERE id=?",
        )
        .run(JSON.stringify(taskIds), instantiationId);
      this.#database.exec("COMMIT;");
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
      this.#database.exec("ROLLBACK;");
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
      const task = this.getTask(ownerId, taskId);
      if (task === undefined)
        throw new Error("Instantiated task could not be read");
      const row = this.#database
        .prepare("SELECT * FROM task_template_provenance WHERE task_id=?")
        .get(taskId) as unknown as Record<string, string | number> | undefined;
      if (row === undefined)
        throw new Error("Instantiated task provenance could not be read");
      return {
        task,
        subtasks: this.listSubtasks(ownerId, taskId),
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
  createChoicePool(
    pool: ChoicePoolRecord,
    items: readonly ChoicePoolItemRecord[],
  ): ChoicePoolRecord {
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      if (
        items.length < pool.pickCount ||
        new Set(items.map(({ id }) => id)).size !== items.length ||
        new Set(items.map(({ position }) => position)).size !== items.length
      )
        throw new Error(
          "Choice pool items must be unique and satisfy pick count",
        );
      this.#database
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
      const insert = this.#database.prepare(
        "INSERT INTO choice_pool_items (id,pool_id,title,position,revision,created_at,updated_at,archived_at) VALUES (?,?,?,?,?,?,?,?)",
      );
      for (const item of items)
        insert.run(
          item.id,
          pool.id,
          item.title,
          item.position,
          item.revision,
          item.createdAt,
          item.updatedAt,
          item.archivedAt,
        );
      this.#appendSyncChangeInTransaction(
        pool.ownerId,
        "choice_pool",
        pool.id,
        "upsert",
        pool.revision,
        pool.createdAt,
      );
      this.#database.exec("COMMIT;");
      return pool;
    } catch (error) {
      this.#database.exec("ROLLBACK;");
      throw error;
    }
  }
  updateChoicePool(input: {
    readonly ownerId: string;
    readonly id: string;
    readonly expectedRevision: number;
    readonly title: string;
    readonly policy: ChoicePoolRecord["policy"];
    readonly pickCount: number;
    readonly cooldownSeconds: number | null;
    readonly items: readonly { readonly id?: string; readonly title: string }[];
    readonly now: string;
  }): ChoicePoolRecord | undefined {
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      const current = this.getChoicePool(input.ownerId, input.id);
      if (
        current?.revision !== input.expectedRevision ||
        input.items.length < input.pickCount
      ) {
        this.#database.exec("COMMIT;");
        return undefined;
      }
      const existing = this.listChoicePoolItems(input.id, true);
      const existingById = new Map(existing.map((item) => [item.id, item]));
      const existingByTitle = new Map(
        existing
          .filter(({ archivedAt }) => archivedAt === null)
          .map((item) => [item.title.toLocaleLowerCase(), item]),
      );
      this.#database
        .prepare(
          "UPDATE choice_pool_items SET position=position+10000 WHERE pool_id=?",
        )
        .run(input.id);
      const retained = new Set<string>();
      const update = this.#database.prepare(
        "UPDATE choice_pool_items SET title=?,position=?,revision=revision+1,updated_at=?,archived_at=NULL WHERE id=? AND pool_id=?",
      );
      const insert = this.#database.prepare(
        "INSERT INTO choice_pool_items (id,pool_id,title,position,revision,created_at,updated_at,archived_at) VALUES (?,?,?,?,1,?,?,NULL)",
      );
      for (const [position, candidate] of input.items.entries()) {
        const matched =
          (candidate.id === undefined
            ? undefined
            : existingById.get(candidate.id)) ??
          existingByTitle.get(candidate.title.toLocaleLowerCase());
        if (matched === undefined)
          insert.run(
            randomUUID(),
            input.id,
            candidate.title,
            position,
            input.now,
            input.now,
          );
        else {
          retained.add(matched.id);
          update.run(
            candidate.title,
            position,
            input.now,
            matched.id,
            input.id,
          );
        }
      }
      const archive = this.#database.prepare(
        "UPDATE choice_pool_items SET archived_at=?,updated_at=?,revision=revision+1 WHERE id=? AND pool_id=? AND archived_at IS NULL",
      );
      for (const item of existing)
        if (!retained.has(item.id))
          archive.run(input.now, input.now, item.id, input.id);
      this.#database
        .prepare(
          "UPDATE choice_pools SET title=?,policy=?,pick_count=?,cooldown_seconds=?,revision=revision+1,updated_at=? WHERE owner_id=? AND id=? AND revision=?",
        )
        .run(
          input.title,
          input.policy,
          input.pickCount,
          input.cooldownSeconds,
          input.now,
          input.ownerId,
          input.id,
          input.expectedRevision,
        );
      this.#appendSyncChangeInTransaction(
        input.ownerId,
        "choice_pool",
        input.id,
        "upsert",
        input.expectedRevision + 1,
        input.now,
      );
      this.#database.exec("COMMIT;");
      return this.getChoicePool(input.ownerId, input.id, true);
    } catch (error) {
      this.#database.exec("ROLLBACK;");
      throw error;
    }
  }
  recordChoicePoolCompletion(input: {
    readonly ownerId: string;
    readonly poolId: string;
    readonly itemId: string;
    readonly placeholderId: string | null;
    readonly occurredAt: string;
  }): ChoicePoolHistoryRecord | undefined {
    const pool = this.getChoicePool(input.ownerId, input.poolId, true);
    const item = this.listChoicePoolItems(input.poolId, true).find(
      ({ id }) => id === input.itemId,
    );
    if (pool === undefined || item === undefined) return undefined;
    const selections = this.listChoicePoolHistory(input.poolId).filter(
      ({ itemId, kind }) => itemId === input.itemId && kind === "selected",
    );
    const event: ChoicePoolHistoryRecord = {
      id: randomUUID(),
      poolId: input.poolId,
      itemId: input.itemId,
      placeholderId: input.placeholderId,
      kind: "completed",
      cycle: selections.at(-1)?.cycle ?? 1,
      overridden: false,
      occurredAt: input.occurredAt,
    };
    this.#database
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
      input.ownerId,
      "choice_pool",
      input.poolId,
      "upsert",
      pool.revision,
      input.occurredAt,
    );
    return event;
  }
  getChoicePool(
    ownerId: string,
    id: string,
    includeArchived = false,
  ): ChoicePoolRecord | undefined {
    const row = this.#database
      .prepare(
        "SELECT * FROM choice_pools WHERE owner_id=? AND id=? AND (?=1 OR archived_at IS NULL)",
      )
      .get(ownerId, id, includeArchived ? 1 : 0) as unknown as
      Record<string, string | number | null> | undefined;
    return row === undefined ? undefined : this.#choicePoolFromRow(row);
  }
  listChoicePools(
    ownerId: string,
    includeArchived = false,
  ): readonly ChoicePoolRecord[] {
    return (
      this.#database
        .prepare(
          "SELECT * FROM choice_pools WHERE owner_id=? AND (?=1 OR archived_at IS NULL) ORDER BY archived_at IS NOT NULL,title COLLATE NOCASE,id",
        )
        .all(ownerId, includeArchived ? 1 : 0) as unknown as readonly Record<
        string,
        string | number | null
      >[]
    ).map((row) => this.#choicePoolFromRow(row));
  }
  listChoicePoolItems(
    poolId: string,
    includeArchived = true,
  ): readonly ChoicePoolItemRecord[] {
    return (
      this.#database
        .prepare(
          "SELECT * FROM choice_pool_items WHERE pool_id=? AND (?=1 OR archived_at IS NULL) ORDER BY position,id",
        )
        .all(poolId, includeArchived ? 1 : 0) as unknown as readonly Record<
        string,
        string | number | null
      >[]
    ).map((row) => this.#choicePoolItemFromRow(row));
  }
  listChoicePoolHistory(poolId: string): readonly ChoicePoolHistoryRecord[] {
    return (
      this.#database
        .prepare(
          "SELECT * FROM choice_pool_history WHERE pool_id=? ORDER BY occurred_at,id",
        )
        .all(poolId) as unknown as readonly Record<
        string,
        string | number | null
      >[]
    ).map((row) => this.#choicePoolHistoryFromRow(row));
  }
  createPlanningPlaceholder(
    record: PlanningPlaceholderRecord,
  ): PlanningPlaceholderRecord | undefined {
    if (
      this.getChoicePool(record.ownerId, record.poolId) === undefined ||
      this.getTask(record.ownerId, record.taskId) === undefined ||
      this.listChoicePoolItems(record.poolId, false).length < record.pickCount
    )
      return undefined;
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      this.#database
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
      this.#database.exec("COMMIT;");
      return record;
    } catch (error) {
      this.#database.exec("ROLLBACK;");
      throw error;
    }
  }
  getPlanningPlaceholder(
    ownerId: string,
    id: string,
  ): PlanningPlaceholderRecord | undefined {
    const row = this.#database
      .prepare("SELECT * FROM planning_placeholders WHERE owner_id=? AND id=?")
      .get(ownerId, id) as unknown as
      Record<string, string | number | null> | undefined;
    return row === undefined ? undefined : this.#placeholderFromRow(row);
  }
  listPlanningPlaceholders(
    ownerId: string,
  ): readonly PlanningPlaceholderRecord[] {
    return (
      this.#database
        .prepare(
          "SELECT * FROM planning_placeholders WHERE owner_id=? ORDER BY created_at,id",
        )
        .all(ownerId) as unknown as readonly Record<
        string,
        string | number | null
      >[]
    ).map((row) => this.#placeholderFromRow(row));
  }
  getPlanningPlaceholderResolution(
    placeholderId: string,
  ): PlanningPlaceholderResolutionRecord | undefined {
    const row = this.#database
      .prepare(
        "SELECT * FROM planning_placeholder_resolutions WHERE placeholder_id=?",
      )
      .get(placeholderId) as unknown as
      Record<string, string | number> | undefined;
    return row === undefined ? undefined : this.#resolutionFromRow(row);
  }
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
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      const prior = this.#database
        .prepare(
          "SELECT * FROM planning_placeholder_resolutions WHERE owner_id=? AND placeholder_id=? AND idempotency_key=?",
        )
        .get(
          input.ownerId,
          input.placeholderId,
          input.idempotencyKey,
        ) as unknown as Record<string, string | number> | undefined;
      if (prior !== undefined) {
        this.#database.exec("COMMIT;");
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
        this.#database.exec("COMMIT;");
        return { kind: "not-found" };
      }
      if (
        placeholder.state !== "unresolved" ||
        placeholder.revision !== input.expectedRevision
      ) {
        this.#database.exec("COMMIT;");
        return { kind: "stale" };
      }
      if (
        input.selectedItemIds.length !== placeholder.pickCount ||
        new Set(input.selectedItemIds).size !== input.selectedItemIds.length
      ) {
        this.#database.exec("COMMIT;");
        return { kind: "conflict" };
      }
      const itemRows = input.selectedItemIds.map((id) =>
        this.#database
          .prepare(
            "SELECT * FROM choice_pool_items WHERE id=? AND pool_id=? AND archived_at IS NULL",
          )
          .get(id, placeholder.poolId),
      );
      if (itemRows.some((row) => row === undefined)) {
        this.#database.exec("COMMIT;");
        return { kind: "conflict" };
      }
      const items = itemRows.map((row) =>
        this.#choicePoolItemFromRow(
          row as unknown as Record<string, string | number | null>,
        ),
      );
      const resolutionId = randomUUID();
      const existingSubtasks = this.listSubtasks(
        input.ownerId,
        placeholder.taskId,
      );
      const subtaskIds: string[] = [];
      const historyIds: string[] = [];
      const insertSubtask = this.#database.prepare(
        "INSERT INTO subtasks (id,owner_id,task_id,title,completed,position,revision,created_at,updated_at) VALUES (?,?,?,?,0,?,?,?,?)",
      );
      const insertHistory = this.#database.prepare(
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
        const archive = this.#database.prepare(
          "UPDATE choice_pool_items SET archived_at=?,updated_at=?,revision=revision+1 WHERE id=? AND archived_at IS NULL",
        );
        for (const item of items)
          archive.run(input.logicalTime, input.now, item.id);
      }
      this.#database
        .prepare(
          "UPDATE planning_placeholders SET state='resolved',revision=revision+1,updated_at=?,resolved_at=? WHERE id=?",
        )
        .run(input.now, input.logicalTime, placeholder.id);
      this.#database
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
      this.#database.exec("COMMIT;");
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
      this.#database.exec("ROLLBACK;");
      throw error;
    }
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
    const subtasks = this.listSubtasks(ownerId, placeholder.taskId).filter(
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
  #organizationFromRow(
    row: Record<string, string | number | null>,
    title: string,
  ): Omit<TagRecord, "normalizedName"> {
    return {
      id: String(row.id),
      ownerId: String(row.owner_id),
      title,
      revision: Number(row.revision),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      archivedAt: row.archived_at === null ? null : String(row.archived_at),
      color: row.color == null ? null : String(row.color),
      icon: row.icon == null ? null : String(row.icon),
      position: Number(row.position ?? 0),
    };
  }
  #projectFromRow(
    row: Record<string, string | number | null>,
    backlog: ReadonlyMap<string, readonly string[]>,
  ): ProjectRecord {
    return {
      ...this.#organizationFromRow(row, String(row.title)),
      hiddenFromMenu: Number(row.hidden_from_menu) === 1,
      completedAt: row.completed_at == null ? null : String(row.completed_at),
      backlogEnabled: Number(row.backlog_enabled) === 1,
      backlogTaskIds: backlog.get(String(row.id)) ?? [],
    };
  }
  #tagFromRow(row: Record<string, string | number | null>): TagRecord {
    return {
      ...this.#organizationFromRow(row, String(row.display_name)),
      normalizedName: String(row.normalized_name),
    };
  }
  #tag(ownerId: string, id: string): TagRecord | undefined {
    const row = this.#database
      .prepare("SELECT * FROM tags WHERE owner_id=? AND id=?")
      .get(ownerId, id) as unknown as
      Record<string, string | number | null> | undefined;
    return row === undefined ? undefined : this.#tagFromRow(row);
  }

  #migrate(): void {
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id TEXT PRIMARY KEY,
        checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL
      ) STRICT;
    `);

    const applied = new Map(
      (
        this.#database
          .prepare("SELECT id, checksum FROM schema_migrations")
          .all() as unknown as readonly MigrationRow[]
      ).map((row) => [row.id, row.checksum]),
    );

    for (const migration of migrations) {
      const expectedChecksum = checksum(migration.sql);
      const appliedChecksum = applied.get(migration.id);

      if (appliedChecksum !== undefined) {
        if (appliedChecksum !== expectedChecksum) {
          throw new Error(`Migration checksum mismatch: ${migration.id}`);
        }
        continue;
      }

      this.#database.exec("BEGIN IMMEDIATE;");
      try {
        this.#database.exec(migration.sql);
        this.#database
          .prepare(
            "INSERT INTO schema_migrations (id, checksum, applied_at) VALUES (?, ?, ?)",
          )
          .run(migration.id, expectedChecksum, new Date().toISOString());
        this.#database.exec("COMMIT;");
      } catch (error: unknown) {
        this.#database.exec("ROLLBACK;");
        throw error;
      }
    }
  }

  #ensureInstallMetadata(): void {
    this.#database
      .prepare(
        `INSERT OR IGNORE INTO install_metadata
          (singleton, instance_id, created_at) VALUES (1, ?, ?)`,
      )
      .run(randomUUID(), new Date().toISOString());
  }
}
