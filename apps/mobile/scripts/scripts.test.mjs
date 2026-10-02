import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { URL } from "node:url";
import vm from "node:vm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  jdkMajorVersion,
  jdkProblem,
  locateSdk,
  sdkDirectoryFromProperties,
} from "./android.mjs";
import { buildWww } from "./build-www.mjs";
import {
  cleartextHostAllowed,
  networkSecurityConfigPath,
  parseNetworkSecurityConfig,
  renderNetworkSecurityConfig,
} from "./cleartext.mjs";
import { iconVariants } from "./generate-icons.mjs";

const packageDirectory = join(import.meta.dirname, "..");
const read = (...parts) =>
  readFileSync(join(packageDirectory, ...parts), "utf8");

describe("Android toolchain check", () => {
  const sdk = "/opt/android-sdk";
  const exists = (path) => path === join(sdk, "platforms");

  it("finds the SDK the way Gradle does", () => {
    expect(
      locateSdk({
        environment: {},
        localProperties: `# comment\nsdk.dir=${sdk}\n`,
        exists,
      }),
    ).toEqual({ path: sdk, source: "android/local.properties" });
    expect(
      locateSdk({
        environment: { ANDROID_HOME: sdk },
        localProperties: undefined,
        exists,
      }),
    ).toEqual({ path: sdk, source: "ANDROID_HOME" });
    expect(
      locateSdk({
        environment: { ANDROID_HOME: "/missing", ANDROID_SDK_ROOT: sdk },
        localProperties: undefined,
        exists,
      }),
    ).toEqual({ path: sdk, source: "ANDROID_SDK_ROOT" });
  });

  it("says what is missing and what to do", () => {
    const none = locateSdk({
      environment: {},
      localProperties: undefined,
      exists,
    });
    expect(none.path).toBeUndefined();
    expect(none.problem).toContain("The Android SDK was not found");
    expect(none.problem).toContain("ANDROID_HOME is not set");
    expect(none.problem).toContain("docs/operations/mobile.md");

    const wrong = locateSdk({
      environment: { ANDROID_HOME: "/missing" },
      localProperties: undefined,
      exists,
    });
    expect(wrong.problem).toContain(
      "ANDROID_HOME names /missing, which has no platforms directory.",
    );
  });

  it("reads sdk.dir from local.properties", () => {
    expect(sdkDirectoryFromProperties("sdk.dir=/a/b")).toBe("/a/b");
    expect(sdkDirectoryFromProperties("  sdk.dir = /a/b  \r\nx=1")).toBe(
      "/a/b",
    );
    expect(sdkDirectoryFromProperties("ndk.dir=/a")).toBeUndefined();
    expect(sdkDirectoryFromProperties(undefined)).toBeUndefined();
  });

  it("accepts JDK 21 to 24 and explains the rest", () => {
    expect(jdkMajorVersion('openjdk version "21.0.4" 2024-07-16')).toBe(21);
    expect(jdkMajorVersion('openjdk version "26.0.2.1" 2026-08-18')).toBe(26);
    expect(jdkMajorVersion('java version "1.8.0_292"')).toBe(8);
    expect(jdkMajorVersion('openjdk version "22" 2024-03-19')).toBe(22);
    expect(jdkMajorVersion("nothing")).toBeUndefined();
    expect(jdkProblem('openjdk version "21.0.4"')).toBeUndefined();
    expect(jdkProblem('openjdk version "24.0.1"')).toBeUndefined();
    expect(jdkProblem('openjdk version "17.0.9"')).toContain("version 17");
    expect(jdkProblem('openjdk version "26.0.2.1"')).toContain("version 26");
    expect(jdkProblem(undefined)).toContain("No JDK was found");
  });
});

