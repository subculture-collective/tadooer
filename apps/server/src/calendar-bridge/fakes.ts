/**
 * In-memory Google Calendar and CalDAV servers for bridge tests (ADR 0041).
 * They implement the conditional semantics the adapters rely on: ETags,
 * If-Match/If-None-Match, client-chosen Google IDs (409 on reuse), cancelled
 * Google events, sync tokens with 410 expiry, and commit-then-lose-response.
 * The Google fake also models recurring series (ADR 0042): exception events
 * under instance IDs `<master>_<basic original start>`, readable before they
 * exist, listing by `iCalUID`, and cancelling a master cancels its
 * exceptions. No network access: each exposes a `fetch` function.
 */

const requestUrl = (input: string | URL | Request): URL =>
  input instanceof URL
    ? input
    : new URL(typeof input === "string" ? input : input.url);

const bodyText = (init: RequestInit | undefined): string =>
  typeof init?.body === "string" ? init.body : "";

type GoogleEvent = Record<string, unknown> & {
  id: string;
  etag: string;
  status: string;
};

export interface FakeGoogleCalendar {
  readonly fetch: typeof fetch;
  readonly calendarId: string;
  readonly events: Map<string, GoogleEvent>;
  readonly writes: { method: string; id: string; sendUpdates: string | null }[];
  /** Owner edits made directly in Google. */
  userCreate(id: string, fields: Record<string, unknown>): GoogleEvent;
  /**
   * Modifies one instance of a series, as the Google UI does: an exception
   * event with `recurringEventId` and `originalStartTime`.
   */
  userEditInstance(
    masterId: string,
    suffix: string,
    originalStartTime: Record<string, unknown>,
    fields: Record<string, unknown>,
  ): GoogleEvent;
  /** Deletes one instance: a cancelled exception event. */
  userCancelInstance(
    masterId: string,
    suffix: string,
    originalStartTime: Record<string, unknown>,
  ): GoogleEvent;
  userUpdate(id: string, fields: Record<string, unknown>): GoogleEvent;
  userDelete(id: string): void;
  userRestore(id: string): void;
  /** Next write commits, then the response is lost. */
  loseNextWriteResponse(): void;
  expireSyncTokens(): void;
  setUnavailable(value: boolean): void;
  setAccessRole(role: "reader" | "writer" | "owner"): void;
  /** Extra token-endpoint scopes; used by the server route test. */
  grantScopes: string[];
}

