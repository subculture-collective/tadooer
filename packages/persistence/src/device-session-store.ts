import type { DatabaseSync } from "node:sqlite";

/**
 * Owner sessions and trusted-device sessions (ADR 0007, ADR 0048).
 *
 * An ordinary browser session is one `web_sessions` row whose token never
 * changes. A trusted-device session is the same row with a `device_id`: that
 * row is the device record (label, last activity, last address family) and
 * its token rotates. Three kinds of token hash can then name the row:
 *
 * - `token_hash`: the token the device is known to hold;
 * - `next_token_hash`: a successor that was sent but has not been presented
 *   yet, so the device may not have received it;
 * - `web_session_retired_tokens`: every hash that was replaced, with the time
 *   it was replaced. The caller decides whether a retired token is still
 *   inside the overlap window or is a replay.
 *
 * Only SHA-256 digests are stored. Nothing here verifies a token or decides
 * a lifetime; `AuthService` does.
 */

export type SessionAddressFamily = "ipv4" | "ipv6";

export type SessionRevocationReason =
  /** The device signed itself out. */
  | "signed-out"
  /** The owner signed the device out from another session. */
  | "revoked-by-owner"
  /** A replaced token was presented after the overlap window. */
  | "token-reuse";

export interface SessionRecord {
  readonly tokenHash: string;
  readonly ownerId: string;
  readonly csrfHash: string;
  readonly idleExpiresAt: string;
  readonly absoluteExpiresAt: string;
  readonly revokedAt: string | null;
}

export interface StoredSession extends SessionRecord {
  readonly issuedAt: string;
  readonly lastSeenAt: string;
  /** Null for an ordinary browser session. */
  readonly deviceId: string | null;
  readonly deviceLabel: string | null;
  readonly lastAddressFamily: SessionAddressFamily | null;
  /** When the current token was sent to the device. */
  readonly tokenRotatedAt: string | null;
  readonly nextTokenHash: string | null;
  readonly nextIssuedAt: string | null;
  readonly passwordConfirmedAt: string | null;
  readonly revokedReason: SessionRevocationReason | null;
}

export interface SessionDeviceInput {
  readonly id: string;
  readonly label: string;
  readonly addressFamily: SessionAddressFamily | null;
}

export interface RetiredSessionToken {
  readonly deviceId: string;
  readonly retiredAt: string;
}

const columns = `token_hash, owner_id, csrf_hash, issued_at, last_seen_at,
  idle_expires_at, absolute_expires_at, revoked_at, device_id, device_label,
  last_address_family, token_rotated_at, next_token_hash, next_issued_at,
  password_confirmed_at, revoked_reason`;

type Row = Readonly<Record<string, string | null>>;

const fromRow = (row: Row): StoredSession => ({
  tokenHash: String(row.token_hash),
  ownerId: String(row.owner_id),
  csrfHash: String(row.csrf_hash),
  issuedAt: String(row.issued_at),
  lastSeenAt: String(row.last_seen_at),
  idleExpiresAt: String(row.idle_expires_at),
  absoluteExpiresAt: String(row.absolute_expires_at),
  revokedAt: row.revoked_at ?? null,
  deviceId: row.device_id ?? null,
  deviceLabel: row.device_label ?? null,
  lastAddressFamily:
    (row.last_address_family as SessionAddressFamily | null | undefined) ??
    null,
  tokenRotatedAt: row.token_rotated_at ?? null,
  nextTokenHash: row.next_token_hash ?? null,
  nextIssuedAt: row.next_issued_at ?? null,
  passwordConfirmedAt: row.password_confirmed_at ?? null,
  revokedReason:
    (row.revoked_reason as SessionRevocationReason | null | undefined) ?? null,
});

export class SqliteDeviceSessionStore {
  readonly #database: DatabaseSync;

  constructor(database: DatabaseSync) {
    this.#database = database;
  }

