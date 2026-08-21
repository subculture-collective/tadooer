import type { DatabaseSync } from "node:sqlite";
import type { SessionRecord } from "./index.js";
import type { SessionStore } from "./stores.js";

export class SqliteSessionStore implements SessionStore {
  constructor(private readonly db: DatabaseSync) {}

  insertSession(session: SessionRecord & { readonly issuedAt: string }): void {
    this.db
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

  getSession(tokenHash: string): SessionRecord | undefined {
    const row = this.db
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

  updateCsrf(tokenHash: string, csrfHash: string): void {
    this.db
      .prepare(
        "UPDATE web_sessions SET csrf_hash = ? WHERE token_hash = ? AND revoked_at IS NULL",
      )
      .run(csrfHash, tokenHash);
  }

  revokeSession(tokenHash: string, revokedAt: string): boolean {
    return (
      this.db
        .prepare(
          `UPDATE web_sessions SET revoked_at = ?
           WHERE token_hash = ? AND revoked_at IS NULL`,
        )
        .run(revokedAt, tokenHash).changes === 1
    );
  }

  purgeExpiredSessions(): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        "DELETE FROM web_sessions WHERE absolute_expires_at <= ? OR revoked_at IS NOT NULL",
      )
      .run(now);
  }
}
