import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { DatabaseState, OwnerRecord } from "./index.js";
import type { MetadataStore } from "./stores.js";

interface InstallRow {
  readonly instance_id: string;
  readonly created_at: string;
}

export class SqliteMetadataStore implements MetadataStore {
  constructor(private readonly db: DatabaseSync) {}

  state(): DatabaseState {
    const install = this.db
      .prepare(
        "SELECT instance_id, created_at FROM install_metadata WHERE singleton = 1",
      )
      .get() as unknown as InstallRow | undefined;

    if (install === undefined) {
      throw new Error("Installation metadata is missing");
    }

    const migrationCount = this.db
      .prepare("SELECT COUNT(*) AS count FROM schema_migrations")
      .get() as unknown as { readonly count: number };

    return {
      install: {
        instanceId: install.instance_id,
        createdAt: install.created_at,
      },
      appliedMigrationCount: migrationCount.count,
      expectedMigrationCount: 14,
    };
  }

  isSetupComplete(): boolean {
    return (
      this.db
        .prepare("SELECT 1 FROM owner_accounts WHERE disabled_at IS NULL")
        .get() !== undefined
    );
  }

  claimInstallation(opts: {
    readonly username: string;
    readonly displayName: string;
    readonly passwordHash: string;
  }): OwnerRecord {
    if (this.isSetupComplete()) {
      throw new Error("Installation already claimed");
    }
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO owner_accounts
          (id, username, display_name, password_hash, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, opts.username, opts.displayName, opts.passwordHash, createdAt);
    return {
      id,
      username: opts.username,
      displayName: opts.displayName,
      passwordHash: opts.passwordHash,
      createdAt,
    };
  }
}
