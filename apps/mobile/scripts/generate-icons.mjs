import { spawnSync } from "node:child_process";
import console from "node:console";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

/**
 * Renders the Android launcher icons from the web app's icon
 * (`apps/web/public/suite-icon.svg`). The PNG files are committed; run this
 * again only when that icon changes. It needs `rsvg-convert` (librsvg).
 *
 *   ic_launcher.png             the icon as it is, for Android 7
 *   ic_launcher_round.png       the same glyph on a disc, for Android 7.1
 *   ic_launcher_foreground.png  the glyph alone inside the adaptive icon's
 *                               safe zone; the background is the colour in
 *                               res/values/ic_launcher_background.xml
 */

const packageDirectory = join(dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = join(
  packageDirectory,
  "..",
  "web",
  "public",
  "suite-icon.svg",
);
const resourceDirectory = join(
  packageDirectory,
  "android",
  "app",
  "src",
  "main",
  "res",
);

const densities = Object.freeze({
  mdpi: 1,
  hdpi: 1.5,
  xhdpi: 2,
  xxhdpi: 3,
  xxxhdpi: 4,
});

const backgroundPattern =
  /<rect width="512" height="512" rx="112" fill="(#[0-9a-f]{6})"\/>/i;

/** The three SVG documents, derived from the web icon's text. */
export const iconVariants = (svg) => {
  const background = backgroundPattern.exec(svg);
  const body = /<svg[^>]*>([\s\S]*)<\/svg>/.exec(svg);
  if (background === null || body === null)
    throw new Error(
      "suite-icon.svg no longer has the expected background rectangle; update generate-icons.mjs.",
    );
  const glyph = body[1].replace(backgroundPattern, "").trim();
  const wrap = (content) =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">${content}</svg>`;
  const scaled = (factor) =>
    `<g transform="translate(256 256) scale(${String(factor)}) translate(-268 -256)">${glyph}</g>`;
  return {
    background: background[1],
    square: svg,
    round: wrap(
      `<circle cx="256" cy="256" r="256" fill="${background[1]}"/>${scaled(0.8)}`,
    ),
    // The adaptive icon is 108dp with a 66dp safe zone, 61% of the canvas.
    // The glyph's diagonal is 66% of the canvas, so 0.85 keeps it inside.
    foreground: wrap(scaled(0.85)),
  };
};

const render = (svg, size, output) => {
  const result = spawnSync(
    "rsvg-convert",
    ["--width", String(size), "--height", String(size), "--output", output],
    { input: svg, encoding: "utf8" },
  );
  if (result.error !== undefined || result.status !== 0)
    throw new Error(
      `rsvg-convert failed for ${output}: ${result.error?.message ?? result.stderr}`,
    );
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const variants = iconVariants(readFileSync(sourcePath, "utf8"));
  for (const [density, factor] of Object.entries(densities)) {
    const directory = join(resourceDirectory, `mipmap-${density}`);
    render(variants.square, 48 * factor, join(directory, "ic_launcher.png"));
    render(
      variants.round,
      48 * factor,
      join(directory, "ic_launcher_round.png"),
    );
    render(
      variants.foreground,
      108 * factor,
      join(directory, "ic_launcher_foreground.png"),
    );
  }
  console.log(
    `Wrote launcher icons for ${Object.keys(densities).join(", ")}; background ${variants.background}.`,
  );
}
