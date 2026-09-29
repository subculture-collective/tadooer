import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { URL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { readSecretFile } from "./baikal-setup.mjs";

const directories = [];
const temporary = () => {
  const directory = mkdtempSync(join(tmpdir(), "baikal-setup-"));
  directories.push(directory);
  return directory;
};
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const pinnedImage = (path) =>
  readFileSync(new URL(path, import.meta.url), "utf8").match(
    /^ {4}image: (ckulka\/baikal:\S+)$/m,
  )?.[1];

describe("Baikal setup tooling (ADR 0039)", () => {
  it("reads secrets only from owner-only regular files", () => {
    const directory = temporary();
    const path = join(directory, "dav.pw");
    writeFileSync(path, "generated-secret-value\n", { mode: 0o600 });
    expect(readSecretFile(path, "DAV password")).toBe("generated-secret-value");
    chmodSync(path, 0o644);
    expect(() => readSecretFile(path, "DAV password")).toThrow(
      /must be mode 0600/,
    );
    expect(() => readSecretFile(directory, "DAV password")).toThrow(
      /not a regular file/,
    );
    try {
      readSecretFile(path, "DAV password");
    } catch (error) {
      expect(String(error)).not.toContain("generated-secret-value");
    }
  });

  it("pins the bundled production service to the qualified development image", () => {
    const development = pinnedImage("../compose.yaml");
    const production = pinnedImage("./production/compose.yaml");
    expect(development).toMatch(/@sha256:[0-9a-f]{64}$/);
    expect(production).toBe(development);
    const compose = readFileSync(
      new URL("./production/compose.yaml", import.meta.url),
      "utf8",
    );
    expect(compose).toContain('profiles: ["bundled-baikal"]');
    expect(compose).toContain(
      "BAIKAL_ENDPOINT: ${BAIKAL_ENDPOINT:-http://baikal/dav.php/}",
    );
    expect(compose).toMatch(
      /"127\.0\.0\.1:\$\{TADOOER_BAIKAL_ADMIN_PORT:-18086\}:80"/,
    );
  });
});
