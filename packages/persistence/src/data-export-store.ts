import { randomUUID } from "node:crypto";
import type { DatabaseSync, SQLOutputValue, StatementSync } from "node:sqlite";
import {
  dataExportFormat,
  dataExportVersion,
  type DataExportDocument,
  type DataExportRow,
  type DataRestoreIssue,
  type DataRestoreMode,
  type DataRestorePreview,
} from "@suite/contracts";

/**
 * Owner data export and restore (issue #93, ADR 0034).
 *
 * The export is a table-level copy of the owner's rows. `inventory` lists
 * every table with a disposition; the test compares it with `sqlite_master`
 * so a new migration cannot add a table silently. Restore inserts rows in
 * inventory order inside one transaction with deferred foreign keys, rewrites
 * `owner_id` to the target owner and writes the two trigger-guarded columns
 * (`tasks.archived_at`, `counters.deleted_at`) after every row exists.
 */

interface TableSpec {
  readonly table: string;
  /** `owner`: the table has an `owner_id` column; otherwise join `column` to the parent's `id`. */
  readonly scope:
    "owner" | { readonly column: string; readonly parent: string };
  /** Per-owner singleton rows; replaced in both modes and not counted as content. */
  readonly singleton?: boolean;
  /** Columns written after every row exists because insert triggers inspect them. */
  readonly deferred?: readonly string[];
  /** Restore ordering inside the table when an insert trigger needs it. */
  readonly sort?: (left: DataExportRow, right: DataExportRow) => number;
}

const parentsFirst = (left: DataExportRow, right: DataExportRow): number =>
  Number(left.parent_id !== null) - Number(right.parent_id !== null);

const owner = (table: string, extra: Partial<TableSpec> = {}): TableSpec => ({
  table,
  scope: "owner",
  ...extra,
});
const via = (table: string, column: string, parent: string): TableSpec => ({
  table,
  scope: { column, parent },
});

/** Included tables in restore (dependency) order. */
export const dataExportInventory: readonly TableSpec[] = [
  owner("owner_planning_preferences", { singleton: true }),
  owner("owner_notification_preferences", { singleton: true }),
  owner("owner_preference_revisions", { singleton: true }),
  owner("owner_focus_preferences", { singleton: true }),
  owner("owner_focus_reminder_state", { singleton: true }),
  owner("owner_application_preferences", { singleton: true }),
  owner("owner_capture_preferences", { singleton: true }),
  owner("projects"),
  owner("tags"),
  owner("tasks", { deferred: ["archived_at"], sort: parentsFirst }),
  via("task_tags", "task_id", "tasks"),
  via("task_field_versions", "task_id", "tasks"),
  owner("subtasks"),
  owner("project_backlog_tasks"),
  owner("notes"),
  owner("task_templates"),
  via("task_template_tags", "template_id", "task_templates"),
  via("template_subtask_blueprints", "template_id", "task_templates"),
  owner("template_sets"),
  via("template_set_members", "set_id", "template_sets"),
  owner("template_instantiations"),
  via("task_template_provenance", "task_id", "tasks"),
  owner("choice_pools"),
  via("choice_pool_items", "pool_id", "choice_pools"),
  via("template_pool_slots", "template_id", "task_templates"),
  owner("planning_placeholders"),
  via("choice_pool_history", "pool_id", "choice_pools"),
  owner("planning_placeholder_resolutions"),
  owner("habits"),
  via("habit_occurrences", "habit_id", "habits"),
  owner("task_import_sources"),
  owner("task_issue_links"),
  owner("task_attachments"),
  owner("task_archive_provenance"),
  owner("task_historical_references"),
  owner("recurring_series"),
  owner("recurring_occurrences"),
  owner("recurring_task_links"),
  owner("time_entries"),
  owner("time_work_context_days"),
  owner("counters", { deferred: ["deleted_at"] }),
  owner("counter_day_values"),
  owner("daily_evaluations"),
  owner("plugin_data_entries"),
  owner("plugin_metadata_records"),
  owner("day_orders"),
  owner("day_order_entries"),
  owner("boards"),
  owner("board_panels"),
  via("board_panel_tasks", "panel_id", "board_panels"),
  owner("task_board_markers"),
  owner("sections"),
  via("section_tasks", "section_id", "sections"),
  owner("task_views"),
  owner("menu_folders"),
  via("menu_folder_items", "folder_id", "menu_folders"),
  owner("notification_deliveries"),
];

