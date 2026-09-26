import type { DatabaseSync } from "node:sqlite";
import { passesSubscriptionFilter } from "@suite/domain";
import type { CalendarEventProjectionRecord } from "./index.ts";

/**
 * iCal subscriptions (issue #91, ADR 0032): owner-scoped, revisioned,
 * read-only feed records; their bounded event occurrences; hidden events;
 * and conversion/dismissal records that keep event-to-task conversion
 * idempotent and stop auto-import from re-creating deleted tasks.
 *
 * The feed address is stored only as AES-256-GCM ciphertext (the server
 * service holds the key); `urlHost` is the only address-derived value kept in
 * clear for display. Subscription events are online-only projections: they
 * are not in the sync change feed or the offline cache.
 */
export const calendarSubscriptionMigration = {
  id: "0036_calendar_subscriptions",
  sql: `
      CREATE TABLE calendar_subscriptions (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL REFERENCES owner_accounts(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL CHECK (revision > 0),
        name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
        url_host TEXT NOT NULL CHECK (length(url_host) BETWEEN 1 AND 253),
        url_key_id TEXT NOT NULL,
        url_nonce BLOB NOT NULL,
        url_ciphertext BLOB NOT NULL,
        url_tag BLOB NOT NULL,
        refresh_interval_minutes INTEGER NOT NULL
          CHECK (refresh_interval_minutes BETWEEN 5 AND 1440),
        color TEXT CHECK (color IS NULL OR length(color) = 7),
        icon TEXT CHECK (icon IS NULL OR length(icon) BETWEEN 1 AND 50),
        include_pattern TEXT CHECK (include_pattern IS NULL OR length(include_pattern) BETWEEN 1 AND 256),
        exclude_pattern TEXT CHECK (exclude_pattern IS NULL OR length(exclude_pattern) BETWEEN 1 AND 256),
        reference_only INTEGER NOT NULL CHECK (reference_only IN (0, 1)),
        auto_import INTEGER NOT NULL CHECK (auto_import IN (0, 1)),
        enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
        hidden INTEGER NOT NULL CHECK (hidden IN (0, 1)),
        etag TEXT,
        last_modified TEXT,
        next_fetch_at TEXT NOT NULL,
        last_attempt_at TEXT,
        last_success_at TEXT,
        last_error_class TEXT CHECK (last_error_class IS NULL OR length(last_error_class) <= 40),
        event_count INTEGER NOT NULL DEFAULT 0 CHECK (event_count >= 0),
        fetch_revision INTEGER NOT NULL DEFAULT 0 CHECK (fetch_revision >= 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX calendar_subscriptions_by_owner
        ON calendar_subscriptions(owner_id, name);
      CREATE INDEX calendar_subscriptions_due
        ON calendar_subscriptions(enabled, next_fetch_at);
      CREATE TABLE calendar_subscription_events (
        subscription_id TEXT NOT NULL
          REFERENCES calendar_subscriptions(id) ON DELETE CASCADE,
        owner_id TEXT NOT NULL,
        uid TEXT NOT NULL CHECK (length(uid) BETWEEN 1 AND 512),
        occurrence_start TEXT NOT NULL,
        summary TEXT NOT NULL CHECK (length(summary) <= 1024),
        starts_at TEXT NOT NULL,
        ends_at TEXT NOT NULL,
        all_day INTEGER NOT NULL CHECK (all_day IN (0, 1)),
        recurring INTEGER NOT NULL CHECK (recurring IN (0, 1)),
        url TEXT CHECK (url IS NULL OR length(url) <= 1024),
        fetched_at TEXT NOT NULL,
        PRIMARY KEY (subscription_id, uid, occurrence_start)
      ) STRICT;
      CREATE INDEX calendar_subscription_events_by_owner_time
        ON calendar_subscription_events(owner_id, starts_at, ends_at);
      CREATE TABLE calendar_subscription_hidden_events (
        subscription_id TEXT NOT NULL
          REFERENCES calendar_subscriptions(id) ON DELETE CASCADE,
        owner_id TEXT NOT NULL,
        uid TEXT NOT NULL,
        occurrence_start TEXT NOT NULL,
        hidden_at TEXT NOT NULL,
        PRIMARY KEY (subscription_id, uid, occurrence_start)
      ) STRICT;
      CREATE TABLE calendar_subscription_conversions (
        subscription_id TEXT NOT NULL
          REFERENCES calendar_subscriptions(id) ON DELETE CASCADE,
        owner_id TEXT NOT NULL,
        uid TEXT NOT NULL,
        occurrence_start TEXT NOT NULL,
        task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
        kind TEXT NOT NULL CHECK (kind IN ('manual', 'auto_import', 'dismissed')),
        created_at TEXT NOT NULL,
        PRIMARY KEY (subscription_id, uid, occurrence_start)
      ) STRICT;
      CREATE INDEX calendar_subscription_conversions_by_task
        ON calendar_subscription_conversions(task_id);
    `,
};

