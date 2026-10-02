import {
  createHash,
  randomBytes,
  randomUUID,
  scrypt,
  timingSafeEqual,
} from "node:crypto";
import type { IncomingMessage } from "node:http";
import { isIP } from "node:net";
import {
  liveSyncPushTrigger,
  liveSyncTriggerHeader,
  type DeviceSecurityEvent,
  type Owner,
  type SessionResponse,
  type SignedInDevice,
} from "@suite/contracts";
import type {
  SessionAddressFamily,
  StoredSession,
  SuiteDatabase,
} from "@suite/persistence";
import { clientAddress } from "./http-utils.ts";
import { sessionPolicy, type SessionLifetime } from "./session-policy.ts";

const scryptParameters = {
  N: 32_768,
  r: 8,
  p: 1,
  maxmem: 64 * 1024 * 1024,
} as const;
const derivedKeyLength = 64;
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

const tokenPattern = /^[A-Za-z0-9_-]{43}$/;

const lifetimeOf = (session: {
  readonly deviceId: string | null;
}): SessionLifetime =>
  session.deviceId === null
    ? sessionPolicy.browser
    : sessionPolicy.trustedDevice;

const usable = (session: StoredSession, now: number): boolean =>
  session.revokedAt === null &&
  Date.parse(session.idleExpiresAt) > now &&
  Date.parse(session.absoluteExpiresAt) > now;

const pushTriggered = (request: IncomingMessage): boolean =>
  request.headers[liveSyncTriggerHeader] === liveSyncPushTrigger;

/**
 * Lifetime of the cookie that carries a session token: until the session's
 * absolute expiry, as ADR 0007 already did for the 12-hour browser session.
 * The server enforces the idle window; the cookie only has to outlive it and
 * to survive a browser or app restart.
 */
const cookieMaxAgeSeconds = (absoluteExpiresAt: string, now: string): number =>
  Math.max(
    0,
    Math.ceil((Date.parse(absoluteExpiresAt) - Date.parse(now)) / 1000),
  );

const addressFamilyOf = (address: string): SessionAddressFamily | null => {
  const version = isIP(address);
  return version === 4 ? "ipv4" : version === 6 ? "ipv6" : null;
};

/**
 * A short label for the device list, from the user agent. It names the
 * browser family and the operating system and nothing else; the owner can
 * rename the device.
 */
export const deviceLabelFromUserAgent = (
  userAgent: string | undefined,
): string => {
  const agent = userAgent ?? "";
  // First match wins: an Android agent also says Linux, Edge also says
  // Chrome, and every Chromium agent also says Safari.
  const first = (
    names: readonly (readonly [label: string, ...markers: string[]])[],
  ): string | undefined =>
    names.find(([, ...markers]) =>
      markers.some((marker) => agent.includes(marker)),
    )?.[0];
  const system = first([
    ["Android", "Android"],
    ["iOS", "iPhone", "iPad", "iPod"],
    ["Windows", "Windows"],
    ["macOS", "Macintosh", "Mac OS X"],
    ["ChromeOS", "CrOS"],
    ["Linux", "Linux"],
  ]);
  const browser = first([
    ["Desktop app", "Electron/"],
    ["Edge", "Edg/", "Edge/", "EdgA/", "EdgiOS/"],
    ["Opera", "OPR/"],
    ["Firefox", "Firefox/", "FxiOS/"],
    ["Chrome", "Chrome/", "CriOS/"],
    ["Safari", "Safari/"],
  ]);
  if (browser === undefined && system === undefined) return "Unknown device";
  return `${browser ?? "Browser"} on ${system ?? "an unknown system"}`;
};

export interface AuthenticatedSession {
  readonly owner: Owner;
  readonly token: string;
  readonly csrfHash: string;
  readonly expiresAt: string;
  /** ADR 0048: the device record of a trusted-device session, else null. */
  readonly deviceId: string | null;
  /** The last password entry on this session, when one was recorded. */
  readonly passwordConfirmedAt: string | null;
}

export interface IssuedSession extends AuthenticatedSession {
  readonly csrfToken: string;
}

/** A token to send to the device and the lifetime of its cookie. */
export interface SessionCookieGrant {
  readonly token: string;
  readonly maxAgeSeconds: number;
}

