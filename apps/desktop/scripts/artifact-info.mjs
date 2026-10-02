#!/usr/bin/env node
import console from "node:console";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import {
  artifactBaseName,
  manifestDesktopArtifact,
  outputDirectory,
  readPackage,
  sha256File,
} from "./artifact.mjs";

/**
 * Prints the desktop artifact's name, size and SHA-256, and the string to
 * put in the release manifest's `desktopArtifact` field. It recomputes the
 * checksum and fails when it differs from the recorded `.sha256` file.
 *
 * Usage: artifact-info.mjs [platform] [arch] [--manifest-value]
 */

const valueOnly = process.argv.includes("--manifest-value");
const [platform = "linux", arch = "x64"] = process.argv
  .slice(2)
  .filter((argument) => !argument.startsWith("--"));
const manifest = await readPackage();
const archiveName = `${artifactBaseName(manifest.version, platform, arch)}.tar.gz`;
const archivePath = join(outputDirectory, archiveName);
const recorded = (await readFile(`${archivePath}.sha256`, "utf8")).trim();
const sha256 = await sha256File(archivePath);
if (recorded !== `${sha256}  ${archiveName}`)
  throw new Error(`Checksum file does not match ${archiveName}`);
const desktopArtifact = manifestDesktopArtifact(archiveName, sha256);
if (valueOnly) console.log(desktopArtifact);
else
  console.log(
    JSON.stringify(
      {
        artifact: archiveName,
        sha256,
        bytes: (await stat(archivePath)).size,
        desktopArtifact,
      },
      null,
      2,
    ),
  );
