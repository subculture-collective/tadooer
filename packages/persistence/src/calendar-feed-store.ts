import type { DatabaseSync } from "node:sqlite";
import type { CalendarFeedCapabilityRecord, CalendarProviderRecord, OwnedCalendarRecord } from "./index.js";
import type { CalendarFeedStore } from "./stores.js";

export class SqliteCalendarFeedStore implements CalendarFeedStore {
  constructor(private readonly db: DatabaseSync) {}

  // -----------------------------------------------------------------------
  // createFeedCapability
  // -----------------------------------------------------------------------

  createFeedCapability(record: CalendarFeedCapabilityRecord): void {
    if (this.#getOwnedCalendar(record.ownerId, record.calendarId) === undefined)
      throw new Error("Calendar not found");
    this.db
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

  // -----------------------------------------------------------------------
  // getCalendarFeedCapability
  // -----------------------------------------------------------------------

  getCalendarFeedCapability(
    feedId: string,
  ): CalendarFeedCapabilityRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM calendar_feed_capabilities WHERE id=?")
      .get(feedId) as unknown as Record<string, string | null> | undefined;
    return row === undefined ? undefined : this.#calendarFeedFromRow(row);
  }

  // -----------------------------------------------------------------------
  // listCalendarFeeds
  // -----------------------------------------------------------------------

  listCalendarFeeds(
    ownerId: string,
  ): readonly CalendarFeedCapabilityRecord[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM calendar_feed_capabilities WHERE owner_id=? ORDER BY created_at,id",
        )
        .all(ownerId) as unknown as readonly Record<string, string | null>[]
    ).map((row) => this.#calendarFeedFromRow(row));
  }

  // -----------------------------------------------------------------------
  // revokeCalendarFeed
  // -----------------------------------------------------------------------

  revokeCalendarFeed(
    ownerId: string,
    feedId: string,
    now: string,
  ): boolean {
    return (
      this.db
        .prepare(
          "UPDATE calendar_feed_capabilities SET revoked_at=? WHERE owner_id=? AND id=? AND revoked_at IS NULL",
        )
        .run(now, ownerId, feedId).changes === 1
    );
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

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

  #getOwnedCalendar(
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
}
