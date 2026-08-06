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
  BaikalStatusResponse,
  CalendarCollection,
} from "@suite/contracts";
import {
  discoverCalDavCalendars,
  type CalDavDiscoveryFailure,
} from "@suite/caldav";
import type { SuiteDatabase } from "@suite/persistence";

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
