import type { DatabaseSync } from "node:sqlite";

/**
 * Google-Baikal calendar bridge state (issue #40, ADR 0041): owner-scoped
 * mappings, event links carrying accepted state and tombstones, the ordered
 * per-mapping outbox, and retained conflicts. Provider I/O lives in the server;
 * every method here is one local transaction.
 */
export const calendarBridgeMigration = {
  id: "0045_calendar_bridge",
  sql: `
      CREATE TABLE calendar_bridge_mappings (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL REFERENCES owner_accounts(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL CHECK (revision > 0),
        -- Collection IDs without a foreign key: disconnecting a provider deletes
        -- its collections, and the mapping must survive as blocked provenance.
        google_calendar_id TEXT NOT NULL,
        google_calendar_ref TEXT NOT NULL,
        baikal_calendar_id TEXT NOT NULL,
        baikal_calendar_ref TEXT NOT NULL,
        direction TEXT NOT NULL
          CHECK (direction IN ('two_way', 'google_to_baikal', 'baikal_to_google')),
        initial_sync TEXT NOT NULL CHECK (initial_sync IN ('copy_existing', 'new_only')),
        enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
        google_cursor TEXT,
        first_pass_at TEXT,
        last_run_at TEXT,
        last_success_at TEXT,
        last_error_code TEXT CHECK (last_error_code IS NULL OR length(last_error_code) <= 64),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        removed_at TEXT
      ) STRICT;
      CREATE UNIQUE INDEX calendar_bridge_google_calendar_live
        ON calendar_bridge_mappings(google_calendar_id) WHERE removed_at IS NULL;
      CREATE UNIQUE INDEX calendar_bridge_baikal_calendar_live
        ON calendar_bridge_mappings(baikal_calendar_id) WHERE removed_at IS NULL;
      CREATE INDEX calendar_bridge_mappings_by_owner
        ON calendar_bridge_mappings(owner_id, created_at, id);

      CREATE TABLE calendar_bridge_links (
        id TEXT PRIMARY KEY,
        mapping_id TEXT NOT NULL REFERENCES calendar_bridge_mappings(id) ON DELETE CASCADE,
        owner_id TEXT NOT NULL REFERENCES owner_accounts(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL CHECK (revision > 0),
        origin TEXT NOT NULL CHECK (origin IN ('google', 'baikal')),
        google_event_id TEXT,
        google_ical_uid TEXT,
        baikal_href TEXT,
        baikal_uid TEXT,
        google_kind TEXT NOT NULL CHECK (google_kind IN ('unknown', 'present', 'deleted')),
        google_revision TEXT,
        google_digest TEXT,
        google_snapshot TEXT,
        baikal_kind TEXT NOT NULL CHECK (baikal_kind IN ('unknown', 'present', 'deleted')),
        baikal_revision TEXT,
        baikal_digest TEXT,
        baikal_snapshot TEXT,
        accepted_kind TEXT NOT NULL CHECK (accepted_kind IN ('none', 'present', 'deleted')),
        accepted_digest TEXT,
        accepted_snapshot TEXT,
        accepted_at TEXT,
        status TEXT NOT NULL CHECK (status IN
          ('pending', 'active', 'conflict', 'blocked', 'excluded', 'tombstoned')),
        status_reason TEXT CHECK (status_reason IS NULL OR length(status_reason) <= 64),
        deletion_approval_side TEXT CHECK (deletion_approval_side IN ('google', 'baikal')),
        deletion_approval_proof TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (accepted_kind <> 'present' OR accepted_digest IS NOT NULL),
        UNIQUE (mapping_id, google_event_id),
        UNIQUE (mapping_id, baikal_href)
      ) STRICT;
      CREATE INDEX calendar_bridge_links_by_mapping
        ON calendar_bridge_links(mapping_id, status, id);
      CREATE INDEX calendar_bridge_links_by_google
        ON calendar_bridge_links(owner_id, google_event_id);
      CREATE INDEX calendar_bridge_links_by_baikal
        ON calendar_bridge_links(owner_id, baikal_href);

      CREATE TABLE calendar_bridge_outbox (
        id TEXT PRIMARY KEY,
        mapping_id TEXT NOT NULL REFERENCES calendar_bridge_mappings(id) ON DELETE CASCADE,
        link_id TEXT NOT NULL REFERENCES calendar_bridge_links(id) ON DELETE CASCADE,
        owner_id TEXT NOT NULL REFERENCES owner_accounts(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL CHECK (sequence > 0),
        mapping_revision INTEGER NOT NULL CHECK (mapping_revision > 0),
        target TEXT NOT NULL CHECK (target IN ('google', 'baikal')),
        action TEXT NOT NULL CHECK (action IN ('create', 'update', 'delete')),
        target_native_id TEXT NOT NULL,
        target_uid TEXT,
        expected_revision TEXT,
        source_side TEXT NOT NULL CHECK (source_side IN ('google', 'baikal')),
        source_revision TEXT,
        payload TEXT,
        payload_digest TEXT,
        reason TEXT NOT NULL CHECK (reason IN ('propagate', 'create', 'resolution')),
        state TEXT NOT NULL CHECK (state IN
          ('pending', 'dispatched', 'uncertain', 'applied', 'failed', 'cancelled')),
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        last_error TEXT CHECK (last_error IS NULL OR length(last_error) <= 64),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        CHECK (action = 'create' OR expected_revision IS NOT NULL),
        CHECK (action = 'delete' OR (payload IS NOT NULL AND payload_digest IS NOT NULL)),
        UNIQUE (mapping_id, sequence)
      ) STRICT;
      CREATE UNIQUE INDEX calendar_bridge_outbox_one_unfinished
        ON calendar_bridge_outbox(link_id)
        WHERE state IN ('pending', 'dispatched', 'uncertain');

      CREATE TABLE calendar_bridge_conflicts (
        id TEXT PRIMARY KEY,
        mapping_id TEXT NOT NULL REFERENCES calendar_bridge_mappings(id) ON DELETE CASCADE,
        link_id TEXT NOT NULL REFERENCES calendar_bridge_links(id) ON DELETE CASCADE,
        owner_id TEXT NOT NULL REFERENCES owner_accounts(id) ON DELETE CASCADE,
        reason TEXT NOT NULL CHECK (reason IN ('concurrent-change', 'resurrection')),
        baseline_kind TEXT NOT NULL CHECK (baseline_kind IN ('none', 'present', 'deleted')),
        baseline_digest TEXT,
        google_kind TEXT NOT NULL CHECK (google_kind IN ('present', 'deleted')),
        google_revision TEXT,
        google_digest TEXT,
        google_snapshot TEXT,
        baikal_kind TEXT NOT NULL CHECK (baikal_kind IN ('present', 'deleted')),
        baikal_revision TEXT,
        baikal_digest TEXT,
        baikal_snapshot TEXT,
        state TEXT NOT NULL CHECK (state IN ('open', 'resolved', 'superseded')),
        resolution TEXT CHECK (resolution IN ('google', 'baikal')),
        created_at TEXT NOT NULL,
        closed_at TEXT
      ) STRICT;
      CREATE UNIQUE INDEX calendar_bridge_conflicts_one_open
        ON calendar_bridge_conflicts(link_id) WHERE state = 'open';
    `,
};

