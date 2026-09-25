import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  isOccurrence,
  nextOccurrence,
  planGeneration,
  upcomingOccurrences,
  validateRecurrenceRule,
  zonedCalendarDate,
  zonedStartInstant,
  addCalendarDays,
  type MissedOccurrencePolicy,
  type RecurrenceRule,
  type RecurrenceRuleViolation,
  type RecurrenceWindow,
} from "@suite/domain";
import type { StoredStartReminder } from "./task-planning-columns.ts";
import type {
  ConditionalTaskResult,
  IdempotentTaskCreateResult,
  TaskPatch,
  TaskRecord,
} from "./index.ts";

/**
 * Recurring series (issue #42, docs/adr/0023-recurring-tasks.md).
 *
 * A series is a template plus a rule. Each materialized occurrence is an
 * ordinary task. `recurring_occurrences` is the identity ledger: its primary
 * key (series, occurrence date) makes generation idempotent across restarts
 * and concurrent generators, and it keeps skipped and deleted exceptions.
 * `recurring_task_links` ties instance tasks to their series; imported
 * history may link more than one task to a date, the ledger never does.
 */
export const recurrenceMigration = {
  id: "0027_recurring_tasks",
  sql: `
      CREATE TABLE recurring_series (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL REFERENCES owner_accounts(id) ON DELETE CASCADE,
        title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 240),
        notes TEXT NOT NULL CHECK(length(notes) <= 20000),
        project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
        tag_ids_json TEXT NOT NULL,
        estimate_minutes INTEGER
          CHECK(estimate_minutes IS NULL OR estimate_minutes BETWEEN 1 AND 720),
        rule_json TEXT NOT NULL,
        start_date TEXT NOT NULL,
        end_date TEXT CHECK(end_date IS NULL OR end_date >= start_date),
        start_time TEXT CHECK(start_time IS NULL OR (length(start_time) = 5
          AND start_time GLOB '[0-2][0-9]:[0-5][0-9]')),
        start_reminder_mode TEXT NOT NULL
          CHECK(start_reminder_mode IN ('default','none','before_start')),
        start_reminder_minutes INTEGER
          CHECK(start_reminder_minutes IS NULL OR start_reminder_minutes IN (0,5,10,15,30,60)),
        anchor_mode TEXT NOT NULL CHECK(anchor_mode IN ('schedule','completion')),
        wait_for_completion INTEGER NOT NULL CHECK(wait_for_completion IN (0,1)),
        missed_policy TEXT NOT NULL CHECK(missed_policy IN ('skip','latest')),
        child_templates_json TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('active','paused','ended')),
        anchor_date TEXT NOT NULL,
        cursor_date TEXT,
        floor_date TEXT,
        source TEXT NOT NULL CHECK(source IN ('tadooer','super_productivity')),
        revision INTEGER NOT NULL CHECK(revision > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        paused_at TEXT,
        ended_at TEXT,
        CHECK((start_reminder_mode = 'before_start') = (start_reminder_minutes IS NOT NULL)),
        CHECK(start_reminder_mode = 'default' OR start_time IS NOT NULL)
      ) STRICT;
      CREATE INDEX recurring_series_by_owner ON recurring_series(owner_id, state, id);
      CREATE TABLE recurring_occurrences (
        series_id TEXT NOT NULL REFERENCES recurring_series(id) ON DELETE CASCADE,
        owner_id TEXT NOT NULL REFERENCES owner_accounts(id) ON DELETE CASCADE,
        occurrence_date TEXT NOT NULL CHECK(length(occurrence_date) = 10
          AND occurrence_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
        state TEXT NOT NULL
          CHECK(state IN ('generated','imported','linked','skipped','deleted')),
        task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
        recorded_at TEXT NOT NULL,
        PRIMARY KEY(series_id, occurrence_date),
        CHECK(state <> 'skipped' OR task_id IS NULL)
      ) STRICT;
      CREATE TABLE recurring_task_links (
        task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
        owner_id TEXT NOT NULL REFERENCES owner_accounts(id) ON DELETE CASCADE,
        series_id TEXT NOT NULL REFERENCES recurring_series(id) ON DELETE CASCADE,
        occurrence_date TEXT NOT NULL,
        origin TEXT NOT NULL CHECK(origin IN ('generated','imported','linked'))
      ) STRICT;
      CREATE INDEX recurring_task_links_by_series
        ON recurring_task_links(series_id, occurrence_date, task_id);
    `,
};

export interface RecurrenceChildTemplate {
  readonly title: string;
  readonly notes: string;
  readonly estimateMinutes: number | null;
}

export type RecurringSeriesState = "active" | "paused" | "ended";
export type SeriesAnchorMode = "schedule" | "completion";

/** Template and rule fields that the owner edits. */
export interface RecurringSeriesFields {
  readonly title: string;
  readonly notes: string;
  readonly projectId: string | null;
  readonly tagIds: readonly string[];
  readonly estimateMinutes: number | null;
  readonly rule: RecurrenceRule;
  readonly startDate: string;
  readonly endDate: string | null;
  readonly startTime: string | null;
  readonly startReminder: StoredStartReminder;
  readonly anchor: SeriesAnchorMode;
  readonly waitForCompletion: boolean;
  readonly missedOccurrences: MissedOccurrencePolicy;
  readonly childTemplates: readonly RecurrenceChildTemplate[];
}

export interface RecurringSeriesRecord extends RecurringSeriesFields {
  readonly id: string;
  readonly ownerId: string;
  readonly state: RecurringSeriesState;
  readonly anchorDate: string;
  readonly cursorDate: string | null;
  readonly floorDate: string | null;
  readonly source: "tadooer" | "super_productivity";
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly pausedAt: string | null;
  readonly endedAt: string | null;
}

