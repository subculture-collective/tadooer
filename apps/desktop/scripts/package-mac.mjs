#!/usr/bin/env node
import { packager } from "@electron/packager";
import console from "node:console";
import { copyFile, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import {
  desktopDirectory,
  outputDirectory,
  packagedDirectoryName,
  packagedExecutableSegments,
  readPackage,
} from "./artifact.mjs";
import { icnsImageTypes, readIcns } from "./icns.mjs";
import { afterPackage } from "./mac-sign.mjs";
import {
  applicationFileProblems,
  asarFilePaths,
  macArchitectures,
  macInfoPlistProblems,
  machOArchitecture,
  machOCodeSignature,
  macPackagerOptions,
} from "./mac.mjs";
import { parsePlist } from "./plist.mjs";

/**
 * Builds the unsigned macOS application bundles, one per architecture, and
 * checks each one as far as a Linux host can: the `Info.plist`, the icon,
 * the executable's architecture and the packaged application files. It
 * cannot start the application; that is the checklist in
 * docs/operations/desktop.md.
 *
 * `package-artifact.mjs darwin <arch>` then zips each bundle.
 *
 * Usage: package-mac.mjs [--check-only] [arch...]
 */

const checkOnly = process.argv.includes("--check-only");
const requested = process.argv
  .slice(2)
  .filter((argument) => !argument.startsWith("--"));
const architectures = requested.length > 0 ? requested : [...macArchitectures];
const manifest = await readPackage();
const { productName, version } = manifest;

// A build that asks for a signature stops here, before anything is
// downloaded or written.
afterPackage({ appPath: `${productName}.app` }, process.env, process.platform);

const inspect = async (arch) => {
  const directory = join(
    outputDirectory,
    packagedDirectoryName(productName, "darwin", arch),
  );
  const contents = join(directory, `${productName}.app`, "Contents");
  const problems = [];
  const plist = parsePlist(
    await readFile(join(contents, "Info.plist"), "utf8"),
  );
  problems.push(...macInfoPlistProblems(plist, { productName, version }));

  const executablePath = join(
    outputDirectory,
    ...packagedExecutableSegments(productName, "darwin", arch),
  );
  const executable = await readFile(executablePath);
  const executableArch = machOArchitecture(executable);
  const codeSignature = machOCodeSignature(executable);
  if (executableArch !== arch)
    problems.push(
      `The executable is ${String(executableArch)}, expected ${arch}`,
    );
  if (((await stat(executablePath)).mode & 0o111) === 0)
    problems.push("The executable is not marked executable");
  // Apple silicon does not start arm64 code that has no signature at all.
  // Electron's arm64 binaries carry the linker's ad hoc one; if a later
  // Electron drops it, the bundle would need `codesign --sign -` on a Mac.
  if (arch === "arm64" && (codeSignature ?? "none") === "none")
    problems.push("The arm64 executable carries no code signature");

  let iconTypes = [];
  try {
    iconTypes = readIcns(
      await readFile(
        join(contents, "Resources", String(plist.CFBundleIconFile)),
      ),
    ).map(({ type }) => type);
    if (iconTypes.join() !== icnsImageTypes.map(({ type }) => type).join())
      problems.push("The bundle icon is not the generated application icon");
  } catch (error) {
    problems.push(
      `The bundle icon cannot be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let applicationFiles = [];
  try {
    applicationFiles = asarFilePaths(
      await readFile(join(contents, "Resources", "app.asar")),
    );
    problems.push(...applicationFileProblems(applicationFiles));
  } catch (error) {
    problems.push(
      `The application archive cannot be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return {
    bundle: `${packagedDirectoryName(productName, "darwin", arch)}/${productName}.app`,
    arch,
    bundleId: plist.CFBundleIdentifier,
    version: plist.CFBundleShortVersionString,
    minimumSystemVersion: plist.LSMinimumSystemVersion,
    category: plist.LSApplicationCategoryType,
    urlSchemes: (plist.CFBundleURLTypes ?? []).flatMap(
      (type) => type.CFBundleURLSchemes ?? [],
    ),
    lsUiElement: plist.LSUIElement,
    icon: iconTypes,
    applicationFiles: applicationFiles.length,
    codeSignature,
    developerSigned: codeSignature === "identity",
    problems,
  };
};

for (const arch of architectures) {
  if (!checkOnly) {
    await packager(
      macPackagerOptions({
        directory: desktopDirectory,
        outputDirectory,
        productName,
        arch,
      }),
    );
    // The licence texts of Electron and Chromium travel inside the bundle,
    // because the zip holds the bundle and nothing beside it.
    const directory = join(
      outputDirectory,
      packagedDirectoryName(productName, "darwin", arch),
    );
    for (const file of ["LICENSE", "LICENSES.chromium.html"])
      await copyFile(
        join(directory, file),
        join(directory, `${productName}.app`, "Contents", "Resources", file),
      );
  }
  const report = await inspect(arch);
  console.log(JSON.stringify(report));
  if (report.problems.length > 0)
    throw new Error(
      `The ${arch} bundle is not what was specified:\n${report.problems.join("\n")}`,
    );
}
