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
  listGoogleEventsByICalUid,
  updateGoogleEvent,
  type GoogleEventResource,
  type GoogleEventWriteResult,
} from "@suite/google-calendar";
import {
  calDavEventIcs,
  googleEventBody,
  googleInstanceBody,
  googleInstanceId,
  masterDigest,
  normalizeCalDavEvent,
  normalizeGoogleEvent,
  normalizeGoogleSeries,
  type BridgeEnvelope,
} from "./envelope.ts";
import type {
  BridgeObservation,
  BridgeReadResult,
  BridgeSide,
  BridgeWriteResult,
} from "./ports.ts";

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

/** A Google master with its exception events (ADR 0042). */
interface GoogleSeries {
  readonly master: GoogleEventResource;
  readonly exceptions: readonly GoogleEventResource[];
}

/**
 * Opaque series revision: the master ETag alone when there are no
 * exceptions (the ADR 0041 form), otherwise the master ETag and every
 * exception's ID and ETag.
 */
const seriesRevision = (series: GoogleSeries): string =>
  series.exceptions.length === 0
    ? series.master.etag
    : JSON.stringify([
        series.master.etag,
        series.exceptions
          .map((event) => [event.id, event.etag])
          .toSorted(([a], [b]) => ((a ?? "") < (b ?? "") ? -1 : 1)),
      ]);

const masterEtag = (revision: string): string => {
  if (!revision.startsWith("[")) return revision;
  try {
    const parsed = JSON.parse(revision) as unknown;
    return Array.isArray(parsed) && typeof parsed[0] === "string"
      ? parsed[0]
      : revision;
  } catch {
    return revision;
  }
};

const seriesObservation = (series: GoogleSeries): BridgeObservation => ({
  kind: "present",
  nativeId: series.master.id,
  revision: seriesRevision(series),
  event: normalizeGoogleSeries(
    series.master.raw,
    series.exceptions.map((event) => event.raw),
  ),
});

type SeriesRead =
  | { readonly kind: "series"; readonly series: GoogleSeries }
  | {
      readonly kind: "deleted";
      readonly proof: string;
      /** The master does not exist in this calendar at all. */
      readonly missing: boolean;
    }
  | { readonly kind: "unavailable"; readonly reason: string };

const isSeriesMaster = (event: GoogleEventResource): boolean =>
  Array.isArray(event.raw.recurrence) &&
  typeof event.raw.recurringEventId !== "string";

