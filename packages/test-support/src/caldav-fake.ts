/**
 * In-memory CalDAV discovery fake shaped on Baikal 0.10.1 (sabre/dav)
 * responses recorded against a disposable instance on 2026-09-25: the OPTIONS
 * DAV header, principal, calendar home, collections and RFC 3744
 * current-user-privilege-set. It checks Basic credentials on every request,
 * so revoking the DAV user is observable as 401.
 */

export const baikalDavHeader =
  "1, 3, extended-mkcol, access-control, calendarserver-principal-property-search, calendar-access, calendar-proxy, calendar-auto-schedule, calendar-availability, resource-sharing, calendarserver-sharing, addressbook";

/** Privileges Baikal 0.10.1 reports to the owner of a calendar. */
export const baikalOwnerPrivileges = [
  "cal:read-free-busy",
  "d:read",
  "d:read-acl",
  "d:read-current-user-privilege-set",
  "d:write-properties",
  "d:write",
  "d:write-content",
  "d:unlock",
  "d:bind",
  "d:unbind",
  "d:write-acl",
  "d:share",
] as const;

export interface CalDavFakeCalendar {
  readonly name: string;
  readonly displayName: string;
  readonly components: readonly ("VEVENT" | "VTODO")[];
  /**
   * Prefixed privilege elements (`d:` DAV, `cal:` CalDAV), `null` to omit the
   * property (404 propstat), or `"forbidden"` to answer the PROPFIND with 403.
   */
  readonly privileges: readonly string[] | null | "forbidden";
}

export interface CalDavFakeOptions {
  readonly origin?: string;
  readonly username?: string;
  readonly password?: string;
  readonly davHeader?: string | null;
  readonly calendars?: readonly CalDavFakeCalendar[];
  /** Replace any response; return undefined to fall through to the fake. */
  readonly override?: (
    method: string,
    url: URL,
  ) => Response | Promise<Response> | undefined;
}

export interface CalDavFakeRequest {
  readonly method: string;
  readonly url: string;
  readonly redirect: RequestRedirect | undefined;
}

export interface CalDavFake {
  readonly fetch: typeof fetch;
  readonly requests: readonly CalDavFakeRequest[];
  /** Simulates deleting the DAV user or changing its password in Baikal. */
  revoke(): void;
}

const multistatus = (body: string): string =>
  `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:s="http://sabredav.org/ns" xmlns:cal="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/">${body}</d:multistatus>`;

const ok = (href: string, prop: string): string =>
  `<d:response><d:href>${href}</d:href><d:propstat><d:prop>${prop}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;

const xml = (body: string): Response =>
  new Response(multistatus(body), {
    status: 207,
    headers: { "Content-Type": "application/xml; charset=utf-8" },
  });

const requestUrl = (input: RequestInfo | URL): URL =>
  new URL(
    input instanceof URL
      ? input.href
      : typeof input === "string"
        ? input
        : input.url,
  );

export const createCalDavFake = (
  options: CalDavFakeOptions = {},
): CalDavFake => {
  const origin = options.origin ?? "http://baikal.test";
  const username = options.username ?? "tadooer";
  const password = options.password ?? "fake-dav-password";
  const calendars = options.calendars ?? [
    {
      name: "default",
      displayName: "Default calendar",
      components: ["VEVENT", "VTODO"],
      privileges: baikalOwnerPrivileges,
    },
  ];
  const davHeader =
    options.davHeader === undefined ? baikalDavHeader : options.davHeader;
  const expected = `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
  const principal = `/dav.php/principals/${username}/`;
  const home = `/dav.php/calendars/${username}/`;
  const requests: CalDavFakeRequest[] = [];
  let revoked = false;

  const fakeFetch: typeof fetch = async (input, init) => {
    const url = requestUrl(input);
    const method = (init?.method ?? "GET").toUpperCase();
    requests.push({ method, url: url.href, redirect: init?.redirect });
    const overridden = await options.override?.(method, url);
    if (overridden !== undefined) return overridden;
    if (url.origin !== origin) throw new TypeError("fetch failed");
    if (!url.pathname.startsWith("/dav.php"))
      return new Response("<html>Not Allowed</html>", {
        status: 405,
        headers: { "Content-Type": "text/html" },
      });
    const authorization = new Headers(init?.headers).get("authorization");
    if (revoked || authorization !== expected)
      return new Response("", {
        status: 401,
        headers: { "WWW-Authenticate": 'Basic realm="BaikalDAV"' },
      });
    if (method === "OPTIONS")
      return new Response(null, {
        status: 200,
        headers: davHeader === null ? {} : { DAV: davHeader },
      });
    if (method !== "PROPFIND") return new Response("", { status: 405 });
    const body = typeof init?.body === "string" ? init.body : "";
    const path = url.pathname;
    if (path === "/dav.php/" || path === "/dav.php")
      return xml(
        ok(
          "/dav.php/",
          `<d:current-user-principal><d:href>${principal}</d:href></d:current-user-principal>`,
        ),
      );
    if (path === principal)
      return xml(
        ok(
          principal,
          `<cal:calendar-home-set><d:href>${home}</d:href></cal:calendar-home-set>`,
        ),
      );
    if (path === home)
      return xml(
        [
          ok(home, "<d:resourcetype><d:collection/></d:resourcetype>"),
          ...calendars.map((calendar) =>
            ok(
              `${home}${calendar.name}/`,
              `<d:resourcetype><d:collection/><cal:calendar/></d:resourcetype><d:displayname>${calendar.displayName}</d:displayname><cal:supported-calendar-component-set>${calendar.components.map((component) => `<cal:comp name="${component}"/>`).join("")}</cal:supported-calendar-component-set>`,
            ),
          ),
        ].join(""),
      );
    const calendar = calendars.find(
      (candidate) => path === `${home}${candidate.name}/`,
    );
    if (calendar === undefined || !body.includes("current-user-privilege-set"))
      return new Response("", { status: 404 });
    if (calendar.privileges === "forbidden")
      return new Response("", { status: 403 });
    if (calendar.privileges === null)
      return xml(
        `<d:response><d:href>${path}</d:href><d:propstat><d:prop><d:current-user-privilege-set/></d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat></d:response>`,
      );
    return xml(
      ok(
        path,
        `<d:current-user-privilege-set>${calendar.privileges.map((privilege) => `<d:privilege><${privilege}/></d:privilege>`).join("")}</d:current-user-privilege-set>`,
      ),
    );
  };

  return {
    fetch: fakeFetch,
    requests,
    revoke: () => {
      revoked = true;
    },
  };
};
