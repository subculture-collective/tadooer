#!/usr/bin/env node
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";
import console from "node:console";

export const parseManifest = (value) => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Release manifest must be an object");
  const manifest = value;
  if (
    manifest.schemaVersion !== 1 ||
    typeof manifest.version !== "string" ||
    !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version) ||
    typeof manifest.revision !== "string" ||
    !/^[0-9a-f]{7,64}$/.test(manifest.revision) ||
    typeof manifest.imageDigest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/.test(manifest.imageDigest) ||
    typeof manifest.desktopArtifact !== "string" ||
    manifest.desktopArtifact === "" ||
    typeof manifest.qualifiedAt !== "string" ||
    !Number.isFinite(Date.parse(manifest.qualifiedAt))
  )
    throw new Error("Release manifest is invalid");
  return {
    schemaVersion: 1,
    version: manifest.version,
    revision: manifest.revision,
    imageDigest: manifest.imageDigest,
    desktopArtifact: manifest.desktopArtifact,
    qualifiedAt: manifest.qualifiedAt,
  };
};

const readManifest = async (path) =>
  parseManifest(JSON.parse(await readFile(path, "utf8")));
const atomicWrite = async (path, value) => {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${String(process.pid)}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
  await rename(temporary, path);
};

export const promoteRelease = async (candidatePath, channelDirectory) => {
  const candidate = await readManifest(candidatePath);
  const stablePath = join(channelDirectory, "stable.json");
  let current;
  try {
    current = await readManifest(stablePath);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
      throw error;
  }
  if (
    current?.version === candidate.version &&
    current.revision !== candidate.revision
  )
    throw new Error("A released version is immutable; choose a new version");
  if (current !== undefined)
    await atomicWrite(
      join(
        channelDirectory,
        "history",
        `${current.qualifiedAt.replaceAll(":", "-")}-${current.version}.json`,
      ),
      current,
    );
  await atomicWrite(stablePath, candidate);
  return candidate;
};

export const rollbackRelease = async (historyPath, channelDirectory) => {
  const target = await readManifest(historyPath);
  const stablePath = join(channelDirectory, "stable.json");
  const current = await readManifest(stablePath);
  await atomicWrite(
    join(
      channelDirectory,
      "history",
      `${current.qualifiedAt.replaceAll(":", "-")}-${current.version}.json`,
    ),
    current,
  );
  await atomicWrite(stablePath, target);
  return target;
};

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? "")).href) {
  const [command, manifestPath, channelDirectory] = process.argv.slice(2);
  if (
    !manifestPath ||
    !channelDirectory ||
    !["promote", "rollback"].includes(command)
  )
    throw new Error(
      "Usage: release-channel.mjs <promote|rollback> <manifest> <channel-directory>",
    );
  const selected =
    command === "promote"
      ? await promoteRelease(manifestPath, channelDirectory)
      : await rollbackRelease(manifestPath, channelDirectory);
  console.log(
    JSON.stringify({
      channel: "stable",
      version: selected.version,
      revision: selected.revision,
    }),
  );
}