export interface TrustedDeviceRequest {
  readonly label: string;
  readonly addressFamily: SessionAddressFamily | null;
}

export class AuthService {
  constructor(
    private readonly database: SuiteDatabase,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly randomToken: () => string = () =>
      randomBytes(32).toString("base64url"),
    private readonly trustedProxyCidrs: readonly string[] = [],
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

  /**
   * Signs the owner in. With `device` the session is a trusted-device
   * session (ADR 0048): the sliding and absolute lifetimes of
   * `sessionPolicy.trustedDevice` and a rotating token. Without it the
   * session is the browser session of ADR 0007.
   */
  async login(
    username: string,
    password: string,
    device?: TrustedDeviceRequest,
  ): Promise<
    (IssuedSession & { readonly cookie: SessionCookieGrant }) | undefined
  > {
    const owner = this.database.findOwnerByUsername(username);
    const valid = await verifyPassword(
      password,
      owner?.passwordHash ?? dummyPasswordHash,
    );
    if (owner === undefined || !valid) return undefined;

    const issuedAt = this.now();
    const token = this.randomToken();
    const csrfToken = this.randomToken();
    const deviceId = device === undefined ? null : randomUUID();
    const lifetime = lifetimeOf({ deviceId });
    const idleExpiresAt = addMilliseconds(issuedAt, lifetime.idleMs);
    const absoluteExpiresAt = addMilliseconds(issuedAt, lifetime.absoluteMs);
    this.database.deleteExpiredSessions(
      issuedAt,
      addMilliseconds(issuedAt, -sessionPolicy.tokenReuseRecordRetentionMs),
    );
    this.database.createSession({
      tokenHash: digest(token),
      ownerId: owner.id,
      csrfHash: digest(csrfToken),
      issuedAt,
      idleExpiresAt,
      absoluteExpiresAt,
      revokedAt: null,
      ...(device === undefined || deviceId === null
        ? {}
        : {
            device: {
              id: deviceId,
              label: device.label,
              addressFamily: device.addressFamily,
            },
          }),
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
      deviceId,
      passwordConfirmedAt: deviceId === null ? null : issuedAt,
      cookie: {
        token,
        maxAgeSeconds: cookieMaxAgeSeconds(absoluteExpiresAt, issuedAt),
      },
    };
  }

  /**
   * Finds the session a presented token names (ADR 0048).
   *
   * - The current token: the session.
   * - The successor that was sent but not yet presented: the device received
   *   it, so it becomes the current token and the previous one is retired.
   * - A retired token inside the overlap window: the session. Requests the
   *   device sent before it stored the successor arrive like this.
   * - A retired token after the window: a replay. Either the device or
   *   someone holding a copy of its cookie is using a token that was already
   *   replaced, and the server cannot tell which, so the device session is
   *   revoked.
   */
  #resolve(tokenHash: string, now: string): StoredSession | undefined {
    const store = this.database.deviceSessions;
    const current = store.findByToken(tokenHash);
    if (current !== undefined) return current;
    const promoted = store.findByNextToken(tokenHash);
    if (promoted !== undefined) {
      if (usable(promoted, Date.parse(now)))
        store.promoteNextToken(tokenHash, now);
      return store.findByToken(tokenHash) ?? promoted;
    }
    const retired = store.findRetiredToken(tokenHash);
    if (retired === undefined) return undefined;
    const session = store.findByDevice(retired.deviceId);
    if (session === undefined) return undefined;
    if (
      Date.parse(now) - Date.parse(retired.retiredAt) <=
      sessionPolicy.tokenRotationOverlapMs
    )
      return session;
    if (store.revoke(session.tokenHash, now, "token-reuse"))
      console.warn("auth.device.token_reuse_detected");
    return undefined;
  }

  /** The stored row of an authenticated session, whichever token it holds. */
  #stored(session: AuthenticatedSession): StoredSession | undefined {
    return session.deviceId === null
      ? this.database.findSession(digest(session.token))
      : this.database.deviceSessions.findByDevice(session.deviceId);
  }

