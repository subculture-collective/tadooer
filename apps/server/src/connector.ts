import {
  constants,
  chmodSync,
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import type {
  BaikalProbeResponse,
  BaikalStatusResponse,
  CalendarCollection,
} from "@suite/contracts";
import {
  createCalDavEvent,
  deleteCalDavEvent,
  discoverCalDavCalendars,
  probeCalDavEndpoint,
  readBoundedCalDavEvents,
  replaceCalDavEvent,
  serializeBoundedVEvent,
  type CalendarEventResource,
  type CalDavEventFailure,
  type CalDavDiscoveryFailure,
} from "@suite/caldav";
import type {
  BaikalConnectorRecord,
  OwnedCalendarRecord,
  SuiteDatabase,
} from "@suite/persistence";

const keyBytes = 32;

const readKey = (path: string): Buffer => {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const status = fstatSync(descriptor);
    if (!status.isFile() || (status.mode & 0o077) !== 0 || status.size > 128)
      throw new Error();
    const encoded = readFileSync(descriptor, "utf8").trimEnd();
    const key = Buffer.from(encoded, "base64url");
    if (key.length !== keyBytes || key.toString("base64url") !== encoded)
      throw new Error();
    return key;
  } catch {
    throw new Error("Connector credential key is unavailable");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
};

export const loadOrCreateCredentialKey = (path: string): Buffer => {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  try {
    const descriptor = openSync(
      path,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      writeFileSync(
        descriptor,
        `${randomBytes(keyBytes).toString("base64url")}\n`,
        "utf8",
      );
    } finally {
      closeSync(descriptor);
    }
    chmodSync(path, 0o600);
  } catch (error: unknown) {
    const code =
      error instanceof Error && "code" in error ? String(error.code) : "";
    if (code !== "EEXIST") throw error;
  }
  return readKey(path);
};

const aad = (
  ownerId: string,
  endpoint: string,
  username: string,
  keyId: string,
): Buffer =>
  Buffer.from(
    `suite-baikal-v1\0${ownerId}\0${endpoint}\0${username}\0${keyId}`,
    "utf8",
  );

export type ConnectorFailure =
  CalDavDiscoveryFailure | "credential-unavailable";

export type CalendarOperationFailure =
  ConnectorFailure | CalDavEventFailure | "calendar-not-found";

export type CalendarOperationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: CalendarOperationFailure };

export type ConnectorResult =
  | { readonly ok: true; readonly status: BaikalStatusResponse }
  | { readonly ok: false; readonly reason: ConnectorFailure };

export class BaikalConnectorService {
  readonly #key: Buffer;
  readonly #keyId: string;

