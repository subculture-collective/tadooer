import type { DatabaseSync } from "node:sqlite";

export const hostedOAuthMigration = {
  id: "0052_hosted_mcp_oauth",
  sql: `
    CREATE TABLE hosted_oauth_requests (
      id TEXT PRIMARY KEY,
      request_hash TEXT NOT NULL UNIQUE,
      owner_id TEXT NOT NULL REFERENCES owner_accounts(id) ON DELETE CASCADE,
      client_id TEXT NOT NULL,
      redirect_uri TEXT NOT NULL,
      resource TEXT NOT NULL,
      scopes_json TEXT NOT NULL,
      state_hash TEXT NOT NULL,
      code_challenge TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      consumed_at TEXT,
      created_at TEXT NOT NULL
    ) STRICT;
    CREATE INDEX hosted_oauth_requests_expiry
      ON hosted_oauth_requests(expires_at, consumed_at);

    CREATE TABLE hosted_oauth_grants (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES owner_accounts(id) ON DELETE CASCADE,
      client_id TEXT NOT NULL,
      resource TEXT NOT NULL,
      scopes_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      revoked_at TEXT
    ) STRICT;
    CREATE INDEX hosted_oauth_grants_owner
      ON hosted_oauth_grants(owner_id, created_at, id);

    CREATE TABLE hosted_oauth_codes (
      code_hash TEXT PRIMARY KEY,
      grant_id TEXT NOT NULL REFERENCES hosted_oauth_grants(id) ON DELETE CASCADE,
      client_id TEXT NOT NULL,
      redirect_uri TEXT NOT NULL,
      resource TEXT NOT NULL,
      scopes_json TEXT NOT NULL,
      code_challenge TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      consumed_at TEXT,
      created_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE hosted_oauth_tokens (
      token_hash TEXT PRIMARY KEY,
      grant_id TEXT NOT NULL REFERENCES hosted_oauth_grants(id) ON DELETE CASCADE,
      client_id TEXT NOT NULL,
      resource TEXT NOT NULL,
      scopes_json TEXT NOT NULL,
      token_kind TEXT NOT NULL CHECK(token_kind IN ('access','refresh')),
      expires_at TEXT NOT NULL,
      rotated_at TEXT,
      revoked_at TEXT,
      created_at TEXT NOT NULL
    ) STRICT;
    CREATE INDEX hosted_oauth_tokens_grant
      ON hosted_oauth_tokens(grant_id, token_kind, expires_at);

    CREATE TABLE hosted_oauth_audit (
      id TEXT PRIMARY KEY,
      owner_id TEXT REFERENCES owner_accounts(id) ON DELETE SET NULL,
      client_id TEXT,
      subject_id TEXT,
      phase TEXT NOT NULL CHECK(phase IN ('authorize','consent','token','refresh','revoke','resource')),
      outcome TEXT NOT NULL CHECK(outcome IN ('succeeded','denied','failed','rate_limited')),
      error_code TEXT,
      scopes_json TEXT NOT NULL,
      resource TEXT,
      created_at TEXT NOT NULL
    ) STRICT;
    CREATE INDEX hosted_oauth_audit_created ON hosted_oauth_audit(created_at, id);
  `,
} as const;

export interface HostedOAuthRequestRecord {
  readonly id: string;
  readonly requestHash: string;
  readonly ownerId: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly resource: string;
  readonly scopes: readonly string[];
  readonly stateHash: string;
  readonly codeChallenge: string;
  readonly expiresAt: string;
  readonly consumedAt: string | null;
  readonly createdAt: string;
}

export interface HostedOAuthGrantRecord {
  readonly id: string;
  readonly ownerId: string;
  readonly clientId: string;
  readonly resource: string;
  readonly scopes: readonly string[];
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
}

export interface HostedOAuthCodeRecord {
  readonly codeHash: string;
  readonly grantId: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly resource: string;
  readonly scopes: readonly string[];
  readonly codeChallenge: string;
  readonly expiresAt: string;
  readonly consumedAt: string | null;
  readonly createdAt: string;
}

export interface HostedOAuthTokenRecord {
  readonly tokenHash: string;
  readonly grantId: string;
  readonly clientId: string;
  readonly resource: string;
  readonly scopes: readonly string[];
  readonly tokenKind: "access" | "refresh";
  readonly expiresAt: string;
  readonly rotatedAt: string | null;
  readonly revokedAt: string | null;
  readonly createdAt: string;
}

export interface HostedOAuthAuditRecord {
  readonly id: string;
  readonly ownerId: string | null;
  readonly clientId: string | null;
  readonly subjectId: string | null;
  readonly phase:
    "authorize" | "consent" | "token" | "refresh" | "revoke" | "resource";
  readonly outcome: "succeeded" | "denied" | "failed" | "rate_limited";
  readonly errorCode: string | null;
  readonly scopes: readonly string[];
  readonly resource: string | null;
  readonly createdAt: string;
}

