import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  defaultFocusPreferences,
  focusPlanSchema,
  focusPreferenceProvenanceSchema,
  focusPreferencesSchema,
  focusReminderKinds,
  type FocusPlan,
  type FocusPreferenceProvenance,
  type FocusPreferences,
  type FocusReminderKind,
} from "@suite/contracts";

/**
 * Focus preferences, session plans, idle dispositions and focus reminder
 * state (issue #65, ADR 0029).
 *
 * - `owner_focus_preferences`: one revisioned JSON record per owner. The
 *   revision lives here rather than in `owner_preference_revisions`, whose
 *   kind check is fixed; it starts at 1 on the first save and 0 means the
 *   defaults are in effect.
 * - `active_session_focus_plans`: the millisecond targets frozen for one
 *   session when the owner picks a preset. Cycle and elapsed time are derived
 *   from the session's intervals and events; nothing else is stored.
 * - `active_session_idle_dispositions`: provenance of each idle correction,
 *   written in the session transaction.
 * - `owner_focus_reminder_state`: the take-a-break snooze.
 * - The notification ledger's kind check is widened for focus reminders,
 *   which carry no task ID and dedupe on (owner, kind, occurrence).
 *
 * Focus preferences are read-only offline sync records (issue #114). Plans,
 * idle dispositions and reminder state remain online-only.
 */
export const focusMigration = {
  id: "0033_focus_preferences_idle",
  sql: `
      CREATE TABLE owner_focus_preferences (
        owner_id TEXT PRIMARY KEY REFERENCES owner_accounts(id) ON DELETE CASCADE,
        preferences_json TEXT NOT NULL CHECK (json_valid(preferences_json)),
        revision INTEGER NOT NULL CHECK (revision > 0),
        import_provenance_json TEXT CHECK (import_provenance_json IS NULL
          OR json_valid(import_provenance_json)),
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE active_session_focus_plans (
        session_id TEXT PRIMARY KEY REFERENCES active_sessions(id) ON DELETE CASCADE,
        owner_id TEXT NOT NULL REFERENCES owner_accounts(id) ON DELETE CASCADE,
        plan_json TEXT NOT NULL CHECK (json_valid(plan_json)),
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE active_session_idle_dispositions (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES active_sessions(id) ON DELETE CASCADE,
        owner_id TEXT NOT NULL REFERENCES owner_accounts(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL CHECK (revision > 0),
        disposition TEXT NOT NULL CHECK (disposition IN ('assign','break','discard')),
        idle_started_at TEXT NOT NULL,
        idle_ended_at TEXT NOT NULL,
        trimmed_ms INTEGER NOT NULL CHECK (trimmed_ms >= 0),
        actor_client_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (session_id, revision)
      ) STRICT;
      CREATE TABLE owner_focus_reminder_state (
        owner_id TEXT PRIMARY KEY REFERENCES owner_accounts(id) ON DELETE CASCADE,
        break_snoozed_until TEXT,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE notification_deliveries_v3 (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL REFERENCES owner_accounts(id) ON DELETE CASCADE,
        task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
        occurrence_start TEXT NOT NULL,
        reminder_kind TEXT NOT NULL CHECK(reminder_kind IN ('lead','at_start','deadline','test',
          'focus_countdown','focus_break_end','focus_break_reminder','focus_tracking_reminder')),
        task_revision INTEGER CHECK(task_revision IS NULL OR task_revision > 0),
        state TEXT NOT NULL CHECK(state IN ('pending','sending','retry','delivered','suppressed','cancelled','failed')),
        due_at TEXT NOT NULL, next_attempt_at TEXT NOT NULL,
        attempt_count INTEGER NOT NULL CHECK(attempt_count >= 0),
        error_code TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, delivered_at TEXT
      ) STRICT;
      INSERT INTO notification_deliveries_v3
        (id,owner_id,task_id,occurrence_start,reminder_kind,task_revision,state,due_at,next_attempt_at,attempt_count,error_code,created_at,updated_at,delivered_at)
        SELECT id,owner_id,task_id,occurrence_start,reminder_kind,task_revision,state,due_at,next_attempt_at,attempt_count,error_code,created_at,updated_at,delivered_at
        FROM notification_deliveries;
      DROP TABLE notification_deliveries;
      ALTER TABLE notification_deliveries_v3 RENAME TO notification_deliveries;
      CREATE UNIQUE INDEX notification_delivery_occurrence
        ON notification_deliveries(owner_id,task_id,occurrence_start,reminder_kind)
        WHERE task_id IS NOT NULL;
      CREATE UNIQUE INDEX notification_delivery_focus_occurrence
        ON notification_deliveries(owner_id,reminder_kind,occurrence_start)
        WHERE task_id IS NULL AND reminder_kind IN
          ('focus_countdown','focus_break_end','focus_break_reminder','focus_tracking_reminder');
      CREATE INDEX notification_delivery_due
        ON notification_deliveries(state,next_attempt_at,owner_id);
      CREATE INDEX notification_delivery_status
        ON notification_deliveries(owner_id,updated_at DESC,id);
    `,
} as const;

