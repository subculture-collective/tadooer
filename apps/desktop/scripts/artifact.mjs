import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Names and checksums of the desktop release artifact. Shared by the
 * packaging step and by `artifact-info.mjs`, which prints what goes into the
 * release manifest.
 */

export const desktopDirectory = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);
export const outputDirectory = join(desktopDirectory, "dist-packages");

export const readPackage = async () =>
  JSON.parse(await readFile(join(desktopDirectory, "package.json"), "utf8"));

/** The directory electron-packager writes for a platform and architecture. */
export const packagedDirectoryName = (productName, platform, arch) =>
  `${productName}-${platform}-${arch}`;

/** `productivity-suite-desktop-0.1.0-linux-x64` */
export const artifactBaseName = (version, platform, arch) => {
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(version))
    throw new Error("The desktop version must be a semantic version");
  if (!/^[a-z0-9]+$/.test(platform) || !/^[a-z0-9]+$/.test(arch))
    throw new Error("Platform and architecture must be lower-case words");
  return `productivity-suite-desktop-${version}-${platform}-${arch}`;
};

/**
 * The `desktopArtifact` string of a release manifest: the file name and its
 * SHA-256, in the same `name@sha256:hex` form as an image digest reference.
 */
export const manifestDesktopArtifact = (fileName, sha256) => {
  if (!/^[0-9a-f]{64}$/.test(sha256))
    throw new Error("The checksum must be 64 lower-case hexadecimal digits");
  if (!/^[\w.-]+$/.test(fileName))
    throw new Error("The artifact file name contains unexpected characters");
  return `${fileName}@sha256:${sha256}`;
};

export const sha256File = (path) =>
  new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(path)
      .on("error", reject)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve(hash.digest("hex")));
  });
