import type { DatabaseSync } from "node:sqlite";

/**
 * Date-only planning and per-task reminder storage (issue #29, ADR 0020).
 * Kept beside the main store so the task SELECT lists stay unchanged; the
 * values are read and written by task identity inside the caller's
 * transaction.
 */

export type StoredStartReminder =
  | { readonly kind: "default" }
  | { readonly kind: "none" }
  | { readonly kind: "before_start"; readonly minutes: number };

export interface TaskPlanningColumns {
  readonly plannedDay: string | null;
  readonly startReminder: StoredStartReminder;
  readonly deadlineReminderMinutes: number | null;
}

export const dateOnlyPlanningMigration = {
  id: "0023_date_only_planning",
  sql: `
      ALTER TABLE tasks ADD COLUMN planned_day TEXT
        CHECK (planned_day IS NULL OR (length(planned_day) = 10
          AND planned_day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'));
      ALTER TABLE tasks ADD COLUMN start_reminder_mode TEXT NOT NULL DEFAULT 'default'
        CHECK (start_reminder_mode IN ('default','none','before_start'));
      ALTER TABLE tasks ADD COLUMN start_reminder_minutes INTEGER
        CHECK (start_reminder_minutes IS NULL OR start_reminder_minutes IN (0,5,10,15,30,60));
      ALTER TABLE tasks ADD COLUMN deadline_reminder_minutes INTEGER
        CHECK (deadline_reminder_minutes IS NULL OR deadline_reminder_minutes IN (0,5,10,15,30,60));
      CREATE INDEX tasks_planned_day ON tasks(owner_id,planned_day)
        WHERE planned_day IS NOT NULL;
      CREATE TRIGGER tasks_plan_insert_valid
      BEFORE INSERT ON tasks
      WHEN (NEW.planned_day IS NOT NULL AND NEW.planned_start IS NOT NULL)
        OR ((NEW.start_reminder_mode = 'before_start') <> (NEW.start_reminder_minutes IS NOT NULL))
        OR (NEW.deadline_reminder_minutes IS NOT NULL AND NEW.deadline_at IS NULL)
      BEGIN
        SELECT RAISE(ABORT, 'task plan or reminder is inconsistent');
      END;
      CREATE TRIGGER tasks_plan_update_valid
      BEFORE UPDATE OF planned_day, planned_start, start_reminder_mode,
        start_reminder_minutes, deadline_reminder_minutes, deadline_at ON tasks
      WHEN (NEW.planned_day IS NOT NULL AND NEW.planned_start IS NOT NULL)
        OR ((NEW.start_reminder_mode = 'before_start') <> (NEW.start_reminder_minutes IS NOT NULL))
        OR (NEW.deadline_reminder_minutes IS NOT NULL AND NEW.deadline_at IS NULL)
      BEGIN
        SELECT RAISE(ABORT, 'task plan or reminder is inconsistent');
      END;
      CREATE TABLE notification_deliveries_v2 (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL REFERENCES owner_accounts(id) ON DELETE CASCADE,
        task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
        occurrence_start TEXT NOT NULL,
        reminder_kind TEXT NOT NULL CHECK(reminder_kind IN ('lead','at_start','deadline','test')),
        task_revision INTEGER CHECK(task_revision IS NULL OR task_revision > 0),
        state TEXT NOT NULL CHECK(state IN ('pending','sending','retry','delivered','suppressed','cancelled','failed')),
        due_at TEXT NOT NULL, next_attempt_at TEXT NOT NULL,
        attempt_count INTEGER NOT NULL CHECK(attempt_count >= 0),
        error_code TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, delivered_at TEXT
      ) STRICT;
      INSERT INTO notification_deliveries_v2
        (id,owner_id,task_id,occurrence_start,reminder_kind,task_revision,state,due_at,next_attempt_at,attempt_count,error_code,created_at,updated_at,delivered_at)
        SELECT id,owner_id,task_id,occurrence_start,reminder_kind,task_revision,state,due_at,next_attempt_at,attempt_count,error_code,created_at,updated_at,delivered_at
        FROM notification_deliveries;
      DROP TABLE notification_deliveries;
      ALTER TABLE notification_deliveries_v2 RENAME TO notification_deliveries;
      CREATE UNIQUE INDEX notification_delivery_occurrence
        ON notification_deliveries(owner_id,task_id,occurrence_start,reminder_kind)
        WHERE task_id IS NOT NULL;
      CREATE INDEX notification_delivery_due
        ON notification_deliveries(state,next_attempt_at,owner_id);
      CREATE INDEX notification_delivery_status
        ON notification_deliveries(owner_id,updated_at DESC,id);
    `,
} as const;

interface PlanningRow {
  readonly planned_day: string | null;
  readonly start_reminder_mode: "default" | "none" | "before_start";
  readonly start_reminder_minutes: number | null;
  readonly deadline_reminder_minutes: number | null;
}

export const defaultTaskPlanning: TaskPlanningColumns = {
  plannedDay: null,
  startReminder: { kind: "default" },
  deadlineReminderMinutes: null,
};

export const readTaskPlanning = (
  database: DatabaseSync,
  ownerId: string,
  taskId: string,
): TaskPlanningColumns => {
  const row = database
    .prepare(
      `SELECT planned_day,start_reminder_mode,start_reminder_minutes,deadline_reminder_minutes
       FROM tasks WHERE owner_id=? AND id=?`,
    )
    .get(ownerId, taskId) as unknown as PlanningRow | undefined;
  if (row === undefined) return defaultTaskPlanning;
  return {
    plannedDay: row.planned_day,
    startReminder:
      row.start_reminder_mode === "before_start" &&
      row.start_reminder_minutes !== null
        ? { kind: "before_start", minutes: row.start_reminder_minutes }
        : row.start_reminder_mode === "none"
          ? { kind: "none" }
          : { kind: "default" },
    deadlineReminderMinutes: row.deadline_reminder_minutes,
  };
};

/**
 * Persist planning columns for an existing row. The caller has already
 * written planned_start and deadline_at, so the consistency triggers see the
 * final state.
 */
export const writeTaskPlanning = (
  database: DatabaseSync,
  ownerId: string,
  taskId: string,
  planning: TaskPlanningColumns,
): void => {
  database
    .prepare(
      `UPDATE tasks SET planned_day=?,start_reminder_mode=?,start_reminder_minutes=?,deadline_reminder_minutes=?
       WHERE owner_id=? AND id=?`,
    )
    .run(
      planning.plannedDay,
      planning.startReminder.kind,
      planning.startReminder.kind === "before_start"
        ? planning.startReminder.minutes
        : null,
      planning.deadlineReminderMinutes,
      ownerId,
      taskId,
    );
};
