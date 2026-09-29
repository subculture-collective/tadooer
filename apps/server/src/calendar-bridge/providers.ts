import {
  createCalDavEvent,
  deleteCalDavEvent,
  listCalDavResources,
  readCalDavResource,
  replaceCalDavEvent,
  type CalDavEventFailure,
  type CalDavRawResource,
} from "@suite/caldav";
import {
  deleteGoogleEvent,
  getGoogleEvent,
  insertGoogleEvent,
  listGoogleEventChanges,
  updateGoogleEvent,
  type GoogleEventResource,
  type GoogleEventWriteResult,
} from "@suite/google-calendar";
import {
  calDavEventIcs,
  googleEventBody,
  normalizeCalDavEvent,
  normalizeGoogleEvent,
} from "./envelope.ts";
import type {
  BridgeObservation,
  BridgeSide,
  BridgeWriteResult,
} from "./ports.ts";

const googleObservation = (event: GoogleEventResource): BridgeObservation =>
  event.cancelled
    ? { kind: "deleted", nativeId: event.id, proof: event.etag }
    : {
        kind: "present",
        nativeId: event.id,
        revision: event.etag,
        event: normalizeGoogleEvent(event.raw),
      };

const googleWrite = (result: GoogleEventWriteResult): BridgeWriteResult => {
  switch (result.kind) {
    case "ok":
    case "precondition-failed":
    case "exists":
    case "gone":
      return { kind: result.kind };
    case "failed":
      return result.reason === "outcome-unknown" ||
        result.reason === "invalid-response"
        ? { kind: "uncertain", reason: `google-${result.reason}` }
        : { kind: "retry", reason: `google-${result.reason}` };
  }
};

/** Google side over the Calendar API with a client-reserved event ID. */
export const createGoogleBridgeSide = (options: {
  readonly accessToken: string;
  readonly calendarId: string;
  readonly fetch?: typeof fetch;
}): BridgeSide => {
  const fetcher = options.fetch ?? fetch;
  const { accessToken, calendarId } = options;
  return {
    name: "google",
    async listChanges(cursor) {
      const result = await listGoogleEventChanges(
        accessToken,
        calendarId,
        cursor,
        fetcher,
      );
      if (result.kind === "reset-required") return result;
      if (result.kind === "failed")
        return { kind: "unavailable", reason: `google-${result.reason}` };
      return {
        kind: "ok",
        events: result.events.map(googleObservation),
        cursor: result.nextSyncToken,
        incremental: cursor !== null,
      };
    },
    async read(nativeId) {
      const result = await getGoogleEvent(
        accessToken,
        calendarId,
        nativeId,
        fetcher,
      );
      if (result.kind === "gone")
        return { kind: "deleted", nativeId, proof: "gone" };
      if (result.kind === "failed")
        return { kind: "unavailable", reason: `google-${result.reason}` };
      return googleObservation(result.event);
    },
    // Link IDs are UUIDs; lowercase hex without dashes is valid base32hex.
    reserveNativeId: (linkId) => linkId.replaceAll("-", "").toLowerCase(),
    async create(nativeId, _uid, envelope) {
      return googleWrite(
        await insertGoogleEvent(
          accessToken,
          calendarId,
          nativeId,
          googleEventBody(envelope),
          fetcher,
        ),
      );
    },
    async update(nativeId, _uid, expectedRevision, envelope) {
      return googleWrite(
        await updateGoogleEvent(
          accessToken,
          calendarId,
          nativeId,
          expectedRevision,
          googleEventBody(envelope),
          fetcher,
        ),
      );
    },
    async delete(nativeId, expectedRevision) {
      return googleWrite(
        await deleteGoogleEvent(
          accessToken,
          calendarId,
          nativeId,
          expectedRevision,
          fetcher,
        ),
      );
    },
  };
};

const calDavObservation = (resource: CalDavRawResource): BridgeObservation => ({
  kind: "present",
  nativeId: resource.href,
  revision: resource.etag,
  event: normalizeCalDavEvent(resource.rawIcs),
});

