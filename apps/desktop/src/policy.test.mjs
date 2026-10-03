import { mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { URL, URLSearchParams } from "node:url";
import { describe, expect, it } from "vitest";
import { parseManifest } from "../../../deploy/release-channel.mjs";
import {
  artifactBaseName,
  manifestDesktopArtifact,
} from "../scripts/artifact.mjs";
import {
  autostartEntry,
  autostartPath,
  quoteExecArgument,
  setAutostart,
} from "./autostart.mjs";
import {
  bridgeVersion,
  channels,
  commandEvents,
  createRateLimiter,
  focusLine,
  parseFocusReport,
  parseNotificationRequest,
  parseShellCommand,
  parseStatusReport,
  statusLine,
} from "./bridge.mjs";
import {
  allowedExternalOAuth,
  allowedNavigation,
  allowedPermission,
  classifyServerAddress,
  deepLinkFromArguments,
  deepLinkTarget,
  navigationTarget,
  normalizeServerInput,
  privateLanHost,
  suiteBuildResponse,
  suiteOrigin,
} from "./policy.mjs";
import { checkServer, serverCheckMessage } from "./server-check.mjs";
import {
  defaultSettings,
  parseSettings,
  readSettings,
  writeSettings,
} from "./settings.mjs";

describe("desktop authority policy", () => {
  it("accepts HTTPS and loopback development origins only", () => {
    expect(suiteOrigin("https://suite.example.test")).toBe(
      "https://suite.example.test",
    );
    expect(suiteOrigin("http://127.0.0.1:18080")).toBe(
      "http://127.0.0.1:18080",
    );
    expect(suiteOrigin("http://suite.example.test")).toBeUndefined();
    expect(
      suiteOrigin("https://user:secret@suite.example.test"),
    ).toBeUndefined();
    expect(suiteOrigin("https://suite.example.test/path")).toBeUndefined();
  });
  it("blocks navigation outside the configured Suite authority", () => {
    expect(
      allowedNavigation(
        "https://suite.example.test/api/health",
        "https://suite.example.test",
      ),
    ).toBe(true);
    expect(
      allowedNavigation(
        "https://attacker.example/",
        "https://suite.example.test",
      ),
    ).toBe(false);
  });
  it("opens only the exact Google OAuth authorization surface externally", () => {
    const allowed = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    allowed.search = new URLSearchParams({
      response_type: "code",
      client_id: "client.apps.googleusercontent.com",
      redirect_uri: "http://127.0.0.1:18080/api/connectors/google/callback",
      state: "s".repeat(43),
    }).toString();
    expect(allowedExternalOAuth(allowed.href)).toBe(true);
    expect(
      allowedExternalOAuth(
        allowed.href.replace("accounts.google.com", "attacker.example"),
      ),
    ).toBe(false);
    expect(
      allowedExternalOAuth("https://accounts.google.com/ServiceLogin"),
    ).toBe(false);
    expect(
      allowedExternalOAuth(
        "https://accounts.google.com/o/oauth2/v2/auth?response_type=code",
      ),
    ).toBe(false);
  });
});

describe("server address policy", () => {
  it("accepts HTTPS anywhere and plain HTTP on loopback", () => {
    expect(classifyServerAddress("https://suite.example.test")).toEqual({
      ok: true,
      origin: "https://suite.example.test",
      transport: "https",
    });
    expect(classifyServerAddress("https://suite.example.test:8443/")).toEqual({
      ok: true,
      origin: "https://suite.example.test:8443",
      transport: "https",
    });
    for (const address of [
      "http://127.0.0.1:18080",
      "http://localhost:18080",
      "http://[::1]:18080",
    ])
      expect(classifyServerAddress(address)).toMatchObject({
        ok: true,
        transport: "loopback-http",
      });
  });

  it("asks for consent before plain HTTP on a private network address", () => {
    for (const address of [
      "http://10.0.0.56:18080",
      "http://172.16.4.1",
      "http://172.31.255.254",
      "http://192.168.1.20:8080",
      "http://100.65.164.66",
      "http://[fd12:3456:789a::1]:8080",
    ]) {
      expect(classifyServerAddress(address)).toEqual({
        ok: false,
        reason: "private-lan-consent",
      });
      expect(
        classifyServerAddress(address, { allowPrivateLanHttp: true }),
      ).toMatchObject({ ok: true, transport: "private-lan-http" });
      expect(suiteOrigin(address)).toBeUndefined();
      expect(suiteOrigin(address, { allowPrivateLanHttp: true })).toBe(
        new URL(address).origin,
      );
    }
  });

  it("refuses plain HTTP everywhere else, even with consent", () => {
    for (const address of [
      "http://suite.example.test",
      "http://nas.local",
      "http://8.8.8.8",
      "http://172.32.0.1",
      "http://172.15.0.1",
      "http://192.169.0.1",
      "http://100.128.0.1",
      "http://169.254.10.10",
      "http://[2001:db8::1]",
      "http://[fe80::1]",
      // A name that only looks like an address is still a name.
      "http://10.0.0.1.example.test",
      "http://192.168.1.1.nip.io",
    ])
      expect(
        classifyServerAddress(address, { allowPrivateLanHttp: true }),
      ).toEqual({ ok: false, reason: "insecure-http" });
  });

  it("classifies the canonical host, not the spelling", () => {
    // 0x0a000001 and 167772161 are both 10.0.0.1 to the URL parser.
    expect(classifyServerAddress("http://0x0a000001")).toEqual({
      ok: false,
      reason: "private-lan-consent",
    });
    expect(suiteOrigin("http://167772161", { allowPrivateLanHttp: true })).toBe(
      "http://10.0.0.1",
    );
    expect(privateLanHost("10.0.0.256")).toBe(false);
    expect(privateLanHost("fd00::1")).toBe(false);
    expect(privateLanHost(undefined)).toBe(false);
  });

  it("refuses credentials, paths, other schemes and non-addresses", () => {
    const reason = (address) => classifyServerAddress(address).reason;
    expect(reason("https://user:secret@suite.example.test")).toBe(
      "credentials",
    );
    expect(reason("https://suite.example.test/app")).toBe("path");
    expect(reason("https://suite.example.test/?next=1")).toBe("path");
    expect(reason("https://suite.example.test/#x")).toBe("path");
    expect(reason("ftp://suite.example.test")).toBe("scheme");
    expect(reason("file:///etc/passwd")).toBe("path");
    expect(reason("javascript:alert(1)")).toBe("path");
    expect(reason("not an address")).toBe("invalid");
    expect(reason("")).toBe("invalid");
    expect(reason(undefined)).toBe("invalid");
    expect(reason(`https://${"a".repeat(2100)}.test`)).toBe("invalid");
  });

  it("treats a bare host as HTTPS and never upgrades to HTTP", () => {
    expect(normalizeServerInput("  suite.example.test ")).toBe(
      "https://suite.example.test",
    );
    expect(normalizeServerInput("10.0.0.56:18080")).toBe(
      "https://10.0.0.56:18080",
    );
    expect(normalizeServerInput("http://127.0.0.1:18080")).toBe(
      "http://127.0.0.1:18080",
    );
    expect(normalizeServerInput("")).toBe("");
    expect(normalizeServerInput(42)).toBe("");
  });

  it("recognises the Suite build response", () => {
    expect(
      suiteBuildResponse({
        service: "productivity-suite",
        version: "1.2.3",
        revision: "abc",
      }),
    ).toEqual({ version: "1.2.3" });
    expect(suiteBuildResponse({ service: "other", version: "1" })).toBe(
      undefined,
    );
    expect(suiteBuildResponse({ service: "productivity-suite" })).toBe(
      undefined,
    );
    expect(suiteBuildResponse(null)).toBeUndefined();
    expect(suiteBuildResponse([])).toBeUndefined();
  });
});

describe("server check", () => {
  const build = { service: "productivity-suite", version: "0.9.0" };
  const answering = (status, body, calls = []) => {
    return (url, init) => {
      calls.push({ url, init });
      return Promise.resolve({
        status,
        text: () => Promise.resolve(body),
      });
    };
  };

  it("asks the configured origin for /api/build without credentials", async () => {
    const calls = [];
    await expect(
      checkServer("https://suite.example.test/", {
        allowPrivateLanHttp: false,
        fetchImplementation: answering(200, JSON.stringify(build), calls),
      }),
    ).resolves.toEqual({
      ok: true,
      origin: "https://suite.example.test",
      transport: "https",
      version: "0.9.0",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://suite.example.test/api/build");
    expect(calls[0].init).toMatchObject({
      method: "GET",
      redirect: "error",
      credentials: "omit",
    });
  });

  it("does not contact an address the policy refuses", async () => {
    const calls = [];
    const fetchImplementation = answering(200, JSON.stringify(build), calls);
    await expect(
      checkServer("http://suite.example.test", {
        allowPrivateLanHttp: true,
        fetchImplementation,
      }),
    ).resolves.toEqual({ ok: false, reason: "insecure-http" });
    await expect(
      checkServer("http://192.168.1.20", {
        allowPrivateLanHttp: false,
        fetchImplementation,
      }),
    ).resolves.toEqual({ ok: false, reason: "private-lan-consent" });
    expect(calls).toHaveLength(0);
    await expect(
      checkServer("http://192.168.1.20", {
        allowPrivateLanHttp: true,
        fetchImplementation,
      }),
    ).resolves.toMatchObject({ ok: true, transport: "private-lan-http" });
  });

  it("refuses servers that are unreachable or are not the Suite", async () => {
    const check = (fetchImplementation) =>
      checkServer("https://suite.example.test", {
        allowPrivateLanHttp: false,
        fetchImplementation,
      });
    await expect(
      check(() => Promise.reject(new Error("refused"))),
    ).resolves.toEqual({ ok: false, reason: "unreachable" });
    await expect(check(answering(404, "{}"))).resolves.toEqual({
      ok: false,
      reason: "not-suite",
    });
    await expect(check(answering(200, "<html>"))).resolves.toEqual({
      ok: false,
      reason: "not-suite",
    });
    await expect(
      check(answering(200, JSON.stringify({ service: "gitea" }))),
    ).resolves.toEqual({ ok: false, reason: "not-suite" });
    await expect(
      check(
        answering(
          200,
          JSON.stringify({ ...build, padding: "x".repeat(20000) }),
        ),
      ),
    ).resolves.toEqual({ ok: false, reason: "not-suite" });
  });

  it("has a message for every reason", () => {
    for (const reason of [
      "invalid",
      "credentials",
      "path",
      "scheme",
      "insecure-http",
      "private-lan-consent",
      "unreachable",
      "not-suite",
    ])
      expect(serverCheckMessage(reason).length).toBeGreaterThan(10);
    expect(serverCheckMessage("unknown")).toBe(serverCheckMessage("invalid"));
  });
});

describe("deep links and navigation targets", () => {
  const origin = "https://suite.example.test";

  it("maps tadooer://open/<path> onto the configured origin", () => {
    expect(deepLinkTarget("tadooer://open/today", origin)).toBe(
      `${origin}/today`,
    );
    expect(deepLinkTarget("tadooer://open/tasks?view=due#top", origin)).toBe(
      `${origin}/tasks?view=due#top`,
    );
    expect(deepLinkTarget("tadooer://open", origin)).toBe(`${origin}/`);
    expect(deepLinkTarget("tadooer://open/", origin)).toBe(`${origin}/`);
    expect(deepLinkTarget("TADOOER://open/inbox", origin)).toBe(
      `${origin}/inbox`,
    );
    expect(
      deepLinkTarget("tadooer://open/today", "http://127.0.0.1:18080"),
    ).toBe("http://127.0.0.1:18080/today");
  });

  it("never leaves the configured origin", () => {
    for (const link of [
      "https://attacker.example/",
      "tadooer://attacker.example/today",
      "tadooer://open//attacker.example/",
      "tadooer://open/\\attacker.example/",
      "tadooer://open/\\\\attacker.example/",
      "tadooer://open/%5cattacker.example",
      "tadooer://open/a%2f..%2f..%2fb",
      "tadooer://user:secret@open/today",
      "tadooer://open:8080/today",
      "tadooer:open/today",
      "tadooer:///today",
      "tadooer://open/today\n",
      "tadooer://open/to\tday",
      "javascript:alert(1)",
      "file:///etc/passwd",
      `tadooer://open/${"a".repeat(2100)}`,
      "",
      undefined,
      42,
    ])
      expect(deepLinkTarget(link, origin), String(link)).toBeUndefined();
    expect(deepLinkTarget("tadooer://open/today", undefined)).toBeUndefined();
  });

  it("opens application pages, not API routes", () => {
    for (const link of [
      "tadooer://open/api/connectors/google/callback?code=x&state=y",
      "tadooer://open/api",
      "tadooer://open/API/auth/logout",
      "tadooer://open/today/../api/export",
      "tadooer://open/./api/build",
    ])
      expect(deepLinkTarget(link, origin), link).toBeUndefined();
    expect(deepLinkTarget("tadooer://open/apiary", origin)).toBe(
      `${origin}/apiary`,
    );
  });

  it("resolves notification paths with the same rule", () => {
    expect(navigationTarget("/today", origin)).toBe(`${origin}/today`);
    expect(navigationTarget("today", origin)).toBeUndefined();
    expect(navigationTarget("//attacker.example", origin)).toBeUndefined();
    expect(navigationTarget("/\\attacker.example", origin)).toBeUndefined();
    expect(navigationTarget("/api/export", origin)).toBeUndefined();
    expect(navigationTarget("https://attacker.example/", origin)).toBe(
      undefined,
    );
    expect(navigationTarget(`/${"a".repeat(1100)}`, origin)).toBeUndefined();
  });

  it("finds a deep link among command-line arguments", () => {
    expect(
      deepLinkFromArguments([
        "/opt/suite/Tadooer",
        "--flag",
        "tadooer://open/today",
      ]),
    ).toBe("tadooer://open/today");
    expect(deepLinkFromArguments(["/opt/suite/app", "--flag"])).toBe(undefined);
    expect(deepLinkFromArguments("tadooer://open/today")).toBeUndefined();
  });
});

describe("origin permissions", () => {
  const origin = "https://suite.example.test";

  it("grants notifications and the copy button to the Suite origin only", () => {
    expect(allowedPermission("notifications", `${origin}/today`, origin)).toBe(
      true,
    );
    expect(allowedPermission("notifications", `${origin}/`, origin)).toBe(true);
    expect(
      allowedPermission("clipboard-sanitized-write", `${origin}/`, origin),
    ).toBe(true);
    expect(
      allowedPermission("notifications", "https://attacker.example/", origin),
    ).toBe(false);
    expect(allowedPermission("notifications", undefined, origin)).toBe(false);
    expect(allowedPermission("notifications", `${origin}/`, undefined)).toBe(
      false,
    );
  });

  it("denies every other permission", () => {
    for (const permission of [
      "media",
      "geolocation",
      "clipboard-read",
      "midi",
      "midiSysex",
      "pointerLock",
      "fullscreen",
      "openExternal",
      "display-capture",
      "hid",
      "serial",
      "usb",
      "fileSystem",
      "idle-detection",
      "unknown",
    ])
      expect(allowedPermission(permission, `${origin}/`, origin)).toBe(false);
  });
});

describe("shell settings", () => {
  it("defaults to no server, no tray hiding and no autostart", () => {
    expect(defaultSettings).toEqual({
      version: 1,
      serverOrigin: null,
      allowPrivateLanHttp: false,
      closeToTray: false,
      startAtLogin: false,
    });
    for (const damaged of [undefined, null, [], "text", 7])
      expect(parseSettings(damaged)).toEqual(defaultSettings);
  });

  it("keeps valid fields and drops everything else", () => {
    expect(
      parseSettings({
        version: 9,
        serverOrigin: "https://suite.example.test/",
        closeToTray: true,
        startAtLogin: "yes",
        sessionCookie: "must-not-survive",
        password: "must-not-survive",
      }),
    ).toEqual({
      version: 1,
      serverOrigin: "https://suite.example.test",
      allowPrivateLanHttp: false,
      closeToTray: true,
      startAtLogin: false,
    });
  });

  it("re-validates the stored origin with the stored consent", () => {
    expect(
      parseSettings({ serverOrigin: "http://192.168.1.20:8080" }),
    ).toMatchObject({ serverOrigin: null, allowPrivateLanHttp: false });
    expect(
      parseSettings({
        serverOrigin: "http://192.168.1.20:8080",
        allowPrivateLanHttp: true,
      }),
    ).toMatchObject({
      serverOrigin: "http://192.168.1.20:8080",
      allowPrivateLanHttp: true,
    });
    // Consent never widens beyond private addresses.
    expect(
      parseSettings({
        serverOrigin: "http://suite.example.test",
        allowPrivateLanHttp: true,
      }),
    ).toMatchObject({ serverOrigin: null, allowPrivateLanHttp: false });
    expect(
      parseSettings({ serverOrigin: "https://user:pw@suite.example.test" }),
    ).toMatchObject({ serverOrigin: null });
  });

  it("writes atomically with mode 0600 and reads back", async () => {
    const directory = await mkdtemp(join(tmpdir(), "suite-desktop-"));
    const path = join(directory, "profile", "shell-settings.json");
    await expect(readSettings(path)).resolves.toEqual(defaultSettings);
    const written = await writeSettings(path, {
      ...defaultSettings,
      serverOrigin: "https://suite.example.test",
      closeToTray: true,
      extra: "dropped",
    });
    expect(written).not.toHaveProperty("extra");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readdir(join(directory, "profile"))).toEqual([
      "shell-settings.json",
    ]);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(written);
    await expect(readSettings(path)).resolves.toEqual({
      ...defaultSettings,
      serverOrigin: "https://suite.example.test",
      closeToTray: true,
    });
    // Rewriting an existing file keeps it private.
    await writeSettings(path, { ...written, closeToTray: false });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    await writeFile(path, "{ not json");
    await expect(readSettings(path)).resolves.toEqual(defaultSettings);
  });
});

describe("preload bridge validators", () => {
  it("names a fixed set of channels and commands", () => {
    expect(bridgeVersion).toBe(1);
    expect(channels).toEqual({
      status: "tadooer-shell:status",
      focus: "tadooer-shell:focus",
      notify: "tadooer-shell:notify",
      command: "tadooer-shell:command",
    });
    expect(commandEvents).toEqual({
      "quick-capture": "tadooer:quick-capture",
      "sync-now": "tadooer:sync-now",
    });
    expect(Object.isFrozen(channels) && Object.isFrozen(commandEvents)).toBe(
      true,
    );
  });

  it("accepts well-formed status reports only", () => {
    expect(parseStatusReport({ sync: "online", live: "live" })).toEqual({
      sync: "online",
      live: "live",
      conflicts: 0,
    });
    expect(
      parseStatusReport({
        sync: "syncing",
        live: "reconnecting",
        conflicts: 3,
      }),
    ).toEqual({ sync: "syncing", live: "reconnecting", conflicts: 3 });
    for (const bad of [
      undefined,
      null,
      "online",
      [],
      {},
      { sync: "online" },
      { sync: "online", live: "streaming" },
      { sync: "ONLINE", live: "live" },
      { sync: "online", live: "live", conflicts: -1 },
      { sync: "online", live: "live", conflicts: 1.5 },
      { sync: "online", live: "live", conflicts: "3" },
      { sync: "online", live: "live", conflicts: 10000 },
      { sync: "online", live: "live", channel: "fs:read" },
      new (class Report {
        sync = "online";
        live = "live";
      })(),
    ])
      expect(parseStatusReport(bad)).toBeUndefined();
  });

  it("accepts well-formed focus reports only", () => {
    expect(parseFocusReport({ state: "idle" })).toEqual({ state: "idle" });
    expect(
      parseFocusReport({ state: "running", phase: "focus", label: " Write " }),
    ).toEqual({ state: "running", phase: "focus", label: "Write" });
    expect(parseFocusReport({ state: "paused", phase: "break" })).toEqual({
      state: "paused",
      phase: "break",
      label: "",
    });
    for (const bad of [
      null,
      { state: "running" },
      { state: "running", phase: "nap" },
      { state: "done", phase: "focus" },
      { state: "idle", label: "x" },
      { state: "running", phase: "focus", label: 5 },
      { state: "running", phase: "focus", label: "a".repeat(121) },
      { state: "running", phase: "focus", label: "two\nlines" },
      { state: "running", phase: "focus", label: "bell\u0007" },
      { state: "running", phase: "focus", taskId: "t1" },
    ])
      expect(parseFocusReport(bad)).toBeUndefined();
  });

  it("accepts well-formed notification requests only", () => {
    expect(parseNotificationRequest({ title: "Break is over" })).toEqual({
      title: "Break is over",
      body: "",
      tag: null,
      path: null,
    });
    expect(
      parseNotificationRequest({
        title: "Reminder",
        body: "Line one\nLine two",
        tag: "reminder:42",
        path: "/today",
      }),
    ).toEqual({
      title: "Reminder",
      body: "Line one\nLine two",
      tag: "reminder:42",
      path: "/today",
    });
    for (const bad of [
      null,
      {},
      { title: "" },
      { title: "   " },
      { title: 7 },
      { title: "a".repeat(121) },
      { title: "two\nlines" },
      { title: "ok", body: "b".repeat(501) },
      { title: "ok", body: "nul\u0000" },
      { title: "ok", tag: "has space" },
      { title: "ok", tag: "t".repeat(65) },
      { title: "ok", path: "https://attacker.example/" },
      { title: "ok", path: "//attacker.example" },
      { title: "ok", path: "today" },
      { title: "ok", icon: "file:///etc/passwd" },
      { title: "ok", url: "https://attacker.example/" },
    ])
      expect(parseNotificationRequest(bad)).toBeUndefined();
  });

  it("knows two shell commands and nothing else", () => {
    expect(parseShellCommand("quick-capture")).toBe("quick-capture");
    expect(parseShellCommand("sync-now")).toBe("sync-now");
    for (const bad of [
      "open-file",
      "toString",
      "__proto__",
      "constructor",
      "",
      undefined,
      { command: "sync-now" },
    ])
      expect(parseShellCommand(bad)).toBeUndefined();
  });

  it("limits how often the page can raise a notification", () => {
    let time = 0;
    const allowed = createRateLimiter(2, 1000, () => time);
    expect([allowed(), allowed(), allowed()]).toEqual([true, true, false]);
    time = 999;
    expect(allowed()).toBe(false);
    time = 1000;
    expect([allowed(), allowed(), allowed()]).toEqual([true, true, false]);
  });

  it("renders the tray lines", () => {
    expect(statusLine(undefined)).toBe("Waiting for the app");
    expect(
      statusLine({ sync: "signed-out", live: "paused", conflicts: 0 }),
    ).toBe("Not signed in");
    expect(statusLine({ sync: "online", live: "live", conflicts: 0 })).toBe(
      "Synced · live",
    );
    expect(
      statusLine({ sync: "syncing", live: "reconnecting", conflicts: 1 }),
    ).toBe("Syncing · reconnecting · 1 conflict");
    expect(statusLine({ sync: "offline", live: "offline", conflicts: 2 })).toBe(
      "Offline · 2 conflicts",
    );
    expect(focusLine(undefined)).toBeUndefined();
    expect(focusLine({ state: "idle" })).toBeUndefined();
    expect(
      focusLine({ state: "running", phase: "focus", label: "Write" }),
    ).toBe("Focus running: Write");
    expect(focusLine({ state: "paused", phase: "break", label: "" })).toBe(
      "Break paused",
    );
  });
});

describe("start at login", () => {
  it("places the entry in the XDG autostart directory", () => {
    expect(autostartPath({}, "/home/owner")).toBe(
      "/home/owner/.config/autostart/tadooer-desktop.desktop",
    );
    expect(autostartPath({ XDG_CONFIG_HOME: "/xdg" }, "/home/owner")).toBe(
      "/xdg/autostart/tadooer-desktop.desktop",
    );
    // A relative XDG_CONFIG_HOME is invalid by the specification.
    expect(autostartPath({ XDG_CONFIG_HOME: "relative" }, "/home/owner")).toBe(
      "/home/owner/.config/autostart/tadooer-desktop.desktop",
    );
  });

  it("quotes the executable for the Exec key", () => {
    expect(quoteExecArgument("/opt/Tadooer/Tadooer")).toBe(
      '"/opt/Tadooer/Tadooer"',
    );
    expect(quoteExecArgument('/opt/a"b$c`d%e\\f')).toBe(
      '"/opt/a\\\\"b\\\\$c\\\\`d%%e\\\\\\\\f"',
    );
    expect(() => quoteExecArgument("/opt/a\nExec=evil")).toThrow();
    expect(() => quoteExecArgument("")).toThrow();
  });

  it("writes a single-command entry and removes it again", async () => {
    const entry = autostartEntry({
      name: "Tadooer",
      executable: "/opt/Tadooer/Tadooer",
    });
    expect(entry.split("\n")).toEqual([
      "[Desktop Entry]",
      "Type=Application",
      "Name=Tadooer",
      'Exec="/opt/Tadooer/Tadooer"',
      "Terminal=false",
      "X-GNOME-Autostart-enabled=true",
      "",
    ]);
    expect(() =>
      autostartEntry({ name: "Suite", executable: "relative/app" }),
    ).toThrow();
    expect(() =>
      autostartEntry({ name: "Suite\nExec=evil", executable: "/opt/app" }),
    ).toThrow();

    const directory = await mkdtemp(join(tmpdir(), "suite-autostart-"));
    const path = autostartPath({ XDG_CONFIG_HOME: directory }, "/unused");
    const options = {
      path,
      name: "Tadooer",
      executable: "/opt/Tadooer/Tadooer",
    };
    await setAutostart({ ...options, enabled: true });
    expect(await readFile(path, "utf8")).toBe(entry);
    expect(await readdir(join(directory, "autostart"))).toEqual([
      "tadooer-desktop.desktop",
    ]);
    await setAutostart({ ...options, enabled: false });
    expect(await readdir(join(directory, "autostart"))).toEqual([]);
    // Disabling twice is not an error.
    await setAutostart({ ...options, enabled: false });
  });
});

describe("release artifact naming", () => {
  it("builds a manifest value the release channel accepts unchanged", () => {
    const name = `${artifactBaseName("0.1.0", "linux", "x64")}.tar.gz`;
    expect(name).toBe("tadooer-desktop-0.1.0-linux-x64.tar.gz");
    const desktopArtifact = manifestDesktopArtifact(name, "a".repeat(64));
    expect(desktopArtifact).toBe(`${name}@sha256:${"a".repeat(64)}`);
    expect(
      parseManifest({
        schemaVersion: 1,
        version: "0.1.0",
        revision: "0021e02",
        imageDigest: `sha256:${"b".repeat(64)}`,
        desktopArtifact,
        qualifiedAt: "2026-10-02T00:00:00.000Z",
      }).desktopArtifact,
    ).toBe(desktopArtifact);
    expect(() => manifestDesktopArtifact(name, "short")).toThrow();
    expect(() =>
      manifestDesktopArtifact("a b.tar.gz", "a".repeat(64)),
    ).toThrow();
    expect(() => artifactBaseName("latest", "linux", "x64")).toThrow();
    expect(() => artifactBaseName("0.1.0", "Linux x", "x64")).toThrow();
  });
});