export type CalendarBridgeSideName = "google" | "baikal";
export type CalendarBridgeDirectionName =
  "two_way" | "google_to_baikal" | "baikal_to_google";
export type CalendarBridgeInitialSync = "copy_existing" | "new_only";

export interface CalendarBridgeMappingRecord {
  readonly id: string;
  readonly ownerId: string;
  readonly revision: number;
  readonly googleCalendarId: string;
  /** Google calendar ID at creation (provenance). */
  readonly googleCalendarRef: string;
  readonly baikalCalendarId: string;
  /** Baikal collection href at creation (provenance). */
  readonly baikalCalendarRef: string;
  readonly direction: CalendarBridgeDirectionName;
  readonly initialSync: CalendarBridgeInitialSync;
  readonly enabled: boolean;
  readonly googleCursor: string | null;
  readonly firstPassAt: string | null;
  readonly lastRunAt: string | null;
  readonly lastSuccessAt: string | null;
  readonly lastErrorCode: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly removedAt: string | null;
}

/** Last observed state of one side of an event link. */
export interface CalendarBridgeSideState {
  readonly kind: "unknown" | "present" | "deleted";
  /** Opaque native revision (ETag); for a deletion, its proof. */
  readonly revision: string | null;
  readonly digest: string | null;
  /** Normalized envelope JSON owned by the server bridge module. */
  readonly snapshot: string | null;
}

export type CalendarBridgeLinkStatus =
  "pending" | "active" | "conflict" | "blocked" | "excluded" | "tombstoned";

