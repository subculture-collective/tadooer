#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import {
  outputDirectory,
  packagedExecutableSegments,
  readPackage,
} from "./artifact.mjs";

/**
 * Runs a check of the packaged shell built for this machine: the Linux x64
 * directory on Linux, the bundle of this Mac's architecture on macOS.
 *
 * By default it is the window self-check (`--suite-selfcheck`), in a
 * temporary profile that is removed afterwards, so the check never touches
 * the owner's profile and leaves nothing behind. It needs a display. On
 * Linux without one: `xvfb-run -a pnpm smoke:linux:shell`. On macOS the
 * windows stay hidden, but the Dock shows the app while the check runs.
 *
 * With `--smoke` it is the check that opens no window (`--suite-smoke`).
 * Other arguments are passed to the application.
 */

const smoke = process.argv.includes("--smoke");
const passed = process.argv
  .slice(2)
  .filter((argument) => argument !== "--smoke");
const manifest = await readPackage();
const executable = join(
  outputDirectory,
  ...packagedExecutableSegments(
    manifest.productName,
    process.platform,
    process.platform === "darwin" ? process.arch : "x64",
  ),
);
const profile = await mkdtemp(join(tmpdir(), "tadooer-selfcheck-"));
const environment = { ...process.env };
// Set by some Electron-based terminals; it would start Node, not the app.
delete environment.ELECTRON_RUN_AS_NODE;
// The check starts from the first-run state.
delete environment.SUITE_SERVER_URL;
let status;
try {
  const result = spawnSync(
    executable,
    [
      smoke ? "--suite-smoke" : "--suite-selfcheck",
      `--user-data-dir=${profile}`,
      ...passed,
    ],
    { stdio: "inherit", env: environment, timeout: 120_000 },
  );
  if (result.error !== undefined) throw result.error;
  status = result.status ?? 1;
} finally {
  await rm(profile, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 200,
  });
}
process.exit(status ?? 1);
