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

export interface OwnerRecord {
  readonly id: string;
  readonly username: string;
  readonly displayName: string;
  readonly passwordHash: string;
  readonly createdAt: string;
}

export interface SessionRecord {
  readonly tokenHash: string;
  readonly ownerId: string;
  readonly csrfHash: string;
  readonly idleExpiresAt: string;
  readonly absoluteExpiresAt: string;
  readonly revokedAt: string | null;
}

export interface BaikalConnectorRecord {
  readonly id: string;
  readonly ownerId: string;
  readonly endpoint: string;
  readonly username: string;
  readonly credentialKeyId: string;
  readonly credentialNonce: Uint8Array;
  readonly credentialCiphertext: Uint8Array;
  readonly credentialTag: Uint8Array;
  readonly verifiedAt: string;
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
  {
    id: "0002_owner_accounts",
    sql: `
      CREATE TABLE owner_accounts (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        display_name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        disabled_at TEXT
      ) STRICT;

      CREATE UNIQUE INDEX one_active_owner
        ON owner_accounts ((1)) WHERE disabled_at IS NULL;
    `,
  },
  {
    id: "0003_web_sessions",
    sql: `
      CREATE TABLE web_sessions (
        token_hash TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL REFERENCES owner_accounts(id) ON DELETE CASCADE,
        csrf_hash TEXT NOT NULL,
        issued_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        idle_expires_at TEXT NOT NULL,
        absolute_expires_at TEXT NOT NULL,
        revoked_at TEXT
      ) STRICT;

      CREATE INDEX web_sessions_by_owner ON web_sessions(owner_id);
      CREATE INDEX web_sessions_by_expiry ON web_sessions(absolute_expires_at);
    `,
  },
  {
    id: "0004_baikal_connectors",
    sql: `
      CREATE TABLE baikal_connectors (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL UNIQUE REFERENCES owner_accounts(id) ON DELETE CASCADE,
        endpoint TEXT NOT NULL,
        username TEXT NOT NULL,
        credential_key_id TEXT NOT NULL,
        credential_nonce BLOB NOT NULL,
        credential_ciphertext BLOB NOT NULL,
        credential_tag BLOB NOT NULL,
        verified_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
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

  setupRequired(): boolean {
    return (
      this.#database
        .prepare("SELECT 1 FROM owner_accounts WHERE disabled_at IS NULL")
        .get() === undefined
    );
  }

  createOwner(owner: OwnerRecord): boolean {
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      if (!this.setupRequired()) {
        this.#database.exec("ROLLBACK;");
        return false;
      }
      this.#database
        .prepare(
          `INSERT INTO owner_accounts
            (id, username, display_name, password_hash, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          owner.id,
          owner.username,
          owner.displayName,
          owner.passwordHash,
          owner.createdAt,
        );
      this.#database.exec("COMMIT;");
      return true;
    } catch (error: unknown) {
      this.#database.exec("ROLLBACK;");
      throw error;
    }
  }

  findOwnerByUsername(username: string): OwnerRecord | undefined {
    const row = this.#database
      .prepare(
        `SELECT id, username, display_name, password_hash, created_at
         FROM owner_accounts WHERE username = ? COLLATE NOCASE AND disabled_at IS NULL`,
      )
      .get(username) as unknown as
      | {
          readonly id: string;
          readonly username: string;
          readonly display_name: string;
          readonly password_hash: string;
          readonly created_at: string;
        }
      | undefined;
    return row === undefined
      ? undefined
      : {
          id: row.id,
          username: row.username,
          displayName: row.display_name,
          passwordHash: row.password_hash,
          createdAt: row.created_at,
        };
  }

  findOwnerById(
    ownerId: string,
  ): Omit<OwnerRecord, "passwordHash"> | undefined {
    const row = this.#database
      .prepare(
        `SELECT id, username, display_name, created_at
         FROM owner_accounts WHERE id = ? AND disabled_at IS NULL`,
      )
      .get(ownerId) as unknown as
      | {
          readonly id: string;
          readonly username: string;
          readonly display_name: string;
          readonly created_at: string;
        }
      | undefined;
    return row === undefined
      ? undefined
      : {
          id: row.id,
          username: row.username,
          displayName: row.display_name,
          createdAt: row.created_at,
        };
  }

  createSession(session: SessionRecord & { readonly issuedAt: string }): void {
    this.#database
      .prepare(
        `INSERT INTO web_sessions
          (token_hash, owner_id, csrf_hash, issued_at, last_seen_at,
           idle_expires_at, absolute_expires_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(
        session.tokenHash,
        session.ownerId,
        session.csrfHash,
        session.issuedAt,
        session.issuedAt,
        session.idleExpiresAt,
        session.absoluteExpiresAt,
      );
  }

  findSession(tokenHash: string): SessionRecord | undefined {
    const row = this.#database
      .prepare(
        `SELECT token_hash, owner_id, csrf_hash, idle_expires_at,
                absolute_expires_at, revoked_at
         FROM web_sessions WHERE token_hash = ?`,
      )
      .get(tokenHash) as unknown as
      | {
          readonly token_hash: string;
          readonly owner_id: string;
          readonly csrf_hash: string;
          readonly idle_expires_at: string;
          readonly absolute_expires_at: string;
          readonly revoked_at: string | null;
        }
      | undefined;
    return row === undefined
      ? undefined
      : {
          tokenHash: row.token_hash,
          ownerId: row.owner_id,
          csrfHash: row.csrf_hash,
          idleExpiresAt: row.idle_expires_at,
          absoluteExpiresAt: row.absolute_expires_at,
          revokedAt: row.revoked_at,
        };
  }

  refreshSession(
    tokenHash: string,
    lastSeenAt: string,
    idleExpiresAt: string,
  ): void {
    this.#database
      .prepare(
        `UPDATE web_sessions SET last_seen_at = ?, idle_expires_at = ?
         WHERE token_hash = ? AND revoked_at IS NULL`,
      )
      .run(lastSeenAt, idleExpiresAt, tokenHash);
  }

  rotateSessionCsrf(tokenHash: string, csrfHash: string): void {
    this.#database
      .prepare(
        "UPDATE web_sessions SET csrf_hash = ? WHERE token_hash = ? AND revoked_at IS NULL",
      )
      .run(csrfHash, tokenHash);
  }

  revokeSession(tokenHash: string, revokedAt: string): boolean {
    return (
      this.#database
        .prepare(
          `UPDATE web_sessions SET revoked_at = ?
           WHERE token_hash = ? AND revoked_at IS NULL`,
        )
        .run(revokedAt, tokenHash).changes === 1
    );
  }

  deleteExpiredSessions(now: string): void {
    this.#database
      .prepare(
        "DELETE FROM web_sessions WHERE absolute_expires_at <= ? OR revoked_at IS NOT NULL",
      )
      .run(now);
  }

  putBaikalConnector(
    connector: BaikalConnectorRecord & { readonly updatedAt: string },
  ): void {
    this.#database
      .prepare(
        `INSERT INTO baikal_connectors (
          id, owner_id, endpoint, username, credential_key_id,
          credential_nonce, credential_ciphertext, credential_tag,
          verified_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(owner_id) DO UPDATE SET
          endpoint = excluded.endpoint,
          username = excluded.username,
          credential_key_id = excluded.credential_key_id,
          credential_nonce = excluded.credential_nonce,
          credential_ciphertext = excluded.credential_ciphertext,
          credential_tag = excluded.credential_tag,
          verified_at = excluded.verified_at,
          updated_at = excluded.updated_at`,
      )
      .run(
        connector.id,
        connector.ownerId,
        connector.endpoint,
        connector.username,
        connector.credentialKeyId,
        connector.credentialNonce,
        connector.credentialCiphertext,
        connector.credentialTag,
        connector.verifiedAt,
        connector.updatedAt,
        connector.updatedAt,
      );
  }

  getBaikalConnector(ownerId: string): BaikalConnectorRecord | undefined {
    const row = this.#database
      .prepare("SELECT * FROM baikal_connectors WHERE owner_id = ?")
      .get(ownerId) as unknown as
      Record<string, string | Uint8Array> | undefined;
    return row === undefined
      ? undefined
      : {
          id: String(row.id),
          ownerId: String(row.owner_id),
          endpoint: String(row.endpoint),
          username: String(row.username),
          credentialKeyId: String(row.credential_key_id),
          credentialNonce: row.credential_nonce as Uint8Array,
          credentialCiphertext: row.credential_ciphertext as Uint8Array,
          credentialTag: row.credential_tag as Uint8Array,
          verifiedAt: String(row.verified_at),
        };
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
