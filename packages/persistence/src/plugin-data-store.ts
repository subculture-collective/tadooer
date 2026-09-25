import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

/**
 * Imported plugin data (issue #66, docs/adr/0026-plugin-data-and-extensions.md).
 *
 * `plugin_data_entries` keeps Super Productivity `pluginUserData` values as
 * opaque text: Tadooer never decodes, parses, renders or runs them. The value
 * is stored as a JSON string literal (`data_json`) so every UTF-16 code unit,
 * including lone surrogates and NUL, survives SQLite's UTF-8 text storage.
 * `plugin_metadata_records` keeps each plugin's enabled flag as an inert
 * record; no plugin is installed, loaded or enabled by it.
 *
 * Both are online HTTP records, outside the sync change feed and the offline
 * cache. Import provenance lives in `task_import_sources` with a fingerprint
 * of the value, never the value itself, so a repeat import neither duplicates
 * nor restores an entry the owner deleted.
 */
export const pluginDataMigration = {
  id: "0030_plugin_data",
  sql: `
      CREATE TABLE plugin_data_entries (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL REFERENCES owner_accounts(id) ON DELETE CASCADE,
        plugin_id TEXT NOT NULL
          CHECK (length(plugin_id) BETWEEN 1 AND 200 AND instr(plugin_id, ':') = 0),
        data_key TEXT CHECK (data_key IS NULL OR length(data_key) BETWEEN 1 AND 256),
        data_json TEXT NOT NULL,
        byte_length INTEGER NOT NULL CHECK (byte_length BETWEEN 0 AND 1048576),
        format TEXT NOT NULL CHECK (format IN ('text','gzip_base64')),
        source_kind TEXT NOT NULL CHECK (source_kind IN ('super_productivity')),
        revision INTEGER NOT NULL CHECK (revision > 0),
        imported_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE UNIQUE INDEX plugin_data_entries_unkeyed
        ON plugin_data_entries(owner_id, plugin_id) WHERE data_key IS NULL;
      CREATE UNIQUE INDEX plugin_data_entries_keyed
        ON plugin_data_entries(owner_id, plugin_id, data_key) WHERE data_key IS NOT NULL;
      CREATE TABLE plugin_metadata_records (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL REFERENCES owner_accounts(id) ON DELETE CASCADE,
        plugin_id TEXT NOT NULL
          CHECK (length(plugin_id) BETWEEN 1 AND 200 AND instr(plugin_id, ':') = 0),
        enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
        source_kind TEXT NOT NULL CHECK (source_kind IN ('super_productivity')),
        revision INTEGER NOT NULL CHECK (revision > 0),
        imported_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE UNIQUE INDEX plugin_metadata_records_identity
        ON plugin_metadata_records(owner_id, plugin_id);
    `,
};

const maxDataBytes = 1024 * 1024;

export interface PluginDataEntryRecord {
  readonly id: string;
  readonly ownerId: string;
  readonly pluginId: string;
  readonly key: string | null;
  readonly byteLength: number;
  readonly format: "text" | "gzip_base64";
  readonly source: "super_productivity";
  readonly revision: number;
  readonly importedAt: string;
  readonly updatedAt: string;
}

export interface PluginMetadataRecord {
  readonly id: string;
  readonly ownerId: string;
  readonly pluginId: string;
  readonly enabled: boolean;
  readonly source: "super_productivity";
  readonly revision: number;
  readonly importedAt: string;
  readonly updatedAt: string;
}

/** One `pluginUserData` entry as mapped by the importer. */
export interface ImportedPluginDataEntry {
  /** The source entity ID: `pluginId` or `pluginId:key`. */
  readonly sourceId: string;
  readonly pluginId: string;
  readonly key: string | null;
  readonly data: string;
}

/** One `pluginMetadata` entry as mapped by the importer. */
export interface ImportedPluginMetadata {
  readonly pluginId: string;
  readonly enabled: boolean;
}