const scopes = (value: string): readonly string[] =>
  JSON.parse(value) as string[];

export class SqliteHostedOAuthStore {
  constructor(private readonly database: DatabaseSync) {}

  createRequest(record: HostedOAuthRequestRecord): void {
    this.database
      .prepare(
        `INSERT INTO hosted_oauth_requests
        (id,request_hash,owner_id,client_id,redirect_uri,resource,scopes_json,state_hash,
         code_challenge,expires_at,consumed_at,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        record.id,
        record.requestHash,
        record.ownerId,
        record.clientId,
        record.redirectUri,
        record.resource,
        JSON.stringify([...record.scopes].sort()),
        record.stateHash,
        record.codeChallenge,
        record.expiresAt,
        record.consumedAt,
        record.createdAt,
      );
  }

  consumeRequest(
    id: string,
    requestHash: string,
    ownerId: string,
    now: string,
  ): HostedOAuthRequestRecord | undefined {
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      const row = this.database
        .prepare(
          `SELECT * FROM hosted_oauth_requests
          WHERE id=? AND request_hash=? AND owner_id=?
            AND consumed_at IS NULL AND expires_at>?`,
        )
        .get(id, requestHash, ownerId, now) as unknown as
        Record<string, string | null> | undefined;
      if (row === undefined) {
        this.database.exec("ROLLBACK;");
        return undefined;
      }
      const changed = this.database
        .prepare(
          `UPDATE hosted_oauth_requests SET consumed_at=?
          WHERE id=? AND consumed_at IS NULL AND expires_at>?`,
        )
        .run(now, id, now).changes;
      if (changed !== 1) {
        this.database.exec("ROLLBACK;");
        return undefined;
      }
      this.database.exec("COMMIT;");
      return this.requestFromRow({ ...row, consumed_at: now });
    } catch (error) {
      this.database.exec("ROLLBACK;");
      throw error;
    }
  }

  issueCode(grant: HostedOAuthGrantRecord, code: HostedOAuthCodeRecord): void {
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      this.database
        .prepare(
          `INSERT INTO hosted_oauth_grants
          (id,owner_id,client_id,resource,scopes_json,created_at,expires_at,revoked_at)
          VALUES (?,?,?,?,?,?,?,?)`,
        )
        .run(
          grant.id,
          grant.ownerId,
          grant.clientId,
          grant.resource,
          JSON.stringify([...grant.scopes].sort()),
          grant.createdAt,
          grant.expiresAt,
          grant.revokedAt,
        );
      this.database
        .prepare(
          `INSERT INTO hosted_oauth_codes
          (code_hash,grant_id,client_id,redirect_uri,resource,scopes_json,code_challenge,
           expires_at,consumed_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          code.codeHash,
          code.grantId,
          code.clientId,
          code.redirectUri,
          code.resource,
          JSON.stringify([...code.scopes].sort()),
          code.codeChallenge,
          code.expiresAt,
          code.consumedAt,
          code.createdAt,
        );
      this.database.exec("COMMIT;");
    } catch (error) {
      this.database.exec("ROLLBACK;");
      throw error;
    }
  }

