import { afterEach, describe, expect, it, vi } from "vitest";
import {
  disconnectGoogle,
  getGoogleStatus,
  revokeCalendarFeed,
} from "./api.ts";
import { subscribeSessionFailure } from "./session-recovery.ts";

afterEach(() => vi.unstubAllGlobals());

describe("shared session recovery boundary", () => {
  it.each([
    [401, "AUTH_REQUIRED", "expired"],
    [403, "CSRF_INVALID", "csrf"],
    [403, "CSRF_REQUIRED", "csrf"],
    [403, "AUTH_REQUIRED", "expired"],
    [401, "GOOGLE_AUTH_REQUIRED", null],
    [503, "PROVIDER_UNAVAILABLE", null],
  ] as const)(
    "classifies %s %s without replaying writes",
    async (status, code, expected) => {
      const listener = vi.fn();
      const unsubscribe = subscribeSessionFailure(listener);
      const fetcher = vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              code,
              message: "Request failed",
              requestId: "00000000-0000-4000-8000-000000000001",
            }),
            {
              status,
            },
          ),
        ),
      );
      vi.stubGlobal("fetch", fetcher);
      try {
        await expect(disconnectGoogle("old-token")).rejects.toThrow(
          "Request failed",
        );
        expect(fetcher).toHaveBeenCalledTimes(1);
        if (expected === null) expect(listener).not.toHaveBeenCalled();
        else expect(listener).toHaveBeenCalledWith(expected);
      } finally {
        unsubscribe();
      }
    },
  );

  it("handles empty-response mutations and removes subscribers", async () => {
    const listener = vi.fn();
    const unsubscribe = subscribeSessionFailure(listener);
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              requestId: "00000000-0000-4000-8000-000000000001",
              code: "AUTH_REQUIRED",
              message: "Sign in",
            }),
            { status: 401 },
          ),
        ),
      ),
    );
    await expect(revokeCalendarFeed("feed", "csrf")).rejects.toThrow();
    expect(listener).toHaveBeenCalledWith("expired");
    unsubscribe();
    await expect(getGoogleStatus()).rejects.toThrow();
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