/** Tables that never leave the database, with the reason in ADR 0034. */
export const dataExportExcludedTables: readonly string[] = [
  "schema_migrations",
  "install_metadata",
  "owner_accounts",
  "web_sessions",
  "client_identities",
  "automation_tokens",
  "automation_previews",
  "automation_operation_outcomes",
  "automation_audit_log",
  "baikal_connectors",
  "google_connectors",
  "google_oauth_states",
  "google_calendar_sync",
  "google_calendar_capabilities",
  "calendar_providers",
  "calendar_collections",
  "calendar_event_projections",
  "calendar_feed_capabilities",
  "calendar_import_jobs",
  "calendar_import_items",
  "calendar_write_operations",
  "task_calendar_blocks",
  "calendar_subscriptions",
  "calendar_subscription_events",
  "calendar_subscription_hidden_events",
  "calendar_subscription_conversions",
  "active_sessions",
  "active_session_intervals",
  "active_session_events",
  "active_session_operation_outcomes",
  "active_session_focus_plans",
  "active_session_idle_dispositions",
  "sync_owner_state",
  "sync_changes",
  "sync_operation_outcomes",
  "idempotency_records",
  "habit_operation_outcomes",
];

/** Owner-scoped runtime state cleared by a replace restore (not exported). */
const replaceClearedTables: readonly string[] = [
  "active_sessions",
  "sync_operation_outcomes",
  "idempotency_records",
  "habit_operation_outcomes",
];

export interface DataExportSource {
  readonly appVersion: string | null;
  readonly appRevision: string | null;
}

export type DataRestorePreviewRecord = Omit<DataRestorePreview, "inputHash">;

export interface DataRestoreOutcome {
  readonly mode: DataRestoreMode;
  readonly restored: readonly {
    readonly table: string;
    readonly rows: number;
  }[];
  readonly totalRows: number;
  readonly deletedRows: number;
  readonly restoredAt: string;
}

export class DataRestoreError extends Error {
  constructor(
    readonly code: "RESTORE_NOT_READY" | "RESTORE_TARGET_NOT_EMPTY",
    message: string,
  ) {
    super(message);
    this.name = "DataRestoreError";
  }
}

interface ColumnInfo {
  readonly name: string;
  readonly pk: number;
}

const cell = (value: SQLOutputValue): string | number | null => {
  if (value === null || typeof value === "string" || typeof value === "number")
    return value;
  if (typeof value === "bigint") return Number(value);
  throw new Error("Data export does not support binary columns");
};

const quote = (identifier: string): string => `"${identifier}"`;

export class SqliteDataExportStore {
  readonly #columns = new Map<string, readonly ColumnInfo[]>();

  constructor(private readonly db: DatabaseSync) {}

  /** Every table name in the database, for the inventory test. */
  tableNames(): readonly string[] {
    return (
      this.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all() as unknown as readonly { readonly name: string }[]
    ).map(({ name }) => name);
  }

