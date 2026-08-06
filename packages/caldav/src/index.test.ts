import { describe, expect, it } from "vitest";
import { discoverCalDavCalendars } from "./index.ts";

const multistatus = (body: string): string =>
  `<?xml version="1.0"?><D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">${body}</D:multistatus>`;

describe("CalDAV discovery", () => {
  it("discovers event and todo support without following cross-origin hrefs", async () => {
    const responses = new Map([
      [
        "http://baikal.test/dav.php/",
        multistatus(
          `<D:response><D:href>/dav.php/</D:href><D:propstat><D:prop><D:current-user-principal><D:href>/dav.php/principals/alice/</D:href></D:current-user-principal></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`,
        ),
      ],
      [
        "http://baikal.test/dav.php/principals/alice/",
        multistatus(
          `<D:response><D:href>/dav.php/principals/alice/</D:href><D:propstat><D:prop><C:calendar-home-set><D:href>/dav.php/calendars/alice/</D:href></C:calendar-home-set></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`,
        ),
      ],
      [
        "http://baikal.test/dav.php/calendars/alice/",
        multistatus(
          `<D:response><D:href>/dav.php/calendars/alice/work/</D:href><D:propstat><D:prop><D:resourcetype><D:collection/><C:calendar/></D:resourcetype><D:displayname>Work</D:displayname><C:supported-calendar-component-set><C:comp name="VEVENT"/><C:comp name="VTODO"/></C:supported-calendar-component-set></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`,
        ),
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
          new Response(
            '<!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><D:multistatus xmlns:D="DAV:"/>',
            {
              status: 207,
              headers: { "Content-Type": "application/xml" },
            },
          ),
        ),
    });
    expect(entity).toEqual({ ok: false, reason: "invalid-protocol" });
  });
});
