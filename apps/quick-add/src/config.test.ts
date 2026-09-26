import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseQuickAddConfig, readAutomationTokenFile } from "./config.ts";

const token = `suite_at_d1054acd-c04d-4bd8-a814-254b007154ba.${"A".repeat(43)}`;
const directories: string[] = [];

const tokenFile = (mode: number): string => {
  const directory = mkdtempSync(join(tmpdir(), "suite-quick-add-"));
  directories.push(directory);
  const path = join(directory, "token");
  writeFileSync(path, `${token}\n`, { mode });
  chmodSync(path, mode);
  return path;
};

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("quick-add configuration", () => {
  it("requires explicit URL, credential file, stable idempotency key, and title", () => {
    expect(
      parseQuickAddConfig([
        "--url",
        "http://127.0.0.1:8080",
        "--token-file",
        "/tmp/suite-token",
        "--idempotency-key",
        "capture-inbox-20260806",
        "--notes",
        "from terminal",
        "Capture inbox",
      ]),
    ).toMatchObject({
      baseUrl: "http://127.0.0.1:8080",
      idempotencyKey: "capture-inbox-20260806",
      title: "Capture inbox",
      notes: "from terminal",
    });
    expect(() => parseQuickAddConfig(["Only title"])).toThrow(
      "--url is required",
    );
    expect(
      parseQuickAddConfig([
        "--url",
        "http://127.0.0.1:8080",
        "--token-file",
        "/tmp/suite-token",
        "--idempotency-key",
        "capture-inbox-20260806",
        "--structured",
        "--create-tags",
        "Capture #inbox",
      ]),
    ).toMatchObject({ structured: true, createTags: true });
    expect(() =>
      parseQuickAddConfig([
        "--url",
        "https://suite.example/path",
        "--token-file",
        "/tmp/token",
        "--idempotency-key",
        "capture-inbox-20260806",
        "Only title",
      ]),
    ).toThrow("--url must be HTTPS");
  });

  it("accepts only an owner-only regular mode-0600 token file", () => {
    expect(readAutomationTokenFile(tokenFile(0o600))).toBe(token);
    expect(() => readAutomationTokenFile(tokenFile(0o640))).toThrow(
      "mode 0600",
    );
  });
});