/** Google side over the Calendar API with a client-reserved event ID. */
export const createGoogleBridgeSide = (options: {
  readonly accessToken: string;
  readonly calendarId: string;
  readonly fetch?: typeof fetch;
}): BridgeSide => {
  const fetcher = options.fetch ?? fetch;
  const { accessToken, calendarId } = options;

  /** The master and all of its exceptions, cancelled ones included. */
  const readSeries = async (masterId: string): Promise<SeriesRead> => {
    const result = await getGoogleEvent(
      accessToken,
      calendarId,
      masterId,
      fetcher,
    );
    if (result.kind === "gone")
      return { kind: "deleted", proof: "gone", missing: true };
    if (result.kind === "failed")
      return { kind: "unavailable", reason: `google-${result.reason}` };
    const master = result.event;
    if (master.cancelled)
      return { kind: "deleted", proof: master.etag, missing: false };
    const uid = master.raw.iCalUID;
    if (!isSeriesMaster(master) || typeof uid !== "string")
      return { kind: "series", series: { master, exceptions: [] } };
    const listed = await listGoogleEventsByICalUid(
      accessToken,
      calendarId,
      uid,
      fetcher,
    );
    if (listed.kind === "failed")
      return { kind: "unavailable", reason: `google-${listed.reason}` };
    return {
      kind: "series",
      series: {
        master,
        exceptions: listed.events.filter(
          (event) => event.raw.recurringEventId === masterId,
        ),
      },
    };
  };

  const observe = (nativeId: string, read: SeriesRead): BridgeReadResult =>
    read.kind === "series"
      ? seriesObservation(read.series)
      : read.kind === "deleted"
        ? { kind: "deleted", nativeId, proof: read.proof }
        : read;

  /** ETag of one instance, read when the series did not list it. */
  const instanceEtag = async (
    known: ReadonlyMap<string, string>,
    instanceId: string,
  ): Promise<string | undefined> => {
    const etag = known.get(instanceId);
    if (etag !== undefined) return etag;
    const result = await getGoogleEvent(
      accessToken,
      calendarId,
      instanceId,
      fetcher,
    );
    return result.kind === "found" ? result.event.etag : undefined;
  };

  /**
   * Brings every instance of a written master to the envelope: modified
   * instances, reverted ones and cancelled live exceptions. Runs after the
   * master write committed, so any failure is reported as uncertain.
   */
  const writeInstances = async (
    masterId: string,
    envelope: BridgeEnvelope,
    current: BridgeEnvelope | undefined,
    known: ReadonlyMap<string, string>,
  ): Promise<BridgeWriteResult> => {
    const desired = envelope.recurrence?.overrides ?? {};
    const existing = current?.recurrence?.overrides ?? {};
    const exdates = new Set(envelope.recurrence?.exdates ?? []);
    const keys = [
      ...new Set([...Object.keys(desired), ...Object.keys(existing)]),
    ].toSorted();
    for (const key of keys) {
      const want = desired[key];
      const have = existing[key];
      if (
        want !== undefined &&
        have !== undefined &&
        JSON.stringify(want) === JSON.stringify(have)
      )
        continue;
      const instanceId = googleInstanceId(masterId, envelope, key);
      const etag = await instanceEtag(known, instanceId);
      if (etag === undefined)
        return { kind: "uncertain", reason: "google-instance-unreadable" };
      const result =
        want === undefined && exdates.has(key)
          ? await deleteGoogleEvent(
              accessToken,
              calendarId,
              instanceId,
              etag,
              fetcher,
            )
          : await updateGoogleEvent(
              accessToken,
              calendarId,
              instanceId,
              etag,
              googleInstanceBody(masterId, envelope, key),
              fetcher,
            );
      if (result.kind !== "ok" && result.kind !== "gone")
        return { kind: "uncertain", reason: "google-series-partial" };
    }
    return { kind: "ok" };
  };

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
      // Any change to a master or an exception rereads the whole series.
      const events = new Map<string, BridgeObservation>();
      const series = new Map<string, GoogleEventResource[]>();
      for (const event of result.events) {
        const parent = event.raw.recurringEventId;
        if (typeof parent === "string") {
          series.set(parent, [...(series.get(parent) ?? []), event]);
          continue;
        }
        if (event.cancelled)
          events.set(event.id, {
            kind: "deleted",
            nativeId: event.id,
            proof: event.etag,
          });
        else if (isSeriesMaster(event)) series.set(event.id, []);
        else
          events.set(event.id, {
            kind: "present",
            nativeId: event.id,
            revision: event.etag,
            event: normalizeGoogleEvent(event.raw),
          });
      }
      for (const [masterId, instances] of series) {
        if (events.has(masterId)) continue;
        const read = await readSeries(masterId);
        if (read.kind === "unavailable") return read;
        if (read.kind === "deleted" && read.missing) {
          // Instances of a series outside this calendar stand alone and
          // are blocked as recurring instances.
          for (const instance of instances)
            if (!instance.cancelled)
              events.set(instance.id, {
                kind: "present",
                nativeId: instance.id,
                revision: instance.etag,
                event: normalizeGoogleEvent(instance.raw),
              });
          continue;
        }
        const observation = observe(masterId, read);
        if (observation.kind !== "unavailable")
          events.set(masterId, observation);
      }
      return {
        kind: "ok",
        events: [...events.values()],
        cursor: result.nextSyncToken,
        incremental: cursor !== null,
      };
    },
    async read(nativeId) {
      return observe(nativeId, await readSeries(nativeId));
    },
    // Link IDs are UUIDs; lowercase hex without dashes is valid base32hex.
    reserveNativeId: (linkId) => linkId.replaceAll("-", "").toLowerCase(),
    async create(nativeId, _uid, envelope) {
      const inserted = googleWrite(
        await insertGoogleEvent(
          accessToken,
          calendarId,
          nativeId,
          googleEventBody(envelope),
          fetcher,
        ),
      );
      if (Object.keys(envelope.recurrence?.overrides ?? {}).length === 0)
        return inserted;
      if (inserted.kind === "exists") {
        // A retried create resumes only on its own unchanged master.
        const read = await readSeries(nativeId);
        if (
          read.kind !== "series" ||
          normalizeGoogleEvent(read.series.master.raw).digest !==
            masterDigest(envelope)
        )
          return inserted;
        return writeInstances(
          nativeId,
          envelope,
          normalizeGoogleSeries(
            read.series.master.raw,
            read.series.exceptions.map((event) => event.raw),
          ).envelope,
          new Map(
            read.series.exceptions.map((event) => [event.id, event.etag]),
          ),
        );
      }
      if (inserted.kind !== "ok") return inserted;
      return writeInstances(nativeId, envelope, undefined, new Map());
    },
    async update(nativeId, _uid, expectedRevision, envelope) {
      if (envelope.recurrence === null && !expectedRevision.startsWith("["))
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
      // A series: a change to any instance since the observation fails the
      // precondition, not only a change to the master.
      const read = await readSeries(nativeId);
      if (read.kind === "unavailable")
        return { kind: "retry", reason: read.reason };
      if (read.kind === "deleted") return { kind: "gone" };
      if (seriesRevision(read.series) !== expectedRevision)
        return { kind: "precondition-failed" };
      const master = googleWrite(
        await updateGoogleEvent(
          accessToken,
          calendarId,
          nativeId,
          masterEtag(expectedRevision),
          googleEventBody(envelope),
          fetcher,
        ),
      );
      if (master.kind !== "ok") return master;
      return writeInstances(
        nativeId,
        envelope,
        normalizeGoogleSeries(
          read.series.master.raw,
          read.series.exceptions.map((event) => event.raw),
        ).envelope,
        new Map(read.series.exceptions.map((event) => [event.id, event.etag])),
      );
    },
    async delete(nativeId, expectedRevision) {
      // Deleting the master cancels the whole series.
      return googleWrite(
        await deleteGoogleEvent(
          accessToken,
          calendarId,
          nativeId,
          masterEtag(expectedRevision),
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