describe("network security configuration", () => {
  it("is committed in its default form: loopback only", () => {
    const committed = readFileSync(networkSecurityConfigPath, "utf8");
    expect(committed).toBe(renderNetworkSecurityConfig());
    expect(parseNetworkSecurityConfig(committed)).toEqual({
      hosts: [],
      trustUserCertificates: false,
    });
    expect(committed).toContain(
      '<base-config cleartextTrafficPermitted="false" />',
    );
    expect(committed.match(/<domain /g)).toHaveLength(1);
    expect(committed).toContain(">127.0.0.1</domain>");
  });

  it("adds exact private addresses and nothing wider", () => {
    const xml = renderNetworkSecurityConfig({
      hosts: ["10.0.0.50", "100.65.164.66", "10.0.0.50"],
    });
    expect(parseNetworkSecurityConfig(xml)).toEqual({
      hosts: ["10.0.0.50", "100.65.164.66"],
      trustUserCertificates: false,
    });
    expect(xml).not.toContain('includeSubdomains="true"');
    expect(xml).toContain('<base-config cleartextTrafficPermitted="false" />');
  });

  it("refuses public addresses, names and anything that is not an address", () => {
    for (const host of [
      "8.8.8.8",
      "tasks.example.org",
      "localhost",
      "10.0.0",
      "010.0.0.1",
      "10.0.0.1/24",
      "10.0.0.1</domain><domain>evil.example",
      "[fd00::1]",
      "",
      5,
    ]) {
      expect(cleartextHostAllowed(host), String(host)).toBe(false);
      expect(() => renderNetworkSecurityConfig({ hosts: [host] })).toThrow();
    }
  });

  it("can trust owner-installed certificate authorities", () => {
    const xml = renderNetworkSecurityConfig({ trustUserCertificates: true });
    expect(parseNetworkSecurityConfig(xml)).toEqual({
      hosts: [],
      trustUserCertificates: true,
    });
    expect(xml).toContain('<certificates src="system" />');
    expect(xml).toContain('<base-config cleartextTrafficPermitted="false">');
  });
});

describe("launcher icon variants", () => {
  const webIcon = read("..", "web", "public", "suite-icon.svg");

  it("derives the round and adaptive icons from the web icon", () => {
    const variants = iconVariants(webIcon);
    expect(variants.background).toBe("#11111b");
    expect(variants.square).toBe(webIcon);
    expect(variants.round).toContain('<circle cx="256" cy="256" r="256"');
    expect(variants.foreground).not.toContain("<rect");
    expect(variants.foreground).toContain('fill="#bd93f9"');
    // The adaptive background colour is the icon's own.
    expect(
      read("android/app/src/main/res/values/ic_launcher_background.xml"),
    ).toContain("#11111B");
  });

  it("fails loudly when the web icon changes shape", () => {
    expect(() => iconVariants("<svg></svg>")).toThrow(/suite-icon.svg/);
  });
});

