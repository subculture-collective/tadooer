import type { DatabaseSync } from "node:sqlite";
import {
  plannedDayWindow,
  splitIntervalByDay,
  validateTimeEntryWrite,
  weekStartOf,
  type TimeEntryViolation,
} from "@suite/domain";
import type { TaskRecord } from "./index.ts";

/**
 * Work history (issue #41, docs/adr/0024-time-history.md).
 *
 * `time_entries` holds daily totals without a time of day: Super Productivity
 * imports and manual entries or corrections. Focus time is not copied here;
 * reports project `active_session_intervals` onto owner-zone days on read, so
 * the session stays the only authority for focus intervals.
 *
 * `time_work_context_days` keeps imported Super Productivity work start/end
 * and break records per project, tag or the Today context and day.
 *
 * Stored time entries are sync feed records (ADR 0050): every method that
 * writes `time_entries` appends its feed change in the same savepoint, so the
 * browser routes, the assistant, the importer and the sync outbox cannot
 * write an entry the feed does not carry. Focus intervals and work context
 * days are not feed records of this kind. Mutations use savepoints so they
 * nest inside automation confirmation, import and sync operation
 * transactions.
 */
export const timeHistoryMigration = {
  id: "0028_time_history",
  sql: `
      CREATE TABLE time_entries (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL REFERENCES owner_accounts(id) ON DELETE CASCADE,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        work_date TEXT NOT NULL CHECK (length(work_date) = 10
          AND date(work_date) IS work_date),
        duration_ms INTEGER NOT NULL
          CHECK (duration_ms <> 0 AND duration_ms BETWEEN -86400000 AND 86400000),
        source TEXT NOT NULL CHECK (source IN ('import','manual')),
        note TEXT NOT NULL DEFAULT '' CHECK (length(note) <= 500),
        revision INTEGER NOT NULL CHECK (revision > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        source_kind TEXT CHECK (source_kind IN ('super_productivity')),
        import_kind TEXT CHECK (import_kind IN ('task_day','parent_residual')),
        source_task_id TEXT CHECK (length(source_task_id) BETWEEN 1 AND 200),
        source_work_date TEXT,
        source_store TEXT CHECK (source_store IN ('task','archiveYoung','archiveOld')),
        CHECK ((source = 'import') = (source_kind IS NOT NULL
          AND import_kind IS NOT NULL AND source_task_id IS NOT NULL
          AND source_work_date IS NOT NULL AND source_store IS NOT NULL)),
        CHECK (source = 'manual' OR duration_ms > 0)
      ) STRICT;
      CREATE INDEX time_entries_by_day ON time_entries(owner_id, work_date, task_id);
      CREATE INDEX time_entries_by_task ON time_entries(owner_id, task_id, work_date);
      CREATE UNIQUE INDEX time_entries_import_identity
        ON time_entries(owner_id, source_kind, import_kind, source_task_id, source_work_date)
        WHERE source = 'import';
      CREATE TRIGGER time_entries_archived_insert
      BEFORE INSERT ON time_entries
      WHEN EXISTS (SELECT 1 FROM tasks t WHERE t.id = NEW.task_id
        AND (t.archived_at IS NOT NULL OR t.owner_id IS NOT NEW.owner_id))
      BEGIN
        SELECT RAISE(ABORT, 'time entry task is archived or belongs to another owner');
      END;
      CREATE TRIGGER time_entries_archived_update
      BEFORE UPDATE ON time_entries
      WHEN EXISTS (SELECT 1 FROM tasks t WHERE t.id IN (OLD.task_id, NEW.task_id)
        AND t.archived_at IS NOT NULL)
        OR NEW.task_id IS NOT OLD.task_id OR NEW.owner_id IS NOT OLD.owner_id
        OR NEW.source IS NOT OLD.source
      BEGIN
        SELECT RAISE(ABORT, 'archived task time is read-only');
      END;
      CREATE TRIGGER time_entries_archived_delete
      BEFORE DELETE ON time_entries
      WHEN EXISTS (SELECT 1 FROM tasks t WHERE t.id = OLD.task_id
        AND t.archived_at IS NOT NULL)
      BEGIN
        SELECT RAISE(ABORT, 'archived task time is read-only');
      END;
      CREATE TABLE time_work_context_days (
        owner_id TEXT NOT NULL REFERENCES owner_accounts(id) ON DELETE CASCADE,
        source_kind TEXT NOT NULL CHECK (source_kind IN ('super_productivity')),
        context_kind TEXT NOT NULL CHECK (context_kind IN ('project','tag','today')),
        source_context_id TEXT NOT NULL CHECK (length(source_context_id) BETWEEN 1 AND 200),
        project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
        tag_id TEXT REFERENCES tags(id) ON DELETE SET NULL,
        work_date TEXT NOT NULL CHECK (length(work_date) = 10
          AND date(work_date) IS work_date),
        started_at TEXT,
        ended_at TEXT,
        break_count INTEGER CHECK (break_count >= 0),
        break_ms INTEGER CHECK (break_ms >= 0),
        source_store TEXT NOT NULL
          CHECK (source_store IN ('timeTracking','archiveYoung','archiveOld')),
        imported_at TEXT NOT NULL,
        PRIMARY KEY (owner_id, source_kind, context_kind, source_context_id, work_date)
      ) STRICT;
      CREATE INDEX time_work_context_days_by_day
        ON time_work_context_days(owner_id, work_date);
    `,
};

