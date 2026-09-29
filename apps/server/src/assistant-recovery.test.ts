import { randomUUID } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  automationCalendarFeedResourceSchema,
  automationCalendarImportResourceSchema,
  automationConfirmationResponseSchema,
  automationConnectorStatusResourceSchema,
  automationPreviewResponseSchema,
  calendarImportMutationResponseSchema,
  createAutomationTokenResponseSchema,
  googleAuthorizationResponseSchema,
  sessionResponseSchema,
} from "@suite/contracts";
import { withTemporaryDirectory } from "@suite/test-support";
import { startSuiteServer } from "./server.ts";

// Assistant import, publication and connector recovery (#60, ADR 0038).
// Baikal and Google are fakes; the Baikal password, the feed secret and the
// Google refresh token must never appear in any assistant response.

const multi = (body: string) =>
  `<?xml version="1.0"?><D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">${body}</D:multistatus>`;

const baikalPassword = "baikal-password-4f1c";
const refreshToken = "google-refresh-secret-91ab";
const googleScopes = [
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
  "https://www.googleapis.com/auth/calendar.events.readonly",
];

const baikalFixture = () => {
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
    if (method === "PROPFIND" && url.pathname === "/dav.php/principals/alice/")
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
      if (resources.has(url.pathname)) return new Response("", { status: 412 });
      resources.set(
        url.pathname,
        typeof init?.body === "string" ? init.body : "",
      );
      return new Response("", { status: 201 });
    }
    return new Response("", { status: 404 });
  };
  return { fetcher, resources };
};

const googleFixture = () => {
  let tokenRefreshes = 0;
  const fetcher: typeof fetch = async (input, init) => {
    await Promise.resolve();
    const url =
      input instanceof URL
        ? input
        : new URL(typeof input === "string" ? input : input.url);
    if (url.href === "https://oauth2.googleapis.com/token") {
      const requestBody = init?.body;
      const body = new URLSearchParams(
        typeof requestBody === "string"
          ? requestBody
          : requestBody instanceof URLSearchParams
            ? requestBody.toString()
            : "",
      );
      if (body.get("grant_type") === "authorization_code")
        return Response.json({
          access_token: "access-code",
          refresh_token: refreshToken,
          expires_in: 3600,
          scope: googleScopes.join(" "),
        });
      tokenRefreshes += 1;
      return Response.json({
        access_token: `access-${String(tokenRefreshes)}`,
        expires_in: 3600,
        scope: googleScopes.join(" "),
      });
    }
    if (
      url.href.startsWith(
        "https://www.googleapis.com/calendar/v3/users/me/calendarList",
      )
    )
      return Response.json({
        items: [
          {
            id: "owner@example.test",
            etag: '"calendar-1"',
            summary: "Primary",
            accessRole: "owner",
            primary: true,
            timeZone: "UTC",
          },
        ],
      });
    if (
      url.href.startsWith(
        "https://www.googleapis.com/calendar/v3/calendars/owner%40example.test/events",
      )
    )
      return Response.json({
        items: [
          {
            id: "event-1",
            iCalUID: "event-1@example.test",
            etag: '"event-1"',
            summary: "Google appointment",
            start: { dateTime: "2026-09-26T13:00:00Z" },
            end: { dateTime: "2026-09-26T14:00:00Z" },
          },
        ],
        nextSyncToken: "sync-1",
      });
    return new Response("", { status: 404 });
  };
  return { fetcher, refreshes: () => tokenRefreshes };
};

const recoveryScopes = [
  "connectors:read",
  "connectors:recover",
  "imports:read",
  "imports:write",
  "publication:read",
  "publication:write",
] as const;