export interface FocusPreferencesRecord {
  readonly preferences: FocusPreferences;
  readonly revision: number;
  readonly imported: FocusPreferenceProvenance | null;
}

export interface IdleDispositionRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly ownerId: string;
  readonly revision: number;
  readonly disposition: "assign" | "break" | "discard";
  readonly idleStartedAt: string;
  readonly idleEndedAt: string;
  readonly trimmedMs: number;
  readonly actorClientId: string;
  readonly createdAt: string;
}

export interface OwnerIntervalRecord {
  readonly sessionId: string;
  readonly kind: "focus" | "break";
  readonly startedAt: string;
  /** Bounded by the lease for a running session that is past it. */
  readonly endedAt: string | null;
}

type Row = Record<string, string | number | null>;

export class SqliteFocusStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly appendChange: (
      ownerId: string,
      revision: number,
      now: string,
    ) => void = () => undefined,
  ) {}

  getPreferences(ownerId: string): FocusPreferencesRecord {
    const row = this.db
      .prepare(
        "SELECT preferences_json, revision, import_provenance_json FROM owner_focus_preferences WHERE owner_id=?",
      )
      .get(ownerId) as Row | undefined;
    if (row === undefined)
      return {
        preferences: defaultFocusPreferences,
        revision: 0,
        imported: null,
      };
    // Fields added after a save fall back to their defaults.
    const stored = focusPreferencesSchema.parse({
      ...defaultFocusPreferences,
      ...(JSON.parse(
        String(row.preferences_json),
      ) as Partial<FocusPreferences>),
    });
    return {
      preferences: stored,
      revision: Number(row.revision),
      imported:
        row.import_provenance_json === null
          ? null
          : focusPreferenceProvenanceSchema.parse(
              JSON.parse(String(row.import_provenance_json)),
            ),
    };
  }

  getRevision(ownerId: string): number {
    return this.getPreferences(ownerId).revision;
  }

  /**
   * Saves the record when `expectedRevision` is current (0 for the defaults).
   * Returns undefined on a stale revision and changes nothing.
   */
  putPreferences(
    ownerId: string,
    expectedRevision: number,
    preferences: FocusPreferences,
    now: string,
  ): FocusPreferencesRecord | undefined {
    const parsed = focusPreferencesSchema.safeParse(preferences);
    if (!parsed.success) return undefined;
    this.db.exec("SAVEPOINT focus_preferences;");
    try {
      const current = this.getPreferences(ownerId);
      if (current.revision !== expectedRevision) {
        this.db.exec("RELEASE SAVEPOINT focus_preferences;");
        return undefined;
      }
      this.#write(
        ownerId,
        parsed.data,
        current.revision + 1,
        current.imported,
        now,
      );
      this.appendChange(ownerId, current.revision + 1, now);
      this.db.exec("RELEASE SAVEPOINT focus_preferences;");
      return this.getPreferences(ownerId);
    } catch (error) {
      this.db.exec(
        "ROLLBACK TO SAVEPOINT focus_preferences; RELEASE SAVEPOINT focus_preferences;",
      );
      throw error;
    }
  }

  /**
   * Applies imported preferences only while the owner has never saved the
   * record, so a repeated import never overwrites an edit. Runs inside the
   * import transaction.
   */
  importInTransaction(
    ownerId: string,
    preferences: FocusPreferences,
    provenance: FocusPreferenceProvenance,
    now: string,
  ): "applied" | "skipped" {
    if (this.getPreferences(ownerId).revision !== 0) return "skipped";
    this.#write(
      ownerId,
      focusPreferencesSchema.parse(preferences),
      1,
      focusPreferenceProvenanceSchema.parse(provenance),
      now,
    );
    this.appendChange(ownerId, 1, now);
    return "applied";
  }

  #write(
    ownerId: string,
    preferences: FocusPreferences,
    revision: number,
    imported: FocusPreferenceProvenance | null,
    now: string,
  ): void {
    this.db
      .prepare(
        `INSERT INTO owner_focus_preferences (owner_id,preferences_json,revision,import_provenance_json,updated_at)
         VALUES (?,?,?,?,?)
         ON CONFLICT(owner_id) DO UPDATE SET preferences_json=excluded.preferences_json,
           revision=excluded.revision,import_provenance_json=excluded.import_provenance_json,
           updated_at=excluded.updated_at`,
      )
      .run(
        ownerId,
        JSON.stringify(preferences),
        revision,
        imported === null ? null : JSON.stringify(imported),
        now,
      );
  }

  getPlan(ownerId: string, sessionId: string): FocusPlan | undefined {
    const row = this.db
      .prepare(
        "SELECT plan_json FROM active_session_focus_plans WHERE session_id=? AND owner_id=?",
      )
      .get(sessionId, ownerId) as Row | undefined;
    return row === undefined
      ? undefined
      : focusPlanSchema.parse(JSON.parse(String(row.plan_json)));
  }

  /** Sets or clears a session's plan; the session row must exist. */
  putPlan(
    ownerId: string,
    sessionId: string,
    plan: FocusPlan | null,
    now: string,
  ): void {
    if (plan === null) {
      this.db
        .prepare(
          "DELETE FROM active_session_focus_plans WHERE session_id=? AND owner_id=?",
        )
        .run(sessionId, ownerId);
      return;
    }
    this.db
      .prepare(
        `INSERT INTO active_session_focus_plans (session_id,owner_id,plan_json,created_at)
         VALUES (?,?,?,?)
         ON CONFLICT(session_id) DO UPDATE SET plan_json=excluded.plan_json,created_at=excluded.created_at`,
      )
      .run(
        sessionId,
        ownerId,
        JSON.stringify(focusPlanSchema.parse(plan)),
        now,
      );
  }

  recordIdleDisposition(record: IdleDispositionRecord): void {
    this.db
      .prepare(
        `INSERT INTO active_session_idle_dispositions
          (id,session_id,owner_id,revision,disposition,idle_started_at,idle_ended_at,trimmed_ms,actor_client_id,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        record.id,
        record.sessionId,
        record.ownerId,
        record.revision,
        record.disposition,
        record.idleStartedAt,
        record.idleEndedAt,
        record.trimmedMs,
        record.actorClientId,
        record.createdAt,
      );
  }

  listIdleDispositions(
    ownerId: string,
    sessionId: string,
  ): readonly IdleDispositionRecord[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM active_session_idle_dispositions WHERE owner_id=? AND session_id=? ORDER BY revision",
        )
        .all(ownerId, sessionId) as Row[]
    ).map((row) => ({
      id: String(row.id),
      sessionId: String(row.session_id),
      ownerId: String(row.owner_id),
      revision: Number(row.revision),
      disposition: String(
        row.disposition,
      ) as IdleDispositionRecord["disposition"],
      idleStartedAt: String(row.idle_started_at),
      idleEndedAt: String(row.idle_ended_at),
      trimmedMs: Number(row.trimmed_ms),
      actorClientId: String(row.actor_client_id),
      createdAt: String(row.created_at),
    }));
  }

  /**
   * Every interval of the owner that overlaps [from, to), across sessions.
   * A running interval past its lease ends at the lease, as observation would
   * expire it there.
   */
  listOwnerIntervals(
    ownerId: string,
    from: string,
    to: string,
  ): readonly OwnerIntervalRecord[] {
    const rows = this.db
      .prepare(
        `SELECT i.session_id, i.phase, i.started_at, i.ended_at, s.state, s.lease_expires_at
         FROM active_session_intervals i JOIN active_sessions s ON s.id = i.session_id
         WHERE s.owner_id=? AND i.started_at < ? AND (i.ended_at IS NULL OR i.ended_at > ?)
         ORDER BY i.started_at, i.ordinal`,
      )
      .all(ownerId, to, from) as Row[];
    return rows.map((row) => {
      const lease =
        row.state === "running" && row.lease_expires_at !== null
          ? String(row.lease_expires_at)
          : null;
      return {
        sessionId: String(row.session_id),
        kind: row.phase as "focus" | "break",
        startedAt: String(row.started_at),
        endedAt:
          row.ended_at === null
            ? lease !== null && lease < to
              ? lease
              : null
            : String(row.ended_at),
      };
    });
  }

  /** End of the latest closed focus interval, or null when none exists. */
  lastFocusEnd(ownerId: string): string | null {
    const row = this.db
      .prepare(
        `SELECT max(i.ended_at) AS ended_at
         FROM active_session_intervals i JOIN active_sessions s ON s.id = i.session_id
         WHERE s.owner_id=? AND i.phase='focus' AND i.ended_at IS NOT NULL`,
      )
      .get(ownerId) as Row | undefined;
    return row?.ended_at == null ? null : String(row.ended_at);
  }

  getBreakSnoozedUntil(ownerId: string): string | null {
    const row = this.db
      .prepare(
        "SELECT break_snoozed_until FROM owner_focus_reminder_state WHERE owner_id=?",
      )
      .get(ownerId) as Row | undefined;
    return row?.break_snoozed_until == null
      ? null
      : String(row.break_snoozed_until);
  }

  snoozeBreakReminder(ownerId: string, until: string, now: string): void {
    this.db
      .prepare(
        `INSERT INTO owner_focus_reminder_state (owner_id,break_snoozed_until,updated_at) VALUES (?,?,?)
         ON CONFLICT(owner_id) DO UPDATE SET break_snoozed_until=excluded.break_snoozed_until,updated_at=excluded.updated_at`,
      )
      .run(ownerId, until, now);
  }

  /**
   * Queues one focus reminder per (owner, kind, occurrence). Returns false
   * when that occurrence already has a row in any state, so a delivered or
   * suppressed reminder is never recreated.
   */
  queueReminder(
    ownerId: string,
    kind: FocusReminderKind,
    occurrenceStart: string,
    now: string,
  ): boolean {
    if (!focusReminderKinds.includes(kind)) throw new Error("Unknown kind");
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO notification_deliveries
          (id,owner_id,task_id,occurrence_start,reminder_kind,task_revision,state,due_at,next_attempt_at,attempt_count,error_code,created_at,updated_at,delivered_at)
         VALUES (?,?,NULL,?,?,NULL,'pending',?,?,0,NULL,?,?,NULL)`,
      )
      .run(
        randomUUID(),
        ownerId,
        occurrenceStart,
        kind,
        occurrenceStart,
        occurrenceStart,
        now,
        now,
      );
    return Number(result.changes) === 1;
  }
}