export interface TimeEntryImportProvenance {
  readonly source: "super_productivity";
  readonly kind: "task_day" | "parent_residual";
  readonly sourceTaskId: string;
  readonly sourceWorkDate: string;
  readonly sourceStore: "task" | "archiveYoung" | "archiveOld";
}

export interface TimeEntryRecord {
  readonly id: string;
  readonly ownerId: string;
  readonly taskId: string;
  readonly workDate: string;
  readonly durationMs: number;
  readonly source: "import" | "manual";
  readonly note: string;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly provenance: TimeEntryImportProvenance | null;
}

/** A focus interval's part on one owner-zone day; read-only. */
export interface FocusEntryRecord {
  readonly id: string;
  readonly taskId: string;
  readonly workDate: string;
  readonly durationMs: number;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly running: boolean;
}

export interface ImportedTimeEntry {
  readonly workDate: string;
  readonly durationMs: number;
  readonly kind: TimeEntryImportProvenance["kind"];
  readonly sourceTaskId: string;
  readonly sourceStore: TimeEntryImportProvenance["sourceStore"];
}

export interface ImportedWorkContextDay {
  readonly contextKind: "project" | "tag" | "today";
  readonly sourceContextId: string;
  readonly projectId: string | null;
  readonly tagId: string | null;
  readonly workDate: string;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly breakCount: number | null;
  readonly breakMs: number | null;
  readonly sourceStore: "timeTracking" | "archiveYoung" | "archiveOld";
}

export type TimeEntryWriteResult =
  | {
      readonly kind: "applied" | "replayed";
      readonly entry: TimeEntryRecord | null;
      readonly deletedId: string | null;
      readonly dayTotalMs: number;
    }
  | { readonly kind: "not-found" }
  | { readonly kind: "precondition-failed"; readonly entry: TimeEntryRecord }
  | { readonly kind: "exists" }
  | { readonly kind: "invalid"; readonly code: TimeEntryViolation };

type BySource = Record<"focus" | "import" | "manual", number>;

export interface TimeReportTaskRecord {
  readonly taskId: string;
  readonly title: string;
  readonly parentId: string | null;
  readonly projectId: string | null;
  readonly status: "open" | "completed";
  readonly archived: boolean;
  readonly estimateMinutes: number | null;
  readonly rollupEstimateMinutes: number | null;
  readonly ownMs: number;
  readonly childrenMs: number;
  readonly allTimeMs: number;
  readonly bySource: BySource;
}

export interface TimeReportRecord {
  readonly from: string;
  readonly to: string;
  readonly timeZone: string;
  readonly generatedAt: string;
  readonly totalMs: number;
  readonly bySource: BySource;
  readonly days: readonly {
    readonly date: string;
    readonly totalMs: number;
    readonly workStart: string | null;
    readonly workEnd: string | null;
    readonly breakCount: number | null;
    readonly breakMs: number | null;
    readonly tasks: readonly {
      readonly taskId: string;
      readonly totalMs: number;
      readonly bySource: BySource;
    }[];
  }[];
  readonly weeks: readonly {
    readonly weekStart: string;
    readonly totalMs: number;
    readonly daysWorked: number;
  }[];
  readonly tasks: readonly TimeReportTaskRecord[];
  readonly projects: readonly {
    readonly projectId: string | null;
    readonly title: string;
    readonly totalMs: number;
    readonly estimateMinutes: number | null;
  }[];
  readonly entries: readonly (TimeEntryRecord | FocusEntryRecord)[];
}

/**
 * Appends one sync feed change inside the caller's transaction (ADR 0050).
 * A deletion reports the revision the entry would have had next.
 */
export type TimeEntryChangeAppender = (
  ownerId: string,
  entryId: string,
  kind: "upsert" | "deleted",
  revision: number,
  now: string,
) => void;