  #find(where: string, value: string): StoredSession | undefined {
    const row = this.#database
      .prepare(`SELECT ${columns} FROM web_sessions WHERE ${where} = ?`)
      .get(value) as unknown as Row | undefined;
    return row === undefined ? undefined : fromRow(row);
  }

  #transaction<T>(work: () => T): T {
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      const result = work();
      this.#database.exec("COMMIT;");
      return result;
    } catch (error) {
      this.#database.exec("ROLLBACK;");
      throw error;
    }
  }

  create(
    session: SessionRecord & {
      readonly issuedAt: string;
      readonly device?: SessionDeviceInput;
    },
  ): void {
    const { device } = session;
    this.#database
      .prepare(
        `INSERT INTO web_sessions
          (token_hash, owner_id, csrf_hash, issued_at, last_seen_at,
           idle_expires_at, absolute_expires_at, revoked_at, device_id,
           device_label, last_address_family, token_rotated_at,
           password_confirmed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
      )
      .run(
        session.tokenHash,
        session.ownerId,
        session.csrfHash,
        session.issuedAt,
        session.issuedAt,
        session.idleExpiresAt,
        session.absoluteExpiresAt,
        device?.id ?? null,
        device?.label ?? null,
        device?.addressFamily ?? null,
        // Signing in is a password entry and sends the first token.
        device === undefined ? null : session.issuedAt,
        device === undefined ? null : session.issuedAt,
      );
  }

  findByToken(tokenHash: string): StoredSession | undefined {
    return this.#find("token_hash", tokenHash);
  }

  findByNextToken(tokenHash: string): StoredSession | undefined {
    return this.#find("next_token_hash", tokenHash);
  }

  findByDevice(deviceId: string): StoredSession | undefined {
    return this.#find("device_id", deviceId);
  }

  findRetiredToken(tokenHash: string): RetiredSessionToken | undefined {
    const row = this.#database
      .prepare(
        "SELECT device_id, retired_at FROM web_session_retired_tokens WHERE token_hash = ?",
      )
      .get(tokenHash) as unknown as Row | undefined;
    return row === undefined
      ? undefined
      : { deviceId: String(row.device_id), retiredAt: String(row.retired_at) };
  }

  /**
   * Owner activity: moves the idle expiry and the last-seen time. A trusted
   * device also records the family of the address it was seen from.
   */
  refresh(
    tokenHash: string,
    lastSeenAt: string,
    idleExpiresAt: string,
    addressFamily?: SessionAddressFamily | null,
  ): void {
    this.#database
      .prepare(
        `UPDATE web_sessions SET last_seen_at = ?, idle_expires_at = ?,
           last_address_family = CASE WHEN ? THEN ? ELSE last_address_family END
         WHERE token_hash = ? AND revoked_at IS NULL`,
      )
      .run(
        lastSeenAt,
        idleExpiresAt,
        addressFamily === undefined ? 0 : 1,
        addressFamily ?? null,
        tokenHash,
      );
  }

  /**
   * Records a successor token that is about to be sent to the device. The
   * current token stays valid until the successor is presented. A successor
   * that was sent earlier and never presented is retired now.
   */
  issueNextToken(deviceId: string, nextTokenHash: string, now: string): void {
    this.#transaction(() => {
      this.#database
        .prepare(
          `INSERT INTO web_session_retired_tokens (token_hash, device_id, retired_at)
           SELECT next_token_hash, device_id, ? FROM web_sessions
           WHERE device_id = ? AND next_token_hash IS NOT NULL`,
        )
        .run(now, deviceId);
      this.#database
        .prepare(
          `UPDATE web_sessions SET next_token_hash = ?, next_issued_at = ?
           WHERE device_id = ? AND revoked_at IS NULL`,
        )
        .run(nextTokenHash, now, deviceId);
    });
  }

  /**
   * The device presented its successor token: it becomes the current token
   * and the previous one is retired at `now`. False when another request
   * already promoted it.
   */
  promoteNextToken(nextTokenHash: string, now: string): boolean {
    return this.#transaction(() => {
      const retired = this.#database
        .prepare(
          `INSERT INTO web_session_retired_tokens (token_hash, device_id, retired_at)
           SELECT token_hash, device_id, ? FROM web_sessions
           WHERE next_token_hash = ? AND revoked_at IS NULL`,
        )
        .run(now, nextTokenHash);
      if (retired.changes !== 1) return false;
      this.#database
        .prepare(
          `UPDATE web_sessions SET token_hash = next_token_hash,
             token_rotated_at = next_issued_at, next_token_hash = NULL,
             next_issued_at = NULL
           WHERE next_token_hash = ?`,
        )
        .run(nextTokenHash);
      return true;
    });
  }

  rotateCsrf(tokenHash: string, csrfHash: string): void {
    this.#database
      .prepare(
        "UPDATE web_sessions SET csrf_hash = ? WHERE token_hash = ? AND revoked_at IS NULL",
      )
      .run(csrfHash, tokenHash);
  }

  confirmPassword(tokenHash: string, confirmedAt: string): boolean {
    return (
      this.#database
        .prepare(
          `UPDATE web_sessions SET password_confirmed_at = ?
           WHERE token_hash = ? AND revoked_at IS NULL`,
        )
        .run(confirmedAt, tokenHash).changes === 1
    );
  }

  revoke(
    tokenHash: string,
    revokedAt: string,
    reason: SessionRevocationReason = "signed-out",
  ): boolean {
    return (
      this.#database
        .prepare(
          `UPDATE web_sessions SET revoked_at = ?, revoked_reason = ?
           WHERE token_hash = ? AND revoked_at IS NULL`,
        )
        .run(revokedAt, reason, tokenHash).changes === 1
    );
  }

  /** Trusted devices that can still authenticate, oldest first. */
  listDevices(ownerId: string, now: string): readonly StoredSession[] {
    const rows = this.#database
      .prepare(
        `SELECT ${columns} FROM web_sessions
         WHERE owner_id = ? AND device_id IS NOT NULL AND revoked_at IS NULL
           AND idle_expires_at > ? AND absolute_expires_at > ?
         ORDER BY issued_at, device_id`,
      )
      .all(ownerId, now, now) as unknown as readonly Row[];
    return rows.map(fromRow);
  }

  /** Devices revoked because a replaced token was presented, newest first. */
  listTokenReuseRevocations(
    ownerId: string,
    since: string,
  ): readonly StoredSession[] {
    const rows = this.#database
      .prepare(
        `SELECT ${columns} FROM web_sessions
         WHERE owner_id = ? AND device_id IS NOT NULL
           AND revoked_reason = 'token-reuse' AND revoked_at > ?
         ORDER BY revoked_at DESC, device_id`,
      )
      .all(ownerId, since) as unknown as readonly Row[];
    return rows.map(fromRow);
  }

  renameDevice(ownerId: string, deviceId: string, label: string): boolean {
    return (
      this.#database
        .prepare(
          `UPDATE web_sessions SET device_label = ?
           WHERE owner_id = ? AND device_id = ? AND revoked_at IS NULL`,
        )
        .run(label, ownerId, deviceId).changes === 1
    );
  }

  revokeDevice(
    ownerId: string,
    deviceId: string,
    revokedAt: string,
    reason: SessionRevocationReason,
  ): boolean {
    return (
      this.#database
        .prepare(
          `UPDATE web_sessions SET revoked_at = ?, revoked_reason = ?
           WHERE owner_id = ? AND device_id = ? AND revoked_at IS NULL`,
        )
        .run(revokedAt, reason, ownerId, deviceId).changes === 1
    );
  }

  /**
   * Revokes every other session of the owner, ordinary browser sessions
   * included. Returns how many were revoked.
   */
  revokeOthers(
    ownerId: string,
    keepTokenHash: string,
    revokedAt: string,
  ): number {
    return Number(
      this.#database
        .prepare(
          `UPDATE web_sessions SET revoked_at = ?, revoked_reason = 'revoked-by-owner'
           WHERE owner_id = ? AND token_hash <> ? AND revoked_at IS NULL`,
        )
        .run(revokedAt, ownerId, keepTokenHash).changes,
    );
  }

  /**
   * Removes sessions that can no longer authenticate. A device revoked for
   * token reuse is kept until `reuseRecordsBefore` so Settings can show it;
   * retired tokens go with their session.
   */
  deleteExpired(now: string, reuseRecordsBefore: string = now): void {
    this.#database
      .prepare(
        `DELETE FROM web_sessions
         WHERE absolute_expires_at <= ?
            OR (revoked_at IS NOT NULL
                AND (revoked_reason IS NOT 'token-reuse' OR revoked_at <= ?))
            OR (device_id IS NOT NULL AND revoked_at IS NULL
                AND idle_expires_at <= ?)`,
      )
      .run(now, reuseRecordsBefore, now);
  }
}