  export(
    ownerId: string,
    now: string,
    source: DataExportSource,
  ): DataExportDocument {
    const account = this.db
      .prepare(
        "SELECT id, username, display_name, created_at FROM owner_accounts WHERE id=?",
      )
      .get(ownerId) as unknown as
      | {
          readonly id: string;
          readonly username: string;
          readonly display_name: string;
          readonly created_at: string;
        }
      | undefined;
    if (account === undefined) throw new Error("Owner not found");
    const install = this.db
      .prepare("SELECT instance_id FROM install_metadata WHERE singleton = 1")
      .get() as unknown as { readonly instance_id: string } | undefined;
    if (install === undefined) throw new Error("Installation metadata missing");
    const tables: Record<string, DataExportRow[]> = {};
    for (const spec of dataExportInventory) {
      const rows = this.db
        .prepare(this.#selectSql(spec))
        .all(ownerId) as unknown as readonly Record<string, SQLOutputValue>[];
      tables[spec.table] = rows.map((row) =>
        Object.fromEntries(
          Object.entries(row).map(([column, value]) => [column, cell(value)]),
        ),
      );
    }
    return {
      format: dataExportFormat,
      version: dataExportVersion,
      exportedAt: now,
      source: {
        instanceId: install.instance_id,
        migrationCount: this.#migrationCount(),
        appVersion: source.appVersion,
        appRevision: source.appRevision,
      },
      owner: {
        id: account.id,
        username: account.username,
        displayName: account.display_name,
        createdAt: account.created_at,
      },
      tables,
      excludedTables: [...dataExportExcludedTables],
    };
  }

  preview(
    ownerId: string,
    document: DataExportDocument,
  ): DataRestorePreviewRecord {
    const issues: DataRestoreIssue[] = [];
    const migrationCount = this.#migrationCount();
    if (document.source.migrationCount > migrationCount)
      issues.push({
        code: "NEWER_SCHEMA",
        detail: `The export was made with ${String(document.source.migrationCount)} migrations; this server has ${String(migrationCount)}. Update the server before restoring.`,
      });
    const included = new Set(dataExportInventory.map(({ table }) => table));
    const excluded = new Set(dataExportExcludedTables);
    for (const [table, rows] of Object.entries(document.tables)) {
      if (excluded.has(table)) {
        issues.push({
          code: "EXCLUDED_TABLE",
          detail: `${table} is never restored; remove it from the file.`,
        });
        continue;
      }
      if (!included.has(table)) {
        issues.push({
          code: "UNKNOWN_TABLE",
          detail: `${table} is not a Tadooer table on this server.`,
        });
        continue;
      }
      const known = new Set(this.#columnsOf(table).map(({ name }) => name));
      const unknown = new Set<string>();
      for (const row of rows)
        for (const column of Object.keys(row))
          if (!known.has(column)) unknown.add(column);
      for (const column of [...unknown].toSorted())
        issues.push({
          code: "UNKNOWN_COLUMN",
          detail: `${table}.${column} does not exist on this server.`,
        });
    }
    const counts = this.#counts(document);
    const target = this.#targetCounts(ownerId);
    const install = this.db
      .prepare("SELECT instance_id FROM install_metadata WHERE singleton = 1")
      .get() as unknown as { readonly instance_id: string } | undefined;
    return {
      exportedAt: document.exportedAt,
      source: document.source,
      owner: document.owner,
      sameOwner: document.owner.id === ownerId,
      sameInstance: install?.instance_id === document.source.instanceId,
      counts,
      totalRows: counts.reduce((sum, { rows }) => sum + rows, 0),
      target,
      issues,
      canApply: issues.length === 0,
    };
  }

  /**
   * Replaces or fills the owner's data from `document`. Throws
   * `DataRestoreError` when the preview has issues or the target has content
   * in `empty-only` mode; any other failure rolls back and rethrows.
   */
  restore(
    ownerId: string,
    document: DataExportDocument,
    mode: DataRestoreMode,
    now: string,
  ): DataRestoreOutcome {
    const preview = this.preview(ownerId, document);
    if (!preview.canApply)
      throw new DataRestoreError(
        "RESTORE_NOT_READY",
        preview.issues.map(({ detail }) => detail).join(" "),
      );
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      if (!this.#targetCounts(ownerId).empty && mode !== "replace")
        throw new DataRestoreError(
          "RESTORE_TARGET_NOT_EMPTY",
          "This account already has data. Choose replace to delete it before restoring.",
        );
      this.db.exec("PRAGMA defer_foreign_keys = ON;");
      const deletedRows =
        mode === "replace" ? this.#deleteOwnerData(ownerId) : 0;
      const restored: { table: string; rows: number }[] = [];
      const deferredWrites: (() => void)[] = [];
      for (const spec of dataExportInventory) {
        const rows = document.tables[spec.table] ?? [];
        const sorted =
          spec.sort === undefined ? rows : rows.toSorted(spec.sort);
        const statements = new Map<string, StatementSync>();
        for (const row of sorted) {
          const remapped: DataExportRow = { ...row };
          if ("owner_id" in remapped && remapped.owner_id === document.owner.id)
            remapped.owner_id = ownerId;
          const deferredValues: [string, string | number | null][] = [];
          for (const column of spec.deferred ?? []) {
            if (column in remapped && remapped[column] !== null) {
              deferredValues.push([column, remapped[column] ?? null]);
              remapped[column] = null;
            }
          }
          const columns = Object.keys(remapped);
          const signature = columns.join(",");
          let statement = statements.get(signature);
          if (statement === undefined) {
            statement = this.db.prepare(
              `INSERT ${spec.singleton ? "OR REPLACE " : ""}INTO ${quote(spec.table)} (${columns.map(quote).join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
            );
            statements.set(signature, statement);
          }
          statement.run(...columns.map((column) => remapped[column] ?? null));
          if (deferredValues.length > 0) {
            const keys = this.#columnsOf(spec.table)
              .filter(({ pk }) => pk > 0)
              .map(({ name }) => name);
            deferredWrites.push(() =>
              this.db
                .prepare(
                  `UPDATE ${quote(spec.table)} SET ${deferredValues.map(([column]) => `${quote(column)}=?`).join(",")} WHERE ${keys.map((key) => `${quote(key)}=?`).join(" AND ")}`,
                )
                .run(
                  ...deferredValues.map(([, value]) => value),
                  ...keys.map((key) => remapped[key] ?? null),
                ),
            );
          }
        }
        restored.push({ table: spec.table, rows: sorted.length });
      }
      for (const write of deferredWrites) write();
      this.#resetSyncEpoch(ownerId, now);
      this.db.exec("COMMIT;");
      return {
        mode,
        restored,
        totalRows: restored.reduce((sum, { rows }) => sum + rows, 0),
        deletedRows,
        restoredAt: now,
      };
    } catch (error: unknown) {
      this.db.exec("ROLLBACK;");
      throw error;
    }
  }

  #deleteOwnerData(ownerId: string): number {
    let deleted = 0;
    // Archived tasks are read-only and protect their time entries; clearing
    // the archive flag is allowed and lets the cascade run.
    this.db
      .prepare(
        "UPDATE tasks SET archived_at=NULL WHERE owner_id=? AND archived_at IS NOT NULL",
      )
      .run(ownerId);
    for (const table of replaceClearedTables)
      deleted += Number(
        this.db
          .prepare(`DELETE FROM ${quote(table)} WHERE owner_id=?`)
          .run(ownerId).changes,
      );
    for (const spec of dataExportInventory.toReversed()) {
      const sql =
        spec.scope === "owner"
          ? `DELETE FROM ${quote(spec.table)} WHERE owner_id=?`
          : `DELETE FROM ${quote(spec.table)} WHERE ${quote(spec.scope.column)} IN (SELECT id FROM ${quote(spec.scope.parent)} WHERE owner_id=?)`;
      deleted += Number(this.db.prepare(sql).run(ownerId).changes);
    }
    return deleted;
  }

  #resetSyncEpoch(ownerId: string, now: string): void {
    this.db.prepare("DELETE FROM sync_changes WHERE owner_id=?").run(ownerId);
    this.db
      .prepare("DELETE FROM sync_operation_outcomes WHERE owner_id=?")
      .run(ownerId);
    this.db
      .prepare(
        "INSERT INTO sync_owner_state (owner_id, epoch, next_sequence, updated_at) VALUES (?, ?, 1, ?) ON CONFLICT(owner_id) DO UPDATE SET epoch=excluded.epoch, next_sequence=1, updated_at=excluded.updated_at",
      )
      .run(ownerId, randomUUID(), now);
  }

  #counts(document: DataExportDocument) {
    return dataExportInventory
      .map(({ table }) => ({
        table,
        rows: document.tables[table]?.length ?? 0,
      }))
      .filter(({ rows }) => rows > 0);
  }

  #targetCounts(ownerId: string): DataRestorePreviewRecord["target"] {
    const counts: { table: string; rows: number }[] = [];
    let contentRows = 0;
    for (const spec of dataExportInventory) {
      const { count } = this.db
        .prepare(this.#selectSql(spec, true))
        .get(ownerId) as unknown as { readonly count: number };
      if (count === 0) continue;
      counts.push({ table: spec.table, rows: count });
      if (spec.singleton !== true) contentRows += count;
    }
    return {
      counts,
      totalRows: counts.reduce((sum, { rows }) => sum + rows, 0),
      empty: contentRows === 0,
    };
  }

  #migrationCount(): number {
    const { count } = this.db
      .prepare("SELECT COUNT(*) AS count FROM schema_migrations")
      .get() as unknown as { readonly count: number };
    return count;
  }

  #columnsOf(table: string): readonly ColumnInfo[] {
    let columns = this.#columns.get(table);
    if (columns === undefined) {
      columns = (
        this.db
          .prepare(`PRAGMA table_info(${quote(table)})`)
          .all() as unknown as readonly {
          readonly name: string;
          readonly pk: number;
        }[]
      ).map(({ name, pk }) => ({ name, pk }));
      this.#columns.set(table, columns);
    }
    return columns;
  }

  #selectSql(spec: TableSpec, countOnly = false): string {
    const keys = this.#columnsOf(spec.table)
      .filter(({ pk }) => pk > 0)
      .toSorted((left, right) => left.pk - right.pk)
      .map(({ name }) => `t.${quote(name)}`);
    const projection = countOnly ? "COUNT(*) AS count" : "t.*";
    const order =
      countOnly || keys.length === 0 ? "" : ` ORDER BY ${keys.join(", ")}`;
    return spec.scope === "owner"
      ? `SELECT ${projection} FROM ${quote(spec.table)} t WHERE t.owner_id=?${order}`
      : `SELECT ${projection} FROM ${quote(spec.table)} t JOIN ${quote(spec.scope.parent)} p ON p.id = t.${quote(spec.scope.column)} WHERE p.owner_id=?${order}`;
  }
}
