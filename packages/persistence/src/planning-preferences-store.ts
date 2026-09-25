import type { DatabaseSync } from "node:sqlite";
import type { PlanningPreferencesRecord } from "./index.js";
import type { PlanningPreferencesStore } from "./stores.js";

export class SqlitePlanningPreferencesStore implements PlanningPreferencesStore {
  constructor(private readonly db: DatabaseSync) {}

  getPlanningPreferences(ownerId: string): PlanningPreferencesRecord {
    const row = this.db
      .prepare("SELECT * FROM owner_planning_preferences WHERE owner_id=?")
      .get(ownerId) as unknown as Record<string, string | null> | undefined;
    return row === undefined
      ? {
          workingDays: [1, 2, 3, 4, 5],
          workdayStart: "09:00",
          workdayEnd: "17:00",
          breakStart: "12:00",
          breakEnd: "12:30",
          timeZone: "America/Chicago",
          dayStartsAt: "00:00",
        }
      : {
          workingDays: JSON.parse(String(row.working_days_json)) as number[],
          workdayStart: String(row.workday_start),
          workdayEnd: String(row.workday_end),
          breakStart: row.break_start === null ? null : String(row.break_start),
          breakEnd: row.break_end === null ? null : String(row.break_end),
          timeZone: String(row.time_zone),
          dayStartsAt: row.day_starts_at ?? "00:00",
        };
  }

  upsertPlanningPreferences(
    ownerId: string,
    record: PlanningPreferencesRecord,
  ): PlanningPreferencesRecord {
    const now = new Date().toISOString();
    // ADR 0027: a client that omits dayStartsAt keeps the saved value.
    const dayStartsAt =
      record.dayStartsAt ??
      this.getPlanningPreferences(ownerId).dayStartsAt ??
      "00:00";
    this.db
      .prepare(
        `INSERT INTO owner_planning_preferences (owner_id,working_days_json,workday_start,workday_end,break_start,break_end,time_zone,day_starts_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(owner_id) DO UPDATE SET working_days_json=excluded.working_days_json,workday_start=excluded.workday_start,workday_end=excluded.workday_end,break_start=excluded.break_start,break_end=excluded.break_end,time_zone=excluded.time_zone,day_starts_at=excluded.day_starts_at,updated_at=excluded.updated_at`,
      )
      .run(
        ownerId,
        JSON.stringify(record.workingDays),
        record.workdayStart,
        record.workdayEnd,
        record.breakStart,
        record.breakEnd,
        record.timeZone,
        dayStartsAt,
        now,
      );
    return this.getPlanningPreferences(ownerId);
  }
}