describe("assistant import, publication and connector recovery", () => {
  it("reads status without secrets, applies an owner-previewed import once, revokes a feed and resyncs Google with the stored grant", async () => {
    await withTemporaryDirectory(async (directory) => {
      await mkdir(join(directory, "web"));
      await writeFile(join(directory, "web", "index.html"), "<h1>Suite</h1>");
      const oauthPath = join(directory, "google-oauth.json");
      const baikal = baikalFixture();
      const google = googleFixture();
      const server = await startSuiteServer(
        {
          host: "127.0.0.1",
          port: 0,
          databasePath: join(directory, "suite.sqlite"),
          webRoot: join(directory, "web"),
          baikalEndpoint: "http://baikal.test/dav.php/",
          credentialKeyPath: join(directory, "key"),
          googleOAuthConfigPath: oauthPath,
          secureCookies: false,
          build: { version: "test", revision: "test", builtAt: null },
        },
        { connectorFetch: baikal.fetcher, googleFetch: google.fetcher },
      );
      try {
        await writeFile(
          oauthPath,
          JSON.stringify({
            clientId: "client.apps.googleusercontent.com",
            clientSecret: "client-secret-value",
            redirectUri: `${server.baseUrl}/api/connectors/google/callback`,
          }),
          { mode: 0o600 },
        );
        await chmod(oauthPath, 0o600);
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
        const owner = (
          path: string,
          method: "GET" | "POST" | "PUT" | "DELETE",
          body?: unknown,
        ) =>
          fetch(`${server.baseUrl}${path}`, {
            method,
            redirect: "manual",
            headers: unsafe,
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          });

        // Owner-only preparation: Baikal credential, Google consent, a
        // previewed import and a feed whose address is shown once.
        const connected = await owner("/api/connectors/baikal", "PUT", {
          username: "alice",
          password: baikalPassword,
        });
        expect(connected.status).toBe(200);
        const calendarId =
          ((await connected.json()) as { calendars: { id: string }[] })
            .calendars[0]?.id ?? "";
        const authorization = googleAuthorizationResponseSchema.parse(
          await (
            await owner("/api/connectors/google/authorize", "POST", {
              access: "read",
            })
          ).json(),
        );
        const state =
          new URL(authorization.authorizationUrl).searchParams.get("state") ??
          "";
        expect(
          (
            await fetch(
              `${server.baseUrl}/api/connectors/google/callback?state=${encodeURIComponent(state)}&code=authorized-code`,
              { redirect: "manual" },
            )
          ).status,
        ).toBe(303);
        const rawIcs =
          "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:migrate-1\r\nDTSTART:20260807T120000Z\r\nDTEND:20260807T130000Z\r\nSUMMARY:Migration fixture\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
        const previewed = calendarImportMutationResponseSchema.parse(
          await (
            await owner("/api/imports/preview", "POST", {
              source: "ics",
              calendarId,
              rawIcs,
            })
          ).json(),
        );
        const feed = (await (
          await owner("/api/calendar-feeds", "POST", {
            calendarId,
            label: "Phone",
          })
        ).json()) as { capability: { id: string }; url: string };
        const feedSecret =
          feed.url.split("/").at(-1)?.replace(".ics", "") ?? "";
        expect(feedSecret.length).toBe(43);

        const issue = async (scopes: readonly string[]) =>
          createAutomationTokenResponseSchema.parse(
            await (
              await owner("/api/automation/tokens", "POST", {
                label: `Recovery ${scopes.length.toString()}`,
                scopes,
                expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
              })
            ).json(),
          );
        const full = await issue(recoveryScopes);
        const readOnly = await issue(["imports:read", "publication:read"]);
        const automation = (
          token: string,
          path: string,
          method: "GET" | "POST",
          body?: unknown,
        ) =>
          fetch(`${server.baseUrl}${path}`, {
            method,
            headers: {
              Authorization: `Bearer ${token}`,
              ...(body === undefined
                ? {}
                : { "Content-Type": "application/json" }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          });
        const preview = async (
          token: string,
          operation: string,
          input: unknown,
        ) => {
          const response = await automation(
            token,
            "/api/automation/v1/previews",
            "POST",
            { operation, input },
          );
          return { status: response.status, text: await response.text() };
        };
        const confirm = async (previewId: string) =>
          automationConfirmationResponseSchema.parse(
            await (
              await automation(
                full.token,
                `/api/automation/v1/previews/${previewId}/confirm`,
                "POST",
                { idempotencyKey: randomUUID() },
              )
            ).json(),
          );
        const noSecrets = (text: string) => {
          expect(text).not.toContain(baikalPassword);
          expect(text).not.toContain(refreshToken);
          expect(text).not.toContain(feedSecret);
          expect(text).not.toContain("client-secret-value");
        };

        // Connector status: verified Baikal, connected Google, no secrets.
        const statusText = await (
          await automation(
            full.token,
            "/api/automation/v1/resources/connectors",
            "GET",
          )
        ).text();
        noSecrets(statusText);
        const status = automationConnectorStatusResourceSchema.parse(
          JSON.parse(statusText),
        );
        expect(status.baikal).toMatchObject({
          state: "connected",
          endpointHost: "baikal.test",
          username: "alice",
        });
        expect(status.google).toMatchObject({
          state: "connected",
          grantedScopes: googleScopes,
        });
        expect(
          status.recovery.filter(({ actor }) => actor === "owner"),
        ).toEqual([]);
        expect(
          (
            await automation(
              readOnly.token,
              "/api/automation/v1/resources/connectors",
              "GET",
            )
          ).status,
        ).toBe(403);

        // Imports: the owner's preview without rawIcs; unknown job is 404.
        const importsText = await (
          await automation(
            full.token,
            `/api/automation/v1/resources/imports?jobId=${previewed.job.id}`,
            "GET",
          )
        ).text();
        expect(importsText).not.toContain("BEGIN:VEVENT");
        const imports = automationCalendarImportResourceSchema.parse(
          JSON.parse(importsText),
        );
        expect(imports.jobs).toHaveLength(1);
        expect(imports.jobs[0]).toMatchObject({
          state: "previewed",
          calendarName: "Work",
          itemCounts: { pending: 1, applied: 0 },
        });
        expect(imports.job?.report.candidates[0]).toMatchObject({
          uid: "migrate-1",
          summary: "Migration fixture",
        });
        expect(imports.job?.report.candidates[0]).not.toHaveProperty("rawIcs");
        expect(imports.superProductivity).toEqual({
          lastImportedAt: null,
          entities: [],
        });
        expect(
          (
            await automation(
              full.token,
              `/api/automation/v1/resources/imports?jobId=${randomUUID()}`,
              "GET",
            )
          ).status,
        ).toBe(404);

        // Apply: wrong fingerprint is rejected, preview writes nothing,
        // confirmation writes once and a repeat replays without writes.
        const wrongHash = await preview(full.token, "imports.apply", {
          jobId: previewed.job.id,
          expectedInputHash: "0".repeat(64),
        });
        expect(wrongHash.status).toBe(409);
        expect(wrongHash.text).toContain("IMPORT_PREVIEW_CHANGED");
        const denied = await preview(readOnly.token, "imports.apply", {
          jobId: previewed.job.id,
          expectedInputHash: previewed.job.inputHash,
        });
        expect(denied.status).toBe(403);
        expect(denied.text).toContain("AUTOMATION_SCOPE_DENIED");
        const applyPreview = await preview(full.token, "imports.apply", {
          jobId: previewed.job.id,
          expectedInputHash: previewed.job.inputHash,
        });
        expect(applyPreview.status).toBe(201);
        noSecrets(applyPreview.text);
        const applyParsed = automationPreviewResponseSchema.parse(
          JSON.parse(applyPreview.text),
        );
        expect(applyParsed.preview.summary).toContain('"Work"');
        expect(applyParsed.preview.affected).toEqual(
          expect.arrayContaining([
            { entityKind: "calendar_import", entityId: previewed.job.id },
          ]),
        );
        expect(baikal.resources.size).toBe(0);
        const applied = await confirm(applyParsed.preview.id);
        expect(applied.result).toMatchObject({
          replayed: false,
          job: { state: "applied", itemCounts: { applied: 1, pending: 0 } },
        });
        expect(JSON.stringify(applied)).not.toContain("BEGIN:VEVENT");
        expect(baikal.resources.size).toBe(1);
        const repeatPreview = automationPreviewResponseSchema.parse(
          JSON.parse(
            (
              await preview(full.token, "imports.apply", {
                jobId: previewed.job.id,
                expectedInputHash: previewed.job.inputHash,
              })
            ).text,
          ),
        );
        expect(repeatPreview.preview.summary).toContain("already applied");
        expect((await confirm(repeatPreview.preview.id)).result).toMatchObject({
          replayed: true,
        });
        expect(baikal.resources.size).toBe(1);

        // Feeds: metadata and counts only; revoke once.
        const feedsText = await (
          await automation(
            full.token,
            "/api/automation/v1/resources/calendar-feeds",
            "GET",
          )
        ).text();
        noSecrets(feedsText);
        const feeds = automationCalendarFeedResourceSchema.parse(
          JSON.parse(feedsText),
        );
        expect(feeds.feeds).toEqual([
          expect.objectContaining({
            id: feed.capability.id,
            label: "Phone",
            calendarName: "Work",
            active: true,
          }),
        ]);
        expect(feeds.calendars).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              calendarId,
              displayName: "Work",
              providerKind: "baikal",
              publishedEvents: 1,
              activeFeeds: 1,
            }),
          ]),
        );
        expect((await fetch(`${server.baseUrl}${feed.url}`)).status).toBe(200);
        const revokePreview = await preview(
          full.token,
          "calendar_feeds.revoke",
          {
            feedId: feed.capability.id,
          },
        );
        expect(revokePreview.status).toBe(201);
        noSecrets(revokePreview.text);
        const revoked = await confirm(
          automationPreviewResponseSchema.parse(JSON.parse(revokePreview.text))
            .preview.id,
        );
        expect(revoked.result).toMatchObject({
          feed: { id: feed.capability.id, active: false },
        });
        expect((await fetch(`${server.baseUrl}${feed.url}`)).status).toBe(404);
        const revokeAgain = await preview(full.token, "calendar_feeds.revoke", {
          feedId: feed.capability.id,
        });
        expect(revokeAgain.status).toBe(409);
        expect(revokeAgain.text).toContain("FEED_ALREADY_REVOKED");

        // Google resync reuses the stored grant; scopes do not widen.
        const refreshesBefore = google.refreshes();
        const resyncPreview = automationPreviewResponseSchema.parse(
          JSON.parse(
            (
              await preview(full.token, "connectors.resync", {
                connector: "google",
                full: false,
              })
            ).text,
          ),
        );
        expect(resyncPreview.preview.summary).toContain("no new authorization");
        expect(google.refreshes()).toBe(refreshesBefore);
        const resynced = await confirm(resyncPreview.preview.id);
        noSecrets(JSON.stringify(resynced));
        expect(resynced.result).toMatchObject({
          status: { state: "connected", grantedScopes: googleScopes },
          resetCalendars: [],
        });
        expect(google.refreshes()).toBe(refreshesBefore + 1);
        expect(
          (
            await preview(full.token, "connectors.resync", {
              connector: "baikal",
            })
          ).status,
        ).toBe(400);

        // Audit and revoked credential.
        const audit = (await (
          await fetch(`${server.baseUrl}/api/automation/audit`, {
            headers: { Cookie: cookie },
          })
        ).json()) as {
          entries: { operation: string; phase: string; outcome: string }[];
        };
        for (const operation of [
          "imports.apply",
          "calendar_feeds.revoke",
          "connectors.resync",
        ]) {
          expect(
            audit.entries.some(
              (entry) =>
                entry.operation === operation &&
                entry.phase === "execute" &&
                entry.outcome === "succeeded",
            ),
            operation,
          ).toBe(true);
        }
        expect(
          audit.entries.some(
            (entry) =>
              entry.operation === "imports.apply" &&
              entry.phase === "preview" &&
              entry.outcome === "denied",
          ),
        ).toBe(true);
        expect(
          (await owner(`/api/automation/tokens/${full.record.id}`, "DELETE"))
            .status,
        ).toBe(204);
        expect(
          (
            await automation(
              full.token,
              "/api/automation/v1/resources/calendar-feeds",
              "GET",
            )
          ).status,
        ).toBe(401);
      } finally {
        await server.close();
      }
    });
  });
});
