import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.ts";

describe("production server configuration", () => {
  it("accepts one exact HTTPS origin and explicit proxy hosts", () => {
    const config = loadConfig({
      SUITE_PUBLIC_ORIGIN: "https://tadooer.subcult.tv",
      SUITE_TRUSTED_PROXY_CIDRS: "10.0.0.200/32,2001:db8::1/128",
      SUITE_SECURE_COOKIES: "true",
    });
    expect(config.publicOrigin).toBe("https://tadooer.subcult.tv");
    expect(config.trustedProxyCidrs).toEqual([
      "10.0.0.200/32",
      "2001:db8::1/128",
    ]);
    expect(config.secureCookies).toBe(true);
  });

  it.each([
    "http://tadooer.subcult.tv",
    "https://tadooer.subcult.tv/path",
    "https://user@tadooer.subcult.tv",
  ])("rejects an unsafe public origin: %s", (publicOrigin) => {
    expect(() => loadConfig({ SUITE_PUBLIC_ORIGIN: publicOrigin })).toThrow(
      "SUITE_PUBLIC_ORIGIN",
    );
  });

  it.each(["10.0.0.200/24", "999.0.0.1/32", "localhost/32"])(
    "rejects a non-host proxy CIDR: %s",
    (cidr) => {
      expect(() => loadConfig({ SUITE_TRUSTED_PROXY_CIDRS: cidr })).toThrow(
        "SUITE_TRUSTED_PROXY_CIDRS",
      );
    },
  );

  it("enables the calendar bridge worker with bounded defaults (ADR 0043)", () => {
    expect(loadConfig({}).calendarBridgeWorker).toEqual({
      enabled: true,
      bridgeIntervalMs: 300_000,
      projectionIntervalMs: 900_000,
      maxBackoffMs: 3_600_000,
      concurrency: 2,
      ownerConcurrency: 1,
      shutdownGraceMs: 8_000,
    });
    expect(
      loadConfig({
        SUITE_CALENDAR_BRIDGE_WORKER: "false",
        SUITE_CALENDAR_BRIDGE_INTERVAL_SECONDS: "600",
        SUITE_CALENDAR_BRIDGE_PROJECTION_INTERVAL_SECONDS: "0",
        SUITE_CALENDAR_BRIDGE_CONCURRENCY: "4",
        SUITE_CALENDAR_BRIDGE_OWNER_CONCURRENCY: "2",
        SUITE_CALENDAR_BRIDGE_MAX_BACKOFF_SECONDS: "7200",
        SUITE_CALENDAR_BRIDGE_SHUTDOWN_GRACE_SECONDS: "0",
      }).calendarBridgeWorker,
    ).toEqual({
      enabled: false,
      bridgeIntervalMs: 600_000,
      projectionIntervalMs: 0,
      maxBackoffMs: 7_200_000,
      concurrency: 4,
      ownerConcurrency: 2,
      shutdownGraceMs: 0,
    });
  });

  it.each([
    ["SUITE_CALENDAR_BRIDGE_WORKER", "off"],
    ["SUITE_CALENDAR_BRIDGE_INTERVAL_SECONDS", "10"],
    ["SUITE_CALENDAR_BRIDGE_INTERVAL_SECONDS", "0"],
    ["SUITE_CALENDAR_BRIDGE_PROJECTION_INTERVAL_SECONDS", "30"],
    ["SUITE_CALENDAR_BRIDGE_CONCURRENCY", "0"],
    ["SUITE_CALENDAR_BRIDGE_OWNER_CONCURRENCY", "1.5"],
    ["SUITE_CALENDAR_BRIDGE_MAX_BACKOFF_SECONDS", "999999"],
  ])("rejects an invalid worker setting: %s=%s", (name, value) => {
    expect(() => loadConfig({ [name]: value })).toThrow(name);
  });
});
