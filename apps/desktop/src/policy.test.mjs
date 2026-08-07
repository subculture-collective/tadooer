import { describe, expect, it } from "vitest";
import { allowedNavigation, suiteOrigin } from "./policy.mjs";

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
});
