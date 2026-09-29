import { afterEach, describe, expect, it, vi } from "vitest";
import {
  beginGoogleAuthorization,
  disconnectGoogle,
  getGoogleStatus,
  synchronizeGoogle,
  updatePlanningPreferences,
  withdrawGoogleWriteConsent,
} from "./api.ts";

const response = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

afterEach(() => vi.unstubAllGlobals());

describe("Phase 3 browser API", () => {
  it("requests a full resync without disconnecting or authorizing again", async () => {
    const fetcher = vi.fn(() =>
      Promise.resolve(
        response({ status: disconnectedStatus, resetCalendars: [] }),
      ),
    );
    vi.stubGlobal("fetch", fetcher);
    await synchronizeGoogle("csrf-token", true);
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(
      "/api/connectors/google/sync",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ full: true }),
      }),
    );
  });

  it("asks for write access only from the explicit consent call", async () => {
    const fetcher = vi.fn((path: string, init: RequestInit = {}) => {
      void init;
      return Promise.resolve(
        path.endsWith("/authorize")
          ? response({
              authorizationUrl:
                "https://accounts.google.com/o/oauth2/v2/auth?state=state",
              expiresAt: "2026-08-07T12:10:00.000Z",
            })
          : response(disconnectedStatus),
      );
    });
    vi.stubGlobal("fetch", fetcher);
    await beginGoogleAuthorization("csrf-token");
    await beginGoogleAuthorization("csrf-token", "write");
    await withdrawGoogleWriteConsent("csrf-token");
    const [read, write, withdraw] = fetcher.mock.calls;
    expect(read?.[1]?.body).toBeUndefined();
    expect(write?.[1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({ access: "write" }),
    });
    expect(new Headers(write?.[1]?.headers).get("x-csrf-token")).toBe(
      "csrf-token",
    );
    expect(withdraw?.[0]).toBe("/api/connectors/google/write-consent");
    expect(withdraw?.[1]).toMatchObject({ method: "DELETE" });
    expect(new Headers(withdraw?.[1]?.headers).get("x-csrf-token")).toBe(
      "csrf-token",
    );
  });

  it("uses CSRF-protected connector mutations and strict response contracts", async () => {
    const calls: { path: string; method: string; csrf: string | null }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((path: string, init: RequestInit = {}) => {
        calls.push({
          path,
          method: init.method ?? "GET",
          csrf: new Headers(init.headers).get("x-csrf-token"),
        });
        if (path.endsWith("/authorize"))
          return Promise.resolve(
            response({
              authorizationUrl:
                "https://accounts.google.com/o/oauth2/v2/auth?state=state",
              expiresAt: "2026-08-07T12:10:00.000Z",
            }),
          );
        if (path.endsWith("/sync"))
          return Promise.resolve(
            response({ status: disconnectedStatus, resetCalendars: [] }),
          );
        if (path === "/api/connectors/google" && init.method === "DELETE")
          return Promise.resolve(
            response({ disconnected: true, remoteRevoked: false }),
          );
        if (path === "/api/connectors/google")
          return Promise.resolve(response(disconnectedStatus));
        return Promise.resolve(
          response({
            workingDays: [1, 2, 3, 4, 5],
            workdayStart: "09:00",
            workdayEnd: "17:00",
            breakStart: null,
            breakEnd: null,
            timeZone: "UTC",
          }),
        );
      }),
    );

    await getGoogleStatus();
    await beginGoogleAuthorization("csrf-token");
    await synchronizeGoogle("csrf-token");
    await disconnectGoogle("csrf-token");
    await updatePlanningPreferences(
      {
        workingDays: [1, 2, 3, 4, 5],
        workdayStart: "09:00",
        workdayEnd: "17:00",
        breakStart: null,
        breakEnd: null,
        timeZone: "UTC",
      },
      "csrf-token",
    );

    expect(calls).toEqual([
      { path: "/api/connectors/google", method: "GET", csrf: null },
      {
        path: "/api/connectors/google/authorize",
        method: "POST",
        csrf: "csrf-token",
      },
      {
        path: "/api/connectors/google/sync",
        method: "POST",
        csrf: "csrf-token",
      },
      {
        path: "/api/connectors/google",
        method: "DELETE",
        csrf: "csrf-token",
      },
      {
        path: "/api/planning/preferences",
        method: "PUT",
        csrf: "csrf-token",
      },
    ]);
  });
});

const disconnectedStatus = {
  configured: true,
  connected: false,
  state: "disconnected",
  providerId: null,
  accountLabel: null,
  grantedScopes: [],
  calendars: [],
  freshness: [],
  write: { consent: "none", consentedAt: null, scopeGranted: false },
  capabilities: [],
};
