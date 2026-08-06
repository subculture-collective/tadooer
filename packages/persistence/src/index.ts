import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

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
  readonly projectId?: string | null;
  readonly tagIds?: readonly string[];
}

export interface TaskPatch {
  readonly title?: string;
  readonly notes?: string;
  readonly plannedStart?: string | null;
  readonly estimateMinutes?: number | null;
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
  readonly freshness: "current" | "stale" | "unavailable" | "unsupported";
  readonly mutable: boolean;
  readonly revision: number;
  readonly projectedAt: string;
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

export interface ProjectRecord {
  readonly id: string;
  readonly ownerId: string;
  readonly title: string;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
}
export interface TagRecord extends ProjectRecord {
  readonly normalizedName: string;
}
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
        title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 120), revision INTEGER NOT NULL CHECK(revision > 0),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived_at TEXT
      ) STRICT;
      CREATE TABLE tags (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES owner_accounts(id) ON DELETE CASCADE,
        display_name TEXT NOT NULL CHECK(length(display_name) BETWEEN 1 AND 80), normalized_name TEXT NOT NULL,
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
];

const checksum = (sql: string): string =>
  createHash("sha256").update(sql).digest("hex");

const escapeSqliteString = (value: string): string =>
  value.replaceAll("'", "''");

export class SuiteDatabase {
  readonly #database: DatabaseSync;

  private constructor(database: DatabaseSync) {
    this.#database = database;
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
    this.#database
      .prepare(
        `INSERT INTO baikal_connectors (
          id, owner_id, endpoint, username, credential_key_id,
          credential_nonce, credential_ciphertext, credential_tag,
          verified_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(owner_id) DO UPDATE SET
          endpoint = excluded.endpoint,
          username = excluded.username,
          credential_key_id = excluded.credential_key_id,
          credential_nonce = excluded.credential_nonce,
          credential_ciphertext = excluded.credential_ciphertext,
          credential_tag = excluded.credential_tag,
          verified_at = excluded.verified_at,
          updated_at = excluded.updated_at`,
      )
      .run(
        connector.id,
        connector.ownerId,
        connector.endpoint,
        connector.username,
        connector.credentialKeyId,
        connector.credentialNonce,
        connector.credentialCiphertext,
        connector.credentialTag,
        connector.verifiedAt,
        connector.updatedAt,
        connector.updatedAt,
      );
  }

  getBaikalConnector(ownerId: string): BaikalConnectorRecord | undefined {
    const row = this.#database
      .prepare("SELECT * FROM baikal_connectors WHERE owner_id = ?")
      .get(ownerId) as unknown as
      Record<string, string | Uint8Array> | undefined;
    return row === undefined
      ? undefined
      : {
          id: String(row.id),
          ownerId: String(row.owner_id),
          endpoint: String(row.endpoint),
          username: String(row.username),
          credentialKeyId: String(row.credential_key_id),
          credentialNonce: row.credential_nonce as Uint8Array,
          credentialCiphertext: row.credential_ciphertext as Uint8Array,
          credentialTag: row.credential_tag as Uint8Array,
          verifiedAt: String(row.verified_at),
        };
  }

