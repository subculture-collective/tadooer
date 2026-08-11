import type { DatabaseSync } from "node:sqlite";
import type {
  CalendarImportItemRecord,
  CalendarImportJobRecord,
  CalendarProviderRecord,
  OwnedCalendarRecord,
} from "./index.js";
import type { CalendarImportStore } from "./stores.js";

export class SqliteCalendarImportStore implements CalendarImportStore {
  constructor(private readonly db: DatabaseSync) {}

  // -----------------------------------------------------------------------
  // createImportJob
  // -----------------------------------------------------------------------

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
  }):
    | { readonly job: CalendarImportJobRecord; readonly replayed: boolean }
    | undefined {
    if (this.#getOwnedCalendar(input.ownerId, input.calendarId) === undefined)
      return undefined;
    const prior = this.db
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
      const job = this.getImportJob(input.ownerId, prior.id);
      if (job === undefined)
        throw new Error("Calendar import replay disappeared");
      return { job, replayed: true };
    }
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      this.db
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
      const insert = this.db.prepare(
        `INSERT INTO calendar_import_items (job_id,external_id,uid,raw_ics,href,state,applied_at)
         VALUES (?,?,?,?,?,'pending',NULL)`,
      );
      for (const item of input.candidates)
        insert.run(input.id, item.externalId, item.uid, item.rawIcs, item.href);
      this.db.exec("COMMIT;");
    } catch (error: unknown) {
      this.db.exec("ROLLBACK;");
      throw error;
    }
    const job = this.getImportJob(input.ownerId, input.id);
    if (job === undefined)
      throw new Error("Calendar import preview disappeared");
    return { job, replayed: false };
  }

  // -----------------------------------------------------------------------
  // getImportJob
  // -----------------------------------------------------------------------

  getImportJob(
    ownerId: string,
    jobId: string,
  ): CalendarImportJobRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM calendar_import_jobs WHERE owner_id=? AND id=?")
      .get(ownerId, jobId) as unknown as
      Record<string, string | null> | undefined;
    if (row === undefined) return undefined;
    const items = this.db
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

  // -----------------------------------------------------------------------
  // createImportItem
  // -----------------------------------------------------------------------

  createImportItem(
    record: CalendarImportItemRecord,
  ): void {
    this.db
      .prepare(
        `INSERT INTO calendar_import_items (job_id,external_id,uid,raw_ics,href,state,applied_at)
         VALUES (?,?,?,?,?,?,?)`,
      )
      .run(
        record.externalId,
        record.externalId,
        record.uid,
        record.rawIcs,
        record.href,
        record.state,
        record.appliedAt,
      );
  }

  // -----------------------------------------------------------------------
  // listImportItems
  // -----------------------------------------------------------------------

  listImportItems(
    jobId: string,
  ): readonly CalendarImportItemRecord[] {
    const items = this.db
      .prepare(
        "SELECT * FROM calendar_import_items WHERE job_id=? ORDER BY external_id",
      )
      .all(jobId) as unknown as readonly Record<string, string | null>[];
    return items.map((item) => ({
      externalId: String(item.external_id),
      uid: String(item.uid),
      rawIcs: String(item.raw_ics),
      href: String(item.href),
      state: String(item.state) as CalendarImportItemRecord["state"],
      appliedAt: item.applied_at === null ? null : String(item.applied_at),
    }));
  }

  // -----------------------------------------------------------------------
  // applyImportItem
  // -----------------------------------------------------------------------

  applyImportItem(
    _ownerId: string,
    itemId: string,
    href: string,
    now: string,
  ): void {
    this.db
      .prepare(
        `UPDATE calendar_import_items SET state='applied', applied_at=? WHERE external_id=? AND href=?`,
      )
      .run(now, itemId, href);
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

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
