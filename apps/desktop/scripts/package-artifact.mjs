#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import console from "node:console";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import {
  artifactBaseName,
  manifestDesktopArtifact,
  outputDirectory,
  packagedDirectoryName,
  readPackage,
  sha256File,
} from "./artifact.mjs";

/**
 * Turns the directory electron-packager wrote into the release artifact:
 * `<name>.tar.gz` and `<name>.tar.gz.sha256` (the `sha256sum -c` format).
 *
 * No signing happens here. A signature, an AppImage or a macOS or Windows
 * package would be further steps after this one, each with its own checksum.
 * Set `SOURCE_DATE_EPOCH` to make the archive's timestamps reproducible.
 */

const platform = process.argv[2] ?? "linux";
const arch = process.argv[3] ?? "x64";
const manifest = await readPackage();
const packaged = packagedDirectoryName(manifest.productName, platform, arch);
if (!existsSync(join(outputDirectory, packaged)))
  throw new Error(`Packaged directory is missing: ${packaged}`);

const base = artifactBaseName(manifest.version, platform, arch);
const archiveName = `${base}.tar.gz`;
const tarPath = join(outputDirectory, `${base}.tar`);
const archivePath = join(outputDirectory, archiveName);
const epoch = process.env.SOURCE_DATE_EPOCH;
const tar = spawnSync(
  "tar",
  [
    "--create",
    `--file=${tarPath}`,
    `--directory=${outputDirectory}`,
    "--sort=name",
    "--owner=0",
    "--group=0",
    "--numeric-owner",
    ...(epoch !== undefined && /^[0-9]+$/.test(epoch)
      ? [`--mtime=@${epoch}`]
      : []),
    // The archive unpacks to a directory without a space in its name.
    `--transform=s,^${packaged.replaceAll(",", "\\,")},${base},`,
    packaged,
  ],
  { stdio: "inherit" },
);
if (tar.status !== 0) throw new Error("tar failed");
try {
  await pipeline(
    createReadStream(tarPath),
    createGzip({ level: 9 }),
    createWriteStream(archivePath),
  );
} finally {
  await rm(tarPath, { force: true });
}

const sha256 = await sha256File(archivePath);
await writeFile(`${archivePath}.sha256`, `${sha256}  ${archiveName}\n`);
console.log(
  JSON.stringify({
    artifact: archiveName,
    sha256,
    bytes: (await stat(archivePath)).size,
    desktopArtifact: manifestDesktopArtifact(archiveName, sha256),
  }),
);