  authenticate(
    request: IncomingMessage,
    refresh: boolean,
  ): AuthenticatedSession | undefined {
    const token = parseCookies(request).get(sessionCookieName);
    if (token === undefined || !tokenPattern.test(token)) return undefined;
    const now = this.now();
    const session = this.#resolve(digest(token), now);
    if (session === undefined || !usable(session, Date.parse(now)))
      return undefined;
    const owner = this.database.findOwnerById(session.ownerId);
    if (owner === undefined) return undefined;

    // ADR 0045: a request made because of a live sync hint is not owner
    // activity, whichever route it reads. The same rule holds for a trusted
    // device: only owner activity slides its 30-day window (ADR 0048).
    if (refresh && !pushTriggered(request)) {
      const refreshed = addMilliseconds(now, lifetimeOf(session).idleMs);
      const idleExpiresAt =
        Date.parse(refreshed) < Date.parse(session.absoluteExpiresAt)
          ? refreshed
          : session.absoluteExpiresAt;
      if (session.deviceId === null)
        this.database.refreshSession(session.tokenHash, now, idleExpiresAt);
      else
        this.database.refreshSession(
          session.tokenHash,
          now,
          idleExpiresAt,
          addressFamilyOf(clientAddress(request, this.trustedProxyCidrs)),
        );
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
      deviceId: session.deviceId,
      passwordConfirmedAt: session.passwordConfirmedAt,
    };
  }

  /**
   * Starts a token rotation for a trusted device when one is due (ADR 0048).
   * The server calls this once per API request, before routing, and sends
   * the returned token as the session cookie. Requests marked as caused by a
   * live sync hint and the hint stream are never passed here.
   *
   * The current token stays valid until the device presents the successor,
   * so a response that never arrives cannot sign the device out. While a
   * successor is outstanding, another is sent only after
   * `tokenReissueAfterMs`: parallel requests then get one successor between
   * them, and a device that missed it gets a new one on a later request.
   */
  rotateDeviceToken(request: IncomingMessage): SessionCookieGrant | undefined {
    if (pushTriggered(request)) return undefined;
    const token = parseCookies(request).get(sessionCookieName);
    if (token === undefined || !tokenPattern.test(token)) return undefined;
    // Only the current token starts a rotation; a retired or outstanding
    // token is settled by `authenticate`.
    const session = this.database.findSession(digest(token));
    if (session?.deviceId === undefined || session.deviceId === null)
      return undefined;
    if (session.tokenRotatedAt === null) return undefined;
    const now = this.now();
    const at = Date.parse(now);
    if (
      !usable(session, at) ||
      at - Date.parse(session.tokenRotatedAt) <
        sessionPolicy.tokenRotationIntervalMs ||
      (session.nextIssuedAt !== null &&
        at - Date.parse(session.nextIssuedAt) <
          sessionPolicy.tokenReissueAfterMs)
    )
      return undefined;
    const next = this.randomToken();
    this.database.deviceSessions.issueNextToken(
      session.deviceId,
      digest(next),
      now,
    );
    return {
      token: next,
      maxAgeSeconds: cookieMaxAgeSeconds(session.absoluteExpiresAt, now),
    };
  }

  /**
   * Whether an authenticated session is still neither revoked nor expired.
   * Never refreshes the idle timer; the live sync stream asks this to end
   * itself with the session (ADR 0045). A trusted device is looked up by its
   * device record, because its token may have rotated since the stream opened.
   */
  sessionActive(session: AuthenticatedSession): boolean {
    const stored = this.#stored(session);
    return stored !== undefined && usable(stored, Date.parse(this.now()));
  }

  /**
   * ADR 0048: whether a sensitive route may proceed. An ordinary browser
   * session always may: it began with the password at most 12 hours ago and
   * ends after 30 idle minutes. A trusted device needs a password entry
   * within `sessionPolicy.recentPasswordMs`.
   */
  passwordRecentlyConfirmed(session: AuthenticatedSession): boolean {
    if (session.deviceId === null) return true;
    return (
      session.passwordConfirmedAt !== null &&
      Date.parse(this.now()) - Date.parse(session.passwordConfirmedAt) <
        sessionPolicy.recentPasswordMs
    );
  }

