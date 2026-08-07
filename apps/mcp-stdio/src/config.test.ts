import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { withTemporaryDirectory } from "@suite/test-support";
import {
  automationApiUrl,
  loadConfig,
  parseConfigArguments,
} from "./config.ts";

const validToken = `suite_at_00000000-0000-4000-8000-000000000001.${"a".repeat(43)}`;

describe("MCP stdio adapter configuration", () => {
  it("requires exactly one Suite URL and one token file", () => {
    expect(() => parseConfigArguments([])).toThrow("Usage:");
    expect(() =>
      parseConfigArguments([
        "--url",
        "http://127.0.0.1:8080",
        "--token-file",
        "credential",
      ]),
    ).not.toThrow();
    expect(() =>
      parseConfigArguments([
        "--url",
        "http://suite.example.test",
        "--token-file",
        "credential",
      ]),
    ).toThrow("Plain HTTP");
    expect(() =>
      parseConfigArguments([
        "--url",
        "https://suite.example.test/api",
        "--token-file",
        "credential",
      ]),
    ).toThrow("Suite URL is invalid");
  });

  it("loads only an owner-only token file", async () => {
    await withTemporaryDirectory(async (directory) => {
      const tokenFile = join(directory, "automation.token");
      await writeFile(tokenFile, `${validToken}\n`, { mode: 0o600 });
      await chmod(tokenFile, 0o600);
      await expect(
        loadConfig([
          "--token-file",
          tokenFile,
          "--url",
          "http://localhost:8080",
        ]),
      ).resolves.toMatchObject({ token: validToken });

      await chmod(tokenFile, 0o644);
      await expect(
        loadConfig([
          "--url",
          "http://localhost:8080",
          "--token-file",
          tokenFile,
        ]),
      ).rejects.toThrow("owner-only");
    });
  });

  it("permits only API-local catalog paths", () => {
    const baseUrl = new URL("https://suite.example.test/");
    expect(automationApiUrl(baseUrl, "/api/automation/v1/tasks").href).toBe(
      "https://suite.example.test/api/automation/v1/tasks",
    );
    expect(() => automationApiUrl(baseUrl, "/api/tasks")).toThrow("outside");
    expect(() =>
      automationApiUrl(
        baseUrl,
        "https://elsewhere.test/api/automation/v1/tasks",
      ),
    ).toThrow("invalid");
  });
});
