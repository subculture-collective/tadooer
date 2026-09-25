import { randomUUID, createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  CalendarEventProjectionRecord,
  CalendarProviderRecord,
  CalendarCollectionRecord,
  OwnedCalendarRecord,
  CalendarWriteOperationRecord,
  CalendarWriteReservationResult,
  TaskCalendarBlockRecord,
} from "./index.js";
import type { CalendarProjectionStore } from "./stores.js";

export class SqliteCalendarProjectionStore implements CalendarProjectionStore {
  constructor(private readonly db: DatabaseSync) {}

  // -------------------------------------------------------------------------
  // CalendarProjectionStore interface methods
  // -------------------------------------------------------------------------

  listProjectedEvents(
    ownerId: string,
    from: string,
    to: string,
  ): readonly CalendarEventProjectionRecord[] {
    const rows = this.db
      .prepare(
        `SELECT e.*,p.kind AS provider_kind,c.display_name AS calendar_name
         FROM calendar_event_projections e
         JOIN calendar_providers p ON p.id=e.provider_id
         JOIN calendar_collections c ON c.id=e.calendar_id
         WHERE e.owner_id = ? AND e.starts_at < ? AND e.ends_at > ?
         ORDER BY e.starts_at, e.calendar_id, e.href`,
      )
      .all(ownerId, to, from) as unknown as readonly Record<
      string,
      string | number
    >[];
    return rows.map((row) => this.#calendarEventFromRow(row));
  }

  listOwnedCalendars(ownerId: string): readonly OwnedCalendarRecord[] {
    const rows = this.db
      .prepare(
        `SELECT c.id,c.provider_id,c.href,c.display_name,c.supports_events,c.supports_todos,p.owner_id,p.kind,p.connector_id
       FROM calendar_collections c JOIN calendar_providers p ON p.id=c.provider_id
       WHERE p.owner_id=? ORDER BY p.kind,c.display_name COLLATE NOCASE,c.id`,
      )
      .all(ownerId) as unknown as readonly Record<string, string | number>[];
    return rows.map((row) => ({
      id: String(row.id),
      providerId: String(row.provider_id),
      href: String(row.href),
      displayName: String(row.display_name),
      supportsEvents: Number(row.supports_events) === 1,
      supportsTodos: Number(row.supports_todos) === 1,
      ownerId: String(row.owner_id),
      kind: String(row.kind) as CalendarProviderRecord["kind"],
      connectorId: String(row.connector_id),
    }));
  }

  upsertProjectionBatch(
    records: readonly Omit<
      CalendarEventProjectionRecord,
      "ownerId" | "providerKind" | "providerDisplayLabel" | "calendarName"
    >[],
  ): void {
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      for (const record of records) {
        const event = record as Omit<CalendarEventProjectionRecord, "ownerId">;
        this.#putCalendarEvent(
          (record as unknown as { ownerId: string }).ownerId,
          event,
        );
      }
      this.db.exec("COMMIT;");
    } catch (error: unknown) {
      this.db.exec("ROLLBACK;");
      throw error;
    }
  }

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
  }): CalendarWriteReservationResult {
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const prior = this.#getCalendarWriteOperation(
        input.ownerId,
        input.idempotencyKey,
      );
      if (prior !== undefined) {
        this.db.exec("COMMIT;");
        return prior.requestHash === input.requestHash
          ? { kind: "replayed", operation: prior }
          : { kind: "conflict" };
      }
      const taskRow = this.db
        .prepare(
          `SELECT * FROM tasks WHERE owner_id = ? AND id = ? AND deleted_at IS NULL AND archived_at IS NULL`,
        )
        .get(input.ownerId, input.taskId) as unknown as
        Record<string, string | number | null> | undefined;
      if (taskRow === undefined) {
        this.db.exec("COMMIT;");
        return { kind: "task-not-found" };
      }
      const taskRevision = Number(taskRow.revision);
      if (taskRevision !== input.expectedTaskRevision) {
        this.db.exec("COMMIT;");
        return {
          kind: "task-precondition-failed",
          task: {
            id: String(taskRow.id),
            ownerId: String(taskRow.owner_id),
            title: String(taskRow.title),
            notes: String(taskRow.notes),
            status: String(taskRow.status) as "open" | "completed",
            revision: taskRevision,
            createdAt: String(taskRow.created_at),
            updatedAt: String(taskRow.updated_at),
            completedAt:
              taskRow.completed_at === null
                ? null
                : String(taskRow.completed_at),
            deletedAt:
              taskRow.deleted_at === null ? null : String(taskRow.deleted_at),
            plannedStart:
              taskRow.planned_start === null
                ? null
                : String(taskRow.planned_start),
            estimateMinutes:
              taskRow.estimate_minutes === null
                ? null
                : Number(taskRow.estimate_minutes),
          },
        };
      }
      const operation: CalendarWriteOperationRecord = {
        ownerId: input.ownerId,
        idempotencyKey: input.idempotencyKey,
        requestHash: input.requestHash,
        taskId: input.taskId,
        providerId: input.providerId,
        calendarId: input.calendarHref,
        reservedHref: input.href,
        reservedUid: input.uid,
        state: "pending_remote",
        blockId: null,
        createdAt: input.now,
        updatedAt: input.now,
      };
      this.db
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
      this.db.exec("COMMIT;");
      return { kind: "reserved", operation };
    } catch (error: unknown) {
      this.db.exec("ROLLBACK;");
      throw error;
    }
  }

  completeCalendarWrite(operationId: string): void {
    this.db
      .prepare(
        `UPDATE calendar_write_operations
         SET state = 'completed', updated_at = ?
         WHERE idempotency_key = ?`,
      )
      .run(new Date().toISOString(), operationId);
  }

  getCalendarWrite(
    ownerId: string,
    operationId: string,
  ): CalendarWriteOperationRecord | undefined {
    return this.#getCalendarWriteOperation(ownerId, operationId);
  }

  listTaskCalendarBlocks(
    ownerId: string,
    taskId: string,
  ): readonly TaskCalendarBlockRecord[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM task_calendar_blocks WHERE owner_id = ? AND task_id = ?",
      )
      .all(ownerId, taskId) as unknown as readonly Record<
      string,
      string | number
    >[];
    return rows.map((row) => this.#calendarBlockFromRow(row));
  }

  deleteTaskCalendarBlock(ownerId: string, blockId: string): void {
    this.db
      .prepare("DELETE FROM task_calendar_blocks WHERE owner_id = ? AND id = ?")
      .run(ownerId, blockId);
  }

  listPublishedCalendarRaw(
    ownerId: string,
    calendarId: string,
  ): readonly string[] {
    const projected = this.db
      .prepare(
        "SELECT raw_ics FROM calendar_event_projections WHERE owner_id=? AND calendar_id=? ORDER BY href",
      )
      .all(ownerId, calendarId) as unknown as readonly { raw_ics: string }[];
    const imported = this.db
      .prepare(
        `SELECT i.raw_ics FROM calendar_import_items i JOIN calendar_import_jobs j ON j.id=i.job_id
       WHERE j.owner_id=? AND j.calendar_id=? AND i.state='applied' ORDER BY i.href`,
      )
      .all(ownerId, calendarId) as unknown as readonly { raw_ics: string }[];
    const values = new Map<string, string>();
    for (const row of [...projected, ...imported])
      values.set(
        createHash("sha256").update(row.raw_ics).digest("hex"),
        row.raw_ics,
      );
    return [...values.values()];
  }

  // -------------------------------------------------------------------------
  // Additional public methods (not in CalendarProjectionStore interface)
  // -------------------------------------------------------------------------

  ensureCalendarProvider(
    ownerId: string,
    kind: CalendarProviderRecord["kind"],
    connectorId: string,
    now: string,
  ): CalendarProviderRecord {
    const existing = this.db
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
    this.db
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
      const existing = this.db
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
      this.db
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
    const row = this.db
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
    events: readonly Omit<
      CalendarEventProjectionRecord,
      "ownerId" | "providerKind" | "providerDisplayLabel" | "calendarName"
    >[],
  ): void {
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      this.db
        .prepare(
          `DELETE FROM calendar_event_projections
           WHERE owner_id = ? AND calendar_id = ?
             AND starts_at < ? AND ends_at > ?`,
        )
        .run(ownerId, calendarId, to, from);
      for (const event of events) this.#putCalendarEvent(ownerId, event);
      this.db.exec("COMMIT;");
    } catch (error: unknown) {
      this.db.exec("ROLLBACK;");
      throw error;
    }
  }

  getTaskCalendarBlock(
    ownerId: string,
    taskId: string,
  ): TaskCalendarBlockRecord | undefined {
    const row = this.db
      .prepare(
        "SELECT * FROM task_calendar_blocks WHERE owner_id = ? AND task_id = ?",
      )
      .get(ownerId, taskId) as unknown as
      Record<string, string | number> | undefined;
    return row === undefined ? undefined : this.#calendarBlockFromRow(row);
  }

  markTaskCalendarBlockState(
    ownerId: string,
    taskId: string,
    state: "conflict" | "needs_reconciliation",
    now: string,
  ): void {
    this.db
      .prepare(
        `UPDATE task_calendar_blocks SET state = ?, revision = revision + 1,
           updated_at = ? WHERE owner_id = ? AND task_id = ?`,
      )
      .run(state, now, ownerId, taskId);
  }

  markCalendarWriteConflict(
    ownerId: string,
    idempotencyKey: string,
    now: string,
  ): void {
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const operation = this.#getCalendarWriteOperation(
        ownerId,
        idempotencyKey,
      );
      if (operation !== undefined) {
        this.db
          .prepare(
            `UPDATE calendar_write_operations
             SET state = 'needs_reconciliation', updated_at = ?
             WHERE owner_id = ? AND idempotency_key = ?`,
          )
          .run(now, ownerId, idempotencyKey);
        this.db
          .prepare(
            `UPDATE task_calendar_blocks
             SET state = 'conflict', revision = revision + 1, updated_at = ?
             WHERE owner_id = ? AND task_id = ?`,
          )
          .run(now, ownerId, operation.taskId);
      }
      this.db.exec("COMMIT;");
    } catch (error: unknown) {
      this.db.exec("ROLLBACK;");
      throw error;
    }
  }

  pruneGoogleCalendars(
    ownerId: string,
    providerId: string,
    activeExternalCalendarIds: readonly string[],
  ): void {
    const active = new Set(activeExternalCalendarIds);
    const rows = this.db
      .prepare(
        `SELECT c.id,c.href FROM calendar_collections c
         JOIN calendar_providers p ON p.id=c.provider_id
         WHERE p.owner_id=? AND p.kind='google' AND p.id=?`,
      )
      .all(ownerId, providerId) as unknown as readonly {
      readonly id: string;
      readonly href: string;
    }[];
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const remove = this.db.prepare(
        "DELETE FROM calendar_collections WHERE id=? AND provider_id=?",
      );
      for (const row of rows) {
        if (!active.has(row.href)) remove.run(row.id, providerId);
      }
      this.db.exec("COMMIT;");
    } catch (error: unknown) {
      this.db.exec("ROLLBACK;");
      throw error;
    }
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
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      if (input.reset)
        this.db
          .prepare(
            "DELETE FROM calendar_event_projections WHERE owner_id=? AND calendar_id=?",
          )
          .run(input.ownerId, input.calendarId);
      for (const event of input.events) {
        if (event.deleted)
          this.db
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
      this.db
        .prepare(
          `INSERT INTO google_calendar_sync (calendar_id,owner_id,external_calendar_id,sync_token,state,last_successful_sync_at,last_attempt_at,error_code)
         VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(calendar_id) DO UPDATE SET external_calendar_id=excluded.external_calendar_id,sync_token=excluded.sync_token,
         state=excluded.state,last_successful_sync_at=excluded.last_successful_sync_at,last_attempt_at=excluded.last_attempt_at,error_code=excluded.error_code`,
        )
        .run(
          input.calendarId,
          input.ownerId,
          input.externalCalendarId,
          input.syncToken,
          "fresh",
          input.now,
          input.now,
          null,
        );
      this.db.exec("COMMIT;");
    } catch (error: unknown) {
      this.db.exec("ROLLBACK;");
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
    this.db
      .prepare(
        "UPDATE google_calendar_sync SET state=?,last_attempt_at=?,error_code=? WHERE owner_id=? AND calendar_id=?",
      )
      .run(state, now, errorCode, ownerId, calendarId);
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  #putCalendarEvent(
    ownerId: string,
    event: Omit<CalendarEventProjectionRecord, "ownerId">,
  ): void {
    this.db
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
    const row = this.db
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
      recurrence: String(row.recurrence ?? "none") as "none" | "instance",
      freshness: String(
        row.freshness,
      ) as CalendarEventProjectionRecord["freshness"],
      mutable: Number(row.mutable) === 1,
      revision: Number(row.revision),
      projectedAt: String(row.projected_at),
      providerKind: String(
        row.provider_kind ?? "caldav",
      ) as CalendarProviderRecord["kind"],
      providerDisplayLabel:
        String(row.provider_kind ?? "caldav") === "google"
          ? "Google Calendar"
          : String(row.provider_kind ?? "caldav") === "baikal"
            ? "Baïkal"
            : "CalDAV",
      calendarName: String(row.calendar_name ?? "Calendar"),
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
}
