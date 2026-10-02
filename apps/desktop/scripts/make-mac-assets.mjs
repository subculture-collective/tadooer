#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import console from "node:console";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { desktopDirectory } from "./artifact.mjs";
import { icnsImageTypes, writeIcns } from "./icns.mjs";
import {
  macDirectoryName,
  macEntitlements,
  macEntitlementsFileName,
  macHelperEntitlements,
  macHelperEntitlementsFileName,
  macIconFileName,
} from "./mac.mjs";
import { buildPlist } from "./plist.mjs";

/**
 * Regenerates the committed macOS build inputs. The images come from the
 * Suite icon (`apps/web/public/suite-icon.svg`, the source of
 * `assets/icon.png`):
 *
 * - `mac/icon.icns`, the application icon. The artwork is drawn at 824 of
 *   1024 pixels with a transparent margin, the proportion of Apple's icon
 *   grid, so it sits at the same size as other icons in the Dock.
 * - `assets/trayTemplate.png` and `assets/trayTemplate@2x.png`, the menu-bar
 *   item: the glyph alone in black with transparency. macOS draws a template
 *   image in the menu bar's own colour, light or dark.
 *
 * The SVG is rendered with `rsvg-convert` (librsvg), which has to be on the
 * PATH. The `.icns` container is written by `icns.mjs`; no macOS tool is
 * needed.
 *
 * It also writes the two entitlements files in `mac/` from the values in
 * `mac.mjs`. Run it when the artwork or the entitlements change, and commit
 * the results; a test compares the committed files with their sources.
 */

const source = await readFile(
  join(desktopDirectory, "..", "web", "public", "suite-icon.svg"),
  "utf8",
);
const artwork = /<svg[^>]*viewBox="0 0 512 512"[^>]*>([\s\S]*)<\/svg>/.exec(
  source,
);
if (artwork === null)
  throw new Error("The Suite icon is not the expected 512-unit SVG");

const applicationIcon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
  <g transform="translate(100 100) scale(${String(824 / 512)})">${artwork[1]}</g>
</svg>`;

// The glyph of the Suite icon without its background: the three bars, and
// the badge as a disc with the check mark cut out. A ring of clear space
// separates the badge from the bars, as the fill colours do in the icon.
const trayTemplate = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="112 100 312 312">
  <mask id="glyph" maskUnits="userSpaceOnUse" x="112" y="100" width="312" height="312">
    <path d="M132 154h248v44H132zm0 80h170v44H132zm0 80h248v44H132z" fill="#fff"/>
    <circle cx="350" cy="256" r="70" fill="#000"/>
    <circle cx="350" cy="256" r="54" fill="#fff"/>
    <path d="m327 256 16 17 33-39" fill="none" stroke="#000" stroke-width="18" stroke-linecap="round" stroke-linejoin="round"/>
  </mask>
  <rect x="112" y="100" width="312" height="312" fill="#000" mask="url(#glyph)"/>
</svg>`;

const render = (svg, pixels) => {
  const size = String(pixels);
  const result = spawnSync(
    "rsvg-convert",
    ["--format=png", `--width=${size}`, `--height=${size}`],
    { input: svg, maxBuffer: 64 * 1024 * 1024 },
  );
  if (result.error !== undefined)
    throw new Error(
      `rsvg-convert could not be started: ${result.error.message}`,
    );
  if (result.status !== 0)
    throw new Error(`rsvg-convert failed: ${result.stderr.toString("utf8")}`);
  return result.stdout;
};

const rendered = new Map();
const applicationIconAt = (pixels) => {
  if (!rendered.has(pixels))
    rendered.set(pixels, render(applicationIcon, pixels));
  return rendered.get(pixels);
};
const icon = writeIcns(
  icnsImageTypes.map(({ type, pixels }) => ({
    type,
    data: applicationIconAt(pixels),
  })),
);

const macDirectory = join(desktopDirectory, macDirectoryName);
const assetsDirectory = join(desktopDirectory, "assets");
await mkdir(macDirectory, { recursive: true });
await writeFile(join(macDirectory, macIconFileName), icon);
await writeFile(
  join(assetsDirectory, "trayTemplate.png"),
  render(trayTemplate, 16),
);
await writeFile(
  join(assetsDirectory, "trayTemplate@2x.png"),
  render(trayTemplate, 32),
);
await writeFile(
  join(macDirectory, macEntitlementsFileName),
  buildPlist(macEntitlements),
);
await writeFile(
  join(macDirectory, macHelperEntitlementsFileName),
  buildPlist(macHelperEntitlements),
);
console.log(
  JSON.stringify({
    icon: `${macDirectoryName}/${macIconFileName}`,
    bytes: icon.length,
    types: icnsImageTypes.map(({ type }) => type),
    tray: ["assets/trayTemplate.png", "assets/trayTemplate@2x.png"],
    entitlements: [macEntitlementsFileName, macHelperEntitlementsFileName],
  }),
);
