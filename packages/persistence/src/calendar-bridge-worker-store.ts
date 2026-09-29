import type { DatabaseSync } from "node:sqlite";

/**
 * Calendar bridge background worker state (issue #46, ADR 0043): the durable
 * job schedule and cross-process leases. Operational state only; excluded from
 * the owner data export.
 */
export const calendarBridgeWorkerMigration = {
  id: "0047_calendar_bridge_worker",
  sql: `
      CREATE TABLE calendar_bridge_jobs (
        job_key TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('bridge', 'google_projection')),
        owner_id TEXT NOT NULL REFERENCES owner_accounts(id) ON DELETE CASCADE,
        mapping_id TEXT REFERENCES calendar_bridge_mappings(id) ON DELETE CASCADE,
        next_due_at TEXT NOT NULL,
        consecutive_failures INTEGER NOT NULL DEFAULT 0
          CHECK (consecutive_failures >= 0),
        last_started_at TEXT,
        last_success_at TEXT,
        last_failure_at TEXT,
        last_failure_class TEXT
          CHECK (last_failure_class IS NULL OR length(last_failure_class) <= 32),
        last_error_code TEXT
          CHECK (last_error_code IS NULL OR length(last_error_code) <= 64),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK ((kind = 'bridge') = (mapping_id IS NOT NULL))
      ) STRICT;
      CREATE INDEX calendar_bridge_jobs_due
        ON calendar_bridge_jobs(next_due_at, job_key);

      CREATE TABLE calendar_bridge_leases (
        lease_key TEXT PRIMARY KEY,
        holder TEXT NOT NULL,
        acquired_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      ) STRICT;
    `,
};

export type CalendarBridgeJobKind = "bridge" | "google_projection";