export interface CalendarBridgeLinkRecord {
  readonly id: string;
  readonly mappingId: string;
  readonly ownerId: string;
  readonly revision: number;
  readonly origin: CalendarBridgeSideName;
  readonly googleEventId: string | null;
  readonly googleIcalUid: string | null;
  readonly baikalHref: string | null;
  readonly baikalUid: string | null;
  readonly google: CalendarBridgeSideState;
  readonly baikal: CalendarBridgeSideState;
  /** Accepted Calendar State; `deleted` is the Calendar Tombstone. */
  readonly acceptedKind: "none" | "present" | "deleted";
  readonly acceptedDigest: string | null;
  readonly acceptedSnapshot: string | null;
  readonly acceptedAt: string | null;
  readonly status: CalendarBridgeLinkStatus;
  readonly statusReason: string | null;
  readonly deletionApproval: {
    readonly side: CalendarBridgeSideName;
    readonly proof: string;
  } | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type CalendarBridgeOperationState =
  "pending" | "dispatched" | "uncertain" | "applied" | "failed" | "cancelled";

export interface CalendarBridgeOperationRecord {
  readonly id: string;
  readonly mappingId: string;
  readonly linkId: string;
  readonly ownerId: string;
  readonly sequence: number;
  readonly mappingRevision: number;
  readonly target: CalendarBridgeSideName;
  readonly action: "create" | "update" | "delete";
  readonly targetNativeId: string;
  readonly targetUid: string | null;
  readonly expectedRevision: string | null;
  readonly sourceSide: CalendarBridgeSideName;
  readonly sourceRevision: string | null;
  readonly payload: string | null;
  readonly payloadDigest: string | null;
  readonly reason: "propagate" | "create" | "resolution";
  readonly state: CalendarBridgeOperationState;
  readonly attempts: number;
  readonly lastError: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
}

export interface CalendarBridgeConflictSide {
  readonly kind: "present" | "deleted";
  readonly revision: string | null;
  readonly digest: string | null;
  readonly snapshot: string | null;
}

export interface CalendarBridgeConflictRecord {
  readonly id: string;
  readonly mappingId: string;
  readonly linkId: string;
  readonly ownerId: string;
  readonly reason: "concurrent-change" | "resurrection";
  readonly baselineKind: "none" | "present" | "deleted";
  readonly baselineDigest: string | null;
  readonly google: CalendarBridgeConflictSide;
  readonly baikal: CalendarBridgeConflictSide;
  readonly state: "open" | "resolved" | "superseded";
  readonly resolution: CalendarBridgeSideName | null;
  readonly createdAt: string;
  readonly closedAt: string | null;
}

export type CalendarBridgeMappingCreateResult =
  | { readonly kind: "created"; readonly mapping: CalendarBridgeMappingRecord }
  | { readonly kind: "invalid-calendar" }
  | { readonly kind: "calendar-in-use" };

export type CalendarBridgeMappingUpdateResult =
  | { readonly kind: "updated"; readonly mapping: CalendarBridgeMappingRecord }
  | { readonly kind: "not-found" }
  | { readonly kind: "conflict" };

export type CalendarBridgeMappingRemoveResult =
  "removed" | "not-found" | "conflict" | "in-flight" | "pending-work";

export interface CalendarBridgeNewLink {
  readonly id: string;
  readonly mappingId: string;
  readonly ownerId: string;
  readonly origin: CalendarBridgeSideName;
  readonly googleEventId: string | null;
  readonly googleIcalUid: string | null;
  readonly baikalHref: string | null;
  readonly baikalUid: string | null;
  readonly google: CalendarBridgeSideState;
  readonly baikal: CalendarBridgeSideState;
  readonly status: CalendarBridgeLinkStatus;
  readonly statusReason: string | null;
  readonly now: string;
}

export interface CalendarBridgeOperationInput {
  readonly id: string;
  readonly target: CalendarBridgeSideName;
  readonly action: "create" | "update" | "delete";
  readonly targetNativeId: string;
  readonly targetUid: string | null;
  readonly expectedRevision: string | null;
  readonly sourceSide: CalendarBridgeSideName;
  readonly sourceRevision: string | null;
  readonly payload: string | null;
  readonly payloadDigest: string | null;
  readonly reason: "propagate" | "create" | "resolution";
}

/** Outcome of a confirmed write, committed with the accepted state. */
export interface CalendarBridgeReceipt {
  readonly google: CalendarBridgeSideState;
  readonly baikal: CalendarBridgeSideState;
  readonly accepted:
    | {
        readonly kind: "present";
        readonly digest: string;
        readonly snapshot: string;
      }
    | { readonly kind: "deleted" };
  readonly now: string;
}

export type CalendarBridgeConflictResolveResult =
  | {
      readonly kind: "resolved";
      readonly operation: CalendarBridgeOperationRecord;
    }
  | { readonly kind: "not-found" }
  | { readonly kind: "busy" }
  /** The link changed since the owner reviewed it (ADR 0044). */
  | { readonly kind: "conflict" }
  | { readonly kind: "unresolvable" };

interface MappingRow {
  readonly id: string;
  readonly owner_id: string;
  readonly revision: number;
  readonly google_calendar_id: string;
  readonly google_calendar_ref: string;
  readonly baikal_calendar_id: string;
  readonly baikal_calendar_ref: string;
  readonly direction: CalendarBridgeDirectionName;
  readonly initial_sync: CalendarBridgeInitialSync;
  readonly enabled: number;
  readonly google_cursor: string | null;
  readonly first_pass_at: string | null;
  readonly last_run_at: string | null;
  readonly last_success_at: string | null;
  readonly last_error_code: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly removed_at: string | null;
}

type SideKind = CalendarBridgeSideState["kind"];
interface LinkRow {
  readonly id: string;
  readonly mapping_id: string;
  readonly owner_id: string;
  readonly revision: number;
  readonly origin: CalendarBridgeSideName;
  readonly google_event_id: string | null;
  readonly google_ical_uid: string | null;
  readonly baikal_href: string | null;
  readonly baikal_uid: string | null;
  readonly google_kind: SideKind;
  readonly google_revision: string | null;
  readonly google_digest: string | null;
  readonly google_snapshot: string | null;
  readonly baikal_kind: SideKind;
  readonly baikal_revision: string | null;
  readonly baikal_digest: string | null;
  readonly baikal_snapshot: string | null;
  readonly accepted_kind: CalendarBridgeLinkRecord["acceptedKind"];
  readonly accepted_digest: string | null;
  readonly accepted_snapshot: string | null;
  readonly accepted_at: string | null;
  readonly status: CalendarBridgeLinkStatus;
  readonly status_reason: string | null;
  readonly deletion_approval_side: CalendarBridgeSideName | null;
  readonly deletion_approval_proof: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

interface OperationRow {
  readonly id: string;
  readonly mapping_id: string;
  readonly link_id: string;
  readonly owner_id: string;
  readonly sequence: number;
  readonly mapping_revision: number;
  readonly target: CalendarBridgeSideName;
  readonly action: CalendarBridgeOperationRecord["action"];
  readonly target_native_id: string;
  readonly target_uid: string | null;
  readonly expected_revision: string | null;
  readonly source_side: CalendarBridgeSideName;
  readonly source_revision: string | null;
  readonly payload: string | null;
  readonly payload_digest: string | null;
  readonly reason: CalendarBridgeOperationRecord["reason"];
  readonly state: CalendarBridgeOperationState;
  readonly attempts: number;
  readonly last_error: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly completed_at: string | null;
}

interface ConflictRow {
  readonly id: string;
  readonly mapping_id: string;
  readonly link_id: string;
  readonly owner_id: string;
  readonly reason: CalendarBridgeConflictRecord["reason"];
  readonly baseline_kind: CalendarBridgeConflictRecord["baselineKind"];
  readonly baseline_digest: string | null;
  readonly google_kind: "present" | "deleted";
  readonly google_revision: string | null;
  readonly google_digest: string | null;
  readonly google_snapshot: string | null;
  readonly baikal_kind: "present" | "deleted";
  readonly baikal_revision: string | null;
  readonly baikal_digest: string | null;
  readonly baikal_snapshot: string | null;
  readonly state: CalendarBridgeConflictRecord["state"];
  readonly resolution: CalendarBridgeSideName | null;
  readonly created_at: string;
  readonly closed_at: string | null;
}

const mappingFromRow = (row: MappingRow): CalendarBridgeMappingRecord => ({
  id: row.id,
  ownerId: row.owner_id,
  revision: row.revision,
  googleCalendarId: row.google_calendar_id,
  googleCalendarRef: row.google_calendar_ref,
  baikalCalendarId: row.baikal_calendar_id,
  baikalCalendarRef: row.baikal_calendar_ref,
  direction: row.direction,
  initialSync: row.initial_sync,
  enabled: row.enabled === 1,
  googleCursor: row.google_cursor,
  firstPassAt: row.first_pass_at,
  lastRunAt: row.last_run_at,
  lastSuccessAt: row.last_success_at,
  lastErrorCode: row.last_error_code,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  removedAt: row.removed_at,
});

const linkFromRow = (row: LinkRow): CalendarBridgeLinkRecord => ({
  id: row.id,
  mappingId: row.mapping_id,
  ownerId: row.owner_id,
  revision: row.revision,
  origin: row.origin,
  googleEventId: row.google_event_id,
  googleIcalUid: row.google_ical_uid,
  baikalHref: row.baikal_href,
  baikalUid: row.baikal_uid,
  google: {
    kind: row.google_kind,
    revision: row.google_revision,
    digest: row.google_digest,
    snapshot: row.google_snapshot,
  },
  baikal: {
    kind: row.baikal_kind,
    revision: row.baikal_revision,
    digest: row.baikal_digest,
    snapshot: row.baikal_snapshot,
  },
  acceptedKind: row.accepted_kind,
  acceptedDigest: row.accepted_digest,
  acceptedSnapshot: row.accepted_snapshot,
  acceptedAt: row.accepted_at,
  status: row.status,
  statusReason: row.status_reason,
  deletionApproval:
    row.deletion_approval_side === null || row.deletion_approval_proof === null
      ? null
      : {
          side: row.deletion_approval_side,
          proof: row.deletion_approval_proof,
        },
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const operationFromRow = (
  row: OperationRow,
): CalendarBridgeOperationRecord => ({
  id: row.id,
  mappingId: row.mapping_id,
  linkId: row.link_id,
  ownerId: row.owner_id,
  sequence: row.sequence,
  mappingRevision: row.mapping_revision,
  target: row.target,
  action: row.action,
  targetNativeId: row.target_native_id,
  targetUid: row.target_uid,
  expectedRevision: row.expected_revision,
  sourceSide: row.source_side,
  sourceRevision: row.source_revision,
  payload: row.payload,
  payloadDigest: row.payload_digest,
  reason: row.reason,
  state: row.state,
  attempts: row.attempts,
  lastError: row.last_error,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  completedAt: row.completed_at,
});

const conflictFromRow = (row: ConflictRow): CalendarBridgeConflictRecord => ({
  id: row.id,
  mappingId: row.mapping_id,
  linkId: row.link_id,
  ownerId: row.owner_id,
  reason: row.reason,
  baselineKind: row.baseline_kind,
  baselineDigest: row.baseline_digest,
  google: {
    kind: row.google_kind,
    revision: row.google_revision,
    digest: row.google_digest,
    snapshot: row.google_snapshot,
  },
  baikal: {
    kind: row.baikal_kind,
    revision: row.baikal_revision,
    digest: row.baikal_digest,
    snapshot: row.baikal_snapshot,
  },
  state: row.state,
  resolution: row.resolution,
  createdAt: row.created_at,
  closedAt: row.closed_at,
});

const unfinished = "('pending', 'dispatched', 'uncertain')";

export class SqliteCalendarBridgeStore {
  readonly #database: DatabaseSync;

  constructor(database: DatabaseSync) {
    this.#database = database;
  }

  #transaction<T>(run: () => T): T {
    // Nested inside a caller's transaction (an assistant confirmation, ADR
    // 0044), the work joins it through a savepoint.
    if (this.#database.isTransaction) {
      this.#database.exec("SAVEPOINT calendar_bridge;");
      try {
        const result = run();
        this.#database.exec("RELEASE SAVEPOINT calendar_bridge;");
        return result;
      } catch (error: unknown) {
        this.#database.exec("ROLLBACK TO SAVEPOINT calendar_bridge;");
        this.#database.exec("RELEASE SAVEPOINT calendar_bridge;");
        throw error;
      }
    }
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      const result = run();
      this.#database.exec("COMMIT;");
      return result;
    } catch (error: unknown) {
      this.#database.exec("ROLLBACK;");
      throw error;
    }
  }

  #calendar(
    ownerId: string,
    calendarId: string,
  ): { readonly kind: string; readonly href: string } | undefined {
    return this.#database
      .prepare(
        `SELECT p.kind, c.href FROM calendar_collections c
         JOIN calendar_providers p ON p.id = c.provider_id
         WHERE c.id = ? AND p.owner_id = ? AND c.supports_events = 1`,
      )
      .get(calendarId, ownerId) as unknown as
      { readonly kind: string; readonly href: string } | undefined;
  }

