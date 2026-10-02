import { app } from "electron";
import console from "node:console";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { setTimeout } from "node:timers";
import { createShell } from "./shell.mjs";

/**
 * Self-check of the packaged shell with hidden windows. It runs the real
 * setup page, preload bridge, navigation guard and deep-link handling against
 * a throwaway loopback server and the temporary profile its wrapper script
 * passes in. It never reads or writes the owner's profile and creates no
 * tray, autostart entry or protocol registration.
 */

const page = `<!doctype html><meta charset="utf-8"><title>Self-test</title>
<script>
  const bridge = window.tadooerDesktop;
  window.selfTest = {
    keys: Object.keys(bridge ?? {}).sort().join(","),
    version: bridge?.version,
    node: typeof require + "/" + typeof process,
    rejected: [
      bridge.reportStatus({ sync: "nope", live: "live" }),
      bridge.reportStatus({ sync: "online", live: "live", extra: 1 }),
      bridge.reportFocus({ state: "running" }),
      bridge.notify({ title: "" }),
    ],
    captured: false,
  };
  window.addEventListener("tadooer:quick-capture", () => {
    window.selfTest.captured = true;
  });
  window.addEventListener("tadooer:sync-now", () => {
    bridge.reportFocus({ state: "running", phase: "focus", label: "Self-test" });
  });
  bridge.reportStatus({ sync: "online", live: "live", conflicts: 0 });
</script>`;

const listen = (handler) =>
  new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const until = async (description, predicate) => {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (await predicate()) return;
    await sleep(100);
  }
  throw new Error(`Timed out: ${description}`);
};

export const runSelfCheck = async () => {
  // `scripts/selfcheck.mjs` supplies a temporary profile and removes it
  // afterwards. Without one this would run in the owner's profile, so it
  // refuses.
  if (!app.commandLine.hasSwitch("user-data-dir"))
    throw new Error(
      "The self-check needs --user-data-dir; run it with `pnpm smoke:linux:shell`",
    );
  const suite = await listen((request, response) => {
    if (request.url === "/api/build") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ service: "productivity-suite", version: "0.0.0" }),
      );
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(page);
  });
  const other = await listen((_request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("other origin");
  });
  const origin = `http://127.0.0.1:${String(suite.address().port)}`;
  const otherOrigin = `http://127.0.0.1:${String(other.address().port)}`;
  const checks = [];
  const check = (name, passed) => {
    checks.push({ name, passed });
    if (!passed) throw new Error(`Self-check failed: ${name}`);
  };
  let failure;
  try {
    const shell = createShell({ headless: true, environment: {} });
    await shell.start();

    // First run: no stored address, so the setup page opens.
    check("setup page opens on first run", shell.probe().setupWindow !== null);
    const setup = shell.probe().setupWindow.webContents;
    const run = (contents, code) => contents.executeJavaScript(code, true);
    await until("the setup script runs under its CSP", () =>
      run(setup, "document.documentElement.dataset.ready === 'true'"),
    );
    check(
      "setup page exposes only its three calls",
      (await run(
        setup,
        "Object.keys(window.tadooerSetup).sort().join(',')",
      )) === "cancel,connect,state",
    );
    check(
      "setup page has no Node access",
      (await run(setup, "typeof require + '/' + typeof process")) ===
        "undefined/undefined",
    );
    const lan = await run(
      setup,
      "window.tadooerSetup.connect('http://192.168.77.1', false)",
    );
    check(
      "private network HTTP needs explicit consent",
      lan.ok === false && lan.reason === "private-lan-consent",
    );
    const remote = await run(
      setup,
      "window.tadooerSetup.connect('http://suite.example.test', true)",
    );
    check(
      "plaintext HTTP to a host name is refused",
      remote.ok === false && remote.reason === "insecure-http",
    );
    const wrong = await run(
      setup,
      `window.tadooerSetup.connect(${JSON.stringify(otherOrigin)}, false)`,
    );
    check(
      "a server that is not the Suite is refused",
      wrong.ok === false && wrong.reason === "not-suite",
    );
    check(
      "nothing is stored before a server passes",
      shell.probe().origin === undefined,
    );

    // Submit the real form.
    await run(
      setup,
      `document.querySelector("#address").value = ${JSON.stringify(origin)};
       document.querySelector("#setup-form").requestSubmit(); true`,
    );
    await until(
      "the Suite window opens",
      () => shell.probe().mainWindow !== null,
    );
    const { settingsPath } = shell.probe();
    const stored = JSON.parse(await readFile(settingsPath, "utf8"));
    check("the origin is stored", stored.serverOrigin === origin);
    check(
      "the settings file is private",
      ((await stat(settingsPath)).mode & 0o777) === 0o600,
    );
    check(
      "the settings file holds settings only",
      Object.keys(stored).sort().join(",") ===
        "allowPrivateLanHttp,closeToTray,serverOrigin,startAtLogin,version",
    );
    await until(
      "the setup window closes",
      () => shell.probe().setupWindow === null,
    );

    // The bridge.
    const main = shell.probe().mainWindow.webContents;
    await until(
      "the page reports its status",
      () => shell.probe().statusLine === "Synced · live",
    );
    const result = await run(main, "window.selfTest");
    check(
      "the bridge exposes only the reviewed calls",
      result.keys === "notify,reportFocus,reportStatus,version" &&
        result.version === 1,
    );
    check("the page has no Node access", result.node === "undefined/undefined");
    check(
      "the preload rejects malformed reports",
      result.rejected.every((value) => value === false),
    );
    check("Sync now is delivered", shell.sendCommand("sync-now"));
    await until(
      "the page answers the Sync now event",
      () => shell.probe().focusLine === "Focus running: Self-test",
    );
    check("Quick capture is delivered", shell.sendCommand("quick-capture"));
    await until("the page receives the Quick capture event", () =>
      run(main, "window.selfTest.captured"),
    );
    check("unknown commands are not sent", !shell.sendCommand("open-file"));

    // Deep links and navigation.
    check(
      "a deep link to another host is refused",
      !shell.openDeepLink(`tadooer://open//${otherOrigin.slice(7)}/`) &&
        !shell.openDeepLink(otherOrigin),
    );
    check(
      "a deep link to a page is accepted",
      shell.openDeepLink("tadooer://open/today?from=link"),
    );
    await until(
      "the deep link navigates inside the origin",
      () => main.getURL() === `${origin}/today?from=link`,
    );
    await until(
      "the page reports again after the load",
      () => shell.probe().statusLine === "Synced · live",
    );
    await run(
      main,
      `window.location.href = ${JSON.stringify(`${otherOrigin}/`)}; true`,
    );
    await sleep(500);
    check(
      "navigation to another origin is blocked",
      main.getURL() === `${origin}/today?from=link`,
    );
    const permissions = await run(
      main,
      `Promise.all(["geolocation", "notifications"].map((name) =>
         navigator.permissions.query({ name }).then((status) => status.state)))`,
    );
    check(
      "only notifications are permitted",
      permissions[0] === "denied" && permissions[1] === "granted",
    );
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }
  suite.close();
  other.close();
  suite.closeAllConnections();
  other.closeAllConnections();
  console.log(
    JSON.stringify({
      application: "productivity-suite-desktop",
      selfcheck: failure === undefined ? "passed" : "failed",
      failure,
      checks: checks.map(
        ({ name, passed }) => `${passed ? "ok" : "FAIL"} ${name}`,
      ),
    }),
  );
  app.exit(failure === undefined ? 0 : 1);
};
