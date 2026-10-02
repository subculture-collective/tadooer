#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import {
  outputDirectory,
  packagedDirectoryName,
  readPackage,
} from "./artifact.mjs";

/**
 * Runs the packaged shell's window self-check (`--suite-selfcheck`) in a
 * temporary profile and removes that profile afterwards, so the check never
 * touches the owner's profile and leaves nothing behind.
 *
 * It needs a display. Without one: `xvfb-run -a pnpm smoke:linux:shell`.
 * Extra arguments are passed to the application.
 */

const manifest = await readPackage();
const executable = join(
  outputDirectory,
  packagedDirectoryName(manifest.productName, "linux", "x64"),
  manifest.productName,
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
      "--suite-selfcheck",
      `--user-data-dir=${profile}`,
      ...process.argv.slice(2),
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
