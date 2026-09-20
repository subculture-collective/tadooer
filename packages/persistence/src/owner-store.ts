import type { DatabaseSync } from "node:sqlite";
import type { OwnerRecord } from "./index.js";
import type { OwnerStore } from "./stores.js";

export class SqliteOwnerStore implements OwnerStore {
  constructor(private readonly db: DatabaseSync) {}

  createOwner(owner: OwnerRecord): boolean {
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      if (
        this.db
          .prepare("SELECT 1 FROM owner_accounts WHERE disabled_at IS NULL")
          .get() !== undefined
      ) {
        this.db.exec("ROLLBACK;");
        return false;
      }
      this.db
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
      this.db.exec("COMMIT;");
      return true;
    } catch (error: unknown) {
      this.db.exec("ROLLBACK;");
      throw error;
    }
  }

  getOwner(): string | undefined {
    const row = this.db
      .prepare(
        "SELECT id FROM owner_accounts WHERE disabled_at IS NULL ORDER BY created_at LIMIT 1",
      )
      .get() as unknown as { readonly id: string } | undefined;
    return row?.id;
  }

  getOwnerByUsername(username: string): OwnerRecord | undefined {
    const row = this.db
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
}
