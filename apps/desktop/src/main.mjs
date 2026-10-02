import { app } from "electron";
import console from "node:console";
import { existsSync } from "node:fs";
import process from "node:process";
import { bridgeVersion } from "./bridge.mjs";
import { createShell, preloadPath, setupPreloadPath } from "./shell.mjs";

const fail = (error) => {
  console.error(error instanceof Error ? error.message : String(error));
  app.exit(1);
};

if (process.argv.includes("--suite-smoke")) {
  // Non-graphical check of the packaged bundle: the executable starts, the
  // application code loads and the preload bundles were packaged. No window,
  // no network, no settings file.
  const preloads = existsSync(preloadPath) && existsSync(setupPreloadPath);
  console.log(
    JSON.stringify({
      application: "productivity-suite-desktop",
      electron: process.versions.electron,
      authority: "remote-suite-origin",
      bridge: bridgeVersion,
      preloads,
    }),
  );
  app.exit(preloads ? 0 : 1);
} else if (process.argv.includes("--suite-selfcheck")) {
  // Hidden-window check against a throwaway loopback server. Started by
  // `pnpm smoke:linux:shell`, which supplies a temporary profile. It needs a
  // display; on a machine without one use `xvfb-run -a`.
  const { runSelfCheck } = await import("./selfcheck.mjs");
  void runSelfCheck().catch(fail);
} else if (!app.requestSingleInstanceLock()) {
  // Another instance owns the window; it receives this launch's arguments
  // through `second-instance` and comes to the front.
  app.exit(0);
} else {
  // Not awaited: Electron holds `ready` until this module has finished
  // evaluating, and `start` waits for `ready`.
  void createShell().start().catch(fail);
}