export interface RecurrenceExceptionRecord {
  readonly date: string;
  readonly state: "skipped" | "deleted";
}

export type RecurrenceViolation =
  | RecurrenceRuleViolation
  | "project_unavailable"
  | "tag_unavailable"
  | "reminder_needs_time"
  | "source_task_invalid"
  | "no_occurrence"
  | "series_ended"
  | "state_unchanged"
  | "occurrence_invalid"
  | "occurrence_processed"
  | "occurrence_not_skipped"
  | "instance_missing"
  | "instance_blocked";

export type RecurrenceMutationResult =
  | {
      readonly kind: "created" | "replayed" | "updated";
      readonly series: RecurringSeriesRecord;
      readonly generatedTaskIds: readonly string[];
      readonly updatedTaskIds: readonly string[];
    }
  | { readonly kind: "not-found" }
  | { readonly kind: "conflict" }
  | {
      readonly kind: "precondition-failed";
      readonly series: RecurringSeriesRecord;
    }
  | { readonly kind: "invalid"; readonly code: RecurrenceViolation };

/** One Super Productivity repeat configuration mapped by the importer. */
export interface ImportedRecurringSeries extends Omit<
  RecurringSeriesFields,
  "projectId" | "tagIds"
> {
  readonly sourceId: string;
  readonly sourceHash: string;
  readonly sourceJson: string;
  readonly projectSourceId: string | null;
  readonly tagSourceIds: readonly string[];
  readonly paused: boolean;
  readonly anchorDate: string;
  /** lastTaskCreationDay: the newest occurrence the source already handled. */
  readonly cursorDate: string | null;
  /** deletedInstanceDates: persisted as deleted exceptions. */
  readonly deletedDates: readonly string[];
  readonly createdAt: string | null;
}

export interface ImportedOccurrenceLink {
  readonly taskSourceId: string;
  readonly seriesSourceId: string;
  readonly occurrenceDate: string;
}

export interface RecurrenceDependencies {
  readonly getTask: (
    ownerId: string,
    taskId: string,
    includeInactive?: boolean,
  ) => TaskRecord | undefined;
  readonly createTask: (
    ownerId: string,
    idempotencyKey: string,
    task: RecurrenceTaskInput,
  ) => IdempotentTaskCreateResult;
  readonly createChild: (
    ownerId: string,
    parentId: string,
    now: string,
    create: () => IdempotentTaskCreateResult,
  ) => { readonly kind: string };
  readonly patchTask: (
    ownerId: string,
    taskId: string,
    expectedRevision: number,
    patch: TaskPatch,
    now: string,
  ) => ConditionalTaskResult;
  readonly assignProject: (
    ownerId: string,
    taskId: string,
    projectId: string | null,
    expectedRevision: number,
    now: string,
  ) => TaskRecord | undefined;
  readonly setTags: (
    ownerId: string,
    taskId: string,
    tagIds: readonly string[],
    expectedRevision: number,
    now: string,
  ) => boolean;
  readonly deleteTask: (
    ownerId: string,
    taskId: string,
    expectedRevision: number,
    now: string,
  ) => ConditionalTaskResult;
  /** Task IDs in the family with a running focus session or calendar block. */
  readonly blockedIds: (ownerId: string, taskId: string) => readonly string[];
  /**
   * Re-sends an unchanged task in the sync feed. Linking an existing task to
   * a series changes its `recurrence` field without a revision bump.
   */
  readonly announceTask: (
    ownerId: string,
    taskId: string,
    revision: number,
    now: string,
  ) => void;
}

/** The fields of a generated instance or child task. */
export interface RecurrenceTaskInput {
  readonly id: string;
  readonly title: string;
  readonly notes: string;
  readonly status: "open";
  readonly revision: 1;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly plannedStart: string | null;
  readonly plannedDay: string | null;
  readonly startReminder: StoredStartReminder;
  readonly estimateMinutes: number | null;
  readonly projectId: string | null;
  readonly tagIds: readonly string[];
}

interface SeriesRow {
  readonly id: string;
  readonly owner_id: string;
  readonly title: string;
  readonly notes: string;
  readonly project_id: string | null;
  readonly tag_ids_json: string;
  readonly estimate_minutes: number | null;
  readonly rule_json: string;
  readonly start_date: string;
  readonly end_date: string | null;
  readonly start_time: string | null;
  readonly start_reminder_mode: StoredStartReminder["kind"];
  readonly start_reminder_minutes: number | null;
  readonly anchor_mode: SeriesAnchorMode;
  readonly wait_for_completion: number;
  readonly missed_policy: MissedOccurrencePolicy;
  readonly child_templates_json: string;
  readonly state: RecurringSeriesState;
  readonly anchor_date: string;
  readonly cursor_date: string | null;
  readonly floor_date: string | null;
  readonly source: "tadooer" | "super_productivity";
  readonly revision: number;
  readonly created_at: string;
  readonly updated_at: string;
  readonly paused_at: string | null;
  readonly ended_at: string | null;
}

/** Most series a single generation pass visits per owner. */
export const recurrenceGenerationBatch = 500;

const window = (series: RecurringSeriesRecord): RecurrenceWindow => ({
  startDate: series.startDate,
  endDate: series.endDate,
  anchorDate: series.anchorDate,
});

const sameSet = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length && left.every((id) => right.includes(id));