export type PluginDataDeleteResult = "deleted" | "conflict" | "not_found";

type Row = Record<string, string | number | null>;

const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");

const entryFromRow = (row: Row): PluginDataEntryRecord => ({
  id: String(row.id),
  ownerId: String(row.owner_id),
  pluginId: String(row.plugin_id),
  key: row.data_key === null ? null : String(row.data_key),
  byteLength: Number(row.byte_length),
  format: row.format === "gzip_base64" ? "gzip_base64" : "text",
  source: "super_productivity",
  revision: Number(row.revision),
  importedAt: String(row.imported_at),
  updatedAt: String(row.updated_at),
});

const metadataFromRow = (row: Row): PluginMetadataRecord => ({
  id: String(row.id),
  ownerId: String(row.owner_id),
  pluginId: String(row.plugin_id),
  enabled: Number(row.enabled) === 1,
  source: "super_productivity",
  revision: Number(row.revision),
  importedAt: String(row.imported_at),
  updatedAt: String(row.updated_at),
});

const entryColumns =
  "id,owner_id,plugin_id,data_key,byte_length,format,revision,imported_at,updated_at";

export class SqlitePluginDataStore {
  readonly #database: DatabaseSync;

  constructor(database: DatabaseSync) {
    this.#database = database;
  }

  /** Identity and size only; the listing never reads the data column. */
  list(ownerId: string): {
    readonly plugins: readonly PluginMetadataRecord[];
    readonly entries: readonly PluginDataEntryRecord[];
  } {
    return {
      plugins: (
        this.#database
          .prepare(
            "SELECT * FROM plugin_metadata_records WHERE owner_id=? ORDER BY plugin_id, id",
          )
          .all(ownerId) as unknown as Row[]
      ).map(metadataFromRow),
      entries: (
        this.#database
          .prepare(
            `SELECT ${entryColumns} FROM plugin_data_entries WHERE owner_id=? ORDER BY plugin_id, data_key IS NOT NULL, data_key, id`,
          )
          .all(ownerId) as unknown as Row[]
      ).map(entryFromRow),
    };
  }

  getEntry(ownerId: string, id: string): PluginDataEntryRecord | undefined {
    const row = this.#database
      .prepare(
        `SELECT ${entryColumns} FROM plugin_data_entries WHERE owner_id=? AND id=?`,
      )
      .get(ownerId, id) as Row | undefined;
    return row === undefined ? undefined : entryFromRow(row);
  }

  /** The owner's explicit read of one entry's opaque data. */
  readEntry(
    ownerId: string,
    id: string,
  ):
    | { readonly entry: PluginDataEntryRecord; readonly data: string }
    | undefined {
    const row = this.#database
      .prepare(
        `SELECT ${entryColumns},data_json FROM plugin_data_entries WHERE owner_id=? AND id=?`,
      )
      .get(ownerId, id) as Row | undefined;
    if (row === undefined) return undefined;
    const data: unknown = JSON.parse(String(row.data_json));
    if (typeof data !== "string")
      throw new Error("Stored plugin data is invalid");
    return { entry: entryFromRow(row), data };
  }

  deleteEntry(
    ownerId: string,
    id: string,
    expectedRevision: number,
  ): PluginDataDeleteResult {
    return this.#delete("plugin_data_entries", ownerId, id, expectedRevision);
  }

