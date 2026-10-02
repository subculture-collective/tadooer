import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import process from "node:process";
import { suiteOrigin } from "./policy.mjs";

/**
 * Shell settings (ADR 0047): which server to open and three window
 * preferences. The file holds no session, credential, task or cached owner
 * data. Those stay in the web app's own storage inside Electron's persisted
 * partition.
 */

export const settingsFileName = "shell-settings.json";

export const defaultSettings = Object.freeze({
  version: 1,
  serverOrigin: null,
  allowPrivateLanHttp: false,
  closeToTray: false,
  startAtLogin: false,
});

/**
 * Reads untrusted JSON into settings. Unknown keys are dropped and a field
 * of the wrong type falls back to its default, so a damaged or hand-edited
 * file leads to the setup page instead of a crash. A stored origin is checked
 * again with the same policy that accepted it.
 */
export const parseSettings = (value) => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return { ...defaultSettings };
  const allowPrivateLanHttp = value.allowPrivateLanHttp === true;
  const origin =
    typeof value.serverOrigin === "string"
      ? suiteOrigin(value.serverOrigin, { allowPrivateLanHttp })
      : undefined;
  return {
    version: 1,
    serverOrigin: origin ?? null,
    allowPrivateLanHttp: origin === undefined ? false : allowPrivateLanHttp,
    closeToTray: value.closeToTray === true,
    startAtLogin: value.startAtLogin === true,
  };
};

export const readSettings = async (path) => {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return { ...defaultSettings };
  }
  try {
    return parseSettings(JSON.parse(text));
  } catch {
    return { ...defaultSettings };
  }
};

/**
 * Writes the file through a temporary sibling and a rename, so a crash never
 * leaves half a file. Mode 0600; the directory is created 0700 if missing.
 */
export const writeSettings = async (path, settings) => {
  const value = parseSettings(settings);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${String(process.pid)}`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      mode: 0o600,
      flag: "w",
    });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  return value;
};
