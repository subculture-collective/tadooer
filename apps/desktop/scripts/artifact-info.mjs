#!/usr/bin/env node
import console from "node:console";
import { existsSync } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import {
  artifactFileName,
  checksumIndex,
  checksumIndexName,
  checksumLine,
  desktopTargets,
  manifestDesktopArtifact,
  outputDirectory,
  readPackage,
  releaseDesktopArtifact,
  sha256File,
} from "./artifact.mjs";

/**
 * Prints the desktop artifacts' names, sizes and SHA-256 checksums, and the
 * string to put in the release manifest's `desktopArtifact` field. Each
 * checksum is recomputed, and the script fails when one differs from the
 * recorded `.sha256` file.
 *
 * Usage: artifact-info.mjs [platform arch] [--manifest-value]
 *
 * With a platform and an architecture it reports that one artifact. Without
 * them it reports every packaged artifact of the current version. When there
 * are several it also writes the checksum index
 * (`productivity-suite-desktop-<version>.sha256sums`), and the release value
 * names that index instead of a single archive. `--manifest-value` prints
 * only the release value.
 */

const valueOnly = process.argv.includes("--manifest-value");
const positional = process.argv
  .slice(2)
  .filter((argument) => !argument.startsWith("--"));
if (positional.length !== 0 && positional.length !== 2)
  throw new Error("Give both a platform and an architecture, or neither");
const manifest = await readPackage();

const describe = async ({ platform, arch }) => {
  const artifact = artifactFileName(manifest.version, platform, arch);
  const path = join(outputDirectory, artifact);
  const recorded = (await readFile(`${path}.sha256`, "utf8")).trim();
  const sha256 = await sha256File(path);
  if (recorded !== checksumLine(sha256, artifact))
    throw new Error(`Checksum file does not match ${artifact}`);
  return {
    artifact,
    sha256,
    bytes: (await stat(path)).size,
    desktopArtifact: manifestDesktopArtifact(artifact, sha256),
  };
};

if (positional.length === 2) {
  const [platform, arch] = positional;
  const described = await describe({ platform, arch });
  console.log(
    valueOnly ? described.desktopArtifact : JSON.stringify(described, null, 2),
  );
} else {
  const artifacts = [];
  for (const target of desktopTargets)
    if (
      existsSync(
        join(
          outputDirectory,
          artifactFileName(manifest.version, target.platform, target.arch),
        ),
      )
    )
      artifacts.push(await describe(target));
  if (artifacts.length === 0)
    throw new Error(
      `No desktop artifact of version ${manifest.version} in ${outputDirectory}`,
    );
  const index =
    artifacts.length > 1 ? checksumIndexName(manifest.version) : null;
  if (index !== null)
    await writeFile(join(outputDirectory, index), checksumIndex(artifacts));
  const desktopArtifact = releaseDesktopArtifact(manifest.version, artifacts);
  console.log(
    valueOnly
      ? desktopArtifact
      : JSON.stringify({ artifacts, index, desktopArtifact }, null, 2),
  );
}