  deleteMetadata(
    ownerId: string,
    id: string,
    expectedRevision: number,
  ): PluginDataDeleteResult {
    return this.#delete(
      "plugin_metadata_records",
      ownerId,
      id,
      expectedRevision,
    );
  }

  /**
   * Writes imported entries and metadata inside the caller's transaction.
   * A source ID imported before is counted as existing, even when the owner
   * has since deleted its record; a changed value throws
   * IMPORT_SOURCE_CHANGED so the whole import rolls back.
   */
  importInTransaction(
    ownerId: string,
    input: {
      readonly entries: readonly ImportedPluginDataEntry[];
      readonly plugins: readonly ImportedPluginMetadata[];
    },
    newId: () => string,
    now: string,
  ): { created: number; existing: number } {
    let created = 0;
    let existing = 0;
    const prior = this.#database.prepare(
      "SELECT source_hash FROM task_import_sources WHERE owner_id=? AND source_kind='super_productivity' AND entity_kind=? AND source_id=?",
    );
    const provenance = this.#database.prepare(
      "INSERT INTO task_import_sources (owner_id,source_kind,entity_kind,source_id,target_id,source_hash,source_json,imported_at) VALUES (?,'super_productivity',?,?,?,?,?,?)",
    );
    const record = (
      entityKind: "plugin_user_data" | "plugin_metadata",
      sourceId: string,
      sourceJson: string,
      insert: (id: string) => void,
    ) => {
      const sourceHash = sha256(sourceJson);
      const before = prior.get(ownerId, entityKind, sourceId) as
        { source_hash: string } | undefined;
      if (before !== undefined) {
        if (before.source_hash !== sourceHash)
          throw new Error("IMPORT_SOURCE_CHANGED");
        existing++;
        return;
      }
      const id = newId();
      insert(id);
      provenance.run(
        ownerId,
        entityKind,
        sourceId,
        id,
        sourceHash,
        sourceJson,
        now,
      );
      created++;
    };
    const insertEntry = this.#database.prepare(
      "INSERT INTO plugin_data_entries (id,owner_id,plugin_id,data_key,data_json,byte_length,format,source_kind,revision,imported_at,updated_at) VALUES (?,?,?,?,?,?,?,'super_productivity',1,?,?)",
    );
    for (const entry of input.entries) {
      const dataJson = JSON.stringify(entry.data);
      const byteLength = Buffer.byteLength(entry.data, "utf8");
      if (byteLength > maxDataBytes)
        throw new Error("IMPORT_PLUGIN_DATA_TOO_LARGE");
      // Provenance names the entry and fingerprints the value; it never
      // copies the value.
      const sourceJson = JSON.stringify({
        id: entry.sourceId,
        bytes: byteLength,
        sha256: sha256(dataJson),
      });
      record("plugin_user_data", entry.sourceId, sourceJson, (id) => {
        insertEntry.run(
          id,
          ownerId,
          entry.pluginId,
          entry.key,
          dataJson,
          byteLength,
          entry.data.startsWith("GZ1:") ? "gzip_base64" : "text",
          now,
          now,
        );
      });
    }
    const insertMetadata = this.#database.prepare(
      "INSERT INTO plugin_metadata_records (id,owner_id,plugin_id,enabled,source_kind,revision,imported_at,updated_at) VALUES (?,?,?,?,'super_productivity',1,?,?)",
    );
    for (const plugin of input.plugins)
      record(
        "plugin_metadata",
        plugin.pluginId,
        JSON.stringify({ id: plugin.pluginId, isEnabled: plugin.enabled }),
        (id) => {
          insertMetadata.run(
            id,
            ownerId,
            plugin.pluginId,
            plugin.enabled ? 1 : 0,
            now,
            now,
          );
        },
      );
    return { created, existing };
  }

  #delete(
    table: "plugin_data_entries" | "plugin_metadata_records",
    ownerId: string,
    id: string,
    expectedRevision: number,
  ): PluginDataDeleteResult {
    const changed = this.#database
      .prepare(`DELETE FROM ${table} WHERE owner_id=? AND id=? AND revision=?`)
      .run(ownerId, id, expectedRevision).changes;
    if (changed === 1) return "deleted";
    return this.#database
      .prepare(`SELECT 1 FROM ${table} WHERE owner_id=? AND id=?`)
      .get(ownerId, id) === undefined
      ? "not_found"
      : "conflict";
  }
}