  ensureCalendarProvider(
    ownerId: string,
    kind: CalendarProviderRecord["kind"],
    connectorId: string,
    now: string,
  ): CalendarProviderRecord {
    const existing = this.#database
      .prepare(
        `SELECT id, owner_id, kind, connector_id, created_at, updated_at
         FROM calendar_providers
         WHERE owner_id = ? AND kind = ? AND connector_id = ?`,
      )
      .get(ownerId, kind, connectorId) as unknown as
      | {
          readonly id: string;
          readonly owner_id: string;
          readonly kind: CalendarProviderRecord["kind"];
          readonly connector_id: string;
          readonly created_at: string;
          readonly updated_at: string;
        }
      | undefined;
    if (existing !== undefined) {
      return {
        id: existing.id,
        ownerId: existing.owner_id,
        kind: existing.kind,
        connectorId: existing.connector_id,
        createdAt: existing.created_at,
        updatedAt: existing.updated_at,
      };
    }

    const provider: CalendarProviderRecord = {
      id: randomUUID(),
      ownerId,
      kind,
      connectorId,
      createdAt: now,
      updatedAt: now,
    };
    this.#database
      .prepare(
        `INSERT INTO calendar_providers
          (id, owner_id, kind, connector_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        provider.id,
        provider.ownerId,
        provider.kind,
        provider.connectorId,
        provider.createdAt,
        provider.updatedAt,
      );
    return provider;
  }

  putCalendarCollections(
    providerId: string,
    collections: readonly Omit<CalendarCollectionRecord, "id" | "providerId">[],
    discoveredAt: string,
  ): readonly CalendarCollectionRecord[] {
    return collections.map((collection) => {
      const existing = this.#database
        .prepare(
          "SELECT id FROM calendar_collections WHERE provider_id = ? AND href = ?",
        )
        .get(providerId, collection.href) as unknown as
        { readonly id: string } | undefined;
      const record: CalendarCollectionRecord = {
        id: existing?.id ?? randomUUID(),
        providerId,
        ...collection,
      };
      this.#database
        .prepare(
          `INSERT INTO calendar_collections
            (id, provider_id, href, display_name, supports_events,
             supports_todos, last_discovered_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(provider_id, href) DO UPDATE SET
             display_name = excluded.display_name,
             supports_events = excluded.supports_events,
             supports_todos = excluded.supports_todos,
             last_discovered_at = excluded.last_discovered_at`,
        )
        .run(
          record.id,
          record.providerId,
          record.href,
          record.displayName,
          record.supportsEvents ? 1 : 0,
          record.supportsTodos ? 1 : 0,
          discoveredAt,
        );
      return record;
    });
  }

  getOwnedCalendar(
    ownerId: string,
    calendarId: string,
  ): OwnedCalendarRecord | undefined {
    const row = this.#database
      .prepare(
        `SELECT c.id, c.provider_id, c.href, c.display_name,
                c.supports_events, c.supports_todos,
                p.owner_id, p.kind, p.connector_id
         FROM calendar_collections c
         JOIN calendar_providers p ON p.id = c.provider_id
         WHERE p.owner_id = ? AND c.id = ?`,
      )
      .get(ownerId, calendarId) as unknown as
      | {
          readonly id: string;
          readonly provider_id: string;
          readonly href: string;
          readonly display_name: string;
          readonly supports_events: number;
          readonly supports_todos: number;
          readonly owner_id: string;
          readonly kind: CalendarProviderRecord["kind"];
          readonly connector_id: string;
        }
      | undefined;
    return row === undefined
      ? undefined
      : {
          id: row.id,
          providerId: row.provider_id,
          href: row.href,
          displayName: row.display_name,
          supportsEvents: row.supports_events === 1,
          supportsTodos: row.supports_todos === 1,
          ownerId: row.owner_id,
          kind: row.kind,
          connectorId: row.connector_id,
        };
  }

  replaceCalendarEventWindow(
    ownerId: string,
    calendarId: string,
    from: string,
    to: string,
    events: readonly Omit<CalendarEventProjectionRecord, "ownerId">[],
  ): void {
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      this.#database
        .prepare(
          `DELETE FROM calendar_event_projections
           WHERE owner_id = ? AND calendar_id = ?
             AND starts_at < ? AND ends_at > ?`,
        )
        .run(ownerId, calendarId, to, from);
      for (const event of events) this.#putCalendarEvent(ownerId, event);
      this.#database.exec("COMMIT;");
    } catch (error: unknown) {
      this.#database.exec("ROLLBACK;");
      throw error;
    }
  }

  listCalendarEvents(
    ownerId: string,
    from: string,
    to: string,
  ): readonly CalendarEventProjectionRecord[] {
    const rows = this.#database
      .prepare(
        `SELECT * FROM calendar_event_projections
         WHERE owner_id = ? AND starts_at < ? AND ends_at > ?
         ORDER BY starts_at, calendar_id, href`,
      )
      .all(ownerId, to, from) as unknown as readonly Record<
      string,
      string | number
    >[];
    return rows.map((row) => this.#calendarEventFromRow(row));
  }

  getTaskCalendarBlock(
    ownerId: string,
    taskId: string,
  ): TaskCalendarBlockRecord | undefined {
    const row = this.#database
      .prepare(
        "SELECT * FROM task_calendar_blocks WHERE owner_id = ? AND task_id = ?",
      )
      .get(ownerId, taskId) as unknown as
      Record<string, string | number> | undefined;
    return row === undefined ? undefined : this.#calendarBlockFromRow(row);
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
    this.#database
      .prepare(
        `UPDATE task_calendar_blocks SET state = ?, revision = revision + 1,
           updated_at = ? WHERE owner_id = ? AND task_id = ?`,
      )
      .run(state, now, ownerId, taskId);
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
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      const operation = this.#getCalendarWriteOperation(
        ownerId,
        idempotencyKey,
      );
      if (operation !== undefined) {
        this.#database
          .prepare(
            `UPDATE calendar_write_operations
             SET state = 'needs_reconciliation', updated_at = ?
             WHERE owner_id = ? AND idempotency_key = ?`,
          )
          .run(now, ownerId, idempotencyKey);
        this.#database
          .prepare(
            `UPDATE task_calendar_blocks
             SET state = 'conflict', revision = revision + 1, updated_at = ?
             WHERE owner_id = ? AND task_id = ?`,
          )
          .run(now, ownerId, operation.taskId);
      }
      this.#database.exec("COMMIT;");
    } catch (error: unknown) {
      this.#database.exec("ROLLBACK;");
      throw error;
    }
  }

  getCalendarWriteOperation(
    ownerId: string,
    idempotencyKey: string,
  ): CalendarWriteOperationRecord | undefined {
    return this.#getCalendarWriteOperation(ownerId, idempotencyKey);
  }

  #putCalendarEvent(
    ownerId: string,
    event: Omit<CalendarEventProjectionRecord, "ownerId">,
  ): void {
    this.#database
      .prepare(
        `INSERT INTO calendar_event_projections
          (id, owner_id, provider_id, calendar_id, href, uid, etag, raw_ics,
           summary, starts_at, ends_at, all_day, freshness, mutable, revision,
           projected_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(calendar_id, href) DO UPDATE SET
           uid = excluded.uid, etag = excluded.etag, raw_ics = excluded.raw_ics,
           summary = excluded.summary, starts_at = excluded.starts_at,
           ends_at = excluded.ends_at, all_day = excluded.all_day,
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

  #calendarEventFromRow(
    row: Record<string, string | number>,
  ): CalendarEventProjectionRecord {
    return {
      id: String(row.id),
      ownerId: String(row.owner_id),
      providerId: String(row.provider_id),
      calendarId: String(row.calendar_id),
      href: String(row.href),
      uid: String(row.uid),
      etag: String(row.etag),
      rawIcs: String(row.raw_ics),
      summary: String(row.summary),
      startsAt: String(row.starts_at),
      endsAt: String(row.ends_at),
      allDay: Number(row.all_day) === 1,
      freshness: String(
        row.freshness,
      ) as CalendarEventProjectionRecord["freshness"],
      mutable: Number(row.mutable) === 1,
      revision: Number(row.revision),
      projectedAt: String(row.projected_at),
    };
  }

  #calendarBlockFromRow(
    row: Record<string, string | number>,
  ): TaskCalendarBlockRecord {
    return {
      id: String(row.id),
      ownerId: String(row.owner_id),
      taskId: String(row.task_id),
      providerId: String(row.provider_id),
      calendarId: String(row.calendar_id),
      eventHref: String(row.event_href),
      eventUid: String(row.event_uid),
      remoteEtag: String(row.remote_etag),
      state: String(row.state) as TaskCalendarBlockRecord["state"],
      revision: Number(row.revision),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
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
    >,
  ): IdempotentTaskCreateResult {
    this.#database.exec("BEGIN IMMEDIATE;");
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
          this.#database.exec("COMMIT;");
          return { kind: "conflict" };
        }
        const replayed = this.#findTask(ownerId, prior.resource_id);
        if (replayed === undefined)
          throw new Error("Idempotency record refers to a missing task");
        this.#database.exec("COMMIT;");
        return { kind: "replayed", task: replayed };
      }

      const created: TaskRecord = {
        ownerId,
        ...task,
        completedAt: null,
        deletedAt: null,
        plannedStart: null,
        estimateMinutes: null,
        projectId: null,
        tagIds: [],
      };
      this.#database
        .prepare(
          `INSERT INTO tasks
            (id, owner_id, title, notes, status, revision, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
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
      ])
        initialFieldVersion.run(created.id, field);
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
      this.#database.exec("COMMIT;");
      return { kind: "created", task: created };
    } catch (error: unknown) {
      this.#database.exec("ROLLBACK;");
      throw error;
    }
  }

  listTasks(ownerId: string): readonly TaskRecord[] {
    const rows = this.#database
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

  listDeletedTasks(ownerId: string): readonly TaskRecord[] {
    const rows = this.#database
      .prepare(
        `SELECT id, owner_id, title, notes, status, revision, created_at, updated_at,
                completed_at, deleted_at, planned_start, estimate_minutes
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
                completed_at, deleted_at, planned_start, estimate_minutes
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
        `SELECT * FROM client_identities WHERE owner_id = ? AND credential_hash IS NOT NULL ORDER BY created_at, id`,
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
    readonly cursor: { readonly epoch: string; readonly cursor: number };
  } {
    const tasks = this.listTasks(ownerId);
    const subtasks = tasks.flatMap((task) =>
      this.listSubtasks(ownerId, task.id),
    );
    return {
      tasks,
      projects: this.listProjects(ownerId),
      tags: this.listTags(ownerId),
      subtasks,
      cursor: this.getSyncState(ownerId),
    };
  }

  createProject(record: ProjectRecord): void {
    this.#database
      .prepare(
        "INSERT INTO projects (id, owner_id, title, revision, created_at, updated_at, archived_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
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
          "SELECT * FROM projects WHERE owner_id = ? ORDER BY archived_at IS NOT NULL, title COLLATE NOCASE, id",
        )
        .all(ownerId) as unknown as readonly Record<
        string,
        string | number | null
      >[]
    ).map((row) => this.#projectFromRow(row));
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
  assignTaskProject(
    ownerId: string,
    taskId: string,
    projectId: string | null,
    expectedRevision: number,
    now: string,
  ): TaskRecord | undefined {
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      const valid =
        projectId === null ||
        this.#database
          .prepare(
            "SELECT 1 FROM projects WHERE id=? AND owner_id=? AND archived_at IS NULL",
          )
          .get(projectId, ownerId) !== undefined;
      if (!valid) {
        this.#database.exec("ROLLBACK;");
        return undefined;
      }
      const changed = this.#database
        .prepare(
          "UPDATE tasks SET project_id=?,revision=revision+1,updated_at=? WHERE owner_id=? AND id=? AND revision=?",
        )
        .run(projectId, now, ownerId, taskId, expectedRevision).changes;
      if (changed !== 1) {
        this.#database.exec("COMMIT;");
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
      this.#database.exec("COMMIT;");
      return task;
    } catch (error) {
      this.#database.exec("ROLLBACK;");
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
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      const current = this.getTask(ownerId, taskId);
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
              session: JSON.parse(prior.response_json) as ActiveSessionRecord,
            }
          : { kind: "conflict" };
      }
      const current = this.getActiveSession(input.session.ownerId);
      if (input.expectedRevision === null) {
        if (current !== undefined && current.endedAt === null) {
          this.#database.exec("COMMIT;");
          return { kind: "conflict", session: current };
        }
      } else if (
        current === undefined ||
        current.id !== input.session.id ||
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
          JSON.stringify(input.session),
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
      return { kind: "applied", session: input.session };
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
        .all(sessionId) as unknown as readonly Record<string, string | number>[]
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
      }
    | undefined {
    const row = this.#database
      .prepare(
        "SELECT session_id,revision,request_hash FROM active_session_operation_outcomes WHERE owner_id=? AND client_id=? AND idempotency_key=?",
      )
      .get(ownerId, clientId, idempotencyKey) as unknown as
      Record<string, string | number> | undefined;
    return row === undefined
      ? undefined
      : {
          sessionId: String(row.session_id),
          revision: Number(row.revision),
          requestHash: String(row.request_hash),
        };
  }

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
    readonly task: Omit<
      TaskRecord,
      | "ownerId"
      | "completedAt"
      | "deletedAt"
      | "plannedStart"
      | "projectId"
      | "tagIds"
    >;
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
            input.task.createdAt,
          );
        this.#database.exec("COMMIT;");
        return { kind: "conflict", task: existing };
      }
      const task: TaskRecord = {
        ...input.task,
        ownerId: input.ownerId,
        completedAt: null,
        deletedAt: null,
        plannedStart: null,
        projectId: null,
        tagIds: [],
      };
      this.#database
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
          task.createdAt,
          task.updatedAt,
          task.estimateMinutes,
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
        task.createdAt,
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
      if (
        task === undefined ||
        task.revision !== input.baseRevision ||
        (input.restore ? task.deletedAt === null : task.deletedAt !== null)
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
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      const current = this.getTask(ownerId, taskId, true);
      if (
        current === undefined ||
        (requireDeleted
          ? current.deletedAt === null
          : current.deletedAt !== null)
      ) {
        this.#database.exec("COMMIT;");
        return { kind: "not-found" };
      }
      if (current.revision !== expectedRevision) {
        this.#database.exec("COMMIT;");
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
             planned_start = ?, estimate_minutes = ?
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
          ownerId,
          taskId,
          expectedRevision,
        ).changes;
      if (changed !== 1) throw new Error("Conditional task update was lost");
      this.#database.exec("COMMIT;");
      return { kind: "updated", task: next };
    } catch (error: unknown) {
      this.#database.exec("ROLLBACK;");
      throw error;
    }
  }

  #findTask(ownerId: string, taskId: string): TaskRecord | undefined {
    const row = this.#database
      .prepare(
        `SELECT id, owner_id, title, notes, status, revision, created_at, updated_at,
                completed_at, deleted_at, planned_start, estimate_minutes
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
    return row === undefined ? undefined : this.#projectFromRow(row);
  }
  #projectFromRow(row: Record<string, string | number | null>): ProjectRecord {
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
