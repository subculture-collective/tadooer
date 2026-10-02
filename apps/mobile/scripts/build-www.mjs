import { build } from "esbuild";
import { copyFile, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

/**
 * Builds the files the Android shell bundles (ADR 0049):
 *
 *   index.html, mobile.css   the phone setup page (this package)
 *   setup.js, setup.css      the desktop shell's setup script and stylesheet,
 *                            copied unchanged
 *   shell-setup.js           `window.tadooerSetup` over the native plugin
 *   page-bridge.js           the bridge the shell injects into the Suite page
 *
 * The output directory is Capacitor's `webDir`; `cap sync android` copies it
 * into the Android project. Nothing here needs the Android SDK.
 */

const packageDirectory = join(dirname(fileURLToPath(import.meta.url)), "..");
const sourceDirectory = join(packageDirectory, "src");
const desktopSetupDirectory = join(
  packageDirectory,
  "..",
  "desktop",
  "src",
  "setup",
);

export const defaultOutputDirectory = join(packageDirectory, "www");

export const copiedFiles = Object.freeze([
  [join(sourceDirectory, "setup", "index.html"), "index.html"],
  [join(sourceDirectory, "setup", "mobile.css"), "mobile.css"],
  [join(desktopSetupDirectory, "setup.js"), "setup.js"],
  [join(desktopSetupDirectory, "setup.css"), "setup.css"],
]);

export const bundles = Object.freeze([
  [join(sourceDirectory, "setup-entry.mjs"), "shell-setup.js"],
  [join(sourceDirectory, "page-bridge-entry.mjs"), "page-bridge.js"],
]);

export const buildWww = async (outputDirectory = defaultOutputDirectory) => {
  await rm(outputDirectory, { recursive: true, force: true });
  await mkdir(outputDirectory, { recursive: true });
  for (const [source, name] of copiedFiles)
    await copyFile(source, join(outputDirectory, name));
  for (const [entry, name] of bundles)
    await build({
      entryPoints: [entry],
      outfile: join(outputDirectory, name),
      bundle: true,
      format: "iife",
      platform: "browser",
      target: "chrome90",
      // The shared policy imports `URL` from `node:url`; a WebView has it as
      // a global.
      alias: { "node:url": join(sourceDirectory, "url-shim.mjs") },
      legalComments: "none",
      logLevel: "warning",
    });
  return outputDirectory;
};

if (process.argv[1] === fileURLToPath(import.meta.url)) await buildWww();