  constructor(
    private readonly database: SuiteDatabase,
    private readonly endpoint: URL,
    keyPath: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.#key = loadOrCreateCredentialKey(keyPath);
    this.#keyId = createHash("sha256")
      .update(this.#key)
      .digest("base64url")
      .slice(0, 22);
  }

  async connect(
    ownerId: string,
    username: string,
    password: string,
  ): Promise<ConnectorResult> {
    const discovery = await this.#discover(username, password);
    if (!discovery.ok) return discovery;

    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key, nonce);
    cipher.setAAD(aad(ownerId, this.endpoint.href, username, this.#keyId));
    const ciphertext = Buffer.concat([
      cipher.update(password, "utf8"),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    const now = new Date().toISOString();
    const connectorId = randomUUID();
    this.database.putBaikalConnector({
      id: connectorId,
      ownerId,
      endpoint: this.endpoint.href,
      username,
      credentialKeyId: this.#keyId,
      credentialNonce: nonce,
      credentialCiphertext: ciphertext,
      credentialTag: tag,
      verifiedAt: now,
      updatedAt: now,
    });
    const stored = this.database.getBaikalConnector(ownerId);
    if (stored === undefined)
      throw new Error("Stored Baikal connector could not be read");
    return this.#connectedStatus(
      ownerId,
      stored.id,
      username,
      now,
      discovery.calendars,
    );
  }

  /**
   * Read-only setup check for the configured endpoint (ADR 0039): CalDAV
   * capability, discovery and per-calendar privileges. Nothing is stored and
   * the result never contains the password.
   */
  async probe(
    username: string,
    password: string,
  ): Promise<
    | { readonly ok: true; readonly probe: BaikalProbeResponse }
    | { readonly ok: false; readonly reason: CalDavDiscoveryFailure }
  > {
    const result = await this.#withTimeout((signal) =>
      probeCalDavEndpoint({
        endpoint: this.endpoint,
        username,
        password,
        fetch: this.fetcher,
        signal,
      }),
    );
    if (!result.ok) return result;
    return {
      ok: true,
      probe: {
        endpoint: this.endpoint.href,
        davClasses: result.davClasses.slice(0, 64),
        principalHref: result.principalUrl.pathname,
        calendarHomeHref: result.calendarHomeUrl.pathname,
        calendars: result.calendars.map((calendar) => ({
          href: calendar.href,
          displayName: calendar.displayName,
          supportsEvents: calendar.supportsEvents,
          supportsTodos: calendar.supportsTodos,
          privileges: calendar.privileges?.slice(0, 64) ?? null,
          canRead: calendar.canRead,
          canWrite: calendar.canWrite,
        })),
        writableEventCalendars: result.calendars.filter(
          (calendar) => calendar.supportsEvents && calendar.canWrite === true,
        ).length,
      },
    };
  }

  async status(ownerId: string): Promise<ConnectorResult> {
    const connector = this.database.getBaikalConnector(ownerId);
    if (connector === undefined) {
      return {
        ok: true,
        status: {
          connected: false,
          providerId: null,
          endpoint: this.endpoint.href,
          username: null,
          verifiedAt: null,
          calendars: [],
        },
      };
    }
    if (
      connector.endpoint !== this.endpoint.href ||
      connector.credentialKeyId !== this.#keyId
    ) {
      return { ok: false, reason: "credential-unavailable" };
    }
    try {
      const decipher = createDecipheriv(
        "aes-256-gcm",
        this.#key,
        connector.credentialNonce,
      );
      decipher.setAAD(
        aad(ownerId, connector.endpoint, connector.username, this.#keyId),
      );
      decipher.setAuthTag(Buffer.from(connector.credentialTag));
      const password = Buffer.concat([
        decipher.update(Buffer.from(connector.credentialCiphertext)),
        decipher.final(),
      ]).toString("utf8");
      const discovery = await this.#discover(connector.username, password);
      if (!discovery.ok) return discovery;
      return this.#connectedStatus(
        ownerId,
        connector.id,
        connector.username,
        connector.verifiedAt,
        discovery.calendars,
      );
    } catch {
      return { ok: false, reason: "credential-unavailable" };
    }
  }

  async projectEvents(
    ownerId: string,
    calendarId: string,
    from: string,
    to: string,
  ): Promise<CalendarOperationResult<readonly CalendarEventResource[]>> {
    const access = this.#calendarAccess(ownerId, calendarId);
    if (!access.ok) return access;
    const result = await this.#withTimeout((signal) =>
      readBoundedCalDavEvents({
        collectionUrl: access.collectionUrl,
        username: access.connector.username,
        password: access.password,
        startsAt: from,
        endsAt: to,
        fetch: this.fetcher,
        signal,
      }),
    );
    return result.ok ? { ok: true, value: result.value } : result;
  }

  async putTaskBlock(input: {
    readonly ownerId: string;
    readonly calendarId: string;
    readonly href: string;
    readonly uid: string;
    readonly summary: string;
    readonly startsAt: string;
    readonly endsAt: string;
    readonly expectedEtag?: string;
  }): Promise<CalendarOperationResult<CalendarEventResource>> {
    const access = this.#calendarAccess(input.ownerId, input.calendarId);
    if (!access.ok) return access;
    const rawIcs = serializeBoundedVEvent({
      uid: input.uid,
      summary: input.summary,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      allDay: false,
    });
    if (rawIcs === undefined) return { ok: false, reason: "invalid-protocol" };
    const write = await this.#withTimeout((signal) =>
      input.expectedEtag === undefined
        ? createCalDavEvent({
            collectionUrl: access.collectionUrl,
            username: access.connector.username,
            password: access.password,
            href: input.href,
            rawIcs,
            fetch: this.fetcher,
            signal,
          })
        : replaceCalDavEvent({
            collectionUrl: access.collectionUrl,
            username: access.connector.username,
            password: access.password,
            href: input.href,
            rawIcs,
            expectedEtag: input.expectedEtag,
            fetch: this.fetcher,
            signal,
          }),
    );
    if (!write.ok && write.reason !== "precondition-failed") return write;
    if (!write.ok && input.expectedEtag !== undefined) return write;

    const observed = await this.projectEvents(
      input.ownerId,
      input.calendarId,
      new Date(Date.parse(input.startsAt) - 60 * 60 * 1000).toISOString(),
      new Date(Date.parse(input.endsAt) + 60 * 60 * 1000).toISOString(),
    );
    if (!observed.ok) return observed;
    const event = observed.value.find(
      (candidate) =>
        candidate.href === input.href && candidate.event.uid === input.uid,
    );
    return event === undefined
      ? { ok: false, reason: "outcome-unknown" }
      : { ok: true, value: event };
  }

