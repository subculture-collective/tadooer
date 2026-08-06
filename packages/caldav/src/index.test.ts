import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { discoverCalDavCalendars } from "./index.ts";

const fixture = (name: string): string =>
  readFileSync(new URL(`../test-fixtures/${name}`, import.meta.url), "utf8");

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
