import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { promoteRelease, rollbackRelease } from "./release-channel.mjs";

const manifest = (version, revision, hour) => ({
  schemaVersion: 1,
  version,
  revision,
  imageDigest: `sha256:${"a".repeat(64)}`,
  desktopArtifact: `suite-${version}.tar.zst`,
  qualifiedAt: `2026-08-07T0${String(hour)}:00:00.000Z`,
});

describe("release channels", () => {
  it("promotes immutable manifests and rolls back through append-only history", async () => {
    const directory = await mkdtemp(join(tmpdir(), "suite-release-"));
    const firstPath = join(directory, "first.json");
    const secondPath = join(directory, "second.json");
    const channels = join(directory, "channels");
    await writeFile(firstPath, JSON.stringify(manifest("1.0.0", "abcdef0", 1)));
    await writeFile(
      secondPath,
      JSON.stringify(manifest("1.1.0", "abcdef1", 2)),
    );
    await promoteRelease(firstPath, channels);
    await promoteRelease(secondPath, channels);
    const historyPath = join(
      channels,
      "history",
      "2026-08-07T01-00-00.000Z-1.0.0.json",
    );
    expect(
      JSON.parse(await readFile(join(channels, "stable.json"), "utf8")),
    ).toMatchObject({ version: "1.1.0" });
    await rollbackRelease(historyPath, channels);
    expect(
      JSON.parse(await readFile(join(channels, "stable.json"), "utf8")),
    ).toMatchObject({ version: "1.0.0" });
  });
  it("rejects revision replacement under an already released version", async () => {
    const directory = await mkdtemp(join(tmpdir(), "suite-release-conflict-"));
    const firstPath = join(directory, "first.json");
    const replacementPath = join(directory, "replacement.json");
    const channels = join(directory, "channels");
    await writeFile(firstPath, JSON.stringify(manifest("1.0.0", "abcdef0", 1)));
    await writeFile(
      replacementPath,
      JSON.stringify(manifest("1.0.0", "abcdef9", 2)),
    );
    await promoteRelease(firstPath, channels);
    await expect(promoteRelease(replacementPath, channels)).rejects.toThrow(
      "immutable",
    );
  });
});
