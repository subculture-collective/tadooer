import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  automationTokenScopeSchema,
  createAutomationTokenResponseSchema,
  googleAuthorizationResponseSchema,
  googleConnectorStatusResponseSchema,
  googleSyncResponseSchema,
  taskMutationResponseSchema,
  type GoogleConnectorStatusResponse,
} from "@suite/contracts";
import { withTemporaryDirectory } from "@suite/test-support";
import type { ServerConfig } from "./config.ts";
import { startSuiteServer, type RunningSuiteServer } from "./server.ts";

const readScopes = [
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
  "https://www.googleapis.com/auth/calendar.events.readonly",
];
const writeScope = "https://www.googleapis.com/auth/calendar.events";

/**
 * Google fake for ADR 0040: the scopes returned by code exchange and refresh
 * and each calendar's accessRole are controllable, and every request that is
 * not a read of the calendar API is recorded so the test can prove no write
 * reached Google.
 */
const googleWriteFixture = () => {
  let exchangeScopes = readScopes;
  let refreshScopes: string[] | null = readScopes;
  let invalidGrant = false;
  const roles: Record<string, string> = {
    "owned@example.test": "owner",
    "shared@example.test": "reader",
  };
  const calendarWrites: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    await Promise.resolve();
    const url =
      input instanceof URL
        ? input
        : new URL(typeof input === "string" ? input : input.url);
    const method = init?.method ?? "GET";
    if (url.href === "https://oauth2.googleapis.com/token") {
      const body = new URLSearchParams(
        init?.body instanceof URLSearchParams ? init.body.toString() : "",
      );
      if (body.get("grant_type") === "authorization_code")
        return Response.json({
          access_token: "access-code",
          refresh_token: "refresh-secret",
          expires_in: 3600,
          scope: exchangeScopes.join(" "),
        });
      if (invalidGrant)
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      return Response.json({
        access_token: "access-refresh",
        expires_in: 3600,
        ...(refreshScopes === null ? {} : { scope: refreshScopes.join(" ") }),
      });
    }
    if (url.hostname === "www.googleapis.com" && method !== "GET") {
      calendarWrites.push(`${method} ${url.pathname}`);
      return new Response("", { status: 500 });
    }
    if (url.pathname === "/calendar/v3/users/me/calendarList")
      return Response.json({
        items: Object.entries(roles).map(([id, accessRole]) => ({
          id,
          etag: `"${id}-${accessRole}"`,
          summary: id.startsWith("owned") ? "Owned" : "Shared",
          accessRole,
          primary: id.startsWith("owned"),
        })),
      });
    if (url.pathname.endsWith("/events"))
      return Response.json({ items: [], nextSyncToken: "sync" });
    return new Response("", { status: 404 });
  };
  return {
    fetcher,
    calendarWrites,
    setExchangeScopes: (scopes: string[]) => {
      exchangeScopes = scopes;
    },
    setRefreshScopes: (scopes: string[] | null) => {
      refreshScopes = scopes;
    },
    setRole: (calendar: string, role: string) => {
      roles[calendar] = role;
    },
    setInvalidGrant: (value: boolean) => {
      invalidGrant = value;
    },
  };
};

const configuration = (directory: string, oauth: string): ServerConfig => ({
  host: "127.0.0.1",
  port: 0,
  databasePath: join(directory, "suite.sqlite"),
  webRoot: join(directory, "web"),
  baikalEndpoint: "http://baikal.test/dav.php/",
  credentialKeyPath: join(directory, "credential.key"),
  googleOAuthConfigPath: oauth,
  secureCookies: false,
  build: { version: "test", revision: "google-write", builtAt: null },
});