export const createFakeGoogleCalendar = (
  calendarId = "owner@example.test",
): FakeGoogleCalendar => {
  const events = new Map<string, GoogleEvent>();
  const changeSequence = new Map<string, number>();
  const writes: { method: string; id: string; sendUpdates: string | null }[] =
    [];
  let sequence = 0;
  let etagVersion = 0;
  let loseResponse = false;
  let tokenFloor = 0;
  let unavailable = false;
  let accessRole: "reader" | "writer" | "owner" = "owner";

  const touch = (event: GoogleEvent): GoogleEvent => {
    etagVersion += 1;
    sequence += 1;
    event.etag = `"g${String(etagVersion)}"`;
    event.updated = new Date(
      Date.UTC(2026, 8, 1, 0, 0, sequence),
    ).toISOString();
    changeSequence.set(event.id, sequence);
    events.set(event.id, event);
    return event;
  };

  const base = (id: string): GoogleEvent => ({
    kind: "calendar#event",
    id,
    etag: "",
    status: "confirmed",
    iCalUID: `${id}@google.com`,
    htmlLink: `https://calendar.google.test/event?eid=${id}`,
    created: "2026-09-01T00:00:00.000Z",
    creator: { email: calendarId, self: true },
    organizer: { email: calendarId, self: true },
    sequence: 0,
    reminders: { useDefault: true },
    eventType: "default",
  });

  const accept = (fields: Record<string, unknown>) => {
    const copy = { ...fields };
    delete copy.id;
    delete copy.etag;
    delete copy.iCalUID;
    return copy;
  };

  /** Master of an instance ID, when it names a series in this calendar. */
  const masterOf = (id: string): GoogleEvent | undefined => {
    const cut = id.lastIndexOf("_");
    if (cut < 1 || !/^\d{8}(T\d{6}Z)?$/.test(id.slice(cut + 1)))
      return undefined;
    const master = events.get(id.slice(0, cut));
    return Array.isArray(master?.recurrence) ? master : undefined;
  };

  /** An exception event for a series instance. */
  const instanceOf = (
    master: GoogleEvent,
    id: string,
    fields: Record<string, unknown>,
  ): GoogleEvent => ({
    ...base(id),
    iCalUID: master.iCalUID,
    created: master.created,
    recurringEventId: master.id,
    ...fields,
  });

  /** A generated instance read by ID before it has any exception. */
  const virtualInstance = (master: GoogleEvent, id: string): GoogleEvent => ({
    ...base(id),
    iCalUID: master.iCalUID,
    recurringEventId: master.id,
    summary: master.summary,
    etag: `"v${master.etag.replaceAll('"', "")}-${id}"`,
  });

  const fake: FakeGoogleCalendar = {
    calendarId,
    events,
    writes,
    grantScopes: [],
    userCreate: (id, fields) => touch({ ...base(id), ...fields }),
    userEditInstance: (masterId, suffix, originalStartTime, fields) => {
      const master = events.get(masterId);
      if (master === undefined) throw new Error(`No Google event ${masterId}`);
      const id = `${masterId}_${suffix}`;
      return touch(
        instanceOf(master, id, {
          summary: master.summary,
          start: master.start,
          end: master.end,
          ...events.get(id),
          originalStartTime,
          ...fields,
          status: "confirmed",
        }),
      );
    },
    userCancelInstance: (masterId, suffix, originalStartTime) => {
      const master = events.get(masterId);
      if (master === undefined) throw new Error(`No Google event ${masterId}`);
      const id = `${masterId}_${suffix}`;
      return touch(
        instanceOf(master, id, {
          ...events.get(id),
          originalStartTime,
          status: "cancelled",
        }),
      );
    },
    userUpdate: (id, fields) => {
      const existing = events.get(id);
      if (existing === undefined) throw new Error(`No Google event ${id}`);
      return touch({ ...existing, ...fields });
    },
    userDelete: (id) => {
      const existing = events.get(id);
      if (existing === undefined) throw new Error(`No Google event ${id}`);
      touch({ ...existing, status: "cancelled" });
    },
    userRestore: (id) => {
      const existing = events.get(id);
      if (existing === undefined) throw new Error(`No Google event ${id}`);
      touch({ ...existing, status: "confirmed" });
    },
    loseNextWriteResponse: () => {
      loseResponse = true;
    },
    expireSyncTokens: () => {
      tokenFloor = sequence + 1;
    },
    setUnavailable: (value) => {
      unavailable = value;
    },
    setAccessRole: (role) => {
      accessRole = role;
    },
    fetch: async (input, init) => {
      await Promise.resolve();
      const url = requestUrl(input);
      const method = init?.method ?? "GET";
      if (url.href === "https://oauth2.googleapis.com/token")
        return Response.json({
          access_token: "bridge-access",
          refresh_token: "bridge-refresh-secret",
          expires_in: 3600,
          scope: [
            "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
            "https://www.googleapis.com/auth/calendar.events.readonly",
            ...fake.grantScopes,
          ].join(" "),
        });
      if (url.href === "https://oauth2.googleapis.com/revoke")
        return new Response(null, { status: 200 });
      if (
        url.href.startsWith(
          "https://www.googleapis.com/calendar/v3/users/me/calendarList",
        )
      )
        return Response.json({
          items: [
            {
              id: calendarId,
              etag: '"calendar-1"',
              summary: "Primary",
              accessRole,
              primary: true,
              timeZone: "UTC",
            },
          ],
        });
      const prefix = `/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`;
      if (
        url.origin !== "https://www.googleapis.com" ||
        !url.pathname.startsWith(prefix)
      )
        return new Response("", { status: 404 });
      if (unavailable) return new Response("", { status: 503 });
      const headers = new Headers(init?.headers);
      if (
        headers.get("authorization") !== "Bearer bridge-access" &&
        !headers.get("authorization")?.startsWith("Bearer access")
      )
        return new Response("", { status: 401 });
      const rest = url.pathname.slice(prefix.length);
      const eventId = rest.startsWith("/")
        ? decodeURIComponent(rest.slice(1))
        : undefined;

      if (eventId === undefined && method === "GET") {
        const token = url.searchParams.get("syncToken");
        let since = 0;
        if (token !== null) {
          since = Number(token.slice(1));
          if (!Number.isInteger(since) || since < tokenFloor)
            return new Response("", { status: 410 });
        }
        const uid = url.searchParams.get("iCalUID");
        const items = [...events.values()].filter(
          (event) =>
            (changeSequence.get(event.id) ?? 0) > since &&
            (uid === null || event.iCalUID === uid),
        );
        return Response.json({ items, nextSyncToken: `s${String(sequence)}` });
      }
      const respond = (response: Response): Response => {
        if (loseResponse) {
          loseResponse = false;
          throw new Error("synthetic response loss after commit");
        }
        return response;
      };
      if (eventId === undefined && method === "POST") {
        const body = JSON.parse(bodyText(init)) as Record<string, unknown>;
        const id = typeof body.id === "string" ? body.id : "";
        if (!/^[a-v0-9]{5,1024}$/.test(id))
          return new Response("", { status: 400 });
        if (events.has(id)) return new Response("", { status: 409 });
        writes.push({
          method,
          id,
          sendUpdates: url.searchParams.get("sendUpdates"),
        });
        const created = touch({ ...base(id), ...accept(body) });
        return respond(Response.json(created));
      }
      if (eventId === undefined) return new Response("", { status: 405 });
      const master = masterOf(eventId);
      const existing =
        events.get(eventId) ??
        (master === undefined ? undefined : virtualInstance(master, eventId));
      if (method === "GET")
        return existing === undefined
          ? new Response("", { status: 404 })
          : Response.json(existing);
      if (existing === undefined) return new Response("", { status: 404 });
      const ifMatch = headers.get("if-match");
      if (ifMatch !== existing.etag) return new Response("", { status: 412 });
      writes.push({
        method,
        id: eventId,
        sendUpdates: url.searchParams.get("sendUpdates"),
      });
      if (method === "PUT") {
        const body = JSON.parse(bodyText(init)) as Record<string, unknown>;
        const replaced: GoogleEvent = {
          ...base(eventId),
          iCalUID: existing.iCalUID,
          created: existing.created,
          ...(master === undefined ? {} : { recurringEventId: master.id }),
          ...accept(body),
        };
        return respond(Response.json(touch(replaced)));
      }
      if (method === "DELETE") {
        if (existing.status === "cancelled")
          return new Response("", { status: 410 });
        touch({ ...existing, status: "cancelled" });
        // Deleting a master cancels the whole series.
        for (const event of [...events.values()])
          if (
            event.recurringEventId === eventId &&
            event.status !== "cancelled"
          )
            touch({ ...event, status: "cancelled" });
        return respond(new Response(null, { status: 204 }));
      }
      return new Response("", { status: 405 });
    },
  };
  return fake;
};

