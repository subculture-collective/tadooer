import type { DatabaseSync } from "node:sqlite";
import type {
  BaikalConnectorRecord,
  GoogleCalendarSyncRecord,
  GoogleConnectorRecord,
} from "./index.js";
import type { CredentialStore } from "./stores.js";

export class SqliteCredentialStore implements CredentialStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  // ── Baïkal connector ──────────────────────────────────────────────────

  getBaikalConnector(ownerId: string): BaikalConnectorRecord | undefined {
    const row = this.db
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

  upsertBaikalConnector(
    connector: BaikalConnectorRecord & { readonly updatedAt: string },
  ): void {
    this.db
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

  deleteBaikalConnector(ownerId: string): void {
    this.db
      .prepare("DELETE FROM baikal_connectors WHERE owner_id = ?")
      .run(ownerId);
  }

  // ── Google OAuth state helpers ────────────────────────────────────────

  createGoogleOAuthState(record: {
    readonly stateHash: string;
    readonly ownerId: string;
    readonly expiresAt: string;
    readonly createdAt: string;
  }): void {
    this.db
      .prepare(
        "DELETE FROM google_oauth_states WHERE owner_id=? OR expires_at<=?",
      )
      .run(record.ownerId, record.createdAt);
    this.db
      .prepare(
        "INSERT INTO google_oauth_states (state_hash,owner_id,expires_at,consumed_at,created_at) VALUES (?,?,?,NULL,?)",
      )
      .run(
        record.stateHash,
        record.ownerId,
        record.expiresAt,
        record.createdAt,
      );
  }

  consumeGoogleOAuthState(stateHash: string, now: string): string | undefined {
    const row = this.db
      .prepare(
        "SELECT owner_id FROM google_oauth_states WHERE state_hash=? AND consumed_at IS NULL AND expires_at>?",
      )
      .get(stateHash, now) as unknown as
      { readonly owner_id: string } | undefined;
    if (row === undefined) return undefined;
    const consumed = this.db
      .prepare(
        "UPDATE google_oauth_states SET consumed_at=? WHERE state_hash=? AND consumed_at IS NULL AND expires_at>?",
      )
      .run(now, stateHash, now);
    return consumed.changes === 1 ? row.owner_id : undefined;
  }

  // ── Google connector ──────────────────────────────────────────────────

  upsertGoogleConnector(record: GoogleConnectorRecord): void {
    this.db
      .prepare(
        `INSERT INTO google_connectors (id,owner_id,credential_key_id,credential_nonce,credential_ciphertext,credential_tag,granted_scopes_json,account_label,state,created_at,updated_at,revoked_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(owner_id) DO UPDATE SET id=excluded.id,credential_key_id=excluded.credential_key_id,
       credential_nonce=excluded.credential_nonce,credential_ciphertext=excluded.credential_ciphertext,credential_tag=excluded.credential_tag,
       granted_scopes_json=excluded.granted_scopes_json,account_label=excluded.account_label,state=excluded.state,updated_at=excluded.updated_at,revoked_at=NULL`,
      )
      .run(
        record.id,
        record.ownerId,
        record.credentialKeyId,
        record.credentialNonce,
        record.credentialCiphertext,
        record.credentialTag,
        JSON.stringify([...record.grantedScopes].sort()),
        record.accountLabel,
        record.state,
        record.createdAt,
        record.updatedAt,
        record.revokedAt,
      );
  }

  getGoogleConnector(ownerId: string): GoogleConnectorRecord | undefined {
    const row = this.db
      .prepare(
        "SELECT * FROM google_connectors WHERE owner_id=? AND revoked_at IS NULL",
      )
      .get(ownerId) as unknown as
      Record<string, string | Uint8Array | null> | undefined;
    return row === undefined
      ? undefined
      : {
          id: String(row.id),
          ownerId: String(row.owner_id),
          credentialKeyId: String(row.credential_key_id),
          credentialNonce: row.credential_nonce as Uint8Array,
          credentialCiphertext: row.credential_ciphertext as Uint8Array,
          credentialTag: row.credential_tag as Uint8Array,
          grantedScopes: JSON.parse(
            String(row.granted_scopes_json),
          ) as string[],
          accountLabel:
            row.account_label === null ? null : String(row.account_label),
          state: String(row.state) as GoogleConnectorRecord["state"],
          createdAt: String(row.created_at),
          updatedAt: String(row.updated_at),
          revokedAt: row.revoked_at === null ? null : String(row.revoked_at),
        };
  }

  deleteGoogleConnector(ownerId: string): boolean {
    const result = this.db
      .prepare(
        "DELETE FROM google_connectors WHERE owner_id = ? AND revoked_at IS NULL",
      )
      .run(ownerId);
    return result.changes > 0;
  }

  markGoogleConnectorState(
    ownerId: string,
    state: GoogleConnectorRecord["state"],
    now: string,
  ): void {
    this.db
      .prepare(
        "UPDATE google_connectors SET state=?,updated_at=? WHERE owner_id=? AND revoked_at IS NULL",
      )
      .run(state, now, ownerId);
  }

  // ── Google Calendar sync ──────────────────────────────────────────────

  upsertGoogleCalendarSync(record: GoogleCalendarSyncRecord): void {
    this.db
      .prepare(
        `INSERT INTO google_calendar_sync (calendar_id,owner_id,external_calendar_id,sync_token,state,last_successful_sync_at,last_attempt_at,error_code)
       VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(calendar_id) DO UPDATE SET external_calendar_id=excluded.external_calendar_id,sync_token=excluded.sync_token,
       state=excluded.state,last_successful_sync_at=excluded.last_successful_sync_at,last_attempt_at=excluded.last_attempt_at,error_code=excluded.error_code`,
      )
      .run(
        record.calendarId,
        record.ownerId,
        record.externalCalendarId,
        record.syncToken,
        record.state,
        record.lastSuccessfulSyncAt,
        record.lastAttemptAt,
        record.errorCode,
      );
  }

  listGoogleCalendarSync(ownerId: string): readonly GoogleCalendarSyncRecord[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM google_calendar_sync WHERE owner_id=? ORDER BY calendar_id",
        )
        .all(ownerId) as unknown as readonly Record<string, string | null>[]
    ).map((row) => ({
      calendarId: String(row.calendar_id),
      ownerId: String(row.owner_id),
      externalCalendarId: String(row.external_calendar_id),
      syncToken: row.sync_token === null ? null : String(row.sync_token),
      state: String(row.state) as GoogleCalendarSyncRecord["state"],
      lastSuccessfulSyncAt:
        row.last_successful_sync_at === null
          ? null
          : String(row.last_successful_sync_at),
      lastAttemptAt:
        row.last_attempt_at === null ? null : String(row.last_attempt_at),
      errorCode: row.error_code === null ? null : String(row.error_code),
    }));
  }

  clearGoogleCalendarSync(ownerId: string): void {
    this.db
      .prepare("DELETE FROM google_calendar_sync WHERE owner_id = ?")
      .run(ownerId);
  }
}