  // ---- Mappings -----------------------------------------------------------

  createMapping(input: {
    readonly id: string;
    readonly ownerId: string;
    readonly googleCalendarId: string;
    readonly baikalCalendarId: string;
    readonly direction: CalendarBridgeDirectionName;
    readonly initialSync: CalendarBridgeInitialSync;
    readonly now: string;
  }): CalendarBridgeMappingCreateResult {
    return this.#transaction(() => {
      const google = this.#calendar(input.ownerId, input.googleCalendarId);
      const baikal = this.#calendar(input.ownerId, input.baikalCalendarId);
      if (google?.kind !== "google" || baikal?.kind !== "baikal")
        return { kind: "invalid-calendar" } as const;
      const inUse = this.#database
        .prepare(
          `SELECT 1 FROM calendar_bridge_mappings WHERE removed_at IS NULL
           AND (google_calendar_id = ? OR baikal_calendar_id = ?)`,
        )
        .get(input.googleCalendarId, input.baikalCalendarId);
      if (inUse !== undefined) return { kind: "calendar-in-use" } as const;
      this.#database
        .prepare(
          `INSERT INTO calendar_bridge_mappings
            (id, owner_id, revision, google_calendar_id, google_calendar_ref,
             baikal_calendar_id, baikal_calendar_ref, direction, initial_sync,
             enabled, created_at, updated_at)
           VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        )
        .run(
          input.id,
          input.ownerId,
          input.googleCalendarId,
          google.href,
          input.baikalCalendarId,
          baikal.href,
          input.direction,
          input.initialSync,
          input.now,
          input.now,
        );
      const mapping = this.getMapping(input.ownerId, input.id);
      if (mapping === undefined) throw new Error("Mapping was not stored");
      return { kind: "created", mapping } as const;
    });
  }

  getMapping(
    ownerId: string,
    mappingId: string,
    includeRemoved = false,
  ): CalendarBridgeMappingRecord | undefined {
    const row = this.#database
      .prepare(
        `SELECT * FROM calendar_bridge_mappings WHERE owner_id = ? AND id = ?
         ${includeRemoved ? "" : "AND removed_at IS NULL"}`,
      )
      .get(ownerId, mappingId) as unknown as MappingRow | undefined;
    return row === undefined ? undefined : mappingFromRow(row);
  }

  listMappings(ownerId: string): readonly CalendarBridgeMappingRecord[] {
    return (
      this.#database
        .prepare(
          `SELECT * FROM calendar_bridge_mappings
           WHERE owner_id = ? AND removed_at IS NULL ORDER BY created_at, id`,
        )
        .all(ownerId) as unknown as MappingRow[]
    ).map(mappingFromRow);
  }

  /** Enabled live mappings, for the #46 worker. */
  listRunnableMappings(
    ownerId: string,
  ): readonly CalendarBridgeMappingRecord[] {
    return this.listMappings(ownerId).filter(({ enabled }) => enabled);
  }

  setMappingEnabled(input: {
    readonly ownerId: string;
    readonly mappingId: string;
    readonly expectedRevision: number;
    readonly enabled: boolean;
    readonly now: string;
  }): CalendarBridgeMappingUpdateResult {
    return this.#transaction(() => {
      const mapping = this.getMapping(input.ownerId, input.mappingId);
      if (mapping === undefined) return { kind: "not-found" } as const;
      if (mapping.revision !== input.expectedRevision)
        return { kind: "conflict" } as const;
      if (mapping.enabled !== input.enabled)
        this.#database
          .prepare(
            `UPDATE calendar_bridge_mappings
             SET enabled = ?, revision = revision + 1, updated_at = ? WHERE id = ?`,
          )
          .run(input.enabled ? 1 : 0, input.now, mapping.id);
      const updated = this.getMapping(input.ownerId, input.mappingId);
      if (updated === undefined) throw new Error("Mapping disappeared");
      return { kind: "updated", mapping: updated } as const;
    });
  }

  /**
   * Stops the mapping; never deletes provider events. Links, tombstones and
   * conflicts stay as provenance. In-flight work must be reconciled first.
   */
  removeMapping(input: {
    readonly ownerId: string;
    readonly mappingId: string;
    readonly expectedRevision: number;
    readonly cancelPending: boolean;
    readonly now: string;
  }): CalendarBridgeMappingRemoveResult {
    return this.#transaction(() => {
      const mapping = this.getMapping(input.ownerId, input.mappingId);
      if (mapping === undefined) return "not-found";
      if (mapping.revision !== input.expectedRevision) return "conflict";
      const counts = this.#database
        .prepare(
          `SELECT
             SUM(CASE WHEN state IN ('dispatched', 'uncertain') THEN 1 ELSE 0 END) AS in_flight,
             SUM(CASE WHEN state = 'pending' THEN 1 ELSE 0 END) AS pending
           FROM calendar_bridge_outbox WHERE mapping_id = ?`,
        )
        .get(mapping.id) as unknown as {
        readonly in_flight: number | null;
        readonly pending: number | null;
      };
      if ((counts.in_flight ?? 0) > 0) return "in-flight";
      if ((counts.pending ?? 0) > 0 && !input.cancelPending)
        return "pending-work";
      this.#database
        .prepare(
          `UPDATE calendar_bridge_outbox SET state = 'cancelled', updated_at = ?,
             completed_at = ? WHERE mapping_id = ? AND state = 'pending'`,
        )
        .run(input.now, input.now, mapping.id);
      this.#database
        .prepare(
          `UPDATE calendar_bridge_mappings SET removed_at = ?, enabled = 0,
             revision = revision + 1, updated_at = ? WHERE id = ?`,
        )
        .run(input.now, input.now, mapping.id);
      return "removed";
    });
  }

  /** Records a pass outcome; the cursor only advances on success. */
  recordRun(input: {
    readonly mappingId: string;
    readonly now: string;
    readonly outcome:
      | {
          readonly kind: "success";
          readonly googleCursor: string | null;
          readonly firstPass: boolean;
        }
      | { readonly kind: "failure"; readonly errorCode: string };
  }): void {
    if (input.outcome.kind === "success")
      this.#database
        .prepare(
          `UPDATE calendar_bridge_mappings SET google_cursor = ?,
             first_pass_at = COALESCE(first_pass_at, ?), last_run_at = ?,
             last_success_at = ?, last_error_code = NULL WHERE id = ?`,
        )
        .run(
          input.outcome.googleCursor,
          input.outcome.firstPass ? input.now : null,
          input.now,
          input.now,
          input.mappingId,
        );
    else
      this.#database
        .prepare(
          `UPDATE calendar_bridge_mappings SET last_run_at = ?, last_error_code = ?
           WHERE id = ?`,
        )
        .run(input.now, input.outcome.errorCode.slice(0, 64), input.mappingId);
  }

  /** Drops the Google cursor so the next read is a full read. */
  resetGoogleCursor(mappingId: string): void {
    this.#database
      .prepare(
        "UPDATE calendar_bridge_mappings SET google_cursor = NULL WHERE id = ?",
      )
      .run(mappingId);
  }

  // ---- Links --------------------------------------------------------------

  listLinks(mappingId: string): readonly CalendarBridgeLinkRecord[] {
    return (
      this.#database
        .prepare(
          "SELECT * FROM calendar_bridge_links WHERE mapping_id = ? ORDER BY created_at, id",
        )
        .all(mappingId) as unknown as LinkRow[]
    ).map(linkFromRow);
  }

  getLink(linkId: string): CalendarBridgeLinkRecord | undefined {
    const row = this.#database
      .prepare("SELECT * FROM calendar_bridge_links WHERE id = ?")
      .get(linkId) as unknown as LinkRow | undefined;
    return row === undefined ? undefined : linkFromRow(row);
  }

  /** True when a native identity is linked by another mapping of the owner. */
  identityLinkedElsewhere(input: {
    readonly ownerId: string;
    readonly mappingId: string;
    readonly side: CalendarBridgeSideName;
    readonly nativeId: string;
  }): boolean {
    const column = input.side === "google" ? "google_event_id" : "baikal_href";
    return (
      this.#database
        .prepare(
          `SELECT 1 FROM calendar_bridge_links
           WHERE owner_id = ? AND mapping_id <> ? AND ${column} = ?`,
        )
        .get(input.ownerId, input.mappingId, input.nativeId) !== undefined
    );
  }

  insertLink(link: CalendarBridgeNewLink): CalendarBridgeLinkRecord {
    this.#database
      .prepare(
        `INSERT INTO calendar_bridge_links
          (id, mapping_id, owner_id, revision, origin, google_event_id,
           google_ical_uid, baikal_href, baikal_uid, google_kind, google_revision,
           google_digest, google_snapshot, baikal_kind, baikal_revision,
           baikal_digest, baikal_snapshot, accepted_kind, status, status_reason,
           created_at, updated_at)
         VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'none', ?, ?, ?, ?)`,
      )
      .run(
        link.id,
        link.mappingId,
        link.ownerId,
        link.origin,
        link.googleEventId,
        link.googleIcalUid,
        link.baikalHref,
        link.baikalUid,
        link.google.kind,
        link.google.revision,
        link.google.digest,
        link.google.snapshot,
        link.baikal.kind,
        link.baikal.revision,
        link.baikal.digest,
        link.baikal.snapshot,
        link.status,
        link.statusReason,
        link.now,
        link.now,
      );
    const stored = this.getLink(link.id);
    if (stored === undefined) throw new Error("Link was not stored");
    return stored;
  }

  /** Creates a link and its first create operation atomically. */
  insertLinkWithCreate(
    link: CalendarBridgeNewLink,
    operation: CalendarBridgeOperationInput,
    mappingRevision: number,
  ): CalendarBridgeOperationRecord {
    return this.#transaction(() => {
      this.insertLink(link);
      return this.#insertOperation(
        link.mappingId,
        link.id,
        link.ownerId,
        mappingRevision,
        operation,
        link.now,
      );
    });
  }

  /** Records the latest observation of one side; bumps the link revision. */
  observeSide(
    linkId: string,
    side: CalendarBridgeSideName,
    state: CalendarBridgeSideState,
    now: string,
  ): void {
    const current = this.getLink(linkId);
    if (current === undefined) return;
    const prior = side === "google" ? current.google : current.baikal;
    if (
      prior.kind === state.kind &&
      prior.revision === state.revision &&
      prior.digest === state.digest &&
      prior.snapshot === state.snapshot
    )
      return;
    this.#database
      .prepare(
        `UPDATE calendar_bridge_links SET ${side}_kind = ?, ${side}_revision = ?,
           ${side}_digest = ?, ${side}_snapshot = ?, revision = revision + 1,
           updated_at = ? WHERE id = ?`,
      )
      .run(
        state.kind,
        state.revision,
        state.digest,
        state.snapshot,
        now,
        linkId,
      );
  }

  /** Records a UID learned from the provider when none is stored yet. */
  setLinkUid(
    linkId: string,
    side: CalendarBridgeSideName,
    uid: string,
    now: string,
  ): void {
    const column = side === "google" ? "google_ical_uid" : "baikal_uid";
    this.#database
      .prepare(
        `UPDATE calendar_bridge_links SET ${column} = ?, revision = revision + 1,
           updated_at = ? WHERE id = ? AND ${column} IS NULL`,
      )
      .run(uid, now, linkId);
  }

  /** Sets a link's visible status; unchanged status leaves the revision. */
  setLinkStatus(
    linkId: string,
    status: CalendarBridgeLinkStatus,
    reason: string | null,
    now: string,
  ): void {
    this.#database
      .prepare(
        `UPDATE calendar_bridge_links SET status = ?, status_reason = ?,
           revision = revision + 1, updated_at = ?
         WHERE id = ? AND (status <> ? OR status_reason IS NOT ?)`,
      )
      .run(status, reason, now, linkId, status, reason);
  }

  /**
   * Accepts both sides as settled (no write needed), closing any open
   * conflict as superseded and clearing a consumed deletion approval.
   */
  settleLink(
    linkId: string,
    accepted: CalendarBridgeReceipt["accepted"],
    now: string,
  ): void {
    this.#transaction(() => {
      this.#accept(linkId, accepted, now);
    });
  }

  #accept(
    linkId: string,
    accepted: CalendarBridgeReceipt["accepted"],
    now: string,
  ): void {
    const current = this.getLink(linkId);
    if (current === undefined) return;
    const digest = accepted.kind === "present" ? accepted.digest : null;
    const snapshot = accepted.kind === "present" ? accepted.snapshot : null;
    const status = accepted.kind === "present" ? "active" : "tombstoned";
    if (
      current.acceptedKind !== accepted.kind ||
      current.acceptedDigest !== digest ||
      current.status !== status ||
      current.statusReason !== null ||
      current.deletionApproval !== null
    )
      this.#database
        .prepare(
          `UPDATE calendar_bridge_links SET accepted_kind = ?, accepted_digest = ?,
             accepted_snapshot = ?, accepted_at = ?, status = ?, status_reason = NULL,
             deletion_approval_side = NULL, deletion_approval_proof = NULL,
             revision = revision + 1, updated_at = ? WHERE id = ?`,
        )
        .run(accepted.kind, digest, snapshot, now, status, now, linkId);
    this.#database
      .prepare(
        `UPDATE calendar_bridge_conflicts SET state = 'superseded', closed_at = ?
         WHERE link_id = ? AND state = 'open'`,
      )
      .run(now, linkId);
  }

  /** Binds deletion approval to the side's currently observed deletion. */
  approveDeletion(input: {
    readonly ownerId: string;
    readonly mappingId: string;
    readonly linkId: string;
    readonly expectedRevision: number;
    readonly now: string;
  }):
    | {
        readonly kind: "approved";
        readonly link: CalendarBridgeLinkRecord;
      }
    | { readonly kind: "not-found" | "conflict" | "not-pending" } {
    return this.#transaction(() => {
      const link = this.getLink(input.linkId);
      if (link?.ownerId !== input.ownerId || link.mappingId !== input.mappingId)
        return { kind: "not-found" } as const;
      if (link.revision !== input.expectedRevision)
        return { kind: "conflict" } as const;
      const side =
        link.google.kind === "deleted"
          ? "google"
          : link.baikal.kind === "deleted"
            ? "baikal"
            : undefined;
      const proof =
        side === undefined
          ? null
          : side === "google"
            ? link.google.revision
            : link.baikal.revision;
      if (
        link.status !== "blocked" ||
        link.statusReason !== "deletion-approval" ||
        side === undefined ||
        proof === null
      )
        return { kind: "not-pending" } as const;
      this.#database
        .prepare(
          `UPDATE calendar_bridge_links SET deletion_approval_side = ?,
             deletion_approval_proof = ?, revision = revision + 1, updated_at = ?
           WHERE id = ?`,
        )
        .run(side, proof, input.now, link.id);
      const updated = this.getLink(link.id);
      if (updated === undefined) throw new Error("Link disappeared");
      return { kind: "approved", link: updated } as const;
    });
  }

  /**
   * The owner keeps the surviving copy (ADR 0044): the link leaves the bridge
   * as `excluded` with reason `deletion-declined`, so the observed deletion
   * is never propagated. Nothing is written to either calendar.
   */
  declineDeletion(input: {
    readonly ownerId: string;
    readonly mappingId: string;
    readonly linkId: string;
    readonly expectedRevision: number;
    readonly now: string;
  }):
    | {
        readonly kind: "declined";
        readonly link: CalendarBridgeLinkRecord;
      }
    | { readonly kind: "not-found" | "conflict" | "not-pending" } {
    return this.#transaction(() => {
      const link = this.getLink(input.linkId);
      if (link?.ownerId !== input.ownerId || link.mappingId !== input.mappingId)
        return { kind: "not-found" } as const;
      if (link.revision !== input.expectedRevision)
        return { kind: "conflict" } as const;
      if (
        link.status !== "blocked" ||
        link.statusReason !== "deletion-approval" ||
        this.unfinishedOperationForLink(link.id) !== undefined
      )
        return { kind: "not-pending" } as const;
      this.#database
        .prepare(
          `UPDATE calendar_bridge_links SET status = 'excluded',
             status_reason = 'deletion-declined', deletion_approval_side = NULL,
             deletion_approval_proof = NULL, revision = revision + 1,
             updated_at = ? WHERE id = ?`,
        )
        .run(input.now, link.id);
      const updated = this.getLink(link.id);
      if (updated === undefined) throw new Error("Link disappeared");
      return { kind: "declined", link: updated } as const;
    });
  }

  // ---- Outbox -------------------------------------------------------------

  #insertOperation(
    mappingId: string,
    linkId: string,
    ownerId: string,
    mappingRevision: number,
    input: CalendarBridgeOperationInput,
    now: string,
  ): CalendarBridgeOperationRecord {
    const next = this.#database
      .prepare(
        "SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM calendar_bridge_outbox WHERE mapping_id = ?",
      )
      .get(mappingId) as unknown as { readonly next: number };
    this.#database
      .prepare(
        `INSERT INTO calendar_bridge_outbox
          (id, mapping_id, link_id, owner_id, sequence, mapping_revision, target,
           action, target_native_id, target_uid, expected_revision, source_side,
           source_revision, payload, payload_digest, reason, state, created_at,
           updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .run(
        input.id,
        mappingId,
        linkId,
        ownerId,
        next.next,
        mappingRevision,
        input.target,
        input.action,
        input.targetNativeId,
        input.targetUid,
        input.expectedRevision,
        input.sourceSide,
        input.sourceRevision,
        input.payload,
        input.payloadDigest,
        input.reason,
        now,
        now,
      );
    this.#database
      .prepare(
        `UPDATE calendar_bridge_links SET status = 'pending', status_reason = ?,
           revision = revision + 1, updated_at = ? WHERE id = ?`,
      )
      .run(input.reason, now, linkId);
    const stored = this.getOperation(input.id);
    if (stored === undefined) throw new Error("Operation was not stored");
    return stored;
  }

  /**
   * Persists work intent before any network I/O. Returns `busy` when the link
   * already has unfinished work, keeping per-event work ordered.
   */
  enqueueOperation(input: {
    readonly link: CalendarBridgeLinkRecord;
    readonly mappingRevision: number;
    readonly operation: CalendarBridgeOperationInput;
    readonly now: string;
  }): CalendarBridgeOperationRecord | "busy" {
    return this.#transaction(() => {
      if (this.unfinishedOperationForLink(input.link.id) !== undefined)
        return "busy" as const;
      return this.#insertOperation(
        input.link.mappingId,
        input.link.id,
        input.link.ownerId,
        input.mappingRevision,
        input.operation,
        input.now,
      );
    });
  }

  getOperation(operationId: string): CalendarBridgeOperationRecord | undefined {
    const row = this.#database
      .prepare("SELECT * FROM calendar_bridge_outbox WHERE id = ?")
      .get(operationId) as unknown as OperationRow | undefined;
    return row === undefined ? undefined : operationFromRow(row);
  }

  unfinishedOperationForLink(
    linkId: string,
  ): CalendarBridgeOperationRecord | undefined {
    const row = this.#database
      .prepare(
        `SELECT * FROM calendar_bridge_outbox WHERE link_id = ? AND state IN ${unfinished}`,
      )
      .get(linkId) as unknown as OperationRow | undefined;
    return row === undefined ? undefined : operationFromRow(row);
  }

  /** Unfinished work in mapping order (pending, dispatched, uncertain). */
  listUnfinishedOperations(
    mappingId: string,
  ): readonly CalendarBridgeOperationRecord[] {
    return (
      this.#database
        .prepare(
          `SELECT * FROM calendar_bridge_outbox
           WHERE mapping_id = ? AND state IN ${unfinished} ORDER BY sequence`,
        )
        .all(mappingId) as unknown as OperationRow[]
    ).map(operationFromRow);
  }

  listOperations(mappingId: string): readonly CalendarBridgeOperationRecord[] {
    return (
      this.#database
        .prepare(
          "SELECT * FROM calendar_bridge_outbox WHERE mapping_id = ? ORDER BY sequence",
        )
        .all(mappingId) as unknown as OperationRow[]
    ).map(operationFromRow);
  }

  /** Marks a pending operation as about to be sent. Commits before I/O. */
  markDispatched(operationId: string, now: string): boolean {
    return (
      this.#database
        .prepare(
          `UPDATE calendar_bridge_outbox SET state = 'dispatched',
             attempts = attempts + 1, updated_at = ?
           WHERE id = ? AND state = 'pending'`,
        )
        .run(now, operationId).changes === 1
    );
  }

  /** Transport outcome unknown; the next pass reads the target first. */
  markUncertain(operationId: string, error: string, now: string): void {
    this.#database
      .prepare(
        `UPDATE calendar_bridge_outbox SET state = 'uncertain', last_error = ?,
           updated_at = ? WHERE id = ? AND state IN ('dispatched', 'uncertain')`,
      )
      .run(error.slice(0, 64), now, operationId);
  }

  /** Proven not applied; safe to send again later. */
  returnToPending(operationId: string, error: string, now: string): void {
    this.#database
      .prepare(
        `UPDATE calendar_bridge_outbox SET state = 'pending', last_error = ?,
           updated_at = ? WHERE id = ? AND state IN ${unfinished}`,
      )
      .run(error.slice(0, 64), now, operationId);
  }

  /**
   * Terminal failure (precondition failed, target changed). The link keeps
   * its accepted state; the next observation goes through the policy.
   */
  failOperation(operationId: string, error: string, now: string): void {
    this.#transaction(() => {
      const operation = this.getOperation(operationId);
      if (operation === undefined) return;
      this.#database
        .prepare(
          `UPDATE calendar_bridge_outbox SET state = 'failed', last_error = ?,
             updated_at = ?, completed_at = ? WHERE id = ? AND state IN ${unfinished}`,
        )
        .run(error.slice(0, 64), now, now, operationId);
      const link = this.getLink(operation.linkId);
      if (link?.status === "pending")
        this.#database
          .prepare(
            `UPDATE calendar_bridge_links SET status = ?, status_reason = ?,
               revision = revision + 1, updated_at = ? WHERE id = ?`,
          )
          .run(
            link.acceptedKind === "none" ? "blocked" : "active",
            link.acceptedKind === "none"
              ? error === "identity-exists"
                ? "identity-collision"
                : "create-failed"
              : null,
            now,
            link.id,
          );
    });
  }

  /**
   * Records the confirmed receipt and advances accepted state in one
   * transaction, so a restart never replays applied work.
   */
  completeOperation(
    operationId: string,
    receipt: CalendarBridgeReceipt,
  ): boolean {
    return this.#transaction(() => {
      const operation = this.getOperation(operationId);
      if (
        operation === undefined ||
        !["pending", "dispatched", "uncertain"].includes(operation.state)
      )
        return false;
      this.#database
        .prepare(
          `UPDATE calendar_bridge_outbox SET state = 'applied', last_error = NULL,
             updated_at = ?, completed_at = ? WHERE id = ?`,
        )
        .run(receipt.now, receipt.now, operationId);
      this.observeSide(operation.linkId, "google", receipt.google, receipt.now);
      this.observeSide(operation.linkId, "baikal", receipt.baikal, receipt.now);
      this.#accept(operation.linkId, receipt.accepted, receipt.now);
      return true;
    });
  }

  // ---- Conflicts ----------------------------------------------------------

  /** Opens a conflict unless one is already open; nothing is written. */
  openConflict(input: {
    readonly id: string;
    readonly link: CalendarBridgeLinkRecord;
    readonly reason: CalendarBridgeConflictRecord["reason"];
    readonly google: CalendarBridgeConflictSide;
    readonly baikal: CalendarBridgeConflictSide;
    readonly now: string;
  }): CalendarBridgeConflictRecord {
    return this.#transaction(() => {
      const open = this.#openConflictForLink(input.link.id);
      if (
        open?.google.revision === input.google.revision &&
        open.baikal.revision === input.baikal.revision &&
        open.google.kind === input.google.kind &&
        open.baikal.kind === input.baikal.kind
      )
        return open;
      if (open !== undefined)
        this.#database
          .prepare(
            `UPDATE calendar_bridge_conflicts SET state = 'superseded', closed_at = ?
             WHERE id = ?`,
          )
          .run(input.now, open.id);
      this.#database
        .prepare(
          `INSERT INTO calendar_bridge_conflicts
            (id, mapping_id, link_id, owner_id, reason, baseline_kind,
             baseline_digest, google_kind, google_revision, google_digest,
             google_snapshot, baikal_kind, baikal_revision, baikal_digest,
             baikal_snapshot, state, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
        )
        .run(
          input.id,
          input.link.mappingId,
          input.link.id,
          input.link.ownerId,
          input.reason,
          input.link.acceptedKind,
          input.link.acceptedDigest,
          input.google.kind,
          input.google.revision,
          input.google.digest,
          input.google.snapshot,
          input.baikal.kind,
          input.baikal.revision,
          input.baikal.digest,
          input.baikal.snapshot,
          input.now,
        );
      this.#database
        .prepare(
          `UPDATE calendar_bridge_links SET status = 'conflict', status_reason = ?,
             revision = revision + 1, updated_at = ? WHERE id = ?`,
        )
        .run(input.reason, input.now, input.link.id);
      const stored = this.#openConflictForLink(input.link.id);
      if (stored === undefined) throw new Error("Conflict was not stored");
      return stored;
    });
  }

  #openConflictForLink(
    linkId: string,
  ): CalendarBridgeConflictRecord | undefined {
    const row = this.#database
      .prepare(
        "SELECT * FROM calendar_bridge_conflicts WHERE link_id = ? AND state = 'open'",
      )
      .get(linkId) as unknown as ConflictRow | undefined;
    return row === undefined ? undefined : conflictFromRow(row);
  }

  listOpenConflicts(
    mappingId: string,
  ): readonly CalendarBridgeConflictRecord[] {
    return (
      this.#database
        .prepare(
          `SELECT * FROM calendar_bridge_conflicts
           WHERE mapping_id = ? AND state = 'open' ORDER BY created_at, id`,
        )
        .all(mappingId) as unknown as ConflictRow[]
    ).map(conflictFromRow);
  }

  listConflicts(mappingId: string): readonly CalendarBridgeConflictRecord[] {
    return (
      this.#database
        .prepare(
          "SELECT * FROM calendar_bridge_conflicts WHERE mapping_id = ? ORDER BY created_at, id",
        )
        .all(mappingId) as unknown as ConflictRow[]
    ).map(conflictFromRow);
  }

  /**
   * Resolution is a new reviewed operation: write the kept side's retained
   * snapshot (or deletion) to the other side, conditional on the revision
   * recorded in the conflict. A later change fails the precondition.
   */
  resolveConflict(input: {
    readonly ownerId: string;
    readonly mappingId: string;
    readonly conflictId: string;
    readonly keep: CalendarBridgeSideName;
    readonly operationId: string;
    readonly now: string;
    /** ADR 0044: optional binding to the link revision the owner reviewed. */
    readonly expectedLinkRevision?: number;
  }): CalendarBridgeConflictResolveResult {
    return this.#transaction(() => {
      const row = this.#database
        .prepare(
          `SELECT * FROM calendar_bridge_conflicts
           WHERE id = ? AND owner_id = ? AND mapping_id = ? AND state = 'open'`,
        )
        .get(input.conflictId, input.ownerId, input.mappingId) as unknown as
        ConflictRow | undefined;
      const mapping = this.getMapping(input.ownerId, input.mappingId);
      if (row === undefined || mapping === undefined)
        return { kind: "not-found" } as const;
      const conflict = conflictFromRow(row);
      const link = this.getLink(conflict.linkId);
      if (link === undefined) return { kind: "not-found" } as const;
      if (
        input.expectedLinkRevision !== undefined &&
        link.revision !== input.expectedLinkRevision
      )
        return { kind: "conflict" } as const;
      if (this.unfinishedOperationForLink(link.id) !== undefined)
        return { kind: "busy" } as const;
      const target = input.keep === "google" ? "baikal" : "google";
      const kept = conflict[input.keep];
      const other = conflict[target];
      const targetNativeId =
        target === "google" ? link.googleEventId : link.baikalHref;
      const action =
        kept.kind === "deleted"
          ? "delete"
          : other.kind === "deleted" && target === "baikal"
            ? "create"
            : "update";
      if (
        targetNativeId === null ||
        (kept.kind === "deleted" && other.kind === "deleted") ||
        (kept.kind === "present" &&
          (kept.snapshot === null || kept.digest === null)) ||
        (action !== "create" && other.revision === null)
      )
        return { kind: "unresolvable" } as const;
      const operation = this.#insertOperation(
        mapping.id,
        link.id,
        link.ownerId,
        mapping.revision,
        {
          id: input.operationId,
          target,
          action,
          targetNativeId,
          targetUid: target === "google" ? link.googleIcalUid : link.baikalUid,
          expectedRevision: action === "create" ? null : other.revision,
          sourceSide: input.keep,
          sourceRevision: kept.revision,
          payload: kept.kind === "present" ? kept.snapshot : null,
          payloadDigest: kept.kind === "present" ? kept.digest : null,
          reason: "resolution",
        },
        input.now,
      );
      this.#database
        .prepare(
          `UPDATE calendar_bridge_conflicts SET state = 'resolved', resolution = ?,
             closed_at = ? WHERE id = ?`,
        )
        .run(input.keep, input.now, conflict.id);
      return { kind: "resolved", operation } as const;
    });
  }
}
