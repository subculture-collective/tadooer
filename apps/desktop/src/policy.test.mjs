import { describe, expect, it } from "vitest";
import { URL, URLSearchParams } from "node:url";
import {
  allowedExternalOAuth,
  allowedNavigation,
  suiteOrigin,
} from "./policy.mjs";

describe("desktop authority policy", () => {
  it("accepts HTTPS and loopback development origins only", () => {
    expect(suiteOrigin("https://suite.example.test")).toBe(
      "https://suite.example.test",
    );
    expect(suiteOrigin("http://127.0.0.1:18080")).toBe(
      "http://127.0.0.1:18080",
    );
    expect(suiteOrigin("http://suite.example.test")).toBeUndefined();
    expect(
      suiteOrigin("https://user:secret@suite.example.test"),
    ).toBeUndefined();
    expect(suiteOrigin("https://suite.example.test/path")).toBeUndefined();
  });
  it("blocks navigation outside the configured Suite authority", () => {
    expect(
      allowedNavigation(
        "https://suite.example.test/api/health",
        "https://suite.example.test",
      ),
    ).toBe(true);
    expect(
      allowedNavigation(
        "https://attacker.example/",
        "https://suite.example.test",
      ),
    ).toBe(false);
  });
  it("opens only the exact Google OAuth authorization surface externally", () => {
    const allowed = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    allowed.search = new URLSearchParams({
      response_type: "code",
      client_id: "client.apps.googleusercontent.com",
      redirect_uri: "http://127.0.0.1:18080/api/connectors/google/callback",
      state: "s".repeat(43),
    }).toString();
    expect(allowedExternalOAuth(allowed.href)).toBe(true);
    expect(
      allowedExternalOAuth(
        allowed.href.replace("accounts.google.com", "attacker.example"),
      ),
    ).toBe(false);
    expect(
      allowedExternalOAuth("https://accounts.google.com/ServiceLogin"),
    ).toBe(false);
    expect(
      allowedExternalOAuth(
        "https://accounts.google.com/o/oauth2/v2/auth?response_type=code",
      ),
    ).toBe(false);
  });
});