  async putImportedEvent(input: {
    readonly ownerId: string;
    readonly calendarId: string;
    readonly href: string;
    readonly rawIcs: string;
  }): Promise<CalendarOperationResult<void>> {
    const access = this.#calendarAccess(input.ownerId, input.calendarId);
    if (!access.ok) return access;
    return this.#withTimeout((signal) =>
      createCalDavEvent({
        collectionUrl: access.collectionUrl,
        username: access.connector.username,
        password: access.password,
        href: input.href,
        rawIcs: input.rawIcs,
        fetch: this.fetcher,
        signal,
      }),
    );
  }

  async deleteTaskBlock(input: {
    readonly ownerId: string;
    readonly calendarId: string;
    readonly href: string;
    readonly expectedEtag: string;
  }): Promise<CalendarOperationResult<void>> {
    const access = this.#calendarAccess(input.ownerId, input.calendarId);
    if (!access.ok) return access;
    return this.#withTimeout((signal) =>
      deleteCalDavEvent({
        collectionUrl: access.collectionUrl,
        username: access.connector.username,
        password: access.password,
        href: input.href,
        expectedEtag: input.expectedEtag,
        fetch: this.fetcher,
        signal,
      }),
    );
  }

  async #discover(
    username: string,
    password: string,
  ): Promise<
    | {
        readonly ok: true;
        readonly calendars: readonly Omit<
          CalendarCollection,
          "id" | "providerId"
        >[];
      }
    | { readonly ok: false; readonly reason: CalDavDiscoveryFailure }
  > {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const result = await discoverCalDavCalendars({
        endpoint: this.endpoint,
        username,
        password,
        fetch: this.fetcher,
        signal: controller.signal,
      });
      return result.ok
        ? {
            ok: true,
            calendars: result.collections.map((calendar) => ({
              href: calendar.href,
              displayName: calendar.displayName,
              supportsEvents: calendar.supportsEvents,
              supportsTodos: calendar.supportsTodos,
            })),
          }
        : result;
    } finally {
      clearTimeout(timeout);
    }
  }

  #calendarAccess(
    ownerId: string,
    calendarId: string,
  ):
    | {
        readonly ok: true;
        readonly connector: BaikalConnectorRecord;
        readonly calendar: OwnedCalendarRecord;
        readonly collectionUrl: URL;
        readonly password: string;
      }
    | { readonly ok: false; readonly reason: CalendarOperationFailure } {
    const connector = this.database.getBaikalConnector(ownerId);
    const calendar = this.database.getOwnedCalendar(ownerId, calendarId);
    if (
      connector === undefined ||
      calendar === undefined ||
      !calendar.supportsEvents ||
      calendar.connectorId !== connector.id
    )
      return { ok: false, reason: "calendar-not-found" };
    if (
      connector.endpoint !== this.endpoint.href ||
      connector.credentialKeyId !== this.#keyId
    )
      return { ok: false, reason: "credential-unavailable" };
    try {
      const decipher = createDecipheriv(
        "aes-256-gcm",
        this.#key,
        connector.credentialNonce,
      );
      decipher.setAAD(
        aad(ownerId, connector.endpoint, connector.username, this.#keyId),
      );
      decipher.setAuthTag(Buffer.from(connector.credentialTag));
      const password = Buffer.concat([
        decipher.update(Buffer.from(connector.credentialCiphertext)),
        decipher.final(),
      ]).toString("utf8");
      return {
        ok: true,
        connector,
        calendar,
        collectionUrl: new URL(calendar.href, connector.endpoint),
        password,
      };
    } catch {
      return { ok: false, reason: "credential-unavailable" };
    }
  }

  async #withTimeout<T>(
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      return await operation(controller.signal);
    } finally {
      clearTimeout(timeout);
    }
  }

  #connectedStatus(
    ownerId: string,
    connectorId: string,
    username: string,
    verifiedAt: string,
    calendars: readonly Omit<CalendarCollection, "id" | "providerId">[],
  ): ConnectorResult {
    const now = new Date().toISOString();
    const provider = this.database.ensureCalendarProvider(
      ownerId,
      "baikal",
      connectorId,
      now,
    );
    const storedCalendars = this.database.putCalendarCollections(
      provider.id,
      calendars,
      now,
    );
    return {
      ok: true,
      status: {
        connected: true,
        providerId: provider.id,
        endpoint: this.endpoint.href,
        username,
        verifiedAt,
        calendars: storedCalendars.map((calendar) => ({
          id: calendar.id,
          providerId: calendar.providerId,
          href: calendar.href,
          displayName: calendar.displayName,
          supportsEvents: calendar.supportsEvents,
          supportsTodos: calendar.supportsTodos,
        })),
      },
    };
  }
}
