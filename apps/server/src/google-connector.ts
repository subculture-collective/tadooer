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
  buildGoogleAuthorizationUrl,
  evaluateGoogleWriteCapability,
  exchangeGoogleCode,
  hasGoogleReadScopes,
  hasGoogleWriteScope,
  listGoogleCalendars,
  refreshGoogleAccess,
  revokeGoogleGrant,
  syncGoogleEvents,
  type GoogleAccessRequest,
  type GoogleOAuthClientConfig,
  type GoogleWriteCapability,
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

  /**
   * Starts an owner authorization. `write` is the explicit consent step of
   * ADR 0040; the requested access is bound to the digested state so the
   * callback cannot be upgraded after the fact.
   */
  begin(
    ownerId: string,
    access: GoogleAccessRequest = "read",
    now = new Date(),
  ):
    | { readonly authorizationUrl: string; readonly expiresAt: string }
    | undefined {
    const config = readConfiguration(this.configPath);
    if (config === undefined) return undefined;
    // A write consent step extends an existing connection; it never creates one.
    if (
      access === "write" &&
      this.database.getGoogleConnector(ownerId) === undefined
    )
      return undefined;
    const state = randomBytes(32).toString("base64url");
    const expiresAt = new Date(now.getTime() + 10 * 60_000).toISOString();
    this.database.createGoogleOAuthState({
      stateHash: createHash("sha256").update(state).digest("base64url"),
      ownerId,
      expiresAt,
      createdAt: now.toISOString(),
      requestedAccess: access,
    });
    return {
      authorizationUrl: buildGoogleAuthorizationUrl(config, state, access),
      expiresAt,
    };
  }

  async complete(
    state: string,
    code: string,
    now = new Date(),
  ): Promise<
    | {
        readonly ownerId: string;
        readonly access: GoogleAccessRequest;
        readonly writeGranted: boolean;
      }
    | undefined
  > {
    const config = readConfiguration(this.configPath);
    const request = this.database.consumeGoogleOAuthRequest(
      createHash("sha256").update(state).digest("base64url"),
      now.toISOString(),
    );
    if (config === undefined || request === undefined) return undefined;
    const { ownerId, requestedAccess } = request;
    const grant = await exchangeGoogleCode(config, code, this.fetcher);
    if (grant?.refreshToken == null || !hasGoogleReadScopes(grant.scopes))
      return undefined;
    // Consent belongs to the grant that carried it: only a write request whose
    // grant actually includes the write scope records it. Any other
    // authorization, including a read-only reconnect, clears it.
    const writeGranted =
      requestedAccess === "write" && hasGoogleWriteScope(grant.scopes);

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
      writeConsentAt: writeGranted ? now.toISOString() : null,
    });
    await this.synchronize(ownerId, now);
    return { ownerId, access: requestedAccess, writeGranted };
  }

  /**
   * Withdraws owner write consent locally. Writes stop immediately; Google
   * keeps the scope until disconnect revokes the grant (ADR 0040).
   */
  withdrawWriteConsent(
    ownerId: string,
    now = new Date(),
  ): GoogleConnectorStatusResponse | undefined {
    return this.database.setGoogleWriteConsent(ownerId, null, now.toISOString())
      ? this.status(ownerId, now)
      : undefined;
  }

  /**
   * The single write gate for Google calendars (ADR 0040). Every write path —
   * time blocks today, bridge dispatch in #40/#46 — must call it before
   * reserving work or contacting Google.
   */
  writeCapability(ownerId: string, calendarId: string): GoogleWriteCapability {
    const connector = this.database.getGoogleConnector(ownerId);
    const role =
      this.database
        .listGoogleCalendarCapabilities(ownerId)
        .find((item) => item.calendarId === calendarId)?.accessRole ?? null;
    return evaluateGoogleWriteCapability({
      connectorState: connector?.state ?? "disconnected",
      writeConsentAt: connector?.writeConsentAt ?? null,
      grantedScopes: connector?.grantedScopes ?? [],
      accessRole: role,
    });
  }

  status(ownerId: string, now = new Date()): GoogleConnectorStatusResponse {
    const connector = this.database.getGoogleConnector(ownerId);
    const calendars = this.database.listOwnedCalendars(ownerId, "google");
    const sync = this.database.listGoogleCalendarSync(ownerId);
    const roles = new Map(
      this.database
        .listGoogleCalendarCapabilities(ownerId)
        .map((item) => [item.calendarId, item.accessRole]),
    );
    const consentedAt = connector?.writeConsentAt ?? null;
    const scopeGranted =
      connector !== undefined && hasGoogleWriteScope(connector.grantedScopes);
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
      write: {
        consent:
          consentedAt === null
            ? "none"
            : scopeGranted && connector.state !== "reconnect_required"
              ? "granted"
              : "lost",
        consentedAt,
        scopeGranted,
      },
      capabilities: calendars.map(({ id }) => {
        const accessRole = roles.get(id) ?? null;
        const capability = evaluateGoogleWriteCapability({
          connectorState: connector?.state ?? "disconnected",
          writeConsentAt: consentedAt,
          grantedScopes: connector?.grantedScopes ?? [],
          accessRole,
        });
        return {
          calendarId: id,
          accessRole,
          writable: capability.writable,
          reason: capability.writable ? null : capability.reason,
        };
      }),
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
    // Downgrade handling (ADR 0040): the refreshed grant is authoritative for
    // scopes. A narrowed grant replaces the stored scopes at once, so the
    // write gate refuses before any other work, while recorded consent stays
    // visible as "lost".
    const refreshed = this.database.getGoogleConnector(ownerId);
    if (
      refreshed !== undefined &&
      [...refreshed.grantedScopes].sort().join(" ") !==
        [...grant.scopes].sort().join(" ")
    )
      this.database.putGoogleConnector({
        ...refreshed,
        grantedScopes: grant.scopes,
        updatedAt: now.toISOString(),
      });

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
    // Roles are re-observed on every discovery, so a calendar narrowed to
    // `reader` becomes read-only immediately.
    this.database.putGoogleCalendarCapabilities(
      ownerId,
      active.flatMap((calendar, index) => {
        const collection = collections[index];
        return collection === undefined
          ? []
          : [{ calendarId: collection.id, accessRole: calendar.accessRole }];
      }),
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
