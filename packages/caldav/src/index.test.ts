import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  createCalDavEvent,
  deleteCalDavEvent,
  discoverCalDavCalendars,
  parseBoundedVEvent,
  probeCalDavEndpoint,
  readBoundedCalDavEvents,
  replaceCalDavEvent,
  serializeBoundedVEvent,
  summarizeCalDavPrivileges,
} from "./index.ts";

const fixture = (name: string): string =>
  readFileSync(new URL(`../test-fixtures/${name}`, import.meta.url), "utf8");

const requestUrl = (input: RequestInfo | URL): string =>
  input instanceof URL
    ? input.href
    : typeof input === "string"
      ? input
      : input.url;

describe("CalDAV discovery", () => {
  it("discovers event and todo support without following cross-origin hrefs", async () => {
    const responses = new Map([
      ["http://baikal.test/dav.php/", fixture("principal.xml")],
      [
        "http://baikal.test/dav.php/principals/alice/",
        fixture("calendar-home.xml"),
      ],
      [
        "http://baikal.test/dav.php/calendars/alice/",
        fixture("collections.xml"),
      ],
    ]);
    const requests: string[] = [];
    const result = await discoverCalDavCalendars({
      endpoint: new URL("http://baikal.test/dav.php/"),
      username: "alice",
      password: "secret",
      fetch: (input, init) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input.url;
        requests.push(url);
        expect(init?.redirect).toBe("manual");
        expect(new Headers(init?.headers).get("authorization")).toBe(
          "Basic YWxpY2U6c2VjcmV0",
        );
        return Promise.resolve(
          new Response(responses.get(url) ?? "", {
            status: responses.has(url) ? 207 : 404,
            headers: { "Content-Type": "application/xml" },
          }),
        );
      },
    });

    expect(result).toMatchObject({
      ok: true,
      collections: [
        {
          href: "/dav.php/calendars/alice/work/",
          displayName: "Work",
          supportsEvents: true,
          supportsTodos: true,
        },
      ],
    });
    expect(requests).toHaveLength(3);
  });

  it("fails closed on authentication errors and entity-bearing XML", async () => {
    const unauthorized = await discoverCalDavCalendars({
      endpoint: new URL("https://baikal.test/dav.php/"),
      username: "alice",
      password: "wrong",
      fetch: () => Promise.resolve(new Response("", { status: 401 })),
    });
    expect(unauthorized).toEqual({
      ok: false,
      reason: "authentication-required",
    });

    const entity = await discoverCalDavCalendars({
      endpoint: new URL("https://baikal.test/dav.php/"),
      username: "alice",
      password: "secret",
      fetch: () =>
        Promise.resolve(
          new Response(fixture("entity.xml"), {
            status: 207,
            headers: { "Content-Type": "application/xml" },
          }),
        ),
    });
    expect(entity).toEqual({ ok: false, reason: "invalid-protocol" });
  });
});

const eventXml = fixture("event-listing.xml");
const rawEvent = fixture("event.ics");

