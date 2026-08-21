import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  NotificationDeliveryRecord,
  NotificationPreferencesRecord,
  TaskRecord,
} from "./index.js";
import type {
  NotificationDeliveryStore,
  NotificationPreferencesStore,
} from "./stores.js";

export class SqliteNotificationStore
  implements NotificationPreferencesStore, NotificationDeliveryStore
{
  constructor(private readonly db: DatabaseSync) {}

  // -----------------------------------------------------------------------
  // NotificationPreferencesStore
  // -----------------------------------------------------------------------

  getNotificationPreferences(ownerId: string): NotificationPreferencesRecord {
    const row = this.db
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

  upsertNotificationPreferences(
    ownerId: string,
    preferences: NotificationPreferencesRecord,
  ): NotificationPreferencesRecord {
    const now = new Date().toISOString();
    this.db
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

  // -----------------------------------------------------------------------
  // NotificationDeliveryStore
  // -----------------------------------------------------------------------

  claimDelivery(
    ownerId: string,
    taskId: string,
    occurrenceStart: string,
    kind: "lead" | "at_start" | "test",
    claimedAt: string,
  ): NotificationDeliveryRecord | undefined {
    // claim a pending/retry delivery for the given occurrence
    const row = this.db
      .prepare(
        `SELECT id FROM notification_deliveries
         WHERE owner_id=? AND task_id=? AND occurrence_start=? AND reminder_kind=?
           AND state IN ('pending','retry')
         LIMIT 1`,
      )
      .get(ownerId, taskId, occurrenceStart, kind) as unknown as
      { id: string } | undefined;
    if (row === undefined) return undefined;
    return this.claimNotificationDelivery(row.id, claimedAt);
  }

  getPendingDeliveries(ownerId: string): readonly NotificationDeliveryRecord[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM notification_deliveries
           WHERE owner_id=? AND state IN ('pending','retry')
           ORDER BY next_attempt_at,id`,
        )
        .all(ownerId) as unknown as readonly Record<
        string,
        string | number | null
      >[]
    ).map((row) => this.#notificationDeliveryFromRow(row));
  }

  countDeliveriesByTask(
    ownerId: string,
    taskId: string,
  ): { readonly pendingCount: number; readonly failedCount: number } {
    const counts = this.db
      .prepare(
        `SELECT
          SUM(CASE WHEN state IN ('pending','retry','sending') THEN 1 ELSE 0 END) AS pending_count,
          SUM(CASE WHEN state='failed' THEN 1 ELSE 0 END) AS failed_count
         FROM notification_deliveries WHERE owner_id=? AND task_id=?`,
      )
      .get(ownerId, taskId) as unknown as {
      readonly pending_count: number | null;
      readonly failed_count: number | null;
    };
    return {
      pendingCount: counts.pending_count ?? 0,
      failedCount: counts.failed_count ?? 0,
    };
  }

  markDeliveryFailed(_ownerId: string, deliveryId: string, now: string): void {
    this.finishNotificationDelivery(deliveryId, "failed", "MANUAL_FAIL", now);
  }

  cancelPendingDeliveries(ownerId: string, taskId: string, now: string): void {
    this.db
      .prepare(
        `UPDATE notification_deliveries SET state='cancelled',error_code='OBSOLETE',updated_at=?
         WHERE owner_id=? AND task_id=? AND state IN ('pending','retry')`,
      )
      .run(now, ownerId, taskId);
  }

  insertDelivery(record: NotificationDeliveryRecord): void {
    this.db
      .prepare(
        `INSERT INTO notification_deliveries
          (id,owner_id,task_id,occurrence_start,reminder_kind,task_revision,state,due_at,next_attempt_at,attempt_count,error_code,created_at,updated_at,delivered_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        record.id,
        record.ownerId,
        record.taskId,
        record.occurrenceStart,
        record.kind,
        record.taskRevision,
        record.state,
        record.dueAt,
        record.nextAttemptAt,
        record.attemptCount,
        record.errorCode,
        record.createdAt,
        record.updatedAt,
        record.deliveredAt,
      );
  }

  reconcile(input: {
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
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      for (const task of scheduled) {
        if (task.plannedStart === null) continue;
        for (const kind of kinds) {
          const occurrenceStart = task.plannedStart;
          desired.add(`${task.id}\n${occurrenceStart}\n${kind}`);
          const dueAt = new Date(
            Date.parse(occurrenceStart) - (kind === "lead" ? 15 * 60_000 : 0),
          ).toISOString();
          this.db
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
      const active = this.db
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
          this.db
            .prepare(
              "UPDATE notification_deliveries SET state='cancelled',error_code='OBSOLETE',updated_at=? WHERE id=?",
            )
            .run(input.now, delivery.id);
      }
      this.db.exec("COMMIT;");
    } catch (error: unknown) {
      this.db.exec("ROLLBACK;");
      throw error;
    }
  }

  // -----------------------------------------------------------------------
  // Additional notification methods (from SuiteDatabase)
  // -----------------------------------------------------------------------

  listDueNotificationDeliveries(
    now: string,
    limit = 25,
  ): readonly NotificationDeliveryRecord[] {
    const rows = this.db
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
    const updated = this.db
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
    const row = this.db
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
    this.db
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
    this.db
      .prepare(
        `UPDATE notification_deliveries SET state=?,error_code=?,updated_at=?,delivered_at=?
         WHERE id=? AND state='sending'`,
      )
      .run(state, errorCode, now, state === "delivered" ? now : null, id);
  }

  failUncertainNotificationDeliveries(now: string): number {
    const result = this.db
      .prepare(
        `UPDATE notification_deliveries SET state='failed',error_code='DELIVERY_UNCERTAIN',updated_at=?
         WHERE state='sending'`,
      )
      .run(now);
    return Number(result.changes);
  }

  recordNotificationTest(
    ownerId: string,
    delivered: boolean,
    errorCode: string | null,
    now: string,
  ): void {
    this.db
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
    const counts = this.db
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
    const last = this.db
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

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

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
}
