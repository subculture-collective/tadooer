import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  calendarImportMutationResponseSchema,
  sessionResponseSchema,
} from "@suite/contracts";
import { withTemporaryDirectory } from "@suite/test-support";
import { startSuiteServer } from "./server.ts";

const multi = (body: string) =>
  `<?xml version="1.0"?><D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">${body}</D:multistatus>`;

describe("Phase 7 calendar migration and publication", () => {
  it("previews without writes, applies once, exports, and revokes a GET-only capability", async () => {
    await withTemporaryDirectory(async (directory) => {
      await mkdir(join(directory, "web"));
      await writeFile(join(directory, "web", "index.html"), "<h1>Suite</h1>");
      const resources = new Map<string, string>();
      const fetcher: typeof fetch = async (input, init) => {
        await Promise.resolve();
        const url =
          input instanceof URL
            ? input
            : new URL(typeof input === "string" ? input : input.url);
        const method = init?.method ?? "GET";
        if (method === "PROPFIND" && url.pathname === "/dav.php/")
          return new Response(
            multi(
              `<D:response><D:href>/dav.php/</D:href><D:propstat><D:prop><D:current-user-principal><D:href>/dav.php/principals/alice/</D:href></D:current-user-principal></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`,
            ),
            { status: 207, headers: { "content-type": "application/xml" } },
          );
        if (
          method === "PROPFIND" &&
          url.pathname === "/dav.php/principals/alice/"
        )
          return new Response(
            multi(
              `<D:response><D:href>/dav.php/principals/alice/</D:href><D:propstat><D:prop><C:calendar-home-set><D:href>/dav.php/calendars/alice/</D:href></C:calendar-home-set></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`,
            ),
            { status: 207, headers: { "content-type": "application/xml" } },
          );
        if (method === "PROPFIND")
          return new Response(
            multi(
              `<D:response><D:href>/dav.php/calendars/alice/work/</D:href><D:propstat><D:prop><D:resourcetype><D:collection/><C:calendar/></D:resourcetype><D:displayname>Work</D:displayname><C:supported-calendar-component-set><C:comp name="VEVENT"/></C:supported-calendar-component-set></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`,
            ),
            { status: 207, headers: { "content-type": "application/xml" } },
          );
        if (method === "PUT") {
          if (resources.has(url.pathname))
            return new Response("", { status: 412 });
          resources.set(
            url.pathname,
            typeof init?.body === "string" ? init.body : "",
          );
          return new Response("", { status: 201 });
        }
        return new Response("", { status: 404 });
      };
      const server = await startSuiteServer(
        {
          host: "127.0.0.1",
          port: 0,
          databasePath: join(directory, "suite.sqlite"),
          webRoot: join(directory, "web"),
          baikalEndpoint: "http://baikal.test/dav.php/",
          credentialKeyPath: join(directory, "key"),
          secureCookies: false,
          build: { version: "test", revision: "test", builtAt: null },
        },
        { connectorFetch: fetcher },
      );
      try {
        const baseHeaders = {
          Origin: server.baseUrl,
          "Content-Type": "application/json",
        };
        await fetch(`${server.baseUrl}/api/setup`, {
          method: "POST",
          headers: baseHeaders,
          body: JSON.stringify({
            username: "owner",
            displayName: "Owner",
            password: "correct horse battery staple",
          }),
        });
        const login = await fetch(`${server.baseUrl}/api/auth/login`, {
          method: "POST",
          headers: baseHeaders,
          body: JSON.stringify({
            username: "owner",
            password: "correct horse battery staple",
          }),
        });
        const session = sessionResponseSchema.parse(await login.json());
        const cookie = login.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
        const unsafe = {
          ...baseHeaders,
          Cookie: cookie,
          "X-CSRF-Token": session.csrfToken,
        };
        const connected = await fetch(
          `${server.baseUrl}/api/connectors/baikal`,
          {
            method: "PUT",
            headers: unsafe,
            body: JSON.stringify({ username: "alice", password: "secret" }),
          },
        );
        const calendarId =
          ((await connected.json()) as { calendars: { id: string }[] })
            .calendars[0]?.id ?? "";
        const rawIcs =
          "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:migrate-1\r\nDTSTART:20260807T120000Z\r\nDTEND:20260807T130000Z\r\nSUMMARY:Migration fixture\r\nRRULE:FREQ=WEEKLY;COUNT=2\r\nATTENDEE:mailto:test@example.test\r\nBEGIN:VALARM\r\nACTION:DISPLAY\r\nTRIGGER:-PT10M\r\nEND:VALARM\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
        const preview = await fetch(`${server.baseUrl}/api/imports/preview`, {
          method: "POST",
          headers: unsafe,
          body: JSON.stringify({ source: "google_ics", calendarId, rawIcs }),
        });
        expect(preview.status).toBe(201);
        const first = calendarImportMutationResponseSchema.parse(
          await preview.json(),
        );
        expect(first.job.report.totals).toMatchObject({
          ready: 1,
          recurring: 1,
          attendees: 1,
          alarms: 1,
        });
        expect(resources.size).toBe(0);
        const apply = await fetch(
          `${server.baseUrl}/api/imports/${first.job.id}/apply`,
          { method: "POST", headers: unsafe },
        );
        expect(
          calendarImportMutationResponseSchema.parse(await apply.json()),
        ).toMatchObject({ replayed: false, job: { state: "applied" } });
        expect(resources.size).toBe(1);
        const replay = await fetch(
          `${server.baseUrl}/api/imports/${first.job.id}/apply`,
          { method: "POST", headers: unsafe },
        );
        expect(
          calendarImportMutationResponseSchema.parse(await replay.json())
            .replayed,
        ).toBe(true);
        expect(resources.size).toBe(1);
        const exported = await fetch(
          `${server.baseUrl}/api/calendars/${calendarId}/export.ics`,
          { headers: { Cookie: cookie } },
        );
        expect(exported.headers.get("content-type")).toContain("text/calendar");
        expect(await exported.text()).toContain("RRULE:FREQ=WEEKLY");
        const issued = await fetch(`${server.baseUrl}/api/calendar-feeds`, {
          method: "POST",
          headers: unsafe,
          body: JSON.stringify({ calendarId, label: "Phone" }),
        });
        const capability = (await issued.json()) as {
          capability: { id: string };
          url: string;
        };
        const publicFeed = await fetch(`${server.baseUrl}${capability.url}`);
        expect(publicFeed.status).toBe(200);
        expect(publicFeed.headers.get("cache-control")).toBe(
          "private, no-store",
        );
        expect(
          (
            await fetch(`${server.baseUrl}${capability.url}`, {
              method: "POST",
            })
          ).status,
        ).toBe(405);
        expect(
          (
            await fetch(
              `${server.baseUrl}/api/calendar-feeds/${capability.capability.id}`,
              { method: "DELETE", headers: unsafe },
            )
          ).status,
        ).toBe(204);
        expect((await fetch(`${server.baseUrl}${capability.url}`)).status).toBe(
          404,
        );
      } finally {
        await server.close();
      }
    });
  });
});