describe("bounded CalDAV event port", () => {
  const collectionUrl = new URL(
    "https://baikal.test/dav.php/calendars/alice/work/",
  );

  it("lists strong ETag members then GETs exact raw ICS", async () => {
    const requests: { url: string; init?: RequestInit }[] = [];
    const result = await readBoundedCalDavEvents({
      collectionUrl,
      username: "alice",
      password: "secret",
      startsAt: "2026-08-06T00:00:00Z",
      endsAt: "2026-08-07T00:00:00Z",
      fetch: (input, init) => {
        const url = requestUrl(input);
        requests.push(init === undefined ? { url } : { url, init });
        return Promise.resolve(
          url.endsWith("work/")
            ? new Response(eventXml, {
                status: 207,
                headers: { "content-type": "application/xml" },
              })
            : new Response(rawEvent, {
                status: 200,
                headers: {
                  etag: '"event-v1"',
                  "content-type": "text/calendar",
                },
              }),
        );
      },
    });
    expect(result).toEqual({
      ok: true,
      value: [
        {
          href: "/dav.php/calendars/alice/work/existing.ics",
          etag: '"event-v1"',
          rawIcs: rawEvent,
          event: {
            uid: "event-1",
            summary: "Focus, work",
            startsAt: "2026-08-06T12:00:00Z",
            endsAt: "2026-08-06T13:00:00Z",
            allDay: false,
          },
        },
      ],
    });
    expect(requests).toHaveLength(2);
    expect(requests[0]?.init?.method).toBe("REPORT");
    expect(new Headers(requests[0]?.init?.headers).get("depth")).toBe("1");
    expect(requests[1]?.init?.method).toBe("GET");
    expect(new Headers(requests[1]?.init?.headers).get("accept")).toBe(
      "text/calendar",
    );
  });

  it("fails closed on weak ETags, traversal hrefs, and changed-during-fetch", async () => {
    for (const { href, etag, getEtag } of [
      {
        href: "/dav.php/calendars/alice/work/a.ics",
        etag: 'W/"v1"',
        getEtag: 'W/"v1"',
      },
      {
        href: "/dav.php/calendars/alice/work/%2e%2e/evil.ics",
        etag: '"v1"',
        getEtag: '"v1"',
      },
      {
        href: "/dav.php/calendars/alice/work/a.ics",
        etag: '"v1"',
        getEtag: '"v2"',
      },
    ]) {
      const xml = eventXml
        .replace("/dav.php/calendars/alice/work/existing.ics", href)
        .replace('"event-v1"', etag);
      await expect(
        readBoundedCalDavEvents({
          collectionUrl,
          username: "a",
          password: "b",
          startsAt: "2026-08-06T00:00:00Z",
          endsAt: "2026-08-07T00:00:00Z",
          fetch: (input) =>
            Promise.resolve(
              requestUrl(input).endsWith("work/")
                ? new Response(xml, {
                    status: 207,
                    headers: { "content-type": "application/xml" },
                  })
                : new Response(rawEvent, {
                    status: 200,
                    headers: { etag: getEtag },
                  }),
            ),
        }),
      ).resolves.toEqual({ ok: false, reason: "invalid-protocol" });
    }
  });

  it("projects only non-recurring UTC timed or date-only all-day VEVENTs", () => {
    expect(parseBoundedVEvent(rawEvent)).toMatchObject({
      uid: "event-1",
      allDay: false,
    });
    expect(
      parseBoundedVEvent(
        rawEvent.replace(
          "DTSTART:20260806T120000Z",
          "DTSTART;TZID=America/Chicago:20260806T070000",
        ),
      ),
    ).toBeUndefined();
    expect(
      parseBoundedVEvent(
        rawEvent.replace(
          "SUMMARY:Focus\\, work",
          "RRULE:FREQ=DAILY\nSUMMARY:Focus\\, work",
        ),
      ),
    ).toBeUndefined();
    const allDay = {
      uid: "day",
      summary: "Day",
      startsAt: "20260806",
      endsAt: "20260807",
      allDay: true,
    } as const;
    const serialized = serializeBoundedVEvent(allDay);
    expect(serialized).toBeDefined();
    if (serialized === undefined)
      throw new Error("All-day event did not serialize");
    expect(parseBoundedVEvent(serialized)).toEqual(allDay);
    expect(parseBoundedVEvent(serialized.replace(";VALUE=DATE", ""))).toEqual(
      allDay,
    );
  });

  it("uses conditional CalDAV writes and exposes a typed stale conflict", async () => {
    const request = async (
      method: "create" | "replace" | "delete",
      status = 204,
    ) => {
      let captured: RequestInit | undefined;
      const options = {
        collectionUrl,
        username: "alice",
        password: "secret",
        href: "/dav.php/calendars/alice/work/new.ics",
        rawIcs: rawEvent,
        ...(method === "replace" || method === "delete"
          ? { expectedEtag: '"v1"' }
          : {}),
        fetch: (_input: RequestInfo | URL, init?: RequestInit) => {
          captured = init;
          return Promise.resolve(new Response("", { status }));
        },
      };
      const result =
        method === "create"
          ? await createCalDavEvent(options)
          : method === "replace"
            ? await replaceCalDavEvent(options)
            : await deleteCalDavEvent(options);
      return {
        result,
        headers: new Headers(captured?.headers),
        init: captured,
      };
    };
    expect((await request("create")).headers.get("if-none-match")).toBe("*");
    expect((await request("replace")).headers.get("if-match")).toBe('"v1"');
    const deleted = await request("delete");
    expect(deleted.init?.method).toBe("DELETE");
    expect(deleted.headers.get("if-match")).toBe('"v1"');
    expect((await request("replace", 412)).result).toEqual({
      ok: false,
      reason: "precondition-failed",
    });
  });
});

