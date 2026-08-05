import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

interface Migration {
  readonly id: string;
  readonly sql: string;
}

interface MigrationRow {
  readonly id: string;
  readonly checksum: string;
}

interface InstallRow {
  readonly instance_id: string;
  readonly created_at: string;
}

export interface InstallMetadata {
  readonly instanceId: string;
  readonly createdAt: string;
}

export interface DatabaseState {
  readonly install: InstallMetadata;
  readonly appliedMigrationCount: number;
  readonly expectedMigrationCount: number;
}

const migrations: readonly Migration[] = [
  {
    id: "0001_install_metadata",
    sql: `
      CREATE TABLE install_metadata (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        instance_id TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      ) STRICT;
    `,
  },
];

const checksum = (sql: string): string =>
  createHash("sha256").update(sql).digest("hex");

const escapeSqliteString = (value: string): string =>
  value.replaceAll("'", "''");

export class SuiteDatabase {
  readonly #database: DatabaseSync;

  private constructor(database: DatabaseSync) {
    this.#database = database;
  }

  static open(path: string): SuiteDatabase {
    mkdirSync(dirname(path), { recursive: true });
    const database = new DatabaseSync(path);
    database.exec("PRAGMA journal_mode = WAL;");
    database.exec("PRAGMA foreign_keys = ON;");
    database.exec("PRAGMA busy_timeout = 5000;");

    const suiteDatabase = new SuiteDatabase(database);
    suiteDatabase.#migrate();
    suiteDatabase.#ensureInstallMetadata();
    return suiteDatabase;
  }

  close(): void {
    this.#database.close();
  }

  state(): DatabaseState {
    const install = this.#database
      .prepare(
        "SELECT instance_id, created_at FROM install_metadata WHERE singleton = 1",
      )
      .get() as unknown as InstallRow | undefined;

    if (install === undefined) {
      throw new Error("Installation metadata is missing");
    }

    const migrationCount = this.#database
      .prepare("SELECT COUNT(*) AS count FROM schema_migrations")
      .get() as unknown as { readonly count: number };

    return {
      install: {
        instanceId: install.instance_id,
        createdAt: install.created_at,
      },
      appliedMigrationCount: migrationCount.count,
      expectedMigrationCount: migrations.length,
    };
  }

  check(): void {
    this.#database.prepare("SELECT 1").get();
  }

  backup(destination: string): void {
    mkdirSync(dirname(destination), { recursive: true });
    this.#database.exec(`VACUUM INTO '${escapeSqliteString(destination)}'`);
  }

  #migrate(): void {
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id TEXT PRIMARY KEY,
        checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL
      ) STRICT;
    `);

    const applied = new Map(
      (
        this.#database
          .prepare("SELECT id, checksum FROM schema_migrations")
          .all() as unknown as readonly MigrationRow[]
      ).map((row) => [row.id, row.checksum]),
    );

    for (const migration of migrations) {
      const expectedChecksum = checksum(migration.sql);
      const appliedChecksum = applied.get(migration.id);

      if (appliedChecksum !== undefined) {
        if (appliedChecksum !== expectedChecksum) {
          throw new Error(`Migration checksum mismatch: ${migration.id}`);
        }
        continue;
      }

      this.#database.exec("BEGIN IMMEDIATE;");
      try {
        this.#database.exec(migration.sql);
        this.#database
          .prepare(
            "INSERT INTO schema_migrations (id, checksum, applied_at) VALUES (?, ?, ?)",
          )
          .run(migration.id, expectedChecksum, new Date().toISOString());
        this.#database.exec("COMMIT;");
      } catch (error: unknown) {
        this.#database.exec("ROLLBACK;");
        throw error;
      }
    }
  }

  #ensureInstallMetadata(): void {
    this.#database
      .prepare(
        `INSERT OR IGNORE INTO install_metadata
          (singleton, instance_id, created_at) VALUES (1, ?, ?)`,
      )
      .run(randomUUID(), new Date().toISOString());
  }
}
