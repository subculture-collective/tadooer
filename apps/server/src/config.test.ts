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
});