export interface CalendarBridgeJobRecord {
  readonly key: string;
  readonly kind: CalendarBridgeJobKind;
  readonly ownerId: string;
  readonly mappingId: string | null;
  readonly nextDueAt: string;
  readonly consecutiveFailures: number;
  readonly lastStartedAt: string | null;
  readonly lastSuccessAt: string | null;
  readonly lastFailureAt: string | null;
  readonly lastFailureClass: string | null;
  readonly lastErrorCode: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** A job the worker should have: the runnable set at one tick. */
export interface CalendarBridgeJobTarget {
  readonly key: string;
  readonly kind: CalendarBridgeJobKind;
  readonly ownerId: string;
  readonly mappingId: string | null;
}

/** Content-free aggregates for metrics and readiness. */
export interface CalendarBridgeHealthSnapshot {
  readonly enabledMappings: number;
  readonly jobs: readonly {
    readonly kind: CalendarBridgeJobKind;
    readonly lastSuccessAt: string | null;
    readonly failing: boolean;
    readonly lastFailureClass: string | null;
  }[];
  readonly backlog: {
    readonly pending: number;
    readonly dispatched: number;
    readonly uncertain: number;
  };
  readonly stuckOperations: number;
  readonly openConflicts: number;
}

interface JobRow {
  readonly job_key: string;
  readonly kind: CalendarBridgeJobKind;
  readonly owner_id: string;
  readonly mapping_id: string | null;
  readonly next_due_at: string;
  readonly consecutive_failures: number;
  readonly last_started_at: string | null;
  readonly last_success_at: string | null;
  readonly last_failure_at: string | null;
  readonly last_failure_class: string | null;
  readonly last_error_code: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

const jobFromRow = (row: JobRow): CalendarBridgeJobRecord => ({
  key: row.job_key,
  kind: row.kind,
  ownerId: row.owner_id,
  mappingId: row.mapping_id,
  nextDueAt: row.next_due_at,
  consecutiveFailures: row.consecutive_failures,
  lastStartedAt: row.last_started_at,
  lastSuccessAt: row.last_success_at,
  lastFailureAt: row.last_failure_at,
  lastFailureClass: row.last_failure_class,
  lastErrorCode: row.last_error_code,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

/** Outbox attempts at or above this count are reported as stuck. */
export const calendarBridgeStuckAttempts = 5;

export class SqliteCalendarBridgeWorkerStore {
  readonly #database: DatabaseSync;

  constructor(database: DatabaseSync) {
    this.#database = database;
  }

  /**
   * Enabled live mappings of enabled owners, and whether each owner has a
   * stored Google connector. This is the opt-in boundary: an owner without
   * an enabled mapping gets no jobs.
   */
  listJobTargets(): readonly CalendarBridgeJobTarget[] {
    const mappings = this.#database
      .prepare(
        `SELECT m.id, m.owner_id,
           EXISTS (SELECT 1 FROM google_connectors g WHERE g.owner_id = m.owner_id)
             AS google
         FROM calendar_bridge_mappings m
         JOIN owner_accounts o ON o.id = m.owner_id
         WHERE m.enabled = 1 AND m.removed_at IS NULL AND o.disabled_at IS NULL
         ORDER BY m.owner_id, m.created_at, m.id`,
      )
      .all() as unknown as readonly {
      readonly id: string;
      readonly owner_id: string;
      readonly google: number;
    }[];
    const targets: CalendarBridgeJobTarget[] = [];
    const projection = new Set<string>();
    for (const row of mappings) {
      targets.push({
        key: `bridge:${row.id}`,
        kind: "bridge",
        ownerId: row.owner_id,
        mappingId: row.id,
      });
      if (row.google === 1 && !projection.has(row.owner_id)) {
        projection.add(row.owner_id);
        targets.push({
          key: `google-projection:${row.owner_id}`,
          kind: "google_projection",
          ownerId: row.owner_id,
          mappingId: null,
        });
      }
    }
    return targets;
  }

  /**
   * Makes the stored job set equal to `targets`: new jobs are due at
   * `firstDueAt(target)`, jobs no longer runnable are deleted. Existing
   * schedules are kept, so a restart resumes them.
   */
  reconcileJobs(
    targets: readonly CalendarBridgeJobTarget[],
    now: string,
    firstDueAt: (target: CalendarBridgeJobTarget) => string,
  ): void {
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      const existing = new Set(
        (
          this.#database
            .prepare("SELECT job_key FROM calendar_bridge_jobs")
            .all() as unknown as readonly { readonly job_key: string }[]
        ).map(({ job_key }) => job_key),
      );
      const wanted = new Set(targets.map(({ key }) => key));
      const insert = this.#database.prepare(
        `INSERT INTO calendar_bridge_jobs
           (job_key, kind, owner_id, mapping_id, next_due_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const target of targets)
        if (!existing.has(target.key))
          insert.run(
            target.key,
            target.kind,
            target.ownerId,
            target.mappingId,
            firstDueAt(target),
            now,
            now,
          );
      const remove = this.#database.prepare(
        "DELETE FROM calendar_bridge_jobs WHERE job_key = ?",
      );
      for (const key of existing) if (!wanted.has(key)) remove.run(key);
      this.#database.exec("COMMIT;");
    } catch (error: unknown) {
      this.#database.exec("ROLLBACK;");
      throw error;
    }
  }

  listJobs(): readonly CalendarBridgeJobRecord[] {
    return (
      this.#database
        .prepare(
          "SELECT * FROM calendar_bridge_jobs ORDER BY next_due_at, job_key",
        )
        .all() as unknown as JobRow[]
    ).map(jobFromRow);
  }

  getJob(key: string): CalendarBridgeJobRecord | undefined {
    const row = this.#database
      .prepare("SELECT * FROM calendar_bridge_jobs WHERE job_key = ?")
      .get(key) as unknown as JobRow | undefined;
    return row === undefined ? undefined : jobFromRow(row);
  }

  markJobStarted(key: string, now: string): void {
    this.#database
      .prepare(
        "UPDATE calendar_bridge_jobs SET last_started_at = ?, updated_at = ? WHERE job_key = ?",
      )
      .run(now, now, key);
  }

  /** Moves the next run without counting a success or a failure. */
  deferJob(key: string, nextDueAt: string, now: string): void {
    this.#database
      .prepare(
        "UPDATE calendar_bridge_jobs SET next_due_at = ?, updated_at = ? WHERE job_key = ?",
      )
      .run(nextDueAt, now, key);
  }

  recordJobSuccess(key: string, nextDueAt: string, now: string): void {
    this.#database
      .prepare(
        `UPDATE calendar_bridge_jobs SET next_due_at = ?, consecutive_failures = 0,
           last_success_at = ?, last_failure_class = NULL, last_error_code = NULL,
           updated_at = ? WHERE job_key = ?`,
      )
      .run(nextDueAt, now, now, key);
  }

  recordJobFailure(input: {
    readonly key: string;
    readonly nextDueAt: string;
    readonly failureClass: string;
    readonly errorCode: string;
    readonly now: string;
  }): void {
    this.#database
      .prepare(
        `UPDATE calendar_bridge_jobs SET next_due_at = ?,
           consecutive_failures = consecutive_failures + 1, last_failure_at = ?,
           last_failure_class = ?, last_error_code = ?, updated_at = ?
         WHERE job_key = ?`,
      )
      .run(
        input.nextDueAt,
        input.now,
        input.failureClass.slice(0, 32),
        input.errorCode.slice(0, 64),
        input.now,
        input.key,
      );
  }

  /** Highest attempt count among unfinished operations of a mapping. */
  maxUnfinishedAttempts(mappingId: string): number {
    const row = this.#database
      .prepare(
        `SELECT MAX(attempts) AS attempts FROM calendar_bridge_outbox
         WHERE mapping_id = ? AND state IN ('pending', 'dispatched', 'uncertain')
           AND last_error IS NOT NULL`,
      )
      .get(mappingId) as unknown as { readonly attempts: number | null };
    return row.attempts ?? 0;
  }

  /** Last error of a pending operation a provider refused, if any. */
  refusedOperationError(mappingId: string): string | undefined {
    const row = this.#database
      .prepare(
        `SELECT last_error FROM calendar_bridge_outbox
         WHERE mapping_id = ? AND state = 'pending' AND last_error IS NOT NULL
           AND last_error <> 'not-applied'
         ORDER BY attempts DESC, sequence LIMIT 1`,
      )
      .get(mappingId) as unknown as { readonly last_error: string } | undefined;
    return row?.last_error;
  }

  // ---- Leases -------------------------------------------------------------

  /** Atomic across processes sharing this file; false while another holds it. */
  acquireLease(input: {
    readonly key: string;
    readonly holder: string;
    readonly now: string;
    readonly expiresAt: string;
  }): boolean {
    return (
      this.#database
        .prepare(
          `INSERT INTO calendar_bridge_leases (lease_key, holder, acquired_at, expires_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT (lease_key) DO UPDATE SET holder = excluded.holder,
             acquired_at = excluded.acquired_at, expires_at = excluded.expires_at
           WHERE calendar_bridge_leases.expires_at <= excluded.acquired_at`,
        )
        .run(input.key, input.holder, input.now, input.expiresAt).changes === 1
    );
  }

  /** Extends a lease this holder still owns; false when it was lost. */
  renewLease(key: string, holder: string, expiresAt: string): boolean {
    return (
      this.#database
        .prepare(
          "UPDATE calendar_bridge_leases SET expires_at = ? WHERE lease_key = ? AND holder = ?",
        )
        .run(expiresAt, key, holder).changes === 1
    );
  }

  releaseLease(key: string, holder: string): void {
    this.#database
      .prepare(
        "DELETE FROM calendar_bridge_leases WHERE lease_key = ? AND holder = ?",
      )
      .run(key, holder);
  }

  getLease(
    key: string,
  ): { readonly holder: string; readonly expiresAt: string } | undefined {
    const row = this.#database
      .prepare(
        "SELECT holder, expires_at FROM calendar_bridge_leases WHERE lease_key = ?",
      )
      .get(key) as unknown as
      { readonly holder: string; readonly expires_at: string } | undefined;
    return row === undefined
      ? undefined
      : { holder: row.holder, expiresAt: row.expires_at };
  }

  // ---- Health -------------------------------------------------------------

  health(): CalendarBridgeHealthSnapshot {
    const live = `mapping_id IN (SELECT id FROM calendar_bridge_mappings
      WHERE removed_at IS NULL)`;
    const enabled = this.#database
      .prepare(
        `SELECT COUNT(*) AS count FROM calendar_bridge_mappings
         WHERE enabled = 1 AND removed_at IS NULL`,
      )
      .get() as unknown as { readonly count: number };
    const backlog = this.#database
      .prepare(
        `SELECT
           SUM(CASE WHEN state = 'pending' THEN 1 ELSE 0 END) AS pending,
           SUM(CASE WHEN state = 'dispatched' THEN 1 ELSE 0 END) AS dispatched,
           SUM(CASE WHEN state = 'uncertain' THEN 1 ELSE 0 END) AS uncertain,
           SUM(CASE WHEN attempts >= ? THEN 1 ELSE 0 END) AS stuck
         FROM calendar_bridge_outbox
         WHERE state IN ('pending', 'dispatched', 'uncertain') AND ${live}`,
      )
      .get(calendarBridgeStuckAttempts) as unknown as {
      readonly pending: number | null;
      readonly dispatched: number | null;
      readonly uncertain: number | null;
      readonly stuck: number | null;
    };
    const conflicts = this.#database
      .prepare(
        `SELECT COUNT(*) AS count FROM calendar_bridge_conflicts
         WHERE state = 'open' AND ${live}`,
      )
      .get() as unknown as { readonly count: number };
    return {
      enabledMappings: enabled.count,
      jobs: this.listJobs().map((job) => ({
        kind: job.kind,
        lastSuccessAt: job.lastSuccessAt,
        failing: job.consecutiveFailures > 0,
        lastFailureClass: job.lastFailureClass,
      })),
      backlog: {
        pending: backlog.pending ?? 0,
        dispatched: backlog.dispatched ?? 0,
        uncertain: backlog.uncertain ?? 0,
      },
      stuckOperations: backlog.stuck ?? 0,
      openConflicts: conflicts.count,
    };
  }
}