export class SqliteRecurrenceStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly deps: RecurrenceDependencies,
  ) {}

  get(ownerId: string, seriesId: string): RecurringSeriesRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM recurring_series WHERE owner_id=? AND id=?")
      .get(ownerId, seriesId) as SeriesRow | undefined;
    return row === undefined ? undefined : this.#fromRow(row);
  }

  /** Series newest first, ended ones last. */
  list(ownerId: string): readonly RecurringSeriesRecord[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM recurring_series WHERE owner_id=?
           ORDER BY state = 'ended', created_at DESC, id DESC`,
        )
        .all(ownerId) as unknown as SeriesRow[]
    ).map((row) => this.#fromRow(row));
  }

  exceptions(
    ownerId: string,
    seriesId: string,
  ): readonly RecurrenceExceptionRecord[] {
    return this.db
      .prepare(
        `SELECT occurrence_date AS date, state FROM recurring_occurrences
         WHERE owner_id=? AND series_id=? AND state IN ('skipped','deleted')
         ORDER BY occurrence_date DESC LIMIT 100`,
      )
      .all(ownerId, seriesId) as unknown as RecurrenceExceptionRecord[];
  }

  /** Linked instance tasks that are not soft-deleted (active or archived). */
  instanceCount(ownerId: string, seriesId: string): number {
    return (
      this.db
        .prepare(
          `SELECT count(*) AS count FROM recurring_task_links l JOIN tasks t ON t.id=l.task_id
           WHERE l.owner_id=? AND l.series_id=? AND t.deleted_at IS NULL`,
        )
        .get(ownerId, seriesId) as { count: number }
    ).count;
  }

  /** Upcoming occurrence dates from today (or after the cursor), flagged when skipped. */
  upcoming(
    series: RecurringSeriesRecord,
    today: string,
    count = 5,
  ): readonly { date: string; skipped: boolean }[] {
    if (series.state === "ended") return [];
    const after =
      series.cursorDate !== null && series.cursorDate >= today
        ? addCalendarDays(series.cursorDate, 1)
        : today;
    const from =
      series.floorDate !== null && series.floorDate > after
        ? series.floorDate
        : after;
    const skipped = new Set(
      (
        this.db
          .prepare(
            "SELECT occurrence_date FROM recurring_occurrences WHERE series_id=? AND state='skipped' AND occurrence_date>=?",
          )
          .all(series.id, from) as { occurrence_date: string }[]
      ).map(({ occurrence_date }) => occurrence_date),
    );
    return upcomingOccurrences(series.rule, window(series), from, count).map(
      (date) => ({ date, skipped: skipped.has(date) }),
    );
  }

  /** The series and occurrence date of an instance task, if any. */
  linkOf(
    ownerId: string,
    taskId: string,
  ): { readonly seriesId: string; readonly occurrenceDate: string } | null {
    const row = this.db
      .prepare(
        "SELECT series_id, occurrence_date FROM recurring_task_links WHERE owner_id=? AND task_id=?",
      )
      .get(ownerId, taskId) as
      { series_id: string; occurrence_date: string } | undefined;
    return row === undefined
      ? null
      : { seriesId: row.series_id, occurrenceDate: row.occurrence_date };
  }

  /** Validates fields without writing; used by assistant previews. */
  check(
    ownerId: string,
    fields: RecurringSeriesFields,
    current?: RecurringSeriesRecord,
  ): RecurrenceViolation | null {
    return this.#validate(ownerId, fields, current);
  }

  create(input: {
    readonly ownerId: string;
    readonly id: string;
    readonly idempotencyKey: string;
    readonly requestHash: string;
    readonly fields: RecurringSeriesFields;
    readonly sourceTaskId?: string | undefined;
    readonly timeZone: string;
    readonly now: string;
  }): RecurrenceMutationResult {
    return this.#write("recurrence_create", () => {
      const prior = this.db
        .prepare(
          `SELECT request_hash, resource_id FROM idempotency_records
           WHERE owner_id=? AND operation='recurring_series.create' AND idempotency_key=?`,
        )
        .get(input.ownerId, input.idempotencyKey) as
        { request_hash: string; resource_id: string } | undefined;
      if (prior !== undefined) {
        if (prior.request_hash !== input.requestHash)
          return { kind: "conflict" };
        const series = this.get(input.ownerId, prior.resource_id);
        if (series === undefined)
          throw new Error("Idempotency record refers to a missing series");
        return {
          kind: "replayed",
          series,
          generatedTaskIds: [],
          updatedTaskIds: [],
        };
      }
      const violation = this.#validate(input.ownerId, input.fields);
      if (violation !== null) return { kind: "invalid", code: violation };
      const today = zonedCalendarDate(input.now, input.timeZone);
      let cursorDate: string | null = null;
      let source: TaskRecord | undefined;
      if (input.sourceTaskId !== undefined) {
        source = this.deps.getTask(input.ownerId, input.sourceTaskId);
        if (
          source === undefined ||
          source.parentId != null ||
          this.linkOf(input.ownerId, source.id) !== null
        )
          return { kind: "invalid", code: "source_task_invalid" };
        cursorDate = nextOccurrence(
          input.fields.rule,
          {
            startDate: input.fields.startDate,
            endDate: input.fields.endDate,
            anchorDate: input.fields.startDate,
          },
          input.fields.startDate > today ? input.fields.startDate : today,
        );
        if (cursorDate === null)
          return { kind: "invalid", code: "no_occurrence" };
      }
      this.#insert(input.ownerId, input.id, input.fields, {
        state: "active",
        anchorDate: input.fields.startDate,
        cursorDate,
        floorDate: today,
        source: "tadooer",
        createdAt: input.now,
      });
      if (source !== undefined && cursorDate !== null) {
        this.#link(
          input.ownerId,
          input.id,
          cursorDate,
          source.id,
          "linked",
          input.now,
        );
        this.deps.announceTask(
          input.ownerId,
          source.id,
          source.revision,
          input.now,
        );
      }
      this.db
        .prepare(
          `INSERT INTO idempotency_records
            (owner_id, operation, idempotency_key, request_hash, resource_id, created_at)
           VALUES (?, 'recurring_series.create', ?, ?, ?, ?)`,
        )
        .run(
          input.ownerId,
          input.idempotencyKey,
          input.requestHash,
          input.id,
          input.now,
        );
      const generated = this.#generate(
        this.#required(input.ownerId, input.id),
        input.timeZone,
        input.now,
      );
      return {
        kind: "created",
        series: this.#required(input.ownerId, input.id),
        generatedTaskIds: generated,
        updatedTaskIds: [],
      };
    });
  }

  /**
   * Edits template and rule fields. Template changes propagate to open,
   * active instances whose value still equals the previous template value.
   * Schedule changes affect future generation only.
   */
  update(input: {
    readonly ownerId: string;
    readonly seriesId: string;
    readonly expectedRevision: number;
    readonly patch: Partial<RecurringSeriesFields>;
    readonly timeZone: string;
    readonly now: string;
  }): RecurrenceMutationResult {
    return this.#write("recurrence_update", () => {
      const current = this.get(input.ownerId, input.seriesId);
      if (current === undefined) return { kind: "not-found" };
      if (current.revision !== input.expectedRevision)
        return { kind: "precondition-failed", series: current };
      if (current.state === "ended")
        return { kind: "invalid", code: "series_ended" };
      const next: RecurringSeriesFields = { ...current, ...input.patch };
      const violation = this.#validate(input.ownerId, next, current);
      if (violation !== null) return { kind: "invalid", code: violation };
      const scheduleChanged =
        JSON.stringify(next.rule) !== JSON.stringify(current.rule) ||
        next.startDate !== current.startDate ||
        next.endDate !== current.endDate ||
        next.anchor !== current.anchor;
      const today = zonedCalendarDate(input.now, input.timeZone);
      const anchorDate = !scheduleChanged
        ? current.anchorDate
        : next.anchor === "schedule" || next.startDate > current.anchorDate
          ? next.startDate
          : current.anchorDate;
      this.#writeFields(input.ownerId, current, next, {
        anchorDate,
        floorDate: scheduleChanged ? today : current.floorDate,
        now: input.now,
      });
      const updatedTaskIds = this.#propagate(current, next, input.now);
      const generated = this.#generate(
        this.#required(input.ownerId, current.id),
        input.timeZone,
        input.now,
      );
      return {
        kind: "updated",
        series: this.#required(input.ownerId, current.id),
        generatedTaskIds: generated,
        updatedTaskIds,
      };
    });
  }

  /** Pause, resume or end. Resume never creates an occurrence before today. */
  setState(input: {
    readonly ownerId: string;
    readonly seriesId: string;
    readonly expectedRevision: number;
    readonly action: "pause" | "resume" | "end";
    readonly timeZone: string;
    readonly now: string;
  }): RecurrenceMutationResult {
    return this.#write("recurrence_state", () => {
      const current = this.get(input.ownerId, input.seriesId);
      if (current === undefined) return { kind: "not-found" };
      if (current.revision !== input.expectedRevision)
        return { kind: "precondition-failed", series: current };
      if (current.state === "ended")
        return { kind: "invalid", code: "series_ended" };
      const target =
        input.action === "pause"
          ? "paused"
          : input.action === "resume"
            ? "active"
            : "ended";
      if (target === current.state)
        return { kind: "invalid", code: "state_unchanged" };
      this.db
        .prepare(
          `UPDATE recurring_series SET state=?, paused_at=?, ended_at=?, floor_date=?,
             revision=revision+1, updated_at=? WHERE owner_id=? AND id=? AND revision=?`,
        )
        .run(
          target,
          target === "paused" ? input.now : null,
          target === "ended" ? input.now : null,
          input.action === "resume"
            ? zonedCalendarDate(input.now, input.timeZone)
            : current.floorDate,
          input.now,
          input.ownerId,
          current.id,
          current.revision,
        );
      const generated =
        target === "active"
          ? this.#generate(
              this.#required(input.ownerId, current.id),
              input.timeZone,
              input.now,
            )
          : [];
      return {
        kind: "updated",
        series: this.#required(input.ownerId, current.id),
        generatedTaskIds: generated,
        updatedTaskIds: [],
      };
    });
  }

  /**
   * Occurrence exceptions. `skip` and `unskip` apply to occurrences that have
   * not been processed yet; `delete_instance` soft-deletes a generated or
   * imported instance and records that its date must never regenerate.
   */
  occurrence(input: {
    readonly ownerId: string;
    readonly seriesId: string;
    readonly expectedRevision: number;
    readonly date: string;
    readonly action: "skip" | "unskip" | "delete_instance";
    readonly now: string;
  }): RecurrenceMutationResult {
    return this.#write("recurrence_occurrence", () => {
      const current = this.get(input.ownerId, input.seriesId);
      if (current === undefined) return { kind: "not-found" };
      if (current.revision !== input.expectedRevision)
        return { kind: "precondition-failed", series: current };
      const ledger = this.db
        .prepare(
          "SELECT state, task_id FROM recurring_occurrences WHERE series_id=? AND occurrence_date=?",
        )
        .get(current.id, input.date) as
        { state: string; task_id: string | null } | undefined;
      const updatedTaskIds: string[] = [];
      if (input.action === "delete_instance") {
        const task =
          ledger?.task_id == null
            ? undefined
            : this.deps.getTask(input.ownerId, ledger.task_id);
        if (
          ledger === undefined ||
          ledger.state === "skipped" ||
          task === undefined
        )
          return { kind: "invalid", code: "instance_missing" };
        if (this.deps.blockedIds(input.ownerId, task.id).length > 0)
          return { kind: "invalid", code: "instance_blocked" };
        const deleted = this.deps.deleteTask(
          input.ownerId,
          task.id,
          task.revision,
          input.now,
        );
        if (deleted.kind !== "updated")
          throw new Error("Instance delete changed during the transaction");
        updatedTaskIds.push(task.id);
        this.db
          .prepare(
            "UPDATE recurring_occurrences SET state='deleted', recorded_at=? WHERE series_id=? AND occurrence_date=?",
          )
          .run(input.now, current.id, input.date);
      } else {
        if (current.state === "ended")
          return { kind: "invalid", code: "series_ended" };
        if (!isOccurrence(current.rule, window(current), input.date))
          return { kind: "invalid", code: "occurrence_invalid" };
        if (current.cursorDate !== null && input.date <= current.cursorDate)
          return { kind: "invalid", code: "occurrence_processed" };
        if (input.action === "skip") {
          if (ledger !== undefined)
            return { kind: "invalid", code: "occurrence_processed" };
          this.db
            .prepare(
              "INSERT INTO recurring_occurrences (series_id,owner_id,occurrence_date,state,task_id,recorded_at) VALUES (?,?,?,'skipped',NULL,?)",
            )
            .run(current.id, input.ownerId, input.date, input.now);
        } else {
          if (ledger?.state !== "skipped")
            return { kind: "invalid", code: "occurrence_not_skipped" };
          this.db
            .prepare(
              "DELETE FROM recurring_occurrences WHERE series_id=? AND occurrence_date=? AND state='skipped'",
            )
            .run(current.id, input.date);
        }
      }
      this.#bump(input.ownerId, current, input.now);
      return {
        kind: "updated",
        series: this.#required(input.ownerId, current.id),
        generatedTaskIds: [],
        updatedTaskIds,
      };
    });
  }

  /**
   * One bounded generation pass for an owner: every active series creates at
   * most one instance. Runs in an IMMEDIATE transaction when called outside
   * one, so concurrent generators serialize and re-read the ledger.
   */
  generateDue(input: {
    readonly ownerId: string;
    readonly timeZone: string;
    readonly now: string;
  }): readonly string[] {
    return this.#write("recurrence_generate", () => {
      const ids = (
        this.db
          .prepare(
            `SELECT id FROM recurring_series WHERE owner_id=? AND state='active'
             ORDER BY id LIMIT ?`,
          )
          .all(input.ownerId, recurrenceGenerationBatch) as { id: string }[]
      ).map(({ id }) => id);
      return ids.flatMap((id) =>
        this.#generate(
          this.#required(input.ownerId, id),
          input.timeZone,
          input.now,
        ),
      );
    });
  }

  /**
   * Import helper; runs inside the caller's transaction after the batch's
   * tasks exist. Series are identified by source ID in task_import_sources,
   * so a repeated import neither duplicates series nor regenerates history.
   */
  importInTransaction(
    ownerId: string,
    input: {
      readonly series: readonly ImportedRecurringSeries[];
      readonly links: readonly ImportedOccurrenceLink[];
    },
    resolve: (kind: "project" | "tag" | "task", sourceId: string) => string,
    newId: () => string,
    now: string,
  ): { created: number; existing: number } {
    let created = 0;
    let existing = 0;
    const seriesIds = new Map<string, string>();
    for (const imported of input.series) {
      const prior = this.db
        .prepare(
          "SELECT target_id, source_hash FROM task_import_sources WHERE owner_id=? AND source_kind='super_productivity' AND entity_kind='repeat_config' AND source_id=?",
        )
        .get(ownerId, imported.sourceId) as
        { target_id: string; source_hash: string } | undefined;
      if (prior !== undefined) {
        if (prior.source_hash !== imported.sourceHash)
          throw new Error("IMPORT_SOURCE_CHANGED");
        seriesIds.set(imported.sourceId, prior.target_id);
        existing++;
        continue;
      }
      const id = newId();
      seriesIds.set(imported.sourceId, id);
      this.#insert(
        ownerId,
        id,
        {
          ...imported,
          projectId:
            imported.projectSourceId === null
              ? null
              : resolve("project", imported.projectSourceId),
          tagIds: imported.tagSourceIds.map((tagId) => resolve("tag", tagId)),
        },
        {
          state: imported.paused ? "paused" : "active",
          anchorDate: imported.anchorDate,
          cursorDate: imported.cursorDate,
          floorDate: null,
          source: "super_productivity",
          createdAt: imported.createdAt ?? now,
        },
        now,
      );
      const exception = this.db.prepare(
        "INSERT OR IGNORE INTO recurring_occurrences (series_id,owner_id,occurrence_date,state,task_id,recorded_at) VALUES (?,?,?,'deleted',NULL,?)",
      );
      for (const date of imported.deletedDates)
        exception.run(id, ownerId, date, now);
      this.db
        .prepare(
          "INSERT INTO task_import_sources (owner_id,source_kind,entity_kind,source_id,target_id,source_hash,source_json,imported_at) VALUES (?,'super_productivity','repeat_config',?,?,?,?,?)",
        )
        .run(
          ownerId,
          imported.sourceId,
          id,
          imported.sourceHash,
          imported.sourceJson,
          now,
        );
      created++;
    }
    for (const link of input.links) {
      const seriesId = seriesIds.get(link.seriesSourceId);
      if (seriesId === undefined) throw new Error("IMPORT_REFERENCE_MISSING");
      const taskId = resolve("task", link.taskSourceId);
      if (this.linkOf(ownerId, taskId) !== null) continue;
      this.#link(
        ownerId,
        seriesId,
        link.occurrenceDate,
        taskId,
        "imported",
        now,
      );
      // The cursor always covers imported instances, so history never regenerates.
      this.db
        .prepare(
          `UPDATE recurring_series SET cursor_date=? WHERE id=?
             AND (cursor_date IS NULL OR cursor_date < ?)`,
        )
        .run(link.occurrenceDate, seriesId, link.occurrenceDate);
    }
    return { created, existing };
  }

  // Generation internals ----------------------------------------------------

  #generate(
    initial: RecurringSeriesRecord,
    timeZone: string,
    now: string,
  ): string[] {
    if (initial.state !== "active") return [];
    const today = zonedCalendarDate(now, timeZone);
    const series = this.#followCompletion(initial, timeZone);
    const plan = planGeneration({
      rule: series.rule,
      window: window(series),
      cursorDate: series.cursorDate,
      floorDate: series.floorDate,
      today,
      missed: series.missedOccurrences,
    });
    if (plan.kind === "none") return [];
    const recorded =
      this.db
        .prepare(
          "SELECT 1 FROM recurring_occurrences WHERE series_id=? AND occurrence_date=?",
        )
        .get(series.id, plan.date) !== undefined;
    // An open instance holds back the next one and does not advance the cursor.
    if (!recorded && series.waitForCompletion && this.#hasOpenInstance(series))
      return [];
    this.#advance(series.id, plan.date);
    if (recorded || plan.kind === "advance") return [];
    return [this.#materialize(series, plan.date, timeZone, now)];
  }

  /**
   * A completion-anchored series follows the completion date of its newest
   * instance: the pattern base and cursor move to that owner-local date.
   * Reopening an instance does not move them back.
   */
  #followCompletion(
    series: RecurringSeriesRecord,
    timeZone: string,
  ): RecurringSeriesRecord {
    if (series.anchor !== "completion") return series;
    const latest = this.db
      .prepare(
        `SELECT t.completed_at FROM recurring_task_links l JOIN tasks t ON t.id=l.task_id
         WHERE l.series_id=? AND t.deleted_at IS NULL
         ORDER BY l.occurrence_date DESC, t.created_at DESC, t.id DESC LIMIT 1`,
      )
      .get(series.id) as { completed_at: string | null } | undefined;
    if (latest?.completed_at == null) return series;
    const completed = zonedCalendarDate(latest.completed_at, timeZone);
    if (completed <= series.anchorDate) return series;
    const cursorDate =
      series.cursorDate !== null && series.cursorDate > completed
        ? series.cursorDate
        : completed;
    this.db
      .prepare(
        "UPDATE recurring_series SET anchor_date=?, cursor_date=? WHERE id=?",
      )
      .run(completed, cursorDate, series.id);
    return { ...series, anchorDate: completed, cursorDate };
  }

  #hasOpenInstance(series: RecurringSeriesRecord): boolean {
    return (
      this.db
        .prepare(
          `SELECT 1 FROM recurring_task_links l JOIN tasks t ON t.id=l.task_id
           WHERE l.series_id=? AND t.deleted_at IS NULL AND t.status='open' LIMIT 1`,
        )
        .get(series.id) !== undefined
    );
  }

  #advance(seriesId: string, date: string): void {
    this.db
      .prepare(
        `UPDATE recurring_series SET cursor_date=? WHERE id=?
           AND (cursor_date IS NULL OR cursor_date < ?)`,
      )
      .run(date, seriesId, date);
  }

  /** Creates the instance and its child tasks; the ledger row guards identity. */
  #materialize(
    series: RecurringSeriesRecord,
    date: string,
    timeZone: string,
    now: string,
  ): string {
    const claimed = this.db
      .prepare(
        `INSERT INTO recurring_occurrences (series_id,owner_id,occurrence_date,state,task_id,recorded_at)
         VALUES (?,?,?,'generated',NULL,?) ON CONFLICT(series_id, occurrence_date) DO NOTHING`,
      )
      .run(series.id, series.ownerId, date, now).changes;
    if (claimed !== 1)
      throw new Error("Recurring occurrence was claimed twice");
    const activeProject =
      series.projectId !== null &&
      this.db
        .prepare(
          "SELECT 1 FROM projects WHERE id=? AND owner_id=? AND archived_at IS NULL",
        )
        .get(series.projectId, series.ownerId) !== undefined;
    const activeTags = series.tagIds.filter(
      (tagId) =>
        this.db
          .prepare(
            "SELECT 1 FROM tags WHERE id=? AND owner_id=? AND archived_at IS NULL",
          )
          .get(tagId, series.ownerId) !== undefined,
    );
    const timed = series.startTime !== null;
    const created = this.deps.createTask(
      series.ownerId,
      `recurrence:${series.id}:${date}`,
      {
        id: randomUUID(),
        title: series.title,
        notes: series.notes,
        status: "open",
        revision: 1,
        createdAt: now,
        updatedAt: now,
        plannedStart: timed
          ? zonedStartInstant(date, series.startTime, timeZone)
          : null,
        plannedDay: timed ? null : date,
        startReminder: timed ? series.startReminder : { kind: "default" },
        estimateMinutes: series.estimateMinutes,
        projectId: activeProject ? series.projectId : null,
        tagIds: activeTags,
      },
    );
    if (created.kind !== "created")
      throw new Error("Recurring instance identity was already used");
    const parentId = created.task.id;
    series.childTemplates.forEach((template, index) => {
      const child = this.deps.createChild(series.ownerId, parentId, now, () =>
        this.deps.createTask(
          series.ownerId,
          `recurrence:${series.id}:${date}:child:${String(index)}`,
          {
            id: randomUUID(),
            title: template.title,
            notes: template.notes,
            status: "open",
            revision: 1,
            createdAt: now,
            updatedAt: now,
            plannedStart: null,
            plannedDay: null,
            startReminder: { kind: "default" },
            estimateMinutes: template.estimateMinutes,
            projectId: activeProject ? series.projectId : null,
            tagIds: [],
          },
        ),
      );
      if (child.kind !== "created")
        throw new Error("Recurring child task could not be placed");
    });
    this.db
      .prepare(
        "UPDATE recurring_occurrences SET task_id=? WHERE series_id=? AND occurrence_date=?",
      )
      .run(parentId, series.id, date);
    this.db
      .prepare(
        "INSERT INTO recurring_task_links (task_id,owner_id,series_id,occurrence_date,origin) VALUES (?,?,?,?,'generated')",
      )
      .run(parentId, series.ownerId, series.id, date);
    return parentId;
  }

  // Write internals ---------------------------------------------------------

  /** Template propagation: only open, active instances still on the old value. */
  #propagate(
    before: RecurringSeriesRecord,
    after: RecurringSeriesFields,
    now: string,
  ): string[] {
    const templateChanged =
      before.title !== after.title ||
      before.notes !== after.notes ||
      before.estimateMinutes !== after.estimateMinutes ||
      before.projectId !== after.projectId ||
      !sameSet(before.tagIds, after.tagIds);
    if (!templateChanged) return [];
    const ids = (
      this.db
        .prepare(
          `SELECT t.id FROM recurring_task_links l JOIN tasks t ON t.id=l.task_id
           WHERE l.series_id=? AND t.deleted_at IS NULL AND t.archived_at IS NULL
             AND t.status='open' ORDER BY l.occurrence_date, t.id`,
        )
        .all(before.id) as { id: string }[]
    ).map(({ id }) => id);
    const updated: string[] = [];
    for (const id of ids) {
      let task = this.deps.getTask(before.ownerId, id);
      if (task === undefined) continue;
      let changed = false;
      const patch: {
        title?: string;
        notes?: string;
        estimateMinutes?: number | null;
      } = {};
      if (before.title !== after.title && task.title === before.title)
        patch.title = after.title;
      if (before.notes !== after.notes && task.notes === before.notes)
        patch.notes = after.notes;
      if (
        before.estimateMinutes !== after.estimateMinutes &&
        task.estimateMinutes === before.estimateMinutes
      )
        patch.estimateMinutes = after.estimateMinutes;
      if (Object.keys(patch).length > 0) {
        const result = this.deps.patchTask(
          before.ownerId,
          id,
          task.revision,
          patch,
          now,
        );
        if (result.kind !== "updated")
          throw new Error("Instance changed during propagation");
        task = result.task;
        changed = true;
      }
      if (
        before.projectId !== after.projectId &&
        (task.projectId ?? null) === before.projectId
      ) {
        const assigned = this.deps.assignProject(
          before.ownerId,
          id,
          after.projectId,
          task.revision,
          now,
        );
        if (assigned === undefined)
          throw new Error("Instance project changed during propagation");
        task = assigned;
        changed = true;
      }
      if (
        !sameSet(before.tagIds, after.tagIds) &&
        sameSet(task.tagIds ?? [], before.tagIds)
      ) {
        if (
          !this.deps.setTags(
            before.ownerId,
            id,
            after.tagIds,
            task.revision,
            now,
          )
        )
          throw new Error("Instance tags changed during propagation");
        changed = true;
      }
      if (changed) updated.push(id);
    }
    return updated;
  }

  #validate(
    ownerId: string,
    fields: RecurringSeriesFields,
    current?: RecurringSeriesRecord,
  ): RecurrenceViolation | null {
    const rule = validateRecurrenceRule(fields.rule, fields);
    if (rule !== null) return rule;
    if (fields.startReminder.kind !== "default" && fields.startTime === null)
      return "reminder_needs_time";
    // An unchanged project or tag that was archived later stays valid; the
    // generator skips it until it is restored.
    if (
      fields.projectId !== null &&
      fields.projectId !== current?.projectId &&
      this.db
        .prepare(
          "SELECT 1 FROM projects WHERE id=? AND owner_id=? AND archived_at IS NULL",
        )
        .get(fields.projectId, ownerId) === undefined
    )
      return "project_unavailable";
    for (const tagId of fields.tagIds)
      if (
        !(current?.tagIds.includes(tagId) ?? false) &&
        this.db
          .prepare(
            "SELECT 1 FROM tags WHERE id=? AND owner_id=? AND archived_at IS NULL",
          )
          .get(tagId, ownerId) === undefined
      )
        return "tag_unavailable";
    return null;
  }

  #insert(
    ownerId: string,
    id: string,
    fields: RecurringSeriesFields,
    state: {
      readonly state: RecurringSeriesState;
      readonly anchorDate: string;
      readonly cursorDate: string | null;
      readonly floorDate: string | null;
      readonly source: RecurringSeriesRecord["source"];
      readonly createdAt: string;
    },
    updatedAt = state.createdAt,
  ): void {
    this.db
      .prepare(
        `INSERT INTO recurring_series
          (id, owner_id, title, notes, project_id, tag_ids_json, estimate_minutes, rule_json,
           start_date, end_date, start_time, start_reminder_mode, start_reminder_minutes,
           anchor_mode, wait_for_completion, missed_policy, child_templates_json, state,
           anchor_date, cursor_date, floor_date, source, revision, created_at, updated_at,
           paused_at, ended_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?,NULL)`,
      )
      .run(
        id,
        ownerId,
        fields.title,
        fields.notes,
        fields.projectId,
        JSON.stringify(fields.tagIds),
        fields.estimateMinutes,
        JSON.stringify(fields.rule),
        fields.startDate,
        fields.endDate,
        fields.startTime,
        fields.startReminder.kind,
        fields.startReminder.kind === "before_start"
          ? fields.startReminder.minutes
          : null,
        fields.anchor,
        fields.waitForCompletion ? 1 : 0,
        fields.missedOccurrences,
        JSON.stringify(fields.childTemplates),
        state.state,
        state.anchorDate,
        state.cursorDate,
        state.floorDate,
        state.source,
        state.createdAt,
        updatedAt,
        state.state === "paused" ? updatedAt : null,
      );
  }

  #writeFields(
    ownerId: string,
    current: RecurringSeriesRecord,
    next: RecurringSeriesFields,
    state: {
      readonly anchorDate: string;
      readonly floorDate: string | null;
      readonly now: string;
    },
  ): void {
    const changed = this.db
      .prepare(
        `UPDATE recurring_series SET title=?, notes=?, project_id=?, tag_ids_json=?,
           estimate_minutes=?, rule_json=?, start_date=?, end_date=?, start_time=?,
           start_reminder_mode=?, start_reminder_minutes=?, anchor_mode=?,
           wait_for_completion=?, missed_policy=?, child_templates_json=?,
           anchor_date=?, floor_date=?, revision=revision+1, updated_at=?
         WHERE owner_id=? AND id=? AND revision=?`,
      )
      .run(
        next.title,
        next.notes,
        next.projectId,
        JSON.stringify(next.tagIds),
        next.estimateMinutes,
        JSON.stringify(next.rule),
        next.startDate,
        next.endDate,
        next.startTime,
        next.startReminder.kind,
        next.startReminder.kind === "before_start"
          ? next.startReminder.minutes
          : null,
        next.anchor,
        next.waitForCompletion ? 1 : 0,
        next.missedOccurrences,
        JSON.stringify(next.childTemplates),
        state.anchorDate,
        state.floorDate,
        state.now,
        ownerId,
        current.id,
        current.revision,
      ).changes;
    if (changed !== 1) throw new Error("Conditional series update was lost");
  }

  #bump(ownerId: string, series: RecurringSeriesRecord, now: string): void {
    const changed = this.db
      .prepare(
        "UPDATE recurring_series SET revision=revision+1, updated_at=? WHERE owner_id=? AND id=? AND revision=?",
      )
      .run(now, ownerId, series.id, series.revision).changes;
    if (changed !== 1) throw new Error("Conditional series update was lost");
  }

  #link(
    ownerId: string,
    seriesId: string,
    date: string,
    taskId: string,
    origin: "imported" | "linked",
    now: string,
  ): void {
    this.db
      .prepare(
        "INSERT INTO recurring_task_links (task_id,owner_id,series_id,occurrence_date,origin) VALUES (?,?,?,?,?)",
      )
      .run(taskId, ownerId, seriesId, date, origin);
    // The first task for a date owns the ledger row; later duplicates from
    // imported history stay linked without claiming the identity.
    this.db
      .prepare(
        `INSERT INTO recurring_occurrences (series_id,owner_id,occurrence_date,state,task_id,recorded_at)
         VALUES (?,?,?,?,?,?) ON CONFLICT(series_id, occurrence_date) DO NOTHING`,
      )
      .run(seriesId, ownerId, date, origin, taskId, now);
  }

  #required(ownerId: string, seriesId: string): RecurringSeriesRecord {
    const series = this.get(ownerId, seriesId);
    if (series === undefined) throw new Error("Recurring series disappeared");
    return series;
  }

  #fromRow(row: SeriesRow): RecurringSeriesRecord {
    return {
      id: row.id,
      ownerId: row.owner_id,
      title: row.title,
      notes: row.notes,
      projectId: row.project_id,
      tagIds: JSON.parse(row.tag_ids_json) as string[],
      estimateMinutes: row.estimate_minutes,
      rule: JSON.parse(row.rule_json) as RecurrenceRule,
      startDate: row.start_date,
      endDate: row.end_date,
      startTime: row.start_time,
      startReminder:
        row.start_reminder_mode === "before_start"
          ? { kind: "before_start", minutes: row.start_reminder_minutes ?? 0 }
          : { kind: row.start_reminder_mode },
      anchor: row.anchor_mode,
      waitForCompletion: row.wait_for_completion === 1,
      missedOccurrences: row.missed_policy,
      childTemplates: JSON.parse(
        row.child_templates_json,
      ) as RecurrenceChildTemplate[],
      state: row.state,
      anchorDate: row.anchor_date,
      cursorDate: row.cursor_date,
      floorDate: row.floor_date,
      source: row.source,
      revision: row.revision,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      pausedAt: row.paused_at,
      endedAt: row.ended_at,
    };
  }

  /**
   * IMMEDIATE takes the write lock before reading, so a second connection
   * waits and then sees the first one's ledger rows. Inside an existing
   * transaction (an import or an assistant confirmation) a savepoint nests.
   */
  #write<T>(name: string, body: () => T): T {
    const nested = this.db.isTransaction;
    this.db.exec(nested ? `SAVEPOINT ${name};` : "BEGIN IMMEDIATE;");
    try {
      const result = body();
      this.db.exec(nested ? `RELEASE SAVEPOINT ${name};` : "COMMIT;");
      return result;
    } catch (error) {
      this.db.exec(
        nested
          ? `ROLLBACK TO SAVEPOINT ${name}; RELEASE SAVEPOINT ${name};`
          : "ROLLBACK;",
      );
      throw error;
    }
  }
}
