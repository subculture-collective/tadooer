import {
  createHash,
  randomBytes,
  randomUUID,
  scrypt,
  timingSafeEqual,
} from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Owner, SessionResponse } from "@suite/contracts";
import type { SuiteDatabase } from "@suite/persistence";

const scryptParameters = {
  N: 32_768,
  r: 8,
  p: 1,
  maxmem: 64 * 1024 * 1024,
} as const;
const derivedKeyLength = 64;
const idleLifetimeMs = 30 * 60 * 1000;
const absoluteLifetimeMs = 12 * 60 * 60 * 1000;
const dummyPasswordHash =
  "$scrypt$v1$N=32768,r=8,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const sessionCookieName = "suite_session";

const digest = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("base64url");

const addMilliseconds = (timestamp: string, milliseconds: number): string =>
  new Date(Date.parse(timestamp) + milliseconds).toISOString();

const derive = (password: string, salt: Uint8Array): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    scrypt(password, salt, derivedKeyLength, scryptParameters, (error, key) => {
      if (error !== null) reject(error);
      else resolve(key);
    });
  });

export const passwordMeetsPolicy = (password: string): boolean => {
  const bytes = new TextEncoder().encode(password).byteLength;
  return (
    Array.from(password).length >= 14 && bytes <= 1024 && /\S/u.test(password)
  );
};

export const hashPassword = async (
  password: string,
  salt: Uint8Array = randomBytes(16),
): Promise<string> => {
  if (!passwordMeetsPolicy(password)) {
    throw new Error("Password does not meet policy");
  }
  const key = await derive(password, salt);
  return `$scrypt$v1$N=32768,r=8,p=1$${Buffer.from(salt).toString("base64url")}$${key.toString("base64url")}`;
};

