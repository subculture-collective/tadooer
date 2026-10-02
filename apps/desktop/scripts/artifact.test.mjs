import { describe, expect, it } from "vitest";
import {
  artifactBaseName,
  artifactExtension,
  artifactFileName,
  checksumIndex,
  checksumIndexName,
  checksumLine,
  desktopTargets,
  manifestDesktopArtifact,
  packagedDirectoryName,
  packagedExecutableSegments,
  releaseDesktopArtifact,
  sha256Text,
} from "./artifact.mjs";

const a = "a".repeat(64);
const b = "b".repeat(64);
const c = "c".repeat(64);
const linux = {
  artifact: "productivity-suite-desktop-0.1.0-linux-x64.tar.gz",
  sha256: a,
};
const macArm = {
  artifact: "productivity-suite-desktop-0.1.0-darwin-arm64.zip",
  sha256: b,
};
const macIntel = {
  artifact: "productivity-suite-desktop-0.1.0-darwin-x64.zip",
  sha256: c,
};

describe("desktop artifact names", () => {
  it("packages Linux x64 and both macOS architectures", () => {
    expect(desktopTargets).toEqual([
      { platform: "linux", arch: "x64" },
      { platform: "darwin", arch: "arm64" },
      { platform: "darwin", arch: "x64" },
    ]);
  });

  it("names a tar.gz for Linux and a zip for macOS", () => {
    expect(artifactExtension("linux")).toBe("tar.gz");
    expect(artifactExtension("darwin")).toBe("zip");
    expect(artifactFileName("0.1.0", "linux", "x64")).toBe(linux.artifact);
    expect(artifactFileName("0.1.0", "darwin", "arm64")).toBe(macArm.artifact);
    expect(artifactFileName("0.1.0", "darwin", "x64")).toBe(macIntel.artifact);
    expect(artifactFileName("1.2.3-rc.1", "darwin", "arm64")).toBe(
      "productivity-suite-desktop-1.2.3-rc.1-darwin-arm64.zip",
    );
  });

  it("refuses a version or a target that would change the name's shape", () => {
    expect(() => artifactBaseName("latest", "linux", "x64")).toThrow(
      "semantic version",
    );
    expect(() => artifactBaseName("0.1.0", "darwin/..", "x64")).toThrow(
      "lower-case",
    );
    expect(() => artifactBaseName("0.1.0", "darwin", "ARM64")).toThrow(
      "lower-case",
    );
    expect(() => checksumIndexName("0.1")).toThrow("semantic version");
    expect(() => checksumIndexName(undefined)).toThrow("semantic version");
  });

  it("finds the executable inside the macOS bundle", () => {
    expect(packagedDirectoryName("Productivity Suite", "darwin", "arm64")).toBe(
      "Productivity Suite-darwin-arm64",
    );
    expect(
      packagedExecutableSegments("Productivity Suite", "darwin", "arm64"),
    ).toEqual([
      "Productivity Suite-darwin-arm64",
      "Productivity Suite.app",
      "Contents",
      "MacOS",
      "Productivity Suite",
    ]);
    expect(
      packagedExecutableSegments("Productivity Suite", "linux", "x64"),
    ).toEqual(["Productivity Suite-linux-x64", "Productivity Suite"]);
  });
});

describe("release manifest value", () => {
  it("writes a checksum line in the sha256sum format", () => {
    expect(checksumLine(a, linux.artifact)).toBe(`${a}  ${linux.artifact}`);
    expect(() => checksumLine("abc", linux.artifact)).toThrow("checksum");
    expect(() => checksumLine(a.toUpperCase(), linux.artifact)).toThrow(
      "checksum",
    );
    expect(() => checksumLine(a, "two words.zip")).toThrow("unexpected");
    expect(() => checksumLine(a, "../escape.zip")).toThrow("unexpected");
  });

  it("keeps the single-artifact value as it was", () => {
    expect(releaseDesktopArtifact("0.1.0", [linux])).toBe(
      `${linux.artifact}@sha256:${a}`,
    );
    expect(releaseDesktopArtifact("0.1.0", [linux])).toBe(
      manifestDesktopArtifact(linux.artifact, a),
    );
  });

  it("lists several artifacts in a sorted checksum index", () => {
    const index = checksumIndex([linux, macArm, macIntel]);
    expect(index).toBe(
      `${b}  ${macArm.artifact}\n${c}  ${macIntel.artifact}\n${a}  ${linux.artifact}\n`,
    );
    expect(checksumIndex([macIntel, linux, macArm])).toBe(index);
  });

  it("names the index and its checksum for several artifacts", () => {
    const value = releaseDesktopArtifact("0.1.0", [linux, macArm, macIntel]);
    expect(checksumIndexName("0.1.0")).toBe(
      "productivity-suite-desktop-0.1.0.sha256sums",
    );
    expect(value).toBe(
      `productivity-suite-desktop-0.1.0.sha256sums@sha256:${sha256Text(checksumIndex([linux, macArm, macIntel]))}`,
    );
    // Still one non-empty string in the form the manifest already uses.
    expect(value).toMatch(/^[\w.-]+@sha256:[0-9a-f]{64}$/);
    // The value does not depend on the order the artifacts were found in.
    expect(releaseDesktopArtifact("0.1.0", [macIntel, macArm, linux])).toBe(
      value,
    );
  });

  it("changes the release value when any artifact changes", () => {
    const before = releaseDesktopArtifact("0.1.0", [linux, macArm]);
    const after = releaseDesktopArtifact("0.1.0", [
      linux,
      { ...macArm, sha256: c },
    ]);
    expect(after).not.toBe(before);
  });

  it("refuses an empty or repeated artifact list", () => {
    expect(() => releaseDesktopArtifact("0.1.0", [])).toThrow("at least one");
    expect(() => checksumIndex([])).toThrow("at least one");
    expect(() => checksumIndex([linux, linux])).toThrow("once");
  });
});