describe("Google write consent and writable calendars (ADR 0040)", () => {
  it("keeps read-only by default, records explicit consent, refuses unsafe writes and handles downgrades", async () => {
    await withTemporaryDirectory(async (directory) => {
      await mkdir(join(directory, "web"));
      await writeFile(join(directory, "web", "index.html"), "<h1>Suite</h1>");
      const oauthPath = join(directory, "google-oauth.json");
      const google = googleWriteFixture();
      const server: RunningSuiteServer = await startSuiteServer(
        configuration(directory, oauthPath),
        { googleFetch: google.fetcher },
      );
      try {
        await writeFile(
          oauthPath,
          JSON.stringify({
            clientId: "client.apps.googleusercontent.com",
            clientSecret: "client-secret",
            redirectUri: `${server.baseUrl}/api/connectors/google/callback`,
          }),
          { mode: 0o600 },
        );
        await chmod(oauthPath, 0o600);
        const owner = {
          username: "owner",
          displayName: "Owner",
          password: "correct horse battery staple",
        };
        await fetch(`${server.baseUrl}/api/setup`, {
          method: "POST",
          headers: {
            Origin: server.baseUrl,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(owner),
        });
        const login = await fetch(`${server.baseUrl}/api/auth/login`, {
          method: "POST",
          headers: {
            Origin: server.baseUrl,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(owner),
        });
        const cookie = login.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
        const { csrfToken } = (await login.json()) as { csrfToken: string };
        const browser = (
          path: string,
          method: "POST" | "DELETE",
          body?: unknown,
          headers: Record<string, string> = {},
        ) =>
          fetch(`${server.baseUrl}${path}`, {
            method,
            redirect: "manual",
            headers: {
              Origin: server.baseUrl,
              Cookie: cookie,
              "X-CSRF-Token": csrfToken,
              ...(body === undefined
                ? {}
                : { "Content-Type": "application/json" }),
              ...headers,
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          });
        const status = async (): Promise<GoogleConnectorStatusResponse> =>
          googleConnectorStatusResponseSchema.parse(
            await (
              await fetch(`${server.baseUrl}/api/connectors/google`, {
                headers: { Cookie: cookie },
              })
            ).json(),
          );
        const authorize = async (access?: "read" | "write") => {
          const response = await browser(
            "/api/connectors/google/authorize",
            "POST",
            access === undefined ? undefined : { access },
          );
          expect(response.status).toBe(200);
          return new URL(
            googleAuthorizationResponseSchema.parse(await response.json())
              .authorizationUrl,
          );
        };
        const callback = async (url: URL) =>
          (
            await fetch(
              `${server.baseUrl}/api/connectors/google/callback?state=${encodeURIComponent(url.searchParams.get("state") ?? "")}&code=authorized-code`,
              { redirect: "manual" },
            )
          ).headers.get("location");
        const sync = async () =>
          googleSyncResponseSchema.parse(
            await (await browser("/api/connectors/google/sync", "POST")).json(),
          ).status;
        const calendarIds = (value: GoogleConnectorStatusResponse) => {
          const owned = value.calendars.find(
            ({ href }) => href === "owned@example.test",
          )?.id;
          const shared = value.calendars.find(
            ({ href }) => href === "shared@example.test",
          )?.id;
          if (owned === undefined || shared === undefined)
            throw new Error("Google calendars were not discovered");
          return { owned, shared };
        };
        const capability = (
          value: GoogleConnectorStatusResponse,
          calendarId: string,
        ) => value.capabilities.find((item) => item.calendarId === calendarId);

        // Write consent cannot create a connection on its own.
        const early = await browser(
          "/api/connectors/google/authorize",
          "POST",
          {
            access: "write",
          },
        );
        expect(early.status).toBe(409);
        expect(
          (
            await browser("/api/connectors/google/authorize", "POST", {
              access: "admin",
            })
          ).status,
        ).toBe(400);

        // Default connection: read scopes only, no incremental grant.
        const readUrl = await authorize();
        expect(readUrl.searchParams.get("scope")?.split(" ")).toEqual(
          readScopes,
        );
        expect(readUrl.searchParams.has("include_granted_scopes")).toBe(false);
        expect(await callback(readUrl)).toBe("/?google=connected");
        let current = await status();
        const { owned, shared } = calendarIds(current);
        expect(current.write).toEqual({
          consent: "none",
          consentedAt: null,
          scopeGranted: false,
        });
        expect(capability(current, owned)).toEqual({
          calendarId: owned,
          accessRole: "owner",
          writable: false,
          reason: "consent-required",
        });
        expect(capability(current, shared)).toMatchObject({
          accessRole: "reader",
          writable: false,
        });

        const created = taskMutationResponseSchema.parse(
          await (
            await browser(
              "/api/tasks",
              "POST",
              { title: "Block me", notes: "" },
              { "Idempotency-Key": "google-write-task" },
            )
          ).json(),
        );
        let attempt = 0;
        const timeBlock = async (calendarId: string) => {
          attempt += 1;
          const response = await browser(
            `/api/tasks/${created.task.id}/time-block`,
            "POST",
            {
              calendarId,
              startsAt: "2026-09-30T14:00:00.000Z",
              durationMinutes: 30,
            },
            {
              "If-Match": '"1"',
              "Idempotency-Key": `google-write-${String(attempt)}`,
            },
          );
          return {
            status: response.status,
            code: ((await response.json()) as { code?: string }).code,
          };
        };
        expect(await timeBlock(owned)).toEqual({
          status: 403,
          code: "GOOGLE_CALENDAR_NOT_WRITABLE",
        });

        // The owner unticks the write scope on Google's consent screen.
        const declinedUrl = await authorize("write");
        expect(declinedUrl.searchParams.get("scope")?.split(" ")).toEqual([
          ...readScopes,
          writeScope,
        ]);
        expect(declinedUrl.searchParams.get("include_granted_scopes")).toBe(
          "true",
        );
        expect(await callback(declinedUrl)).toBe("/?google=write-not-granted");
        current = await status();
        expect(current.connected).toBe(true);
        expect(current.write.consent).toBe("none");

        // The owner grants it.
        google.setExchangeScopes([...readScopes, writeScope]);
        google.setRefreshScopes([...readScopes, writeScope]);
        expect(await callback(await authorize("write"))).toBe(
          "/?google=write-granted",
        );
        current = await status();
        expect(current.write).toMatchObject({
          consent: "granted",
          scopeGranted: true,
        });
        expect(current.write.consentedAt).not.toBeNull();
        expect(capability(current, owned)).toMatchObject({
          writable: true,
          reason: null,
        });
        expect(capability(current, shared)).toMatchObject({
          writable: false,
          reason: "read-only-calendar",
        });
        // A writable calendar still has no Google adapter until #40.
        expect(await timeBlock(owned)).toEqual({
          status: 409,
          code: "GOOGLE_WRITE_NOT_AVAILABLE",
        });
        expect(await timeBlock(shared)).toEqual({
          status: 403,
          code: "GOOGLE_CALENDAR_NOT_WRITABLE",
        });

        // The assistant path is gated the same way at preview.
        const token = createAutomationTokenResponseSchema.parse(
          await (
            await browser("/api/automation/tokens", "POST", {
              label: "Assistant",
              scopes: [...automationTokenScopeSchema.options],
              expiresAt: new Date(Date.now() + 3600000).toISOString(),
            })
          ).json(),
        ).token;
        const assistantPreview = await fetch(
          `${server.baseUrl}/api/automation/v1/previews`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              operation: "schedule.create_time_block",
              input: {
                taskId: created.task.id,
                calendarId: shared,
                startsAt: "2026-09-30T14:00:00.000Z",
                durationMinutes: 30,
              },
            }),
          },
        );
        expect(assistantPreview.status).toBe(403);
        expect(((await assistantPreview.json()) as { code: string }).code).toBe(
          "GOOGLE_CALENDAR_NOT_WRITABLE",
        );

        // Google narrows the grant: consent stays recorded but is lost.
        google.setRefreshScopes(readScopes);
        current = await sync();
        expect(current.grantedScopes).not.toContain(writeScope);
        expect(current.write).toMatchObject({
          consent: "lost",
          scopeGranted: false,
        });
        expect(capability(current, owned)).toMatchObject({
          writable: false,
          reason: "scope-missing",
        });
        expect(await timeBlock(owned)).toMatchObject({ status: 403 });

        // A refresh without a scope field never implies write access.
        google.setRefreshScopes(null);
        current = await sync();
        expect(current.write.scopeGranted).toBe(false);

        // Scope restored, then the calendar's role is narrowed in Google.
        google.setRefreshScopes([...readScopes, writeScope]);
        google.setRole("owned@example.test", "reader");
        current = await sync();
        expect(current.write.consent).toBe("granted");
        expect(capability(current, owned)).toMatchObject({
          accessRole: "reader",
          writable: false,
          reason: "read-only-calendar",
        });
        google.setRole("owned@example.test", "writer");
        current = await sync();
        expect(capability(current, owned)).toMatchObject({
          accessRole: "writer",
          writable: true,
        });

        // Revocation: reconnect required, projections kept, writes refused.
        google.setInvalidGrant(true);
        current = await sync();
        expect(current.state).toBe("reconnect_required");
        expect(current.write.consent).toBe("lost");
        expect(current.calendars).toHaveLength(2);
        expect(capability(current, owned)).toMatchObject({
          writable: false,
          reason: "reconnect-required",
        });
        google.setInvalidGrant(false);

        // A read-only reconnect clears consent even if Google returned write.
        expect(await callback(await authorize())).toBe("/?google=connected");
        current = await status();
        expect(current.write.consent).toBe("none");
        expect(capability(current, owned)).toMatchObject({
          writable: false,
          reason: "consent-required",
        });

        // Withdrawal is CSRF-protected and stops writes locally.
        expect(await callback(await authorize("write"))).toBe(
          "/?google=write-granted",
        );
        expect((await status()).write.consent).toBe("granted");
        const forged = await fetch(
          `${server.baseUrl}/api/connectors/google/write-consent`,
          {
            method: "DELETE",
            headers: { Origin: server.baseUrl, Cookie: cookie },
          },
        );
        expect(forged.status).toBe(403);
        const withdrawn = await browser(
          "/api/connectors/google/write-consent",
          "DELETE",
        );
        expect(withdrawn.status).toBe(200);
        current = googleConnectorStatusResponseSchema.parse(
          await withdrawn.json(),
        );
        expect(current.write).toMatchObject({
          consent: "none",
          scopeGranted: true,
        });
        expect(capability(current, owned)).toMatchObject({
          writable: false,
          reason: "consent-required",
        });
        expect(google.calendarWrites).toEqual([]);

        const raw = new DatabaseSync(join(directory, "suite.sqlite"), {
          readOnly: true,
        });
        const states = raw
          .prepare(
            "SELECT state_hash, requested_access FROM google_oauth_states",
          )
          .all() as unknown as readonly {
          readonly state_hash: string;
          readonly requested_access: string;
        }[];
        expect(states.length).toBeGreaterThan(0);
        for (const row of states)
          expect(row.state_hash).toMatch(/^[A-Za-z0-9_-]{43}$/);
        raw.close();

        // Disconnect removes consent and roles with the connector.
        await browser("/api/connectors/google", "DELETE");
        current = await status();
        expect(current.write.consent).toBe("none");
        expect(current.capabilities).toEqual([]);
        expect(
          (await browser("/api/connectors/google/write-consent", "DELETE"))
            .status,
        ).toBe(404);
      } finally {
        await server.close();
      }
    });
  });
});
