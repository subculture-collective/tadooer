import { describe, expect, it } from "vitest";
import {
  checkSubscriptionUrl,
  isBlockedSubscriptionHost,
  isSafeSubscriptionFilter,
  nextSubscriptionFetchAt,
  passesSubscriptionFilter,
  subscriptionFreshness,
} from "./ical-subscription.ts";

describe("subscription URL policy", () => {
  it("accepts http(s) and webcal feeds on public and private LAN hosts", () => {
    for (const raw of [
      "https://calendar.example.test/private/abc.ics",
      "http://10.0.0.56:8080/feed.ics",
      "https://192.168.1.20/cal.ics",
      "webcal://calendar.example.test/feed.ics",
    ]) {
      const check = checkSubscriptionUrl(raw);
      expect(check.ok, raw).toBe(true);
    }
    const webcal = checkSubscriptionUrl("webcal://calendar.example.test/x.ics");
    expect(webcal.ok && webcal.url.protocol).toBe("https:");
  });

  it("rejects other schemes, credentials and blocked addresses", () => {
    expect(checkSubscriptionUrl("file:///etc/passwd")).toEqual({
      ok: false,
      reason: "unsupported_scheme",
    });
    expect(checkSubscriptionUrl("ftp://host/x.ics")).toEqual({
      ok: false,
      reason: "unsupported_scheme",
    });
    expect(checkSubscriptionUrl("https://user:pw@host.test/x.ics")).toEqual({
      ok: false,
      reason: "credentials_in_url",
    });
    expect(checkSubscriptionUrl("not a url")).toEqual({
      ok: false,
      reason: "invalid_url",
    });
    expect(checkSubscriptionUrl(`https://h.test/${"a".repeat(2100)}`)).toEqual({
      ok: false,
      reason: "url_too_long",
    });
    for (const host of [
      "http://localhost/x.ics",
      "http://app.localhost/x.ics",
      "http://127.0.0.1/x.ics",
      "http://127.8.8.8/x.ics",
      "http://0.0.0.0/x.ics",
      "http://169.254.169.254/latest/meta-data",
      "http://[::1]/x.ics",
      "http://[::]/x.ics",
      "http://[fe80::1]/x.ics",
      "http://[::ffff:127.0.0.1]/x.ics",
      "http://[fd00:ec2::254]/x.ics",
      "http://metadata.google.internal/x.ics",
      "http://224.0.0.1/x.ics",
    ])
      expect(checkSubscriptionUrl(host), host).toEqual({
        ok: false,
        reason: "blocked_address",
      });
  });

  it("checks literal addresses the way the fetcher checks resolved ones", () => {
    expect(isBlockedSubscriptionHost("127.0.0.1")).toBe(true);
    expect(isBlockedSubscriptionHost("::1")).toBe(true);
    expect(isBlockedSubscriptionHost("fe80::abcd")).toBe(true);
    expect(isBlockedSubscriptionHost("10.0.0.50")).toBe(false);
    expect(isBlockedSubscriptionHost("2001:db8::1")).toBe(false);
    expect(isBlockedSubscriptionHost("calendar.example.test")).toBe(false);
  });
});

describe("subscription filters", () => {
  it("accepts ordinary patterns and rejects catastrophic ones", () => {
    expect(isSafeSubscriptionFilter("^Standup|Review$")).toBe(true);
    expect(isSafeSubscriptionFilter("(?:work|office) meeting")).toBe(true);
    expect(isSafeSubscriptionFilter("(a+)+")).toBe(false);
    expect(isSafeSubscriptionFilter("(a|ab)*c")).toBe(false);
    expect(isSafeSubscriptionFilter("(x)\\1")).toBe(false);
    expect(isSafeSubscriptionFilter("[")).toBe(false);
    expect(isSafeSubscriptionFilter("a".repeat(257))).toBe(false);
  });

  it("fails closed for include and open for exclude", () => {
    expect(passesSubscriptionFilter("Team standup", "standup", null)).toBe(
      true,
    );
    expect(passesSubscriptionFilter("Lunch", "standup", null)).toBe(false);
    expect(passesSubscriptionFilter("Lunch", null, "lunch")).toBe(false);
    expect(passesSubscriptionFilter("Lunch", "(a+)+", null)).toBe(false);
    expect(passesSubscriptionFilter("Lunch", null, "(a+)+")).toBe(true);
    expect(passesSubscriptionFilter("Lunch", "", "")).toBe(true);
  });
});

describe("subscription scheduling and freshness", () => {
  it("adds the interval and a bounded jitter", () => {
    const now = "2026-09-25T10:00:00.000Z";
    expect(nextSubscriptionFetchAt(now, 120, () => 0)).toBe(
      "2026-09-25T12:00:00.000Z",
    );
    expect(nextSubscriptionFetchAt(now, 120, () => 1)).toBe(
      "2026-09-25T12:05:00.000Z",
    );
    expect(nextSubscriptionFetchAt(now, 10, () => 1)).toBe(
      "2026-09-25T10:11:00.000Z",
    );
  });

  it("labels fetch history without repeating addresses", () => {
    const base = {
      enabled: true,
      refreshIntervalMinutes: 60,
      lastSuccessAt: null,
      lastAttemptAt: null,
      lastErrorClass: null,
    };
    const now = "2026-09-25T10:00:00.000Z";
    expect(subscriptionFreshness(base, now).state).toBe("never");
    expect(subscriptionFreshness({ ...base, enabled: false }, now).state).toBe(
      "never",
    );
    expect(
      subscriptionFreshness(
        { ...base, lastAttemptAt: now, lastErrorClass: "http_404" },
        now,
      ),
    ).toEqual({
      state: "unavailable",
      message: "No successful fetch yet (http_404)",
    });
    expect(
      subscriptionFreshness(
        { ...base, lastAttemptAt: now, lastSuccessAt: now },
        now,
      ).state,
    ).toBe("fresh");
    expect(
      subscriptionFreshness(
        {
          ...base,
          lastAttemptAt: now,
          lastSuccessAt: "2026-09-25T06:00:00.000Z",
        },
        now,
      ).state,
    ).toBe("stale");
    expect(
      subscriptionFreshness(
        {
          ...base,
          lastAttemptAt: now,
          lastSuccessAt: now,
          lastErrorClass: "timeout",
        },
        now,
      ).message,
    ).toBe("Showing saved events; the last fetch failed (timeout)");
  });
});