describe("bundled pages", () => {
  let output;
  beforeAll(async () => {
    output = await buildWww(mkdtempSync(join(tmpdir(), "tadooer-www-")));
  }, 60_000);
  afterAll(() => {
    if (output !== undefined) rmSync(output, { recursive: true, force: true });
  });
  const built = (name) => readFileSync(join(output, name), "utf8");

  it("ships the desktop setup script and stylesheet unchanged", () => {
    expect(built("setup.js")).toBe(read("..", "desktop/src/setup/setup.js"));
    expect(built("setup.css")).toBe(read("..", "desktop/src/setup/setup.css"));
  });

  it("gives the desktop setup script every element it looks for", () => {
    const html = built("index.html");
    const ids = Array.from(
      built("setup.js").matchAll(/querySelector\("#([\w-]+)"\)/g),
      (match) => match[1],
    );
    expect(ids.length).toBeGreaterThanOrEqual(7);
    for (const id of ids) expect(html, id).toContain(`id="${id}"`);
    // The adapter must define window.tadooerSetup before setup.js reads it.
    expect(html.indexOf('src="shell-setup.js"')).toBeGreaterThan(0);
    expect(html.indexOf('src="shell-setup.js"')).toBeLessThan(
      html.indexOf('src="setup.js"'),
    );
  });

  it("keeps the setup page closed to everything but its own files", () => {
    const html = built("index.html");
    expect(html).toContain(
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'",
    );
    expect(html).toContain("viewport-fit=cover");
    expect(html).not.toMatch(/https?:\/\/(?!tasks\.example\.org)/);
    expect(html).not.toContain("<script>");
  });

  it("builds bundles a WebView can run without Node", () => {
    for (const name of ["shell-setup.js", "page-bridge.js"]) {
      const code = built(name);
      expect(code, name).not.toMatch(/\brequire\(/);
      expect(code, name).not.toContain("node:");
      expect(code, name).not.toMatch(/^\s*(import|export)\s/m);
    }
  });

  const runBridge = (window) => {
    window.window = window;
    window.top ??= window;
    vm.createContext(window);
    vm.runInContext(built("page-bridge.js"), window);
    return window;
  };

  it("installs the bridge in the top frame of a page that has the channel", () => {
    const events = [];
    const native = { postMessage: (message) => events.push(["post", message]) };
    const window = runBridge({
      tadooerShellNative: native,
      URL,
      CustomEvent: class {
        constructor(name, init) {
          this.name = name;
          this.detail = init.detail;
        }
      },
      dispatchEvent: (event) =>
        events.push(["event", event.name, event.detail]),
    });
    const bridge = window.tadooerMobile;
    expect(bridge.version).toBe(1);
    // The report is built inside the page's own realm, as the web app's is.
    expect(
      vm.runInContext(
        'tadooerMobile.reportStatus({ sync: "online", live: "live" })',
        window,
      ),
    ).toBe(true);
    expect(bridge.ready()).toBe(true);
    native.onmessage({
      data: JSON.stringify({ type: "share", text: "from another app" }),
    });
    expect(events).toEqual([
      ["post", "ready"],
      ["event", "tadooer:quick-capture", { text: "from another app" }],
    ]);
    expect(() => {
      "use strict";
      window.tadooerMobile = {};
    }).toThrow();
  });

  it("installs nothing without the channel or inside a frame", () => {
    expect(runBridge({ URL }).tadooerMobile).toBeUndefined();
    expect(
      runBridge({
        URL,
        top: {},
        tadooerShellNative: { postMessage: () => undefined },
      }).tadooerMobile,
    ).toBeUndefined();
  });
});

describe("Android project settings", () => {
  const config = JSON.parse(read("capacitor.config.json"));
  const manifest = read("android/app/src/main/AndroidManifest.xml");

  it("bundles the setup page and names no server", () => {
    expect(config.webDir).toBe("www");
    expect(config.server).toEqual({
      androidScheme: "https",
      errorPath: "index.html",
    });
    // The Suite origin is chosen at run time and must never be given
    // Capacitor's bridge, which allowNavigation and server.url would do.
    expect(config.server.url).toBeUndefined();
    expect(config.server.allowNavigation).toBeUndefined();
    expect(config.server.cleartext).toBeUndefined();
    expect(config.android.allowMixedContent).toBe(false);
    expect(config.plugins.CapacitorCookies.enabled).toBe(false);
    expect(config.plugins.CapacitorHttp.enabled).toBe(false);
  });

  it("uses one application id everywhere", () => {
    const id = config.appId;
    expect(read("android/app/build.gradle")).toContain(`applicationId "${id}"`);
    expect(read("android/app/build.gradle")).toContain(`namespace = "${id}"`);
    expect(read("android/app/src/main/res/xml/shortcuts.xml")).toContain(
      `android:targetPackage="${id}"`,
    );
    expect(manifest).toContain(`${id}.action.CHANGE_SERVER`);
    expect(read("android/app/src/main/res/values/strings.xml")).toContain(
      `<string name="package_name">${id}</string>`,
    );
    const plugin = read(
      "android/app/src/main/java",
      ...id.split("."),
      "TadooerShellPlugin.java",
    );
    expect(plugin).toContain(`package ${id};`);
    expect(plugin).toContain(`"${id}.action.CHANGE_SERVER"`);
  });

  it("keeps the session out of backups and plaintext behind the configuration", () => {
    expect(manifest).toContain('android:allowBackup="false"');
    expect(manifest).toContain(
      'android:dataExtractionRules="@xml/data_extraction_rules"',
    );
    expect(manifest).toContain(
      'android:networkSecurityConfig="@xml/network_security_config"',
    );
    expect(manifest).not.toContain("usesCleartextTraffic");
    expect(manifest.match(/<uses-permission /g)).toHaveLength(1);
    expect(manifest).toContain("android.permission.INTERNET");
  });

  it("declares the deep link and the share target", () => {
    expect(manifest).toContain(
      '<data android:scheme="tadooer" android:host="open" />',
    );
    expect(manifest).toContain("android.intent.action.SEND");
    expect(manifest).toContain('<data android:mimeType="text/plain" />');
  });

  it("pins Capacitor to exact versions", () => {
    const manifestJson = JSON.parse(read("package.json"));
    for (const version of [
      manifestJson.dependencies["@capacitor/android"],
      manifestJson.dependencies["@capacitor/core"],
      manifestJson.devDependencies["@capacitor/cli"],
    ])
      expect(version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("uses no Google service", () => {
    expect(read("android/build.gradle")).not.toContain("google-services");
    expect(read("android/app/build.gradle")).not.toContain(
      "apply plugin: 'com.google.gms",
    );
  });
});
