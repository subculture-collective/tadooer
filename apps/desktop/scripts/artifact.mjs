import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Names and checksums of the desktop release artifacts. Shared by the
 * packaging steps and by `artifact-info.mjs`, which prints what goes into the
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

/**
 * The executable inside a packaged directory, as path segments. On macOS it
 * is inside the application bundle.
 */
export const packagedExecutableSegments = (productName, platform, arch) => {
  const directory = packagedDirectoryName(productName, platform, arch);
  return platform === "darwin"
    ? [directory, `${productName}.app`, "Contents", "MacOS", productName]
    : [directory, productName];
};

/**
 * Every platform and architecture the desktop is packaged for, in the order
 * they are reported. Linux is a tar.gz of the packaged directory; macOS is a
 * zip of the application bundle, one per architecture.
 */
export const desktopTargets = Object.freeze([
  Object.freeze({ platform: "linux", arch: "x64" }),
  Object.freeze({ platform: "darwin", arch: "arm64" }),
  Object.freeze({ platform: "darwin", arch: "x64" }),
]);

const requireVersion = (version) => {
  if (
    typeof version !== "string" ||
    !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(version)
  )
    throw new Error("The desktop version must be a semantic version");
  return version;
};

/** `productivity-suite-desktop-0.1.0-linux-x64` */
export const artifactBaseName = (version, platform, arch) => {
  requireVersion(version);
  if (!/^[a-z0-9]+$/.test(platform) || !/^[a-z0-9]+$/.test(arch))
    throw new Error("Platform and architecture must be lower-case words");
  return `productivity-suite-desktop-${version}-${platform}-${arch}`;
};

export const artifactExtension = (platform) =>
  platform === "darwin" ? "zip" : "tar.gz";

/** `productivity-suite-desktop-0.1.0-darwin-arm64.zip` */
export const artifactFileName = (version, platform, arch) =>
  `${artifactBaseName(version, platform, arch)}.${artifactExtension(platform)}`;

/** One line of a checksum file, in the format `sha256sum -c` reads. */
export const checksumLine = (sha256, fileName) => {
  if (!/^[0-9a-f]{64}$/.test(sha256))
    throw new Error("The checksum must be 64 lower-case hexadecimal digits");
  if (!/^[\w.-]+$/.test(fileName))
    throw new Error("The artifact file name contains unexpected characters");
  return `${sha256}  ${fileName}`;
};

/**
 * The checksum index of a release with more than one desktop artifact:
 * `productivity-suite-desktop-0.1.0.sha256sums`. It has no platform in its
 * name because it lists all of them.
 */
export const checksumIndexName = (version) =>
  `productivity-suite-desktop-${requireVersion(version)}.sha256sums`;

/**
 * The text of the checksum index: one `sha256sum -c` line per artifact,
 * sorted by file name so the same artifacts always give the same bytes.
 */
export const checksumIndex = (artifacts) => {
  if (!Array.isArray(artifacts) || artifacts.length === 0)
    throw new Error("A checksum index needs at least one artifact");
  const names = artifacts.map(({ artifact }) => artifact);
  if (new Set(names).size !== names.length)
    throw new Error("A checksum index lists every artifact once");
  return artifacts
    .map(({ artifact, sha256 }) => ({
      artifact,
      line: checksumLine(sha256, artifact),
    }))
    .sort((a, b) => (a.artifact < b.artifact ? -1 : 1))
    .map(({ line }) => `${line}\n`)
    .join("");
};

export const sha256Text = (text) =>
  createHash("sha256").update(text, "utf8").digest("hex");

/**
 * The `desktopArtifact` value of a release (the manifest field is one
 * string).
 *
 * - One artifact: that file and its checksum, as before.
 * - Several: the checksum index and the checksum of the index. The index
 *   names every artifact with its own checksum, so the one string still
 *   pins every file.
 */
export const releaseDesktopArtifact = (version, artifacts) => {
  if (!Array.isArray(artifacts) || artifacts.length === 0)
    throw new Error("A release needs at least one desktop artifact");
  if (artifacts.length === 1)
    return manifestDesktopArtifact(artifacts[0].artifact, artifacts[0].sha256);
  return manifestDesktopArtifact(
    checksumIndexName(version),
    sha256Text(checksumIndex(artifacts)),
  );
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