const calDavWrite = (
  reason: CalDavEventFailure,
  action: "create" | "update" | "delete",
): BridgeWriteResult => {
  switch (reason) {
    case "precondition-failed":
      // If-None-Match: * failing means the reserved href already exists.
      return action === "create"
        ? { kind: "exists" }
        : { kind: "precondition-failed" };
    case "not-found":
      return action === "create"
        ? { kind: "retry", reason: "baikal-not-found" }
        : { kind: "gone" };
    // Credentials and endpoint configuration (#35 adds redirects and
    // servers without CalDAV): the owner fixes them, then the pass retries.
    case "authentication-required":
    case "authorization-denied":
    case "unsafe-remote-url":
    case "redirected":
    case "caldav-unsupported":
      return { kind: "retry", reason: `baikal-${reason}` };
    case "remote-unavailable":
    case "transport-failed":
    case "outcome-unknown":
    case "invalid-protocol":
      return { kind: "uncertain", reason: `baikal-${reason}` };
  }
};

/** Default Baikal listing window around `now`: 90 days back, 270 ahead. */
export const bridgeWindow = (
  now: string,
): { readonly startsAt: string; readonly endsAt: string } => ({
  startsAt: new Date(Date.parse(now) - 90 * 86_400_000).toISOString(),
  endsAt: new Date(Date.parse(now) + 270 * 86_400_000).toISOString(),
});

/**
 * Baikal side over CalDAV. The listing is a bounded window, so the engine
 * reads linked events outside it by href before inferring anything.
 */
export const createCalDavBridgeSide = (options: {
  readonly collectionUrl: URL;
  readonly username: string;
  readonly password: string;
  readonly now: string;
  readonly fetch?: typeof fetch;
}): BridgeSide => {
  const fetcher = options.fetch ?? fetch;
  const access = {
    collectionUrl: options.collectionUrl,
    username: options.username,
    password: options.password,
    fetch: fetcher,
  };
  const collectionPath = options.collectionUrl.pathname.endsWith("/")
    ? options.collectionUrl.pathname
    : `${options.collectionUrl.pathname}/`;
  const signal = () => AbortSignal.timeout(15_000);
  return {
    name: "baikal",
    async listChanges() {
      const result = await listCalDavResources({
        ...access,
        ...bridgeWindow(options.now),
        signal: signal(),
      });
      return result.ok
        ? {
            kind: "ok",
            events: result.value.map(calDavObservation),
            cursor: null,
            incremental: false,
          }
        : { kind: "unavailable", reason: `baikal-${result.reason}` };
    },
    async read(nativeId) {
      const result = await readCalDavResource({
        ...access,
        href: nativeId,
        signal: signal(),
      });
      if (!result.ok)
        return { kind: "unavailable", reason: `baikal-${result.reason}` };
      return result.value === "gone"
        ? { kind: "deleted", nativeId, proof: "gone" }
        : calDavObservation(result.value);
    },
    reserveNativeId: (linkId) => `${collectionPath}${linkId}.ics`,
    async create(nativeId, uid, envelope) {
      const result = await createCalDavEvent({
        ...access,
        href: nativeId,
        rawIcs: calDavEventIcs(envelope, uid ?? nativeId, options.now),
        signal: signal(),
      });
      return result.ok ? { kind: "ok" } : calDavWrite(result.reason, "create");
    },
    async update(nativeId, uid, expectedRevision, envelope) {
      const result = await replaceCalDavEvent({
        ...access,
        href: nativeId,
        rawIcs: calDavEventIcs(envelope, uid ?? nativeId, options.now),
        expectedEtag: expectedRevision,
        signal: signal(),
      });
      return result.ok ? { kind: "ok" } : calDavWrite(result.reason, "update");
    },
    async delete(nativeId, expectedRevision) {
      const result = await deleteCalDavEvent({
        ...access,
        href: nativeId,
        expectedEtag: expectedRevision,
        signal: signal(),
      });
      return result.ok ? { kind: "ok" } : calDavWrite(result.reason, "delete");
    },
  };
};
