import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import process from "node:process";

/**
 * Start at login on Linux: an XDG autostart entry (ADR 0047). Electron's
 * `app.setLoginItemSettings` covers macOS and Windows only, so Linux writes
 * the file itself. The entry starts the same executable with no arguments.
 */

export const autostartFileName = "tadooer-desktop.desktop";

export const autostartPath = (environment, homeDirectory) => {
  const configured = environment.XDG_CONFIG_HOME;
  const base =
    typeof configured === "string" && isAbsolute(configured)
      ? configured
      : join(homeDirectory, ".config");
  return join(base, "autostart", autostartFileName);
};

/**
 * Quotes one argument for the `Exec` key of a desktop entry. The
 * specification quotes with double quotes and escapes `"`, `` ` ``, `$` and
 * `\` inside them; `%` is a field code and is doubled.
 */
export const quoteExecArgument = (argument) => {
  if (typeof argument !== "string" || argument === "")
    throw new Error("An Exec argument must be a non-empty string");
  for (const character of argument) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f)
      throw new Error("An Exec argument must not contain control characters");
  }
  const escaped = argument
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("`", "\\`")
    .replaceAll("$", "\\$")
    .replaceAll("%", "%%");
  // The value is a desktop-entry string, which unescapes `\\` once more
  // before the Exec rules apply.
  return `"${escaped.replaceAll("\\", "\\\\")}"`;
};

export const autostartEntry = ({ name, executable }) => {
  if (!isAbsolute(executable))
    throw new Error("The autostart executable must be an absolute path");
  if (/[\r\n]/.test(name)) throw new Error("The name must be a single line");
  return [
    "[Desktop Entry]",
    "Type=Application",
    `Name=${name}`,
    `Exec=${quoteExecArgument(executable)}`,
    "Terminal=false",
    "X-GNOME-Autostart-enabled=true",
    "",
  ].join("\n");
};

/** Writes or removes the autostart entry. Removing a missing file is fine. */
export const setAutostart = async ({ enabled, path, name, executable }) => {
  if (!enabled) {
    await rm(path, { force: true });
    return;
  }
  const entry = autostartEntry({ name, executable });
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${String(process.pid)}`;
  try {
    await writeFile(temporary, entry, { mode: 0o644 });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
};