describe("CalDAV setup probe (ADR 0039)", () => {
  const davHeader =
    "1, 3, extended-mkcol, access-control, calendar-access, calendar-proxy";
  const multistatus = (body: string): string =>
    `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav">${body}</d:multistatus>`;
  const ok = (href: string, prop: string): string =>
    `<d:response><d:href>${href}</d:href><d:propstat><d:prop>${prop}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
  const privilegeSet = (names: readonly string[]): string =>
    `<d:current-user-privilege-set>${names.map((name) => `<d:privilege><${name}/></d:privilege>`).join("")}</d:current-user-privilege-set>`;
  const xml = (body: string): Response =>
    new Response(multistatus(body), {
      status: 207,
      headers: { "Content-Type": "application/xml" },
    });

  const server = (
    overrides: Readonly<Record<string, () => Response>> = {},
  ): typeof fetch => {
    const documents: Readonly<Record<string, () => Response>> = {
      "OPTIONS http://baikal.test/dav.php/": () =>
        new Response(null, { status: 200, headers: { DAV: davHeader } }),
      "PROPFIND http://baikal.test/dav.php/": () =>
        xml(
          ok(
            "/dav.php/",
            "<d:current-user-principal><d:href>/dav.php/principals/alice/</d:href></d:current-user-principal>",
          ),
        ),
      "PROPFIND http://baikal.test/dav.php/principals/alice/": () =>
        xml(
          ok(
            "/dav.php/principals/alice/",
            "<cal:calendar-home-set><d:href>/dav.php/calendars/alice/</d:href></cal:calendar-home-set>",
          ),
        ),
      "PROPFIND http://baikal.test/dav.php/calendars/alice/": () =>
        xml(
          [
            ["default", "Default", "VEVENT"],
            ["shared", "Shared", "VEVENT"],
            ["todo", "Tasks", "VTODO"],
            ["unreported", "Unreported", "VEVENT"],
          ]
            .map(([name, label, component]) =>
              ok(
                `/dav.php/calendars/alice/${name ?? ""}/`,
                `<d:resourcetype><d:collection/><cal:calendar/></d:resourcetype><d:displayname>${label ?? ""}</d:displayname><cal:supported-calendar-component-set><cal:comp name="${component ?? ""}"/></cal:supported-calendar-component-set>`,
              ),
            )
            .join(""),
        ),
      "PROPFIND http://baikal.test/dav.php/calendars/alice/default/": () =>
        xml(
          ok(
            "/dav.php/calendars/alice/default/",
            privilegeSet([
              "cal:read-free-busy",
              "d:read",
              "d:write",
              "d:write-content",
              "d:bind",
              "d:unbind",
            ]),
          ),
        ),
      "PROPFIND http://baikal.test/dav.php/calendars/alice/shared/": () =>
        xml(
          ok(
            "/dav.php/calendars/alice/shared/",
            privilegeSet(["d:read", "cal:read-free-busy"]),
          ),
        ),
      "PROPFIND http://baikal.test/dav.php/calendars/alice/todo/": () =>
        new Response("", { status: 403 }),
      "PROPFIND http://baikal.test/dav.php/calendars/alice/unreported/": () =>
        xml(
          `<d:response><d:href>/dav.php/calendars/alice/unreported/</d:href><d:propstat><d:prop><d:current-user-privilege-set/></d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat></d:response>`,
        ),
      ...overrides,
    };
    return (input, init) => {
      expect(init?.redirect).toBe("manual");
      const key = `${init?.method ?? "GET"} ${requestUrl(input)}`;
      const response = documents[key];
      return Promise.resolve(
        response === undefined ? new Response("", { status: 404 }) : response(),
      );
    };
  };

  const probe = (fetcher: typeof fetch) =>
    probeCalDavEndpoint({
      endpoint: new URL("http://baikal.test/dav.php/"),
      username: "alice",
      password: "secret",
      fetch: fetcher,
    });

  it("reports capability classes and per-calendar read/write access", async () => {
    const result = await probe(server());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.davClasses).toContain("calendar-access");
    expect(result.calendarHomeUrl.pathname).toBe("/dav.php/calendars/alice/");
    expect(
      result.calendars.map(({ displayName, canRead, canWrite }) => ({
        displayName,
        canRead,
        canWrite,
      })),
    ).toEqual([
      { displayName: "Default", canRead: true, canWrite: true },
      { displayName: "Shared", canRead: true, canWrite: false },
      { displayName: "Tasks", canRead: false, canWrite: false },
      { displayName: "Unreported", canRead: null, canWrite: null },
    ]);
    expect(result.calendars[0]?.privileges).toContain("read-free-busy");
    expect(result.calendars[3]?.privileges).toBeNull();
  });

  it("rejects a WebDAV endpoint without CalDAV calendar access", async () => {
    expect(
      await probe(
        server({
          "OPTIONS http://baikal.test/dav.php/": () =>
            new Response(null, { status: 200, headers: { DAV: "1, 2, 3" } }),
        }),
      ),
    ).toEqual({ ok: false, reason: "caldav-unsupported" });
  });

  it("reports redirects without following them", async () => {
    const redirect = () =>
      new Response(null, {
        status: 301,
        headers: { Location: "https://baikal.test/dav.php/" },
      });
    expect(
      await probe(server({ "OPTIONS http://baikal.test/dav.php/": redirect })),
    ).toEqual({ ok: false, reason: "redirected" });
    expect(
      await probe(
        server({
          "PROPFIND http://baikal.test/dav.php/principals/alice/": redirect,
        }),
      ),
    ).toEqual({ ok: false, reason: "redirected" });
  });

  it("maps authentication, admin paths and transport failures", async () => {
    expect(
      await probe(
        server({
          "OPTIONS http://baikal.test/dav.php/": () =>
            new Response("", { status: 401 }),
        }),
      ),
    ).toEqual({ ok: false, reason: "authentication-required" });
    expect(
      await probe(
        server({
          "OPTIONS http://baikal.test/dav.php/": () =>
            new Response("<html/>", { status: 405 }),
        }),
      ),
    ).toEqual({ ok: false, reason: "invalid-protocol" });
    expect(
      await probe(() => Promise.reject(new TypeError("fetch failed"))),
    ).toEqual({ ok: false, reason: "transport-failed" });
  });

  it("refuses a calendar href on another origin before reading privileges", async () => {
    const requests: string[] = [];
    const inner = server({
      "PROPFIND http://baikal.test/dav.php/calendars/alice/": () =>
        xml(
          ok(
            "http://169.254.169.254/dav.php/calendars/alice/default/",
            "<d:resourcetype><d:collection/><cal:calendar/></d:resourcetype>",
          ),
        ),
    });
    const result = await probe((input, init) => {
      requests.push(requestUrl(input));
      return inner(input, init);
    });
    expect(result).toEqual({ ok: false, reason: "unsafe-remote-url" });
    expect(requests.every((url) => url.startsWith("http://baikal.test/"))).toBe(
      true,
    );
  });

  it("derives write access from RFC 3744 aggregates", () => {
    expect(summarizeCalDavPrivileges(["all"])).toEqual({
      canRead: true,
      canWrite: true,
    });
    expect(
      summarizeCalDavPrivileges(["read", "write-content", "bind", "unbind"]),
    ).toEqual({ canRead: true, canWrite: true });
    expect(summarizeCalDavPrivileges(["read", "write-content"])).toEqual({
      canRead: true,
      canWrite: false,
    });
  });
});
