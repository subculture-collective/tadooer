import type { DatabaseSync } from "node:sqlite";
import type { AutomationTokenRecord } from "./index.js";
import type { AutomationTokenStore } from "./stores.js";

export class SqliteAutomationTokenStore implements AutomationTokenStore {
  constructor(private readonly db: DatabaseSync) {}

  createToken(record: AutomationTokenRecord): void {
    this.db
      .prepare(
        `INSERT INTO automation_tokens
          (id,owner_id,label,secret_hash,scopes_json,created_at,last_used_at,expires_at,revoked_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        record.id,
        record.ownerId,
        record.label,
        record.secretHash,
        JSON.stringify([...record.scopes].sort()),
        record.createdAt,
        record.lastUsedAt,
        record.expiresAt,
        record.revokedAt,
      );
  }

  listTokens(ownerId: string): readonly AutomationTokenRecord[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM automation_tokens WHERE owner_id=? ORDER BY created_at,id",
      )
      .all(ownerId) as unknown as readonly Record<string, string | null>[];
    return rows.map((row) => this.#automationTokenFromRow(row));
  }

  getTokenByPrefix(prefix: string): AutomationTokenRecord | undefined {
    // prefix is the full token ID (UUID) — the "prefix" naming is from the
    // AutomationTokenStore interface contract used by the authentication layer.
    const row = this.db
      .prepare("SELECT * FROM automation_tokens WHERE id=?")
      .get(prefix) as unknown as Record<string, string | null> | undefined;
    return row === undefined ? undefined : this.#automationTokenFromRow(row);
  }

  deleteToken(
    ownerId: string,
    tokenId: string,
    now: string,
  ): boolean {
    return (
      this.db
        .prepare(
          "UPDATE automation_tokens SET revoked_at=? WHERE owner_id=? AND id=? AND revoked_at IS NULL",
        )
        .run(now, ownerId, tokenId).changes === 1
    );
  }

  // Additional methods that were on SuiteDatabase but belong to this context

  authenticateToken(
    tokenId: string,
    secretHash: string,
    now: string,
  ): AutomationTokenRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM automation_tokens WHERE id=? AND secret_hash=?
         AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)`,
      )
      .get(tokenId, secretHash, now) as unknown as
      Record<string, string | null> | undefined;
    if (row === undefined) return undefined;
    this.db
      .prepare("UPDATE automation_tokens SET last_used_at=? WHERE id=?")
      .run(now, tokenId);
    return { ...this.#automationTokenFromRow(row), lastUsedAt: now };
  }

  #automationTokenFromRow(
    row: Record<string, string | null>,
  ): AutomationTokenRecord {
    return {
      id: String(row.id),
      ownerId: String(row.owner_id),
      label: String(row.label),
      secretHash: String(row.secret_hash),
      scopes: JSON.parse(String(row.scopes_json)) as string[],
      createdAt: String(row.created_at),
      lastUsedAt: row.last_used_at ?? null,
      expiresAt: row.expires_at ?? null,
      revokedAt: row.revoked_at ?? null,
    };
  }
}