  exchangeCode(
    codeHash: string,
    clientId: string,
    redirectUri: string,
    resource: string,
    codeChallenge: string,
    now: string,
    accessTokenHash: string,
    accessExpiresAt: string,
    refreshTokenHash: string,
    refreshExpiresAt: string,
  ): HostedOAuthCodeRecord | undefined {
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      const row = this.database
        .prepare(
          `SELECT c.*,g.owner_id FROM hosted_oauth_codes c
          JOIN hosted_oauth_grants g ON g.id=c.grant_id
          WHERE c.code_hash=? AND c.client_id=? AND c.redirect_uri=? AND c.resource=?
            AND c.code_challenge=?
            AND c.consumed_at IS NULL AND c.expires_at>? AND g.revoked_at IS NULL
            AND g.expires_at>?`,
        )
        .get(
          codeHash,
          clientId,
          redirectUri,
          resource,
          codeChallenge,
          now,
          now,
        ) as unknown as Record<string, string | null> | undefined;
      if (row === undefined) {
        this.database.exec("ROLLBACK;");
        return undefined;
      }
      const changed = this.database
        .prepare(
          `UPDATE hosted_oauth_codes SET consumed_at=?
          WHERE code_hash=? AND consumed_at IS NULL AND expires_at>?`,
        )
        .run(now, codeHash, now).changes;
      if (changed !== 1) {
        this.database.exec("ROLLBACK;");
        return undefined;
      }
      const grantedScopes = scopes(String(row.scopes_json));
      const common = {
        grantId: String(row.grant_id),
        clientId,
        resource,
        scopes: grantedScopes,
        rotatedAt: null,
        revokedAt: null,
        createdAt: now,
      } as const;
      this.insertToken({
        ...common,
        tokenHash: accessTokenHash,
        tokenKind: "access",
        expiresAt: accessExpiresAt,
      });
      this.insertToken({
        ...common,
        tokenHash: refreshTokenHash,
        tokenKind: "refresh",
        expiresAt: refreshExpiresAt,
      });
      this.database.exec("COMMIT;");
      return this.codeFromRow({ ...row, consumed_at: now });
    } catch (error) {
      this.database.exec("ROLLBACK;");
      throw error;
    }
  }

  rotateRefresh(
    tokenHash: string,
    clientId: string,
    resource: string,
    requestedScopes: readonly string[],
    now: string,
    accessTokenHash: string,
    accessExpiresAt: string,
    successorTokenHash: string,
    successorExpiresAt: string,
  ): "rotated" | "reused" | "invalid" {
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      const row = this.database
        .prepare(
          `SELECT t.*,g.owner_id,g.revoked_at AS grant_revoked_at,g.expires_at AS grant_expires_at
          FROM hosted_oauth_tokens t JOIN hosted_oauth_grants g ON g.id=t.grant_id
          WHERE t.token_hash=? AND t.token_kind='refresh' AND t.client_id=? AND t.resource=?`,
        )
        .get(tokenHash, clientId, resource) as unknown as
        Record<string, string | null> | undefined;
      if (row === undefined) {
        this.database.exec("ROLLBACK;");
        return "invalid";
      }
      if (row.rotated_at !== null || row.revoked_at !== null) {
        this.revokeGrantInTransaction(String(row.grant_id), now);
        this.database.exec("COMMIT;");
        return "reused";
      }
      const granted = new Set(scopes(String(row.scopes_json)));
      if (
        String(row.expires_at) <= now ||
        row.grant_revoked_at !== null ||
        String(row.grant_expires_at) <= now ||
        requestedScopes.length === 0 ||
        requestedScopes.some((scope) => !granted.has(scope))
      ) {
        this.database.exec("ROLLBACK;");
        return "invalid";
      }
      const changed = this.database
        .prepare(
          `UPDATE hosted_oauth_tokens SET rotated_at=?
          WHERE token_hash=? AND rotated_at IS NULL AND revoked_at IS NULL`,
        )
        .run(now, tokenHash).changes;
      if (changed !== 1) {
        this.revokeGrantInTransaction(String(row.grant_id), now);
        this.database.exec("COMMIT;");
        return "reused";
      }
      const common = {
        grantId: String(row.grant_id),
        clientId,
        resource,
        scopes: requestedScopes,
        rotatedAt: null,
        revokedAt: null,
        createdAt: now,
      } as const;
      this.insertToken({
        ...common,
        tokenHash: accessTokenHash,
        tokenKind: "access",
        expiresAt: accessExpiresAt,
      });
      this.insertToken({
        ...common,
        tokenHash: successorTokenHash,
        tokenKind: "refresh",
        expiresAt: successorExpiresAt,
      });
      this.database.exec("COMMIT;");
      return "rotated";
    } catch (error) {
      this.database.exec("ROLLBACK;");
      throw error;
    }
  }

  authenticateAccess(
    tokenHash: string,
    resource: string,
    requiredScope: string | undefined,
    now: string,
  ): (HostedOAuthTokenRecord & { readonly ownerId: string }) | undefined {
    const row = this.database
      .prepare(
        `SELECT t.*,g.owner_id FROM hosted_oauth_tokens t
        JOIN hosted_oauth_grants g ON g.id=t.grant_id
        WHERE t.token_hash=? AND t.token_kind='access' AND t.resource=?
          AND t.revoked_at IS NULL AND t.expires_at>?
          AND g.revoked_at IS NULL AND g.expires_at>?`,
      )
      .get(tokenHash, resource, now, now) as unknown as
      Record<string, string | null> | undefined;
    if (row === undefined) return undefined;
    const token = this.tokenFromRow(row);
    return requiredScope === undefined || token.scopes.includes(requiredScope)
      ? { ...token, ownerId: String(row.owner_id) }
      : undefined;
  }

  authenticateRefresh(
    tokenHash: string,
    clientId: string,
    resource: string,
  ): HostedOAuthTokenRecord | undefined {
    const row = this.database
      .prepare(
        `SELECT t.* FROM hosted_oauth_tokens t
        JOIN hosted_oauth_grants g ON g.id=t.grant_id
        WHERE t.token_hash=? AND t.token_kind='refresh'
          AND t.client_id=? AND t.resource=?`,
      )
      .get(tokenHash, clientId, resource) as unknown as
      Record<string, string | null> | undefined;
    return row === undefined ? undefined : this.tokenFromRow(row);
  }

  revokeTokenFamily(tokenHash: string, clientId: string, now: string): boolean {
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      const row = this.database
        .prepare(
          `SELECT grant_id FROM hosted_oauth_tokens
          WHERE token_hash=? AND client_id=?`,
        )
        .get(tokenHash, clientId) as unknown as
        { grant_id: string } | undefined;
      if (row !== undefined) this.revokeGrantInTransaction(row.grant_id, now);
      this.database.exec("COMMIT;");
      return row !== undefined;
    } catch (error) {
      this.database.exec("ROLLBACK;");
      throw error;
    }
  }

  revokeGrant(ownerId: string, grantId: string, now: string): boolean {
    const changed = this.database
      .prepare(
        `UPDATE hosted_oauth_grants SET revoked_at=?
        WHERE id=? AND owner_id=? AND revoked_at IS NULL`,
      )
      .run(now, grantId, ownerId).changes;
    if (changed === 1)
      this.database
        .prepare(
          `UPDATE hosted_oauth_tokens SET revoked_at=?
          WHERE grant_id=? AND revoked_at IS NULL`,
        )
        .run(now, grantId);
    return changed === 1;
  }

  appendAudit(record: HostedOAuthAuditRecord): void {
    this.database
      .prepare(
        `INSERT INTO hosted_oauth_audit
        (id,owner_id,client_id,subject_id,phase,outcome,error_code,scopes_json,resource,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        record.id,
        record.ownerId,
        record.clientId,
        record.subjectId,
        record.phase,
        record.outcome,
        record.errorCode,
        JSON.stringify([...record.scopes].sort()),
        record.resource,
        record.createdAt,
      );
  }

  private insertToken(record: HostedOAuthTokenRecord): void {
    this.database
      .prepare(
        `INSERT INTO hosted_oauth_tokens
        (token_hash,grant_id,client_id,resource,scopes_json,token_kind,expires_at,
         rotated_at,revoked_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        record.tokenHash,
        record.grantId,
        record.clientId,
        record.resource,
        JSON.stringify([...record.scopes].sort()),
        record.tokenKind,
        record.expiresAt,
        record.rotatedAt,
        record.revokedAt,
        record.createdAt,
      );
  }

  private revokeGrantInTransaction(grantId: string, now: string): void {
    this.database
      .prepare(
        `UPDATE hosted_oauth_grants SET revoked_at=COALESCE(revoked_at,?) WHERE id=?`,
      )
      .run(now, grantId);
    this.database
      .prepare(
        `UPDATE hosted_oauth_tokens SET revoked_at=COALESCE(revoked_at,?) WHERE grant_id=?`,
      )
      .run(now, grantId);
  }

  private requestFromRow(
    row: Record<string, string | null>,
  ): HostedOAuthRequestRecord {
    return {
      id: String(row.id),
      requestHash: String(row.request_hash),
      ownerId: String(row.owner_id),
      clientId: String(row.client_id),
      redirectUri: String(row.redirect_uri),
      resource: String(row.resource),
      scopes: scopes(String(row.scopes_json)),
      stateHash: String(row.state_hash),
      codeChallenge: String(row.code_challenge),
      expiresAt: String(row.expires_at),
      consumedAt: row.consumed_at ?? null,
      createdAt: String(row.created_at),
    };
  }

  private codeFromRow(
    row: Record<string, string | null>,
  ): HostedOAuthCodeRecord {
    return {
      codeHash: String(row.code_hash),
      grantId: String(row.grant_id),
      clientId: String(row.client_id),
      redirectUri: String(row.redirect_uri),
      resource: String(row.resource),
      scopes: scopes(String(row.scopes_json)),
      codeChallenge: String(row.code_challenge),
      expiresAt: String(row.expires_at),
      consumedAt: row.consumed_at ?? null,
      createdAt: String(row.created_at),
    };
  }

  private tokenFromRow(
    row: Record<string, string | null>,
  ): HostedOAuthTokenRecord {
    return {
      tokenHash: String(row.token_hash),
      grantId: String(row.grant_id),
      clientId: String(row.client_id),
      resource: String(row.resource),
      scopes: scopes(String(row.scopes_json)),
      tokenKind: String(row.token_kind) as "access" | "refresh",
      expiresAt: String(row.expires_at),
      rotatedAt: row.rotated_at ?? null,
      revokedAt: row.revoked_at ?? null,
      createdAt: String(row.created_at),
    };
  }
}