export const verifyPassword = async (
  password: string,
  encoded: string,
): Promise<boolean> => {
  const parts = encoded.split("$");
  if (
    parts.length !== 6 ||
    parts[1] !== "scrypt" ||
    parts[2] !== "v1" ||
    parts[3] !== "N=32768,r=8,p=1"
  ) {
    return false;
  }
  try {
    const salt = Buffer.from(parts[4] ?? "", "base64url");
    const expected = Buffer.from(parts[5] ?? "", "base64url");
    if (salt.length !== 16 || expected.length !== derivedKeyLength)
      return false;
    const actual = await derive(password, salt);
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
};

const parseCookies = (
  request: IncomingMessage,
): ReadonlyMap<string, string> => {
  const cookies = new Map<string, string>();
  for (const part of (request.headers.cookie ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name !== "" && value !== "") cookies.set(name, value);
  }
  return cookies;
};

export interface AuthenticatedSession {
  readonly owner: Owner;
  readonly token: string;
  readonly csrfHash: string;
  readonly expiresAt: string;
}

export interface IssuedSession extends AuthenticatedSession {
  readonly csrfToken: string;
}

export class AuthService {
  constructor(
    private readonly database: SuiteDatabase,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly randomToken: () => string = () =>
      randomBytes(32).toString("base64url"),
  ) {}

  setupRequired(): boolean {
    return this.database.setupRequired();
  }

  async setup(input: {
    readonly username: string;
    readonly displayName: string;
    readonly password: string;
  }): Promise<boolean> {
    if (!this.database.setupRequired()) return false;
    const passwordHash = await hashPassword(input.password);
    return this.database.createOwner({
      id: randomUUID(),
      username: input.username,
      displayName: input.displayName,
      passwordHash,
      createdAt: this.now(),
    });
  }

  async login(
    username: string,
    password: string,
  ): Promise<IssuedSession | undefined> {
    const owner = this.database.findOwnerByUsername(username);
    const valid = await verifyPassword(
      password,
      owner?.passwordHash ?? dummyPasswordHash,
    );
    if (owner === undefined || !valid) return undefined;

    const issuedAt = this.now();
    const token = this.randomToken();
    const csrfToken = this.randomToken();
    const idleExpiresAt = addMilliseconds(issuedAt, idleLifetimeMs);
    const absoluteExpiresAt = addMilliseconds(issuedAt, absoluteLifetimeMs);
    this.database.deleteExpiredSessions(issuedAt);
    this.database.createSession({
      tokenHash: digest(token),
      ownerId: owner.id,
      csrfHash: digest(csrfToken),
      issuedAt,
      idleExpiresAt,
      absoluteExpiresAt,
      revokedAt: null,
    });
    return {
      owner: {
        id: owner.id,
        username: owner.username,
        displayName: owner.displayName,
      },
      token,
      csrfToken,
      csrfHash: digest(csrfToken),
      expiresAt: absoluteExpiresAt,
    };
  }

  authenticate(
    request: IncomingMessage,
    refresh: boolean,
  ): AuthenticatedSession | undefined {
    const token = parseCookies(request).get(sessionCookieName);
    if (token === undefined || !/^[A-Za-z0-9_-]{43}$/.test(token))
      return undefined;
    const tokenHash = digest(token);
    const session = this.database.findSession(tokenHash);
    const now = this.now();
    if (session === undefined) return undefined;
    if (
      session.revokedAt !== null ||
      Date.parse(session.idleExpiresAt) <= Date.parse(now) ||
      Date.parse(session.absoluteExpiresAt) <= Date.parse(now)
    ) {
      return undefined;
    }
    const owner = this.database.findOwnerById(session.ownerId);
    if (owner === undefined) return undefined;

    if (refresh) {
      const refreshed = addMilliseconds(now, idleLifetimeMs);
      const idleExpiresAt =
        Date.parse(refreshed) < Date.parse(session.absoluteExpiresAt)
          ? refreshed
          : session.absoluteExpiresAt;
      this.database.refreshSession(tokenHash, now, idleExpiresAt);
    }
    return {
      owner: {
        id: owner.id,
        username: owner.username,
        displayName: owner.displayName,
      },
      token,
      csrfHash: session.csrfHash,
      expiresAt: session.absoluteExpiresAt,
    };
  }

  resume(request: IncomingMessage): IssuedSession | undefined {
    const session = this.authenticate(request, true);
    if (session === undefined) return undefined;
    const csrfToken = this.randomToken();
    const csrfHash = digest(csrfToken);
    this.database.rotateSessionCsrf(digest(session.token), csrfHash);
    return { ...session, csrfToken, csrfHash };
  }

  csrfMatches(
    session: AuthenticatedSession,
    csrfToken: string | undefined,
  ): boolean {
    if (csrfToken === undefined || !/^[A-Za-z0-9_-]{43}$/.test(csrfToken))
      return false;
    const actual = Buffer.from(digest(csrfToken));
    const expected = Buffer.from(session.csrfHash);
    return (
      actual.length === expected.length && timingSafeEqual(actual, expected)
    );
  }

  revoke(session: AuthenticatedSession): void {
    this.database.revokeSession(digest(session.token), this.now());
  }

  response(session: IssuedSession): SessionResponse {
    return {
      owner: session.owner,
      csrfToken: session.csrfToken,
      expiresAt: session.expiresAt,
    };
  }
}

export const sessionCookie = (token: string, secure: boolean): string =>
  `${sessionCookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${String(absoluteLifetimeMs / 1000)}${secure ? "; Secure" : ""}`;

export const clearSessionCookie = (secure: boolean): string =>
  `${sessionCookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? "; Secure" : ""}`;

interface AttemptWindow {
  count: number;
  resetAt: number;
}

export class LoginRateLimiter {
  readonly #attempts = new Map<string, AttemptWindow>();

  allows(key: string, now = Date.now()): boolean {
    const window = this.#attempts.get(key);
    if (window === undefined || window.resetAt <= now) return true;
    return window.count < 5;
  }

  failed(key: string, now = Date.now()): void {
    const window = this.#attempts.get(key);
    if (window === undefined || window.resetAt <= now) {
      this.#attempts.set(key, { count: 1, resetAt: now + 15 * 60 * 1000 });
    } else {
      window.count += 1;
    }
  }

  succeeded(key: string): void {
    this.#attempts.delete(key);
  }
}
