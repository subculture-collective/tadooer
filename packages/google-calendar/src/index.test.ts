import { describe, expect, it } from "vitest";
import {
  buildGoogleAuthorizationUrl,
  evaluateGoogleWriteCapability,
  exchangeGoogleCode,
  googleReadScopes,
  googleWriteScope,
  listGoogleCalendars,
  refreshGoogleAccess,
  syncGoogleEvents,
} from "./index.ts";

const client = {
  clientId: "client",
  clientSecret: "secret",
  redirectUri: "http://localhost:8080/api/connectors/google/callback",
};

describe("Google Calendar provider boundary", () => {
  it("builds an offline owner-state authorization request with narrow scopes", () => {
    const url = new URL(
      buildGoogleAuthorizationUrl(
        {
          clientId: "client",
          clientSecret: "secret",
          redirectUri: "http://localhost:8080/api/connectors/google/callback",
        },
        "state-proof",
      ),
    );
    expect(url.origin).toBe("https://accounts.google.com");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("state")).toBe("state-proof");
    expect(url.searchParams.get("scope")).toContain("calendar.events.readonly");
  });
  it("paginates discovery without widening authorization", async () => {
    const calls: URL[] = [];
    const result = await listGoogleCalendars("access", async (input) => {
      await Promise.resolve();
      const url =
        input instanceof URL
          ? input
          : new URL(typeof input === "string" ? input : input.url);
      calls.push(url);
      return new Response(
        JSON.stringify(
          calls.length === 1
            ? {
                items: [
                  {
                    id: "one",
                    etag: '"1"',
                    summary: "One",
                    accessRole: "reader",
                  },
                ],
                nextPageToken: "page-2",
              }
            : {
                items: [
                  {
                    id: "two",
                    etag: '"2"',
                    summary: "Two",
                    accessRole: "owner",
                    primary: true,
                  },
                ],
              },
        ),
        { status: 200 },
      );
    });
    expect(result).toHaveLength(2);
    expect(calls[1]?.searchParams.get("pageToken")).toBe("page-2");
    expect(calls[0]?.href).not.toContain("secret");
  });
  it("projects recurring instances, deletions, pagination, and 410 reset", async () => {
    let count = 0;
    const fetcher: typeof fetch = async () => {
      await Promise.resolve();
      count += 1;
      return new Response(
        JSON.stringify(
          count === 1
            ? {
                items: [
                  {
                    id: "instance",
                    iCalUID: "series",
                    etag: '"e1"',
                    summary: "Recurring",
                    start: { dateTime: "2026-08-08T12:00:00Z" },
                    end: { dateTime: "2026-08-08T13:00:00Z" },
                    recurringEventId: "series-master",
                  },
                ],
                nextPageToken: "next",
              }
            : {
                items: [
                  {
                    id: "deleted",
                    iCalUID: "deleted",
                    etag: '"e2"',
                    status: "cancelled",
                  },
                ],
                nextSyncToken: "sync-2",
              },
        ),
        { status: 200 },
      );
    };
    const result = await syncGoogleEvents(
      "access",
      "calendar@example.test",
      null,
      fetcher,
    );
    expect(result).toMatchObject({
      kind: "ok",
      nextSyncToken: "sync-2",
      events: [{ recurrence: "instance" }, { deleted: true }],
    });
    expect(
      await syncGoogleEvents("access", "calendar", "expired", async () => {
        await Promise.resolve();
        return new Response("", { status: 410 });
      }),
    ).toEqual({ kind: "reset-required" });
  });
  it("turns invalid_grant refresh failures into reconnect authority", async () => {
    expect(
      await refreshGoogleAccess(
        {
          clientId: "id",
          clientSecret: "secret",
          redirectUri: "http://localhost/callback",
        },
        "refresh",
        async () => {
          await Promise.resolve();
          return new Response(JSON.stringify({ error: "invalid_grant" }), {
            status: 400,
          });
        },
      ),
    ).toBe("invalid_grant");
  });
  it("keeps read-only as the default request and asks for write only explicitly", () => {
    const read = new URL(buildGoogleAuthorizationUrl(client, "state-proof"));
    const readScopes = read.searchParams.get("scope")?.split(" ") ?? [];
    expect(readScopes).toEqual([...googleReadScopes]);
    expect(readScopes).not.toContain(googleWriteScope);
    // No incremental authorization: a read reconnect must not carry write.
    expect(read.searchParams.has("include_granted_scopes")).toBe(false);

    const write = new URL(
      buildGoogleAuthorizationUrl(client, "state-proof", "write"),
    );
    expect(write.searchParams.get("scope")?.split(" ")).toEqual([
      ...googleReadScopes,
      googleWriteScope,
    ]);
    expect(write.searchParams.get("include_granted_scopes")).toBe("true");
    expect(write.searchParams.get("prompt")).toBe("consent");
    expect(write.searchParams.get("scope")).not.toMatch(/auth\/calendar( |$)/);
  });

  it("reports granted scopes exactly and never infers write from a missing scope field", async () => {
    const tokenResponse =
      (body: Record<string, unknown>): typeof fetch =>
      async () => {
        await Promise.resolve();
        return Response.json(body);
      };
    const declined = await exchangeGoogleCode(
      client,
      "code",
      tokenResponse({
        access_token: "a",
        refresh_token: "r",
        expires_in: 3600,
        scope: googleReadScopes.join(" "),
      }),
    );
    expect(declined?.scopes).not.toContain(googleWriteScope);
    const granted = await exchangeGoogleCode(
      client,
      "code",
      tokenResponse({
        access_token: "a",
        refresh_token: "r",
        expires_in: 3600,
        scope: [...googleReadScopes, googleWriteScope].join(" "),
      }),
    );
    expect(granted?.scopes).toContain(googleWriteScope);
    const refreshed = await refreshGoogleAccess(
      client,
      "r",
      tokenResponse({ access_token: "a", expires_in: 3600 }),
    );
    if (refreshed === undefined || refreshed === "invalid_grant")
      throw new Error("refresh should succeed");
    expect(refreshed.scopes).toEqual([...googleReadScopes]);
  });

  it("discovers writable and read-only calendar roles", async () => {
    const result = await listGoogleCalendars("access", async () => {
      await Promise.resolve();
      return Response.json({
        items: [
          { id: "mine", etag: '"1"', summary: "Mine", accessRole: "owner" },
          { id: "team", etag: '"2"', summary: "Team", accessRole: "writer" },
          { id: "view", etag: '"3"', summary: "View", accessRole: "reader" },
          {
            id: "busy",
            etag: '"4"',
            summary: "Busy",
            accessRole: "freeBusyReader",
          },
          { id: "odd", etag: '"5"', summary: "Odd", accessRole: "admin" },
        ],
      });
    });
    expect(result?.map(({ id, accessRole }) => [id, accessRole])).toEqual([
      ["mine", "owner"],
      ["team", "writer"],
      ["view", "reader"],
      ["busy", "freeBusyReader"],
    ]);
  });

  it("allows writes only with connection, consent, write scope and a writable role", () => {
    const writable = {
      connectorState: "connected" as const,
      writeConsentAt: "2026-09-29T00:00:00.000Z",
      grantedScopes: [...googleReadScopes, googleWriteScope],
      accessRole: "writer" as const,
    };
    expect(evaluateGoogleWriteCapability(writable)).toEqual({
      writable: true,
    });
    expect(
      evaluateGoogleWriteCapability({ ...writable, connectorState: "stale" }),
    ).toEqual({ writable: true });
    expect(
      evaluateGoogleWriteCapability({ ...writable, accessRole: "owner" }),
    ).toEqual({ writable: true });
    const refused = (
      change: Partial<Parameters<typeof evaluateGoogleWriteCapability>[0]>,
    ) => evaluateGoogleWriteCapability({ ...writable, ...change });
    expect(refused({ connectorState: "disconnected" })).toEqual({
      writable: false,
      reason: "not-connected",
    });
    expect(refused({ connectorState: "reconnect_required" })).toEqual({
      writable: false,
      reason: "reconnect-required",
    });
    expect(refused({ writeConsentAt: null })).toEqual({
      writable: false,
      reason: "consent-required",
    });
    expect(refused({ grantedScopes: [...googleReadScopes] })).toEqual({
      writable: false,
      reason: "scope-missing",
    });
    expect(refused({ accessRole: null })).toEqual({
      writable: false,
      reason: "role-unknown",
    });
    expect(refused({ accessRole: "reader" })).toEqual({
      writable: false,
      reason: "read-only-calendar",
    });
    expect(refused({ accessRole: "freeBusyReader" })).toEqual({
      writable: false,
      reason: "read-only-calendar",
    });
  });
});
