#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import console from "node:console";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { lutimes, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import {
  artifactBaseName,
  artifactFileName,
  checksumLine,
  manifestDesktopArtifact,
  outputDirectory,
  packagedDirectoryName,
  readPackage,
  sha256File,
} from "./artifact.mjs";

/**
 * Turns the directory electron-packager wrote into the release artifact and
 * its checksum file (the `sha256sum -c` format):
 *
 * - Linux: `<name>.tar.gz` of the packaged directory;
 * - macOS: `<name>.zip` holding `<product>.app`, with symbolic links stored
 *   as links (the frameworks inside the bundle depend on them).
 *
 * No signing happens here. A signed macOS bundle has to be zipped on a Mac
 * with `ditto`, which keeps the extended attributes a signature may use; see
 * docs/operations/desktop.md. Set `SOURCE_DATE_EPOCH` to fix the file times
 * inside the archive.
 *
 * Usage: package-artifact.mjs [platform] [arch]
 */

const platform = process.argv[2] ?? "linux";
const arch = process.argv[3] ?? "x64";
const manifest = await readPackage();
const packaged = packagedDirectoryName(manifest.productName, platform, arch);
const packagedPath = join(outputDirectory, packaged);
if (!existsSync(packagedPath))
  throw new Error(`Packaged directory is missing: ${packaged}`);

const base = artifactBaseName(manifest.version, platform, arch);
const archiveName = artifactFileName(manifest.version, platform, arch);
const archivePath = join(outputDirectory, archiveName);
const configuredEpoch = process.env.SOURCE_DATE_EPOCH;
const epoch =
  configuredEpoch !== undefined && /^[0-9]+$/.test(configuredEpoch)
    ? Number(configuredEpoch)
    : undefined;

const tarGz = async () => {
  const tarPath = join(outputDirectory, `${base}.tar`);
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
      ...(epoch === undefined ? [] : [`--mtime=@${String(epoch)}`]),
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
};

/** Every entry under `relative`, directories before their contents. */
const listTree = async (root, relative) => {
  const entries = [relative];
  const children = await readdir(join(root, relative), { withFileTypes: true });
  for (const child of children) {
    const path = `${relative}/${child.name}`;
    // A link is one entry even when it points at a directory.
    if (child.isDirectory()) entries.push(...(await listTree(root, path)));
    else entries.push(path);
  }
  return entries;
};

const zipBundle = async () => {
  const bundle = `${manifest.productName}.app`;
  if (!existsSync(join(packagedPath, bundle)))
    throw new Error(`Application bundle is missing: ${packaged}/${bundle}`);
  const entries = (await listTree(packagedPath, bundle)).sort();
  if (entries.some((entry) => /[\r\n]/.test(entry)))
    throw new Error("A bundle path contains a line break");
  if (epoch !== undefined)
    for (const entry of entries)
      await lutimes(join(packagedPath, entry), epoch, epoch);
  // zip adds to an existing archive, so the old one has to go first.
  await rm(archivePath, { force: true });
  const zip = spawnSync(
    "zip",
    [
      "-q",
      "-9",
      // -y stores links as links; -X leaves out owner and access-time fields.
      "-y",
      "-X",
      archivePath,
      // The names come from standard input.
      "-@",
    ],
    {
      cwd: packagedPath,
      input: `${entries.join("\n")}\n`,
      stdio: ["pipe", "inherit", "inherit"],
      // Zip stores local times; a fixed zone keeps them the same everywhere.
      env: { ...process.env, TZ: "UTC" },
    },
  );
  if (zip.error !== undefined) throw zip.error;
  if (zip.status !== 0) throw new Error("zip failed");
};

if (platform === "darwin") await zipBundle();
else await tarGz();

const sha256 = await sha256File(archivePath);
await writeFile(
  `${archivePath}.sha256`,
  `${checksumLine(sha256, archiveName)}\n`,
);
console.log(
  JSON.stringify({
    artifact: archiveName,
    sha256,
    bytes: (await stat(archivePath)).size,
    desktopArtifact: manifestDesktopArtifact(archiveName, sha256),
  }),
);