export const calDavCollectionPath = "/dav.php/calendars/alice/work/";

const multiStatus = (body: string): Response =>
  new Response(
    `<?xml version="1.0"?><D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">${body}</D:multistatus>`,
    { status: 207, headers: { "content-type": "application/xml" } },
  );

export interface FakeCalDav {
  readonly fetch: typeof fetch;
  readonly resources: Map<string, { etag: string; rawIcs: string }>;
  readonly writes: { method: string; href: string }[];
  userPut(name: string, rawIcs: string): string;
  userDelete(href: string): void;
  loseNextWriteResponse(): void;
  setUnavailable(value: boolean): void;
  /** Reject writes with this status before committing (null: accept). */
  rejectWrites(status: number | null): void;
}

export const vevent = (fields: {
  readonly uid: string;
  readonly summary?: string;
  readonly start?: string;
  readonly end?: string;
  readonly extra?: readonly string[];
}): string =>
  [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Client//EN",
    "BEGIN:VEVENT",
    `UID:${fields.uid}`,
    "DTSTAMP:20260901T000000Z",
    `DTSTART:${fields.start ?? "20261001T150000Z"}`,
    `DTEND:${fields.end ?? "20261001T160000Z"}`,
    ...(fields.summary === undefined ? [] : [`SUMMARY:${fields.summary}`]),
    ...(fields.extra ?? []),
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\r\n");

export const createFakeCalDav = (): FakeCalDav => {
  const resources = new Map<string, { etag: string; rawIcs: string }>();
  const writes: { method: string; href: string }[] = [];
  let version = 0;
  let loseResponse = false;
  let unavailable = false;
  let rejectStatus: number | null = null;
  const store = (href: string, rawIcs: string): void => {
    version += 1;
    resources.set(href, { rawIcs, etag: `"b${String(version)}"` });
  };
  return {
    resources,
    writes,
    userPut: (name, rawIcs) => {
      const href = `${calDavCollectionPath}${name}`;
      store(href, rawIcs);
      return href;
    },
    userDelete: (href) => {
      resources.delete(href);
    },
    loseNextWriteResponse: () => {
      loseResponse = true;
    },
    setUnavailable: (value) => {
      unavailable = value;
    },
    rejectWrites: (status) => {
      rejectStatus = status;
    },
    fetch: async (input, init) => {
      await Promise.resolve();
      const url = requestUrl(input);
      const method = init?.method ?? "GET";
      if (unavailable) return new Response("", { status: 503 });
      if (rejectStatus !== null && (method === "PUT" || method === "DELETE"))
        return new Response("", { status: rejectStatus });
      if (method === "PROPFIND" && url.pathname === "/dav.php/")
        return multiStatus(
          `<D:response><D:href>/dav.php/</D:href><D:propstat><D:prop><D:current-user-principal><D:href>/dav.php/principals/alice/</D:href></D:current-user-principal></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`,
        );
      if (
        method === "PROPFIND" &&
        url.pathname === "/dav.php/principals/alice/"
      )
        return multiStatus(
          `<D:response><D:href>/dav.php/principals/alice/</D:href><D:propstat><D:prop><C:calendar-home-set><D:href>/dav.php/calendars/alice/</D:href></C:calendar-home-set></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`,
        );
      if (method === "PROPFIND" && url.pathname === "/dav.php/calendars/alice/")
        return multiStatus(
          `<D:response><D:href>${calDavCollectionPath}</D:href><D:propstat><D:prop><D:resourcetype><D:collection/><C:calendar/></D:resourcetype><D:displayname>Work</D:displayname><C:supported-calendar-component-set><C:comp name="VEVENT"/></C:supported-calendar-component-set></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`,
        );
      if (method === "REPORT" && url.pathname === calDavCollectionPath)
        return multiStatus(
          [...resources.entries()]
            .map(
              ([href, resource]) =>
                `<D:response><D:href>${href}</D:href><D:propstat><D:prop><D:getetag>${resource.etag}</D:getetag></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`,
            )
            .join(""),
        );
      const headers = new Headers(init?.headers);
      const existing = resources.get(url.pathname);
      if (method === "GET")
        return existing === undefined
          ? new Response("", { status: 404 })
          : new Response(existing.rawIcs, {
              status: 200,
              headers: { etag: existing.etag, "content-type": "text/calendar" },
            });
      const respond = (response: Response): Response => {
        if (loseResponse) {
          loseResponse = false;
          throw new Error("synthetic response loss after commit");
        }
        return response;
      };
      if (method === "PUT") {
        if (headers.get("if-none-match") === "*" && existing !== undefined)
          return new Response("", { status: 412 });
        if (
          headers.has("if-match") &&
          headers.get("if-match") !== existing?.etag
        )
          return new Response("", { status: 412 });
        writes.push({ method, href: url.pathname });
        store(url.pathname, bodyText(init));
        return respond(new Response(null, { status: 201 }));
      }
      if (method === "DELETE") {
        if (existing === undefined) return new Response("", { status: 404 });
        if (headers.get("if-match") !== existing.etag)
          return new Response("", { status: 412 });
        writes.push({ method, href: url.pathname });
        resources.delete(url.pathname);
        return respond(new Response(null, { status: 204 }));
      }
      return new Response("", { status: 405 });
    },
  };
};