export interface CalendarSubscriptionUrlCipher {
  readonly urlHost: string;
  readonly urlKeyId: string;
  readonly urlNonce: Uint8Array;
  readonly urlCiphertext: Uint8Array;
  readonly urlTag: Uint8Array;
}

export interface CalendarSubscriptionSettings {
  readonly name: string;
  readonly refreshIntervalMinutes: number;
  readonly color: string | null;
  readonly icon: string | null;
  readonly includePattern: string | null;
  readonly excludePattern: string | null;
  readonly referenceOnly: boolean;
  readonly autoImport: boolean;
  readonly enabled: boolean;
  readonly hidden: boolean;
}

export interface CalendarSubscriptionRecord
  extends CalendarSubscriptionSettings, CalendarSubscriptionUrlCipher {
  readonly id: string;
  readonly ownerId: string;
  readonly revision: number;
  readonly etag: string | null;
  readonly lastModified: string | null;
  readonly nextFetchAt: string;
  readonly lastAttemptAt: string | null;
  readonly lastSuccessAt: string | null;
  readonly lastErrorClass: string | null;
  readonly eventCount: number;
  readonly fetchRevision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CalendarSubscriptionEventInput {
  readonly uid: string;
  readonly occurrenceStart: string;
  readonly summary: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly allDay: boolean;
  readonly recurring: boolean;
  readonly url: string | null;
}

export interface CalendarSubscriptionEventRecord extends CalendarSubscriptionEventInput {
  readonly subscriptionId: string;
  readonly subscriptionName: string;
  /** Reference calendars are context only: no conversion or auto-import. */
  readonly referenceOnly: boolean;
  readonly ownerId: string;
  readonly fetchedAt: string;
  readonly hidden: boolean;
  /** Task created from this occurrence, when it still exists. */
  readonly taskId: string | null;
  /** True once converted or dismissed: auto-import never re-creates it. */
  readonly tombstoned: boolean;
}

export type CalendarSubscriptionFetchOutcome =
  | {
      readonly kind: "fetched";
      readonly events: readonly CalendarSubscriptionEventInput[];
      readonly etag: string | null;
      readonly lastModified: string | null;
    }
  | { readonly kind: "unchanged" }
  | { readonly kind: "failed"; readonly errorClass: string };

export type CalendarSubscriptionWriteResult =
  | { readonly kind: "updated"; readonly record: CalendarSubscriptionRecord }
  | { readonly kind: "conflict"; readonly record: CalendarSubscriptionRecord }
  | { readonly kind: "not_found" };

export type CalendarSubscriptionDeleteResult =
  "deleted" | "conflict" | "not_found";

/** Hidden occurrences retained per subscription; older entries are dropped. */
export const calendarSubscriptionHiddenEventLimit = 1_000;
/** Subscriptions per owner. */
export const calendarSubscriptionLimit = 25;

type Row = Record<string, string | number | Uint8Array | null>;

const text = (value: Row[string] | undefined): string =>
  typeof value === "string"
    ? value
    : typeof value === "number"
      ? String(value)
      : "";
const optional = (value: Row[string] | undefined): string | null =>
  value === null || value === undefined ? null : text(value);

const recordFromRow = (row: Row): CalendarSubscriptionRecord => ({
  id: text(row.id),
  ownerId: text(row.owner_id),
  revision: Number(row.revision),
  name: text(row.name),
  urlHost: text(row.url_host),
  urlKeyId: text(row.url_key_id),
  urlNonce: row.url_nonce as Uint8Array,
  urlCiphertext: row.url_ciphertext as Uint8Array,
  urlTag: row.url_tag as Uint8Array,
  refreshIntervalMinutes: Number(row.refresh_interval_minutes),
  color: optional(row.color),
  icon: optional(row.icon),
  includePattern: optional(row.include_pattern),
  excludePattern: optional(row.exclude_pattern),
  referenceOnly: row.reference_only === 1,
  autoImport: row.auto_import === 1,
  enabled: row.enabled === 1,
  hidden: row.hidden === 1,
  etag: optional(row.etag),
  lastModified: optional(row.last_modified),
  nextFetchAt: text(row.next_fetch_at),
  lastAttemptAt: optional(row.last_attempt_at),
  lastSuccessAt: optional(row.last_success_at),
  lastErrorClass: optional(row.last_error_class),
  eventCount: Number(row.event_count),
  fetchRevision: Number(row.fetch_revision),
  createdAt: text(row.created_at),
  updatedAt: text(row.updated_at),
});

const eventFromRow = (row: Row): CalendarSubscriptionEventRecord => ({
  subscriptionId: text(row.subscription_id),
  subscriptionName: text(row.subscription_name),
  referenceOnly: row.reference_only === 1,
  ownerId: text(row.owner_id),
  uid: text(row.uid),
  occurrenceStart: text(row.occurrence_start),
  summary: text(row.summary),
  startsAt: text(row.starts_at),
  endsAt: text(row.ends_at),
  allDay: row.all_day === 1,
  recurring: row.recurring === 1,
  url: optional(row.url),
  fetchedAt: text(row.fetched_at),
  hidden: row.hidden_at !== null && row.hidden_at !== undefined,
  taskId: optional(row.task_id),
  tombstoned: row.conversion_kind !== null && row.conversion_kind !== undefined,
});

/** SP semantics: filters apply on read, so a filter change needs no refetch. */
const passesFilters = (row: Row): boolean =>
  passesSubscriptionFilter(
    text(row.summary),
    optional(row.include_pattern),
    optional(row.exclude_pattern),
  );

const eventSelect = `
  SELECT e.*, h.hidden_at, c.task_id, c.kind AS conversion_kind,
    s.name AS subscription_name, s.reference_only,
    s.include_pattern, s.exclude_pattern
  FROM calendar_subscription_events e
  JOIN calendar_subscriptions s ON s.id = e.subscription_id
  LEFT JOIN calendar_subscription_hidden_events h
    ON h.subscription_id = e.subscription_id AND h.uid = e.uid
    AND h.occurrence_start = e.occurrence_start
  LEFT JOIN calendar_subscription_conversions c
    ON c.subscription_id = e.subscription_id AND c.uid = e.uid
    AND c.occurrence_start = e.occurrence_start`;

export class SqliteCalendarSubscriptionStore {
  readonly #database: DatabaseSync;

  constructor(database: DatabaseSync) {
    this.#database = database;
  }

  #inTransaction<T>(run: () => T): T {
    this.#database.exec("SAVEPOINT calendar_subscription;");
    try {
      const result = run();
      this.#database.exec("RELEASE SAVEPOINT calendar_subscription;");
      return result;
    } catch (error: unknown) {
      this.#database.exec("ROLLBACK TO SAVEPOINT calendar_subscription;");
      this.#database.exec("RELEASE SAVEPOINT calendar_subscription;");
      throw error;
    }
  }

  list(ownerId: string): readonly CalendarSubscriptionRecord[] {
    return (
      this.#database
        .prepare(
          "SELECT * FROM calendar_subscriptions WHERE owner_id = ? ORDER BY name, id",
        )
        .all(ownerId) as unknown as Row[]
    ).map(recordFromRow);
  }

  get(ownerId: string, id: string): CalendarSubscriptionRecord | undefined {
    const row = this.#database
      .prepare(
        "SELECT * FROM calendar_subscriptions WHERE owner_id = ? AND id = ?",
      )
      .get(ownerId, id) as unknown as Row | undefined;
    return row === undefined ? undefined : recordFromRow(row);
  }

  count(ownerId: string): number {
    const row = this.#database
      .prepare(
        "SELECT count(*) AS total FROM calendar_subscriptions WHERE owner_id = ?",
      )
      .get(ownerId) as unknown as { total: number };
    return row.total;
  }

  create(
    input: CalendarSubscriptionSettings &
      CalendarSubscriptionUrlCipher & {
        readonly id: string;
        readonly ownerId: string;
        readonly nextFetchAt: string;
        readonly now: string;
      },
  ): CalendarSubscriptionRecord {
    this.#database
      .prepare(
        `INSERT INTO calendar_subscriptions (
          id, owner_id, revision, name, url_host, url_key_id, url_nonce,
          url_ciphertext, url_tag, refresh_interval_minutes, color, icon,
          include_pattern, exclude_pattern, reference_only, auto_import,
          enabled, hidden, next_fetch_at, created_at, updated_at
        ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.ownerId,
        input.name,
        input.urlHost,
        input.urlKeyId,
        input.urlNonce,
        input.urlCiphertext,
        input.urlTag,
        input.refreshIntervalMinutes,
        input.color,
        input.icon,
        input.includePattern,
        input.excludePattern,
        input.referenceOnly ? 1 : 0,
        input.autoImport ? 1 : 0,
        input.enabled ? 1 : 0,
        input.hidden ? 1 : 0,
        input.nextFetchAt,
        input.now,
        input.now,
      );
    return this.#require(input.ownerId, input.id);
  }

  #require(ownerId: string, id: string): CalendarSubscriptionRecord {
    const record = this.get(ownerId, id);
    if (record === undefined)
      throw new Error("Calendar subscription disappeared during a write");
    return record;
  }

  /**
   * Revisioned settings update. A new address (cipher) clears the
   * conditional-request state and saved events so nothing from the previous
   * feed survives, and fetches again soon.
   */
  update(input: {
    readonly ownerId: string;
    readonly id: string;
    readonly expectedRevision: number;
    readonly settings: Partial<CalendarSubscriptionSettings>;
    readonly cipher?: CalendarSubscriptionUrlCipher | undefined;
    readonly nextFetchAt?: string | undefined;
    readonly now: string;
  }): CalendarSubscriptionWriteResult {
    return this.#inTransaction(() => {
      const current = this.get(input.ownerId, input.id);
      if (current === undefined) return { kind: "not_found" };
      if (current.revision !== input.expectedRevision)
        return { kind: "conflict", record: current };
      const next: CalendarSubscriptionSettings = {
        ...current,
        ...Object.fromEntries(
          Object.entries(input.settings as Record<string, unknown>).filter(
            ([, value]) => value !== undefined,
          ),
        ),
      };
      this.#database
        .prepare(
          `UPDATE calendar_subscriptions SET
            revision = revision + 1, name = ?, refresh_interval_minutes = ?,
            color = ?, icon = ?, include_pattern = ?, exclude_pattern = ?,
            reference_only = ?, auto_import = ?, enabled = ?, hidden = ?,
            next_fetch_at = COALESCE(?, next_fetch_at), updated_at = ?
          WHERE id = ? AND owner_id = ?`,
        )
        .run(
          next.name,
          next.refreshIntervalMinutes,
          next.color,
          next.icon,
          next.includePattern,
          next.excludePattern,
          next.referenceOnly ? 1 : 0,
          next.autoImport ? 1 : 0,
          next.enabled ? 1 : 0,
          next.hidden ? 1 : 0,
          input.nextFetchAt ?? null,
          input.now,
          input.id,
          input.ownerId,
        );
      if (input.cipher !== undefined) {
        this.#database
          .prepare(
            `UPDATE calendar_subscriptions SET
              url_host = ?, url_key_id = ?, url_nonce = ?, url_ciphertext = ?,
              url_tag = ?, etag = NULL, last_modified = NULL,
              last_success_at = NULL, last_attempt_at = NULL,
              last_error_class = NULL, event_count = 0
            WHERE id = ? AND owner_id = ?`,
          )
          .run(
            input.cipher.urlHost,
            input.cipher.urlKeyId,
            input.cipher.urlNonce,
            input.cipher.urlCiphertext,
            input.cipher.urlTag,
            input.id,
            input.ownerId,
          );
        this.#database
          .prepare(
            "DELETE FROM calendar_subscription_events WHERE subscription_id = ?",
          )
          .run(input.id);
      }
      return {
        kind: "updated",
        record: this.#require(input.ownerId, input.id),
      };
    });
  }

  remove(
    ownerId: string,
    id: string,
    expectedRevision: number,
  ): CalendarSubscriptionDeleteResult {
    const changes = this.#database
      .prepare(
        "DELETE FROM calendar_subscriptions WHERE owner_id = ? AND id = ? AND revision = ?",
      )
      .run(ownerId, id, expectedRevision).changes;
    if (changes === 1) return "deleted";
    return this.get(ownerId, id) === undefined ? "not_found" : "conflict";
  }

  /** Enabled subscriptions whose next fetch is due, oldest first. */
  listDue(now: string, limit: number): readonly CalendarSubscriptionRecord[] {
    return (
      this.#database
        .prepare(
          `SELECT * FROM calendar_subscriptions
           WHERE enabled = 1 AND next_fetch_at <= ?
           ORDER BY next_fetch_at, id LIMIT ?`,
        )
        .all(now, limit) as unknown as Row[]
    ).map(recordFromRow);
  }

  /** Records a fetch attempt; a fetched outcome replaces the saved events. */
  recordFetch(input: {
    readonly ownerId: string;
    readonly id: string;
    readonly outcome: CalendarSubscriptionFetchOutcome;
    readonly nextFetchAt: string;
    readonly now: string;
  }): CalendarSubscriptionRecord | undefined {
    return this.#inTransaction(() => {
      if (this.get(input.ownerId, input.id) === undefined) return undefined;
      const { outcome } = input;
      if (outcome.kind === "failed")
        this.#database
          .prepare(
            `UPDATE calendar_subscriptions SET last_attempt_at = ?,
              last_error_class = ?, next_fetch_at = ? WHERE id = ?`,
          )
          .run(input.now, outcome.errorClass, input.nextFetchAt, input.id);
      else if (outcome.kind === "unchanged")
        this.#database
          .prepare(
            `UPDATE calendar_subscriptions SET last_attempt_at = ?,
              last_success_at = ?, last_error_class = NULL, next_fetch_at = ?
             WHERE id = ?`,
          )
          .run(input.now, input.now, input.nextFetchAt, input.id);
      else {
        this.#database
          .prepare(
            "DELETE FROM calendar_subscription_events WHERE subscription_id = ?",
          )
          .run(input.id);
        const insert = this.#database.prepare(
          `INSERT OR REPLACE INTO calendar_subscription_events (
            subscription_id, owner_id, uid, occurrence_start, summary,
            starts_at, ends_at, all_day, recurring, url, fetched_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        for (const event of outcome.events)
          insert.run(
            input.id,
            input.ownerId,
            event.uid,
            event.occurrenceStart,
            event.summary,
            event.startsAt,
            event.endsAt,
            event.allDay ? 1 : 0,
            event.recurring ? 1 : 0,
            event.url,
            input.now,
          );
        this.#database
          .prepare(
            `UPDATE calendar_subscriptions SET last_attempt_at = ?,
              last_success_at = ?, last_error_class = NULL, next_fetch_at = ?,
              etag = ?, last_modified = ?, event_count = ?,
              fetch_revision = fetch_revision + 1
             WHERE id = ?`,
          )
          .run(
            input.now,
            input.now,
            input.nextFetchAt,
            outcome.etag,
            outcome.lastModified,
            outcome.events.length,
            input.id,
          );
      }
      return this.get(input.ownerId, input.id);
    });
  }

  /**
   * Occurrences overlapping the window with their hidden and conversion
   * state. Disabled subscriptions and occurrences rejected by the
   * subscription's include/exclude filters are excluded; hidden
   * subscriptions and hidden events are included only on request.
   */
  listEvents(
    ownerId: string,
    from: string,
    to: string,
    options: {
      readonly includeHidden?: boolean;
      readonly subscriptionId?: string;
    } = {},
  ): readonly CalendarSubscriptionEventRecord[] {
    const rows = this.#database
      .prepare(
        `${eventSelect}
         WHERE e.owner_id = ? AND s.enabled = 1
           AND e.starts_at < ? AND e.ends_at > ?
           AND (? = 1 OR (s.hidden = 0 AND h.hidden_at IS NULL))
           AND (? IS NULL OR e.subscription_id = ?)
         ORDER BY e.starts_at, e.subscription_id, e.uid, e.occurrence_start`,
      )
      .all(
        ownerId,
        to,
        from,
        options.includeHidden === true ? 1 : 0,
        options.subscriptionId ?? null,
        options.subscriptionId ?? null,
      ) as unknown as Row[];
    return rows.filter(passesFilters).map(eventFromRow);
  }

  getEvent(
    ownerId: string,
    subscriptionId: string,
    uid: string,
    occurrenceStart: string,
  ): CalendarSubscriptionEventRecord | undefined {
    const row = this.#database
      .prepare(
        `${eventSelect}
         WHERE e.owner_id = ? AND e.subscription_id = ? AND e.uid = ?
           AND e.occurrence_start = ?`,
      )
      .get(ownerId, subscriptionId, uid, occurrenceStart) as unknown as
      Row | undefined;
    return row === undefined ? undefined : eventFromRow(row);
  }

  /** Visible occurrences in the shape of the shared calendar projection. */
  listProjectedEvents(
    ownerId: string,
    from: string,
    to: string,
  ): readonly CalendarEventProjectionRecord[] {
    return this.listEvents(ownerId, from, to).map((event) => ({
      id: `${event.subscriptionId}:${event.uid}:${event.occurrenceStart}`,
      ownerId,
      providerId: event.subscriptionId,
      calendarId: event.subscriptionId,
      href: `${event.uid}#${event.occurrenceStart}`,
      uid: event.uid,
      etag: `"${event.fetchedAt}"`,
      rawIcs: "",
      summary: event.summary,
      startsAt: event.startsAt,
      endsAt: event.endsAt,
      allDay: event.allDay,
      recurrence: event.recurring ? "instance" : "none",
      freshness: "current",
      mutable: false,
      revision: 1,
      projectedAt: event.fetchedAt,
      providerKind: "ical",
      providerDisplayLabel: "Subscription",
      calendarName: event.subscriptionName,
    }));
  }

  setEventHidden(input: {
    readonly ownerId: string;
    readonly subscriptionId: string;
    readonly uid: string;
    readonly occurrenceStart: string;
    readonly hidden: boolean;
    readonly now: string;
  }): boolean {
    return this.#inTransaction(() => {
      if (this.get(input.ownerId, input.subscriptionId) === undefined)
        return false;
      if (!input.hidden) {
        this.#database
          .prepare(
            `DELETE FROM calendar_subscription_hidden_events
             WHERE subscription_id = ? AND uid = ? AND occurrence_start = ?`,
          )
          .run(input.subscriptionId, input.uid, input.occurrenceStart);
        return true;
      }
      this.#database
        .prepare(
          `INSERT OR IGNORE INTO calendar_subscription_hidden_events
            (subscription_id, owner_id, uid, occurrence_start, hidden_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          input.subscriptionId,
          input.ownerId,
          input.uid,
          input.occurrenceStart,
          input.now,
        );
      const { total } = this.#database
        .prepare(
          `SELECT count(*) AS total FROM calendar_subscription_hidden_events
           WHERE subscription_id = ?`,
        )
        .get(input.subscriptionId) as unknown as { total: number };
      const excess = total - calendarSubscriptionHiddenEventLimit;
      if (excess > 0)
        this.#database
          .prepare(
            `DELETE FROM calendar_subscription_hidden_events WHERE rowid IN (
               SELECT rowid FROM calendar_subscription_hidden_events
               WHERE subscription_id = ?
               ORDER BY hidden_at, uid, occurrence_start LIMIT ?)`,
          )
          .run(input.subscriptionId, excess);
      return true;
    });
  }

  getConversion(
    ownerId: string,
    subscriptionId: string,
    uid: string,
    occurrenceStart: string,
  ):
    | {
        readonly taskId: string | null;
        readonly kind: "manual" | "auto_import" | "dismissed";
      }
    | undefined {
    const row = this.#database
      .prepare(
        `SELECT task_id, kind FROM calendar_subscription_conversions
         WHERE owner_id = ? AND subscription_id = ? AND uid = ? AND occurrence_start = ?`,
      )
      .get(ownerId, subscriptionId, uid, occurrenceStart) as unknown as
      | { task_id: string | null; kind: "manual" | "auto_import" | "dismissed" }
      | undefined;
    return row === undefined
      ? undefined
      : { taskId: row.task_id, kind: row.kind };
  }

  /**
   * Records a conversion (with its task) or a dismissal. A dismissal never
   * replaces an existing conversion; a conversion replaces a dismissal.
   */
  recordConversion(input: {
    readonly ownerId: string;
    readonly subscriptionId: string;
    readonly uid: string;
    readonly occurrenceStart: string;
    readonly taskId: string | null;
    readonly kind: "manual" | "auto_import" | "dismissed";
    readonly now: string;
  }): void {
    this.#database
      .prepare(
        `INSERT INTO calendar_subscription_conversions
          (subscription_id, owner_id, uid, occurrence_start, task_id, kind, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(subscription_id, uid, occurrence_start) DO UPDATE SET
           task_id = excluded.task_id, kind = excluded.kind
         WHERE excluded.task_id IS NOT NULL`,
      )
      .run(
        input.subscriptionId,
        input.ownerId,
        input.uid,
        input.occurrenceStart,
        input.taskId,
        input.kind,
        input.now,
      );
  }

  /** Provenance of a task created from a subscription event, if any. */
  conversionForTask(
    ownerId: string,
    taskId: string,
  ):
    | {
        readonly subscriptionId: string;
        readonly uid: string;
        readonly occurrenceStart: string;
        readonly kind: "manual" | "auto_import";
      }
    | undefined {
    const row = this.#database
      .prepare(
        `SELECT subscription_id, uid, occurrence_start, kind
         FROM calendar_subscription_conversions
         WHERE owner_id = ? AND task_id = ?`,
      )
      .get(ownerId, taskId) as unknown as
      | {
          subscription_id: string;
          uid: string;
          occurrence_start: string;
          kind: "manual" | "auto_import";
        }
      | undefined;
    return row === undefined
      ? undefined
      : {
          subscriptionId: row.subscription_id,
          uid: row.uid,
          occurrenceStart: row.occurrence_start,
          kind: row.kind,
        };
  }

  /** Enabled auto-import subscriptions across owners, for the server tick. */
  listAutoImport(): readonly CalendarSubscriptionRecord[] {
    return (
      this.#database
        .prepare(
          `SELECT * FROM calendar_subscriptions
           WHERE enabled = 1 AND auto_import = 1 AND reference_only = 0
           ORDER BY owner_id, id`,
        )
        .all() as unknown as Row[]
    ).map(recordFromRow);
  }
}