  /**
   * Checks the owner's password and stamps the session. Returns the time of
   * the confirmation and when it stops satisfying the gate.
   */
  async confirmPassword(
    session: AuthenticatedSession,
    password: string,
  ): Promise<
    { readonly confirmedAt: string; readonly validUntil: string } | undefined
  > {
    const owner = this.database.findOwnerByUsername(session.owner.username);
    const valid = await verifyPassword(
      password,
      owner?.passwordHash ?? dummyPasswordHash,
    );
    const stored = this.#stored(session);
    if (owner === undefined || !valid || stored === undefined) return undefined;
    const confirmedAt = this.now();
    if (
      !this.database.deviceSessions.confirmPassword(
        stored.tokenHash,
        confirmedAt,
      )
    )
      return undefined;
    return {
      confirmedAt,
      validUntil: addMilliseconds(confirmedAt, sessionPolicy.recentPasswordMs),
    };
  }

  /** The owner's trusted devices and recent token-reuse revocations. */
  listDevices(session: AuthenticatedSession): {
    readonly devices: readonly SignedInDevice[];
    readonly securityEvents: readonly DeviceSecurityEvent[];
  } {
    const now = this.now();
    const store = this.database.deviceSessions;
    return {
      devices: store.listDevices(session.owner.id, now).map((device) => ({
        id: device.deviceId ?? "",
        label: device.deviceLabel ?? "Unknown device",
        createdAt: device.issuedAt,
        lastSeenAt: device.lastSeenAt,
        lastAddressFamily: device.lastAddressFamily,
        expiresAt:
          Date.parse(device.idleExpiresAt) <
          Date.parse(device.absoluteExpiresAt)
            ? device.idleExpiresAt
            : device.absoluteExpiresAt,
        current: device.deviceId === session.deviceId,
      })),
      securityEvents: store
        .listTokenReuseRevocations(
          session.owner.id,
          addMilliseconds(now, -sessionPolicy.tokenReuseRecordRetentionMs),
        )
        .map((device) => ({
          deviceId: device.deviceId ?? "",
          label: device.deviceLabel ?? "Unknown device",
          kind: "token-reuse" as const,
          occurredAt: device.revokedAt ?? now,
        })),
    };
  }

  renameDevice(
    session: AuthenticatedSession,
    deviceId: string,
    label: string,
  ): boolean {
    return this.database.deviceSessions.renameDevice(
      session.owner.id,
      deviceId,
      label,
    );
  }

  /** Signs one trusted device out. It loses access on its next request. */
  revokeDevice(session: AuthenticatedSession, deviceId: string): boolean {
    return this.database.deviceSessions.revokeDevice(
      session.owner.id,
      deviceId,
      this.now(),
      deviceId === session.deviceId ? "signed-out" : "revoked-by-owner",
    );
  }

  /** Signs out every other session of the owner; returns how many. */
  revokeOtherSessions(session: AuthenticatedSession): number {
    const stored = this.#stored(session);
    if (stored === undefined) return 0;
    return this.database.deviceSessions.revokeOthers(
      session.owner.id,
      stored.tokenHash,
      this.now(),
    );
  }

  resume(request: IncomingMessage): IssuedSession | undefined {
    const session = this.authenticate(request, true);
    if (session === undefined) return undefined;
    const csrfToken = this.randomToken();
    const csrfHash = digest(csrfToken);
    const stored = this.#stored(session);
    if (stored === undefined) return undefined;
    this.database.rotateSessionCsrf(stored.tokenHash, csrfHash);
    return { ...session, csrfToken, csrfHash };
  }

  csrfMatches(
    session: AuthenticatedSession,
    csrfToken: string | undefined,
  ): boolean {
    if (csrfToken === undefined || !tokenPattern.test(csrfToken)) return false;
    const actual = Buffer.from(digest(csrfToken));
    const expected = Buffer.from(session.csrfHash);
    return (
      actual.length === expected.length && timingSafeEqual(actual, expected)
    );
  }

  revoke(session: AuthenticatedSession): void {
    const stored = this.#stored(session);
    if (stored !== undefined)
      this.database.revokeSession(stored.tokenHash, this.now());
  }

  response(session: IssuedSession): SessionResponse {
    return {
      owner: session.owner,
      csrfToken: session.csrfToken,
      expiresAt: session.expiresAt,
    };
  }
}

export const sessionCookie = (
  grant: SessionCookieGrant,
  secure: boolean,
): string =>
  `${sessionCookieName}=${grant.token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${String(grant.maxAgeSeconds)}${secure ? "; Secure" : ""}`;

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