export interface TimeEntryDependencies {
  readonly getTask: (
    ownerId: string,
    taskId: string,
    includeInactive?: boolean,
  ) => TaskRecord | undefined;
}

type Row = Record<string, string | number | null>;

const emptySources = (): BySource => ({ focus: 0, import: 0, manual: 0 });

const fromRow = (row: Row): TimeEntryRecord => ({
  id: String(row.id),
  ownerId: String(row.owner_id),
  taskId: String(row.task_id),
  workDate: String(row.work_date),
  durationMs: Number(row.duration_ms),
  source: row.source === "import" ? "import" : "manual",
  note: String(row.note),
  revision: Number(row.revision),
  createdAt: String(row.created_at),
  updatedAt: String(row.updated_at),
  provenance:
    row.source === "import"
      ? {
          source: "super_productivity",
          kind:
            row.import_kind === "parent_residual"
              ? "parent_residual"
              : "task_day",
          sourceTaskId: String(row.source_task_id),
          sourceWorkDate: String(row.source_work_date),
          sourceStore: String(
            row.source_store,
          ) as TimeEntryImportProvenance["sourceStore"],
        }
      : null,
});

const add = (map: Map<string, number>, key: string, value: number) =>
  map.set(key, (map.get(key) ?? 0) + value);

export class SqliteTimeEntryStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly deps: TimeEntryDependencies,
    private readonly appendChange: TimeEntryChangeAppender,
  ) {}

  /**
   * ADR 0050: the stored entries a sync snapshot carries, those dated on or
   * after `from`. Entries of soft-deleted tasks are included; a client hides
   * them by the task it caches, and a restore brings them back.
   */
  listSince(ownerId: string, from: string): readonly TimeEntryRecord[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM time_entries WHERE owner_id=? AND work_date >= ?
           ORDER BY work_date, created_at, id`,
        )
        .all(ownerId, from) as Row[]
    ).map(fromRow);
  }

  get(ownerId: string, id: string): TimeEntryRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM time_entries WHERE owner_id=? AND id=?")
      .get(ownerId, id) as Row | undefined;
    return row === undefined ? undefined : fromRow(row);
  }

  /** Whether the ID names one of the owner's focus intervals. */
  isFocusInterval(ownerId: string, id: string): boolean {
    return (
      this.db
        .prepare(
          `SELECT 1 FROM active_session_intervals i JOIN active_sessions s ON s.id = i.session_id
           WHERE s.owner_id=? AND i.id=? AND i.phase='focus'`,
        )
        .get(ownerId, id) !== undefined
    );
  }

  /**
   * Adds a manual entry. The client supplies the UUID, so a retry with the
   * same content replays instead of adding the time twice.
   */
  create(input: {
    readonly ownerId: string;
    readonly id: string;
    readonly taskId: string;
    readonly workDate: string;
    readonly durationMs: number;
    readonly note: string;
    readonly timeZone: string;
    readonly now: string;
  }): TimeEntryWriteResult {
    return this.#transaction("time_entry_create", () => {
      const existing = this.db
        .prepare("SELECT * FROM time_entries WHERE id=?")
        .get(input.id) as Row | undefined;
      if (existing !== undefined) {
        const entry = fromRow(existing);
        return entry.ownerId === input.ownerId &&
          entry.source === "manual" &&
          entry.taskId === input.taskId &&
          entry.workDate === input.workDate &&
          entry.durationMs === input.durationMs &&
          entry.note === input.note
          ? {
              kind: "replayed",
              entry,
              deletedId: null,
              dayTotalMs: this.dayTotal(
                input.ownerId,
                entry.taskId,
                entry.workDate,
                input.timeZone,
                input.now,
              ).totalMs,
            }
          : { kind: "exists" };
      }
      const day = this.dayTotal(
        input.ownerId,
        input.taskId,
        input.workDate,
        input.timeZone,
        input.now,
      );
      const violation = validateTimeEntryWrite({
        task: this.deps.getTask(input.ownerId, input.taskId, true),
        source: "manual",
        durationMs: input.durationMs,
        days: [
          {
            before: day.totalMs,
            after: day.totalMs + input.durationMs,
            focusRunning: day.focusRunning,
          },
        ],
      });
      if (violation !== null) return { kind: "invalid", code: violation };
      this.db
        .prepare(
          `INSERT INTO time_entries (id,owner_id,task_id,work_date,duration_ms,source,note,revision,created_at,updated_at)
           VALUES (?,?,?,?,?,'manual',?,1,?,?)`,
        )
        .run(
          input.id,
          input.ownerId,
          input.taskId,
          input.workDate,
          input.durationMs,
          input.note,
          input.now,
          input.now,
        );
      this.appendChange(input.ownerId, input.id, "upsert", 1, input.now);
      return {
        kind: "applied",
        entry: this.#required(input.ownerId, input.id),
        deletedId: null,
        dayTotalMs: day.totalMs + input.durationMs,
      };
    });
  }

  /** Edits an import or manual entry at its current revision. */
  update(input: {
    readonly ownerId: string;
    readonly id: string;
    readonly expectedRevision: number;
    readonly patch: {
      readonly workDate?: string | undefined;
      readonly durationMs?: number | undefined;
      readonly note?: string | undefined;
    };
    readonly timeZone: string;
    readonly now: string;
  }): TimeEntryWriteResult {
    return this.#transaction("time_entry_update", () => {
      const entry = this.get(input.ownerId, input.id);
      if (entry === undefined)
        return this.isFocusInterval(input.ownerId, input.id)
          ? { kind: "invalid", code: "entry_read_only" }
          : { kind: "not-found" };
      if (entry.revision !== input.expectedRevision)
        return { kind: "precondition-failed", entry };
      const workDate = input.patch.workDate ?? entry.workDate;
      const durationMs = input.patch.durationMs ?? entry.durationMs;
      const note = input.patch.note ?? entry.note;
      const oldDay = this.dayTotal(
        input.ownerId,
        entry.taskId,
        entry.workDate,
        input.timeZone,
        input.now,
      );
      const days =
        workDate === entry.workDate
          ? [
              {
                before: oldDay.totalMs,
                after: oldDay.totalMs - entry.durationMs + durationMs,
                focusRunning: oldDay.focusRunning,
              },
            ]
          : (() => {
              const newDay = this.dayTotal(
                input.ownerId,
                entry.taskId,
                workDate,
                input.timeZone,
                input.now,
              );
              return [
                {
                  before: oldDay.totalMs,
                  after: oldDay.totalMs - entry.durationMs,
                  focusRunning: oldDay.focusRunning,
                },
                {
                  before: newDay.totalMs,
                  after: newDay.totalMs + durationMs,
                  focusRunning: newDay.focusRunning,
                },
              ];
            })();
      const violation = validateTimeEntryWrite({
        task: this.deps.getTask(input.ownerId, entry.taskId, true),
        source: entry.source,
        durationMs,
        days,
      });
      if (violation !== null) return { kind: "invalid", code: violation };
      const changed = this.db
        .prepare(
          `UPDATE time_entries SET work_date=?,duration_ms=?,note=?,revision=revision+1,updated_at=?
           WHERE owner_id=? AND id=? AND revision=?`,
        )
        .run(
          workDate,
          durationMs,
          note,
          input.now,
          input.ownerId,
          input.id,
          input.expectedRevision,
        ).changes;
      if (changed !== 1) throw new Error("Conditional time entry update lost");
      this.appendChange(
        input.ownerId,
        input.id,
        "upsert",
        input.expectedRevision + 1,
        input.now,
      );
      return {
        kind: "applied",
        entry: this.#required(input.ownerId, input.id),
        deletedId: null,
        dayTotalMs: days.at(-1)?.after ?? 0,
      };
    });
  }

  /** Permanently removes an import or manual entry at its current revision. */
  delete(input: {
    readonly ownerId: string;
    readonly id: string;
    readonly expectedRevision: number;
    readonly timeZone: string;
    readonly now: string;
  }): TimeEntryWriteResult {
    return this.#transaction("time_entry_delete", () => {
      const entry = this.get(input.ownerId, input.id);
      if (entry === undefined)
        return this.isFocusInterval(input.ownerId, input.id)
          ? { kind: "invalid", code: "entry_read_only" }
          : { kind: "not-found" };
      if (entry.revision !== input.expectedRevision)
        return { kind: "precondition-failed", entry };
      const day = this.dayTotal(
        input.ownerId,
        entry.taskId,
        entry.workDate,
        input.timeZone,
        input.now,
      );
      const after = day.totalMs - entry.durationMs;
      const violation = validateTimeEntryWrite({
        task: this.deps.getTask(input.ownerId, entry.taskId, true),
        source: entry.source,
        durationMs: null,
        days: [{ before: day.totalMs, after, focusRunning: day.focusRunning }],
      });
      if (violation !== null) return { kind: "invalid", code: violation };
      const changed = this.db
        .prepare(
          "DELETE FROM time_entries WHERE owner_id=? AND id=? AND revision=?",
        )
        .run(input.ownerId, input.id, input.expectedRevision).changes;
      if (changed !== 1) throw new Error("Conditional time entry delete lost");
      this.appendChange(
        input.ownerId,
        input.id,
        "deleted",
        input.expectedRevision + 1,
        input.now,
      );
      return {
        kind: "applied",
        entry: null,
        deletedId: input.id,
        dayTotalMs: after,
      };
    });
  }

  /** Every source for one task and owner-zone day, including running focus. */
  dayTotal(
    ownerId: string,
    taskId: string,
    workDate: string,
    timeZone: string,
    now: string,
  ): { readonly totalMs: number; readonly focusRunning: boolean } {
    const stored = this.db
      .prepare(
        "SELECT COALESCE(SUM(duration_ms),0) AS total FROM time_entries WHERE owner_id=? AND task_id=? AND work_date=?",
      )
      .get(ownerId, taskId, workDate) as { total: number };
    const focus = this.#focusSegments(
      ownerId,
      workDate,
      workDate,
      timeZone,
      now,
      [taskId],
    );
    return {
      totalMs:
        stored.total +
        focus.reduce((sum, segment) => sum + segment.durationMs, 0),
      focusRunning: focus.some((segment) => segment.running),
    };
  }

  /**
   * Worklog for an inclusive range of owner-zone days. Soft-deleted tasks
   * are left out; archived history is included. Each entry counts once: a
   * child's time belongs to the child and appears in its parent's
   * `childrenMs`, never in the parent's own time.
   */
  report(input: {
    readonly ownerId: string;
    readonly from: string;
    readonly to: string;
    readonly timeZone: string;
    readonly now: string;
  }): TimeReportRecord {
    const { ownerId } = input;
    const stored = (
      this.db
        .prepare(
          `SELECT e.* FROM time_entries e JOIN tasks t ON t.id = e.task_id
           WHERE e.owner_id=? AND e.work_date BETWEEN ? AND ? AND t.deleted_at IS NULL
           ORDER BY e.work_date, e.created_at, e.id`,
        )
        .all(ownerId, input.from, input.to) as Row[]
    ).map(fromRow);
    const focus = this.#focusSegments(
      ownerId,
      input.from,
      input.to,
      input.timeZone,
      input.now,
    );
    const entries: (TimeEntryRecord | FocusEntryRecord)[] = [
      ...stored,
      ...focus,
    ].toSorted(
      (left, right) =>
        left.workDate.localeCompare(right.workDate) ||
        left.taskId.localeCompare(right.taskId) ||
        left.id.localeCompare(right.id),
    );
    const sourceOf = (entry: TimeEntryRecord | FocusEntryRecord) =>
      "source" in entry ? entry.source : "focus";
    const own = new Map<string, number>();
    const ownBySource = new Map<string, BySource>();
    const byDay = new Map<string, Map<string, BySource>>();
    const bySource = emptySources();
    for (const entry of entries) {
      const source = sourceOf(entry);
      add(own, entry.taskId, entry.durationMs);
      const taskSources = ownBySource.get(entry.taskId) ?? emptySources();
      taskSources[source] += entry.durationMs;
      ownBySource.set(entry.taskId, taskSources);
      bySource[source] += entry.durationMs;
      const day = byDay.get(entry.workDate) ?? new Map<string, BySource>();
      const daySources = day.get(entry.taskId) ?? emptySources();
      daySources[source] += entry.durationMs;
      day.set(entry.taskId, daySources);
      byDay.set(entry.workDate, day);
    }
    const infoRows = (ids: readonly string[]) =>
      ids.length === 0
        ? []
        : (this.db
            .prepare(
              `SELECT id,title,parent_id,project_id,status,archived_at,estimate_minutes FROM tasks
               WHERE owner_id=? AND id IN (SELECT value FROM json_each(?))`,
            )
            .all(ownerId, JSON.stringify(ids)) as Row[]);
    const info = new Map<string, Row>();
    for (const row of infoRows([...own.keys()])) info.set(String(row.id), row);
    const parentIds = [
      ...new Set(
        [...info.values()].flatMap((row) =>
          row.parent_id === null ? [] : [String(row.parent_id)],
        ),
      ),
    ].filter((id) => !info.has(id));
    for (const row of infoRows(parentIds)) info.set(String(row.id), row);
    const childrenOf = new Map<string, string[]>();
    const listedIds = [...info.keys()];
    const children =
      listedIds.length === 0
        ? []
        : (this.db
            .prepare(
              `SELECT id,parent_id,estimate_minutes FROM tasks
             WHERE owner_id=? AND deleted_at IS NULL AND parent_id IN (SELECT value FROM json_each(?))`,
            )
            .all(ownerId, JSON.stringify(listedIds)) as Row[]);
    const childEstimate = new Map<string, number>();
    for (const child of children) {
      const parent = String(child.parent_id);
      childrenOf.set(parent, [
        ...(childrenOf.get(parent) ?? []),
        String(child.id),
      ]);
      if (child.estimate_minutes !== null)
        add(childEstimate, parent, Number(child.estimate_minutes));
    }
    const allTime = this.#allTime(
      ownerId,
      [
        ...new Set([
          ...listedIds,
          ...children.map((child) => String(child.id)),
        ]),
      ],
      input.now,
    );
    const tasks: TimeReportTaskRecord[] = [...info.entries()].map(
      ([taskId, row]) => {
        const kids = childrenOf.get(taskId) ?? [];
        const estimate =
          row.estimate_minutes === null ? null : Number(row.estimate_minutes);
        const rollup =
          estimate === null && !childEstimate.has(taskId)
            ? null
            : (estimate ?? 0) + (childEstimate.get(taskId) ?? 0);
        return {
          taskId,
          title: String(row.title),
          parentId: row.parent_id === null ? null : String(row.parent_id),
          projectId: row.project_id === null ? null : String(row.project_id),
          status: row.status === "completed" ? "completed" : "open",
          archived: row.archived_at !== null,
          estimateMinutes: estimate,
          rollupEstimateMinutes: kids.length === 0 ? estimate : rollup,
          ownMs: own.get(taskId) ?? 0,
          childrenMs: kids.reduce((sum, id) => sum + (own.get(id) ?? 0), 0),
          allTimeMs:
            (allTime.get(taskId) ?? 0) +
            kids.reduce((sum, id) => sum + (allTime.get(id) ?? 0), 0),
          bySource: ownBySource.get(taskId) ?? emptySources(),
        };
      },
    );
    tasks.sort(
      (left, right) =>
        right.ownMs + right.childrenMs - (left.ownMs + left.childrenMs) ||
        left.title.localeCompare(right.title) ||
        left.taskId.localeCompare(right.taskId),
    );
    const projectTime = new Map<string, number>();
    const projectEstimate = new Map<string, number>();
    for (const task of tasks) {
      if (task.ownMs === 0) continue;
      const key = task.projectId ?? "";
      add(projectTime, key, task.ownMs);
      if (task.estimateMinutes !== null)
        add(projectEstimate, key, task.estimateMinutes);
    }
    const projectTitles = new Map(
      (
        this.db
          .prepare(
            "SELECT id,title FROM projects WHERE owner_id=? AND id IN (SELECT value FROM json_each(?))",
          )
          .all(
            ownerId,
            JSON.stringify([...projectTime.keys()].filter((key) => key !== "")),
          ) as Row[]
      ).map((row) => [String(row.id), String(row.title)]),
    );
    const projects = [...projectTime.entries()]
      .map(([key, totalMs]) => ({
        projectId: key === "" ? null : key,
        title: key === "" ? "No project" : (projectTitles.get(key) ?? key),
        totalMs,
        estimateMinutes: projectEstimate.get(key) ?? null,
      }))
      .toSorted(
        (left, right) =>
          right.totalMs - left.totalMs || left.title.localeCompare(right.title),
      );
    const contexts = this.#workContexts(ownerId, input.from, input.to);
    const days = [...byDay.entries()]
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([date, perTask]) => {
        const dayTasks = [...perTask.entries()]
          .map(([taskId, sources]) => ({
            taskId,
            totalMs: sources.focus + sources.import + sources.manual,
            bySource: sources,
          }))
          .toSorted(
            (left, right) =>
              right.totalMs - left.totalMs ||
              left.taskId.localeCompare(right.taskId),
          );
        return {
          date,
          totalMs: dayTasks.reduce((sum, task) => sum + task.totalMs, 0),
          ...(contexts.get(date) ?? {
            workStart: null,
            workEnd: null,
            breakCount: null,
            breakMs: null,
          }),
          tasks: dayTasks,
        };
      });
    const weeks = new Map<string, { totalMs: number; daysWorked: number }>();
    for (const day of days) {
      const week = weekStartOf(day.date);
      const current = weeks.get(week) ?? { totalMs: 0, daysWorked: 0 };
      weeks.set(week, {
        totalMs: current.totalMs + day.totalMs,
        daysWorked: current.daysWorked + (day.totalMs > 0 ? 1 : 0),
      });
    }
    return {
      from: input.from,
      to: input.to,
      timeZone: input.timeZone,
      generatedAt: input.now,
      totalMs: bySource.focus + bySource.import + bySource.manual,
      bySource,
      days,
      weeks: [...weeks.entries()]
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([weekStart, week]) => ({ weekStart, ...week })),
      tasks,
      projects,
      entries,
    };
  }

  /**
   * Import helper; runs inside the caller's transaction for a newly created
   * task, before the task is marked archived. Each entry is announced in the
   * sync feed (ADR 0050).
   */
  insertImported(
    ownerId: string,
    taskId: string,
    entries: readonly ImportedTimeEntry[],
    newId: () => string,
    now: string,
  ): void {
    const insert = this.db.prepare(
      `INSERT INTO time_entries (id,owner_id,task_id,work_date,duration_ms,source,note,revision,created_at,updated_at,
         source_kind,import_kind,source_task_id,source_work_date,source_store)
       VALUES (?,?,?,?,?,'import','',1,?,?,'super_productivity',?,?,?,?)`,
    );
    for (const entry of entries) {
      const id = newId();
      insert.run(
        id,
        ownerId,
        taskId,
        entry.workDate,
        entry.durationMs,
        now,
        now,
        entry.kind,
        entry.sourceTaskId,
        entry.workDate,
        entry.sourceStore,
      );
      this.appendChange(ownerId, id, "upsert", 1, now);
    }
  }

  /**
   * Import helper; runs inside the caller's transaction. A replayed identical
   * day is kept; a changed one aborts the import, as a changed task does.
   */
  importWorkContexts(
    ownerId: string,
    rows: readonly ImportedWorkContextDay[],
    now: string,
  ): { readonly created: number; readonly existing: number } {
    let created = 0;
    let existing = 0;
    const find = this.db.prepare(
      `SELECT * FROM time_work_context_days WHERE owner_id=? AND source_kind='super_productivity'
         AND context_kind=? AND source_context_id=? AND work_date=?`,
    );
    const insert = this.db.prepare(
      `INSERT INTO time_work_context_days (owner_id,source_kind,context_kind,source_context_id,project_id,tag_id,
         work_date,started_at,ended_at,break_count,break_ms,source_store,imported_at)
       VALUES (?,'super_productivity',?,?,?,?,?,?,?,?,?,?,?)`,
    );
    for (const row of rows) {
      const prior = find.get(
        ownerId,
        row.contextKind,
        row.sourceContextId,
        row.workDate,
      ) as Row | undefined;
      if (prior !== undefined) {
        if (
          prior.started_at !== row.startedAt ||
          prior.ended_at !== row.endedAt ||
          prior.break_count !== row.breakCount ||
          prior.break_ms !== row.breakMs
        )
          throw new Error("IMPORT_SOURCE_CHANGED");
        existing++;
        continue;
      }
      insert.run(
        ownerId,
        row.contextKind,
        row.sourceContextId,
        row.projectId,
        row.tagId,
        row.workDate,
        row.startedAt,
        row.endedAt,
        row.breakCount,
        row.breakMs,
        row.sourceStore,
        now,
      );
      created++;
    }
    return { created, existing };
  }

  /**
   * Imported day start/end and breaks. The Today context covers all work of
   * the day in the source, so it wins; otherwise the earliest start, latest
   * end and largest break record of the day's project and tag contexts.
   */
  #workContexts(ownerId: string, from: string, to: string) {
    const rows = this.db
      .prepare(
        `SELECT work_date, context_kind, started_at, ended_at, break_count, break_ms
         FROM time_work_context_days WHERE owner_id=? AND work_date BETWEEN ? AND ?
         ORDER BY work_date, context_kind, source_context_id`,
      )
      .all(ownerId, from, to) as Row[];
    const byDate = new Map<string, Row[]>();
    for (const row of rows) {
      const date = String(row.work_date);
      byDate.set(date, [...(byDate.get(date) ?? []), row]);
    }
    const result = new Map<
      string,
      {
        workStart: string | null;
        workEnd: string | null;
        breakCount: number | null;
        breakMs: number | null;
      }
    >();
    const text = (values: readonly unknown[]) =>
      values.filter((value): value is string => typeof value === "string");
    const numbers = (values: readonly unknown[]) =>
      values.filter((value): value is number => typeof value === "number");
    for (const [date, dayRows] of byDate) {
      const today = dayRows.filter((row) => row.context_kind === "today");
      const chosen = today.length > 0 ? today : dayRows;
      const starts = text(chosen.map((row) => row.started_at)).toSorted();
      const ends = text(chosen.map((row) => row.ended_at)).toSorted();
      const counts = numbers(chosen.map((row) => row.break_count));
      const breaks = numbers(chosen.map((row) => row.break_ms));
      result.set(date, {
        workStart: starts[0] ?? null,
        workEnd: ends.at(-1) ?? null,
        breakCount: counts.length === 0 ? null : Math.max(...counts),
        breakMs: breaks.length === 0 ? null : Math.max(...breaks),
      });
    }
    return result;
  }

  /** Own time across all dates for each task: stored entries and focus. */
  #allTime(
    ownerId: string,
    taskIds: readonly string[],
    now: string,
  ): Map<string, number> {
    const totals = new Map<string, number>();
    if (taskIds.length === 0) return totals;
    const ids = JSON.stringify(taskIds);
    for (const row of this.db
      .prepare(
        `SELECT task_id, SUM(duration_ms) AS total FROM time_entries
         WHERE owner_id=? AND task_id IN (SELECT value FROM json_each(?)) GROUP BY task_id`,
      )
      .all(ownerId, ids) as Row[])
      add(totals, String(row.task_id), Number(row.total));
    for (const interval of this.#intervals(ownerId, now, taskIds))
      add(totals, interval.taskId, interval.end - interval.start);
    return totals;
  }

  /**
   * Focus intervals with their effective end: a running interval counts up
   * to now, but never past its controller lease, where observation would
   * expire it.
   */
  #intervals(
    ownerId: string,
    now: string,
    taskIds?: readonly string[],
    window?: { readonly from: string; readonly to: string },
  ) {
    const rows = this.db
      .prepare(
        `SELECT i.id, i.task_id, i.started_at, i.ended_at, s.state, s.lease_expires_at
         FROM active_session_intervals i JOIN active_sessions s ON s.id = i.session_id
         JOIN tasks t ON t.id = i.task_id
         WHERE s.owner_id=? AND i.phase='focus' AND t.deleted_at IS NULL
           AND (? IS NULL OR i.task_id IN (SELECT value FROM json_each(?)))
           AND (? IS NULL OR (i.started_at < ? AND (i.ended_at IS NULL OR i.ended_at > ?)))`,
      )
      .all(
        ownerId,
        taskIds === undefined ? null : 1,
        JSON.stringify(taskIds ?? []),
        window === undefined ? null : 1,
        window?.to ?? "",
        window?.from ?? "",
      ) as Row[];
    const current = Date.parse(now);
    return rows.flatMap((row) => {
      const start = Date.parse(String(row.started_at));
      const lease =
        row.lease_expires_at === null
          ? current
          : Date.parse(String(row.lease_expires_at));
      const open = row.ended_at === null;
      const end = open
        ? Math.min(current, row.state === "running" ? lease : current)
        : Date.parse(String(row.ended_at));
      if (end <= start) return [];
      return [
        {
          id: String(row.id),
          taskId: String(row.task_id),
          start,
          end,
          running: open && row.state === "running" && lease > current,
        },
      ];
    });
  }

  #focusSegments(
    ownerId: string,
    from: string,
    to: string,
    timeZone: string,
    now: string,
    taskIds?: readonly string[],
  ): FocusEntryRecord[] {
    const window = {
      from: plannedDayWindow(from, timeZone).from,
      to: plannedDayWindow(to, timeZone).to,
    };
    return this.#intervals(ownerId, now, taskIds, window).flatMap((interval) =>
      splitIntervalByDay(
        new Date(interval.start).toISOString(),
        new Date(interval.end).toISOString(),
        timeZone,
      )
        .filter((segment) => segment.workDate >= from && segment.workDate <= to)
        .map((segment) => ({
          id: interval.id,
          taskId: interval.taskId,
          workDate: segment.workDate,
          durationMs: segment.durationMs,
          startedAt: segment.startedAt,
          endedAt: segment.endedAt,
          running:
            interval.running &&
            segment.endedAt === new Date(interval.end).toISOString(),
        })),
    );
  }

  #required(ownerId: string, id: string): TimeEntryRecord {
    const entry = this.get(ownerId, id);
    if (entry === undefined) throw new Error("Time entry disappeared");
    return entry;
  }

  #transaction(
    name: string,
    body: () => TimeEntryWriteResult,
  ): TimeEntryWriteResult {
    this.db.exec(`SAVEPOINT ${name};`);
    try {
      const result = body();
      this.db.exec(`RELEASE SAVEPOINT ${name};`);
      return result;
    } catch (error) {
      this.db.exec(`ROLLBACK TO SAVEPOINT ${name}; RELEASE SAVEPOINT ${name};`);
      throw error;
    }
  }
}
