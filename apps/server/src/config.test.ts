import { describe, expect, it } from "vitest";
import { loadConfig, parseSyncRetentionDays } from "./config.ts";

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

  it("keeps hosted OAuth disabled unless all public deployment inputs are explicit", () => {
    expect(loadConfig({}).hostedOAuth).toEqual({ enabled: false });
    expect(() =>
      loadConfig({ SUITE_HOSTED_OAUTH_ENABLED: "true" }),
    ).toThrow("Hosted OAuth requires");

    const config = loadConfig({
      SUITE_HOSTED_OAUTH_ENABLED: "true",
      SUITE_PUBLIC_ORIGIN: "https://tadooer.example",
      SUITE_HOSTED_OAUTH_CLIENT_CONFIG_PATH: "./clients.json",
      SUITE_HOSTED_OAUTH_RESOURCE: "https://tadooer.example/mcp",
    });
    expect(config.hostedOAuth).toMatchObject({
      enabled: true,
      resource: "https://tadooer.example/mcp",
    });
    expect(config.hostedOAuth?.clientConfigPath).toMatch(/clients\.json$/);
  });

  it.each([
    "http://tadooer.example/mcp",
    "https://user@tadooer.example/mcp",
    "https://tadooer.example/mcp?token=secret",
    "https://tadooer.example/mcp#fragment",
  ])("rejects an unsafe hosted OAuth resource: %s", (resource) => {
    expect(() =>
      loadConfig({ SUITE_HOSTED_OAUTH_RESOURCE: resource }),
    ).toThrow("SUITE_HOSTED_OAUTH_RESOURCE");
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

  it("retains 30 days of sync feed changes by default (ADR 0045)", () => {
    expect(loadConfig({}).syncRetentionDays).toBe(30);
    expect(
      loadConfig({ SUITE_SYNC_RETENTION_DAYS: "" }).syncRetentionDays,
    ).toBe(30);
    expect(
      loadConfig({ SUITE_SYNC_RETENTION_DAYS: "7" }).syncRetentionDays,
    ).toBe(7);
    expect(
      loadConfig({ SUITE_SYNC_RETENTION_DAYS: "90" }).syncRetentionDays,
    ).toBe(90);
    expect(
      loadConfig({ SUITE_SYNC_RETENTION_DAYS: "3650" }).syncRetentionDays,
    ).toBe(3650);
    // 0 switches pruning off.
    expect(
      loadConfig({ SUITE_SYNC_RETENTION_DAYS: "0" }).syncRetentionDays,
    ).toBe(0);
    expect(parseSyncRetentionDays(undefined)).toBe(30);
  });

  it.each(["1", "6", "-1", "7.5", "30d", "1e2", " 30", "3651", "forever"])(
    "rejects an invalid sync retention window: %s",
    (value) => {
      expect(() => loadConfig({ SUITE_SYNC_RETENTION_DAYS: value })).toThrow(
        "SUITE_SYNC_RETENTION_DAYS",
      );
    },
  );
});
