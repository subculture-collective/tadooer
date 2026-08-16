import { describe, expect, it } from "vitest";
import {
  buildGoogleAuthorizationUrl,
  listGoogleCalendars,
  refreshGoogleAccess,
  syncGoogleEvents,
} from "./index.ts";

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
});
