import { googleProjectionFreshness } from "@suite/domain";
import {
  constants,
  closeSync,
  fstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import {
  googleBridgeScope,
  buildGoogleAuthorizationUrl,
  exchangeGoogleCode,
  googleScopes,
  listGoogleCalendars,
  refreshGoogleAccess,
  revokeGoogleGrant,
  syncGoogleEvents,
  type GoogleOAuthClientConfig,
} from "@suite/google-calendar";
import type {
  GoogleConnectorStatusResponse,
  GoogleSyncResponse,
} from "@suite/contracts";
import type { SuiteDatabase } from "@suite/persistence";
import { loadOrCreateCredentialKey } from "./connector.ts";

const readConfiguration = (
  path: string | undefined,
): GoogleOAuthClientConfig | undefined => {
  if (path === undefined) return undefined;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const status = fstatSync(descriptor);
    if (
      !status.isFile() ||
      (status.mode & 0o077) !== 0 ||
      status.size > 16 * 1024
    )
      return undefined;
    const value = JSON.parse(readFileSync(descriptor, "utf8")) as unknown;
    if (typeof value !== "object" || value === null) return undefined;
    const record = value as Record<string, unknown>;
    if (
      typeof record.clientId !== "string" ||
      record.clientId.length < 5 ||
      typeof record.clientSecret !== "string" ||
      record.clientSecret.length < 5 ||
      typeof record.redirectUri !== "string"
    )
      return undefined;
    const redirect = new URL(record.redirectUri);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(
      redirect.hostname,
    );
    if (
      (redirect.protocol !== "https:" &&
        !(redirect.protocol === "http:" && loopback)) ||
      redirect.username !== "" ||
      redirect.password !== "" ||
      redirect.pathname !== "/api/connectors/google/callback" ||
      redirect.search !== "" ||
      redirect.hash !== ""
    )
      return undefined;
    return {
      clientId: record.clientId,
      clientSecret: record.clientSecret,
      redirectUri: redirect.href,
    };
  } catch {
    return undefined;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
};

const aad = (ownerId: string, connectorId: string, keyId: string): Buffer =>
  Buffer.from(`suite-google-v1\0${ownerId}\0${connectorId}\0${keyId}`);

const dateValue = (iso: string, allDay: boolean): string =>
  allDay
    ? iso.slice(0, 10).replaceAll("-", "")
    : new Date(iso)
        .toISOString()
        .replaceAll("-", "")
        .replaceAll(":", "")
        .replace(/\.\d{3}Z$/, "Z");

const eventIcs = (event: {
  readonly uid: string;
  readonly summary: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly allDay: boolean;
}): string =>
  [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Suite//Google projection v1//EN",
    "BEGIN:VEVENT",
    `UID:${event.uid}`,
    `${event.allDay ? "DTSTART;VALUE=DATE" : "DTSTART"}:${dateValue(event.startsAt, event.allDay)}`,
    `${event.allDay ? "DTEND;VALUE=DATE" : "DTEND"}:${dateValue(event.endsAt, event.allDay)}`,
    `SUMMARY:${event.summary
      .replaceAll("\\", "\\\\")
      .replaceAll("\n", "\\n")
      .replaceAll(",", "\\,")
      .replaceAll(";", "\\;")}`,
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\r\n");

export class GoogleConnectorService {
  readonly #key: Buffer;
  readonly #keyId: string;

  constructor(
    private readonly database: SuiteDatabase,
    keyPath: string,
    private readonly configPath: string | undefined,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.#key = loadOrCreateCredentialKey(keyPath);
    this.#keyId = createHash("sha256")
      .update(this.#key)
      .digest("base64url")
      .slice(0, 22);
  }

  configured(): boolean {
    return readConfiguration(this.configPath) !== undefined;
  }

  begin(
    ownerId: string,
    now = new Date(),
  ):
    | { readonly authorizationUrl: string; readonly expiresAt: string }
    | undefined {
    const config = readConfiguration(this.configPath);
    if (config === undefined) return undefined;
    const state = randomBytes(32).toString("base64url");
    const expiresAt = new Date(now.getTime() + 10 * 60_000).toISOString();
    this.database.createGoogleOAuthState({
      stateHash: createHash("sha256").update(state).digest("base64url"),
      ownerId,
      expiresAt,
      createdAt: now.toISOString(),
    });
    return {
      authorizationUrl: buildGoogleAuthorizationUrl(config, state),
      expiresAt,
    };
  }

  async complete(
    state: string,
    code: string,
    now = new Date(),
  ): Promise<string | undefined> {
    const config = readConfiguration(this.configPath);
    const ownerId = this.database.consumeGoogleOAuthState(
      createHash("sha256").update(state).digest("base64url"),
      now.toISOString(),
    );
    if (config === undefined || ownerId === undefined) return undefined;
    const grant = await exchangeGoogleCode(config, code, this.fetcher);
    if (
      grant?.refreshToken == null ||
      !googleScopes.every((scope) => grant.scopes.includes(scope))
    )
      return undefined;

    const existing = this.database.getGoogleConnector(ownerId);
    const connectorId = existing?.id ?? randomUUID();
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key, nonce);
    cipher.setAAD(aad(ownerId, connectorId, this.#keyId));
    const ciphertext = Buffer.concat([
      cipher.update(grant.refreshToken, "utf8"),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    this.database.putGoogleConnector({
      id: connectorId,
      ownerId,
      credentialKeyId: this.#keyId,
      credentialNonce: nonce,
      credentialCiphertext: ciphertext,
      credentialTag: tag,
      grantedScopes: grant.scopes,
      accountLabel: null,
      state: "connected",
      createdAt: existing?.createdAt ?? now.toISOString(),
      updatedAt: now.toISOString(),
      revokedAt: null,
    });
    await this.synchronize(ownerId, now);
    return ownerId;
  }

  status(ownerId: string, now = new Date()): GoogleConnectorStatusResponse {
    const connector = this.database.getGoogleConnector(ownerId);
    const calendars = this.database.listOwnedCalendars(ownerId, "google");
    const sync = this.database.listGoogleCalendarSync(ownerId);
    return {
      configured: this.configured(),
      connected:
        connector !== undefined && connector.state !== "reconnect_required",
      state: connector?.state ?? "disconnected",
      providerId: calendars[0]?.providerId ?? null,
      accountLabel: connector?.accountLabel ?? null,
      grantedScopes:
        connector === undefined ? [] : [...connector.grantedScopes],
      calendars: calendars.map(
        ({
          id,
          providerId,
          href,
          displayName,
          supportsEvents,
          supportsTodos,
        }) => ({
          id,
          providerId,
          href,
          displayName,
          supportsEvents,
          supportsTodos,
        }),
      ),
      freshness: sync.map((item) => ({
        calendarId: item.calendarId,
        ...googleProjectionFreshness(
          item.state,
          item.lastSuccessfulSyncAt,
          now,
        ),
        lastSuccessfulSyncAt: item.lastSuccessfulSyncAt,
      })),
    };
  }

  #refreshToken(ownerId: string): string | undefined {
    const connector = this.database.getGoogleConnector(ownerId);
    if (connector?.credentialKeyId !== this.#keyId) return undefined;
    try {
      const decipher = createDecipheriv(
        "aes-256-gcm",
        this.#key,
        connector.credentialNonce,
      );
      decipher.setAAD(aad(ownerId, connector.id, this.#keyId));
      decipher.setAuthTag(Buffer.from(connector.credentialTag));
      return Buffer.concat([
        decipher.update(Buffer.from(connector.credentialCiphertext)),
        decipher.final(),
      ]).toString("utf8");
    } catch {
      return undefined;
    }
  }

  /** True when the stored grant includes event write access (#36). */
  hasBridgeConsent(ownerId: string): boolean {
    const connector = this.database.getGoogleConnector(ownerId);
    return (
      connector !== undefined &&
      connector.state !== "reconnect_required" &&
      connector.grantedScopes.includes(googleBridgeScope)
    );
  }

  /**
   * A short-lived access token for one bridge pass (ADR 0041). The token is
   * held in memory only; an invalid grant marks the connector for reconnect.
   */
  async bridgeAccess(
    ownerId: string,
    now = new Date(),
  ): Promise<
    | {
        readonly ok: true;
        readonly accessToken: string;
        readonly fetch: typeof fetch;
      }
    | {
        readonly ok: false;
        readonly reason:
          | "not-connected"
          | "consent-required"
          | "reconnect-required"
          | "unavailable";
      }
  > {
    const config = readConfiguration(this.configPath);
    const refreshToken = this.#refreshToken(ownerId);
    if (config === undefined || refreshToken === undefined)
      return { ok: false, reason: "not-connected" };
    if (!this.hasBridgeConsent(ownerId))
      return { ok: false, reason: "consent-required" };
    const grant = await refreshGoogleAccess(
      config,
      refreshToken,
      this.fetcher,
    ).catch(() => undefined);
    if (grant === "invalid_grant") {
      this.database.markGoogleConnectorState(
        ownerId,
        "reconnect_required",
        now.toISOString(),
      );
      return { ok: false, reason: "reconnect-required" };
    }
    return grant === undefined
      ? { ok: false, reason: "unavailable" }
      : { ok: true, accessToken: grant.accessToken, fetch: this.fetcher };
  }

  async synchronize(
    ownerId: string,
    now = new Date(),
    full = false,
  ): Promise<GoogleSyncResponse> {
    const config = readConfiguration(this.configPath);
    const refreshToken = this.#refreshToken(ownerId);
    if (config === undefined || refreshToken === undefined)
      return { status: this.status(ownerId), resetCalendars: [] };

    const grant = await refreshGoogleAccess(config, refreshToken, this.fetcher);
    if (grant === "invalid_grant") {
      this.database.markGoogleConnectorState(
        ownerId,
        "reconnect_required",
        now.toISOString(),
      );
      return { status: this.status(ownerId), resetCalendars: [] };
    }
    if (grant === undefined) {
      this.database.markGoogleConnectorState(
        ownerId,
        "stale",
        now.toISOString(),
      );
      return { status: this.status(ownerId), resetCalendars: [] };
    }

    const discovered = await listGoogleCalendars(
      grant.accessToken,
      this.fetcher,
    );
    if (discovered === undefined) {
      this.database.markGoogleConnectorState(
        ownerId,
        "stale",
        now.toISOString(),
      );
      return { status: this.status(ownerId), resetCalendars: [] };
    }

    const connector = this.database.getGoogleConnector(ownerId);
    if (connector === undefined)
      return { status: this.status(ownerId), resetCalendars: [] };
    const provider = this.database.ensureCalendarProvider(
      ownerId,
      "google",
      connector.id,
      now.toISOString(),
    );
    const active = discovered.filter(
      ({ deleted, accessRole }) => !deleted && accessRole !== "freeBusyReader",
    );
    const collections = this.database.putCalendarCollections(
      provider.id,
      active.map((calendar) => ({
        href: calendar.id,
        displayName: calendar.summary,
        supportsEvents: true,
        supportsTodos: false,
      })),
      now.toISOString(),
    );
    this.database.pruneGoogleCalendars(
      ownerId,
      provider.id,
      active.map(({ id }) => id),
    );
    const priorByExternal = new Map(
      this.database
        .listGoogleCalendarSync(ownerId)
        .map((item) => [item.externalCalendarId, item]),
    );
    const resetCalendars: string[] = [];
    let failed = false;

    for (const [index, calendar] of active.entries()) {
      const collection = collections[index];
      if (collection === undefined) continue;
      const prior = priorByExternal.get(calendar.id);
      let result = await syncGoogleEvents(
        grant.accessToken,
        calendar.id,
        full ? null : (prior?.syncToken ?? null),
        this.fetcher,
      );
      let reset = full;
      if (full) resetCalendars.push(collection.id);
      if (result.kind === "reset-required") {
        reset = true;
        resetCalendars.push(collection.id);
        result = await syncGoogleEvents(
          grant.accessToken,
          calendar.id,
          null,
          this.fetcher,
        );
      }
      if (result.kind === "ok") {
        this.database.applyGoogleEventSync({
          ownerId,
          calendarId: collection.id,
          externalCalendarId: calendar.id,
          providerId: provider.id,
          syncToken: result.nextSyncToken,
          reset,
          events: result.events.map((event) => ({
            id: event.id,
            uid: event.iCalUid,
            etag: event.etag,
            summary: event.summary,
            startsAt: event.startsAt,
            endsAt: event.endsAt,
            allDay: event.allDay,
            recurrence: event.recurrence,
            deleted: event.deleted,
            rawIcs: eventIcs({
              uid: event.iCalUid,
              summary: event.summary,
              startsAt: event.startsAt,
              endsAt: event.endsAt,
              allDay: event.allDay,
            }),
          })),
          now: now.toISOString(),
        });
      } else {
        failed = true;
        if (prior === undefined)
          this.database.putGoogleCalendarSync({
            calendarId: collection.id,
            ownerId,
            externalCalendarId: calendar.id,
            syncToken: null,
            state: "unavailable",
            lastSuccessfulSyncAt: null,
            lastAttemptAt: now.toISOString(),
            errorCode: result.kind,
          });
        else
          this.database.markGoogleCalendarSyncFailure(
            ownerId,
            collection.id,
            "stale",
            result.kind,
            now.toISOString(),
          );
      }
    }

    this.database.putGoogleConnector({
      ...connector,
      accountLabel:
        active.find(({ primary }) => primary)?.id ?? connector.accountLabel,
      state: failed ? "stale" : "connected",
      updatedAt: now.toISOString(),
    });
    return { status: this.status(ownerId), resetCalendars };
  }

  async disconnect(ownerId: string): Promise<{
    readonly disconnected: boolean;
    readonly remoteRevoked: boolean;
  }> {
    const token = this.#refreshToken(ownerId);
    const remoteRevoked =
      token === undefined
        ? false
        : await revokeGoogleGrant(token, this.fetcher).catch(() => false);
    const disconnected = this.database.disconnectGoogle(ownerId);
    return { disconnected, remoteRevoked };
  }
}
