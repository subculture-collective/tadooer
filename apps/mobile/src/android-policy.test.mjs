import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  allowedExternalOAuth,
  allowedNavigation,
  classifyServerAddress,
  deepLinkTarget,
} from "@suite/shell-policy";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Compares the Android shell's Java policy with the shared JavaScript policy
 * over the same inputs (ADR 0049). The Java class has no Android import, so
 * a plain JDK compiles and runs it; no Android SDK is involved.
 *
 * The Java reading is allowed to be stricter, never looser: whatever it
 * accepts, the JavaScript must accept with the same result. A list of
 * ordinary inputs must be accepted by both.
 *
 * Without `javac` on the PATH the suite is skipped, which is the case in the
 * repository's container check. Run it on a machine with a JDK.
 */

const javaDirectory = join(import.meta.dirname, "..", "android", "app", "src");
const sources = [
  join(javaDirectory, "main/java/tv/subcult/tadooer/ShellPolicy.java"),
  join(javaDirectory, "test/java/tv/subcult/tadooer/PolicyCheck.java"),
];

const hasJdk =
  spawnSync("javac", ["-version"], { encoding: "utf8" }).status === 0 &&
  spawnSync("java", ["-version"], { encoding: "utf8" }).status === 0;

const encode = (value) =>
  value === null ? "-" : Buffer.from(value, "utf8").toString("base64");

let classes;

const runJava = (calls) => {
  const input = calls
    .map(([name, ...parameters]) =>
      [
        name,
        ...parameters.map((parameter) =>
          typeof parameter === "boolean"
            ? String(parameter)
            : encode(parameter),
        ),
      ].join("\t"),
    )
    .join("\n");
  const result = spawnSync(
    "java",
    ["-cp", classes, "tv.subcult.tadooer.PolicyCheck"],
    { input: `${input}\n`, encoding: "utf8" },
  );
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  const lines = result.stdout.split("\n").slice(0, -1);
  expect(lines).toHaveLength(calls.length);
  return lines.map((line) =>
    line === "null"
      ? null
      : line === "true"
        ? true
        : line === "false"
          ? false
          : line,
  );
};

const origin = "https://tasks.example.org";

const origins = [
  "https://tasks.example.org",
  "https://tasks.example.org:8443",
  "https://xn--bcher-kva.example",
  "https://10.0.0.50",
  "https://10.0.0.50:8443",
  "https://a-b.c1.example",
  "http://127.0.0.1",
  "http://127.0.0.1:8080",
  "http://[::1]:8080",
  "https://[::1]",
  "http://10.0.0.50:8080",
  "http://172.16.0.1",
  "http://172.31.255.254:3000",
  "http://192.168.1.10",
  "http://100.64.0.1",
  "http://100.127.255.255:8080",
];

const refusedOrigins = [
  "",
  "tasks.example.org",
  "https://tasks.example.org/",
  "https://tasks.example.org/path",
  "https://tasks.example.org?x",
  "https://tasks.example.org#x",
  "https://Tasks.Example.org",
  "HTTPS://tasks.example.org",
  "https://user@tasks.example.org",
  "https://user:pw@tasks.example.org",
  "https://tasks.example.org:443",
  "https://tasks.example.org:0",
  "https://tasks.example.org:08443",
  "https://tasks.example.org:65536",
  "https://tasks.example.org:",
  "https://tasks.example.org.",
  "https://-bad.example",
  "https://bad_.example",
  "https://exa mple.org",
  "https://",
  "https://localhost",
  "https://localhost:8443",
  "http://localhost",
  "http://localhost:8080",
  "http://tasks.example.org",
  "http://8.8.8.8",
  "http://127.0.0.2",
  "http://172.15.0.1",
  "http://172.32.0.1",
  "http://100.63.0.1",
  "http://100.128.0.1",
  "http://192.169.0.1",
  "http://010.0.0.1",
  "http://10.0.0.256",
  "http://10.0.1",
  "http://0x0a.0.0.1",
  "http://167772161",
  "http://10.0.0.50:80",
  "http://[fd00::1]",
  "http://[fc00::1]:8080",
  "http://[::1",
  "https://[2001:db8::1]",
  "ftp://tasks.example.org",
  "file:///etc/passwd",
  "javascript:alert(1)",
  "https://tasks.example.org\\@evil.example",
  "https://1.2.3",
  "https://example.123",
];

const deepLinks = [
  "tadooer://open",
  "tadooer://open/",
  "tadooer://open/today",
  "TADOOER://open/today",
  "tadooer://open/tasks?view=inbox",
  "tadooer://open/tasks?view=inbox#top",
  "tadooer://open?view=inbox",
  "tadooer://open#top",
  "tadooer://open/a/b/c-d_e.f~g",
  "tadooer://open/planner?date=2026-10-02&x=a%20b",
  "tadooer://open/today?",
  "tadooer://open/today#",
  "tadooer://open/apiary",
  "tadooer://open/notes/@me;v=1,2",
  // A path, not a host: it stays on the configured origin.
  "tadooer://open/@evil.example/",
];

const refusedDeepLinks = [
  "",
  "tadooer:",
  "tadooer://",
  "tadooer:open/today",
  "tadooer:/open/today",
  "tadooer://OPEN/today",
  "tadooer://evil.example/today",
  "tadooer://open.evil.example/today",
  "tadooer://openx/today",
  "tadooer://open:81/today",
  "tadooer://open:/today",
  "tadooer://user@open/today",
  "tadooer://user:pw@open/today",
  "tadooer://open//evil.example/x",
  "tadooer://open/api",
  "tadooer://open/api/",
  "tadooer://open/api/data/export",
  "tadooer://open/API/build",
  "tadooer://open/a/../api/build",
  "tadooer://open/./api/build",
  "tadooer://open/../today",
  "tadooer://open/%2e%2e/api/build",
  "tadooer://open/%2E%2E/api/build",
  "tadooer://open/a%2fb",
  "tadooer://open/a%5cb",
  "tadooer://open/a\\b",
  "tadooer://open/a b",
  "tadooer://open/a\tb",
  "tadooer://open/a\nb",
  "tadooer://open/a\u0000b",
  "tadooer://open/<script>",
  'tadooer://open/"x"',
  "tadooer://open/a'b?c='d'",
  "tadooer://open/a|b",
  "tadooer://open/a{b}",
  "tadooer://open/é",
  "tadooer://open/😀",
  "https://tasks.example.org/today",
  "http://open/today",
  `tadooer://open/${"a".repeat(1100)}`,
  `tadooer://open/${"a".repeat(2100)}`,
];

const state = "0123456789abcdef0123456789abcdef";
const oauth = `https://accounts.google.com/o/oauth2/v2/auth?response_type=code&client_id=abcde.apps.googleusercontent.com&redirect_uri=https%3A%2F%2Ftasks.example.org%2Fapi%2Fconnectors%2Fgoogle%2Fcallback&scope=a+b&state=${state}`;
const oauthUrls = [oauth, `${oauth}&access_type=offline#fragment`];
const refusedOauthUrls = [
  "",
  "https://accounts.google.com/o/oauth2/v2/auth",
  "https://accounts.google.com/o/oauth2/v2/auth?",
  oauth.replace("response_type=code", "response_type=token"),
  oauth.replace("response_type=code&", ""),
  oauth.replace(state, "short"),
  oauth.replace("client_id=abcde.apps.googleusercontent.com", "client_id=abc"),
  oauth.replace(/redirect_uri=[^&]+/, "redirect_uri="),
  oauth.replace("https://", "http://"),
  oauth.replace("accounts.google.com", "accounts.google.com.evil.example"),
  oauth.replace("accounts.google.com", "user@accounts.google.com"),
  oauth.replace("accounts.google.com", "accounts.google.com:444"),
  oauth.replace("/o/oauth2/v2/auth", "/o/oauth2/auth"),
  oauth.replace("/o/oauth2/v2/auth", "/o/oauth2/v2/auth/"),
  `${oauth}&bad=%zz`,
  // The first value of a repeated name counts.
  oauth.replace("response_type=code", "response_type=token&response_type=code"),
  "https://evil.example/o/oauth2/v2/auth?response_type=code",
];

const navigations = [
  [`${origin}/`, true],
  [`${origin}/today?x=1#y`, true],
  [origin, true],
  [`${origin}:8443/`, false],
  [`${origin}.evil.example/`, false],
  [`${origin}@evil.example/`, false],
  ["http://tasks.example.org/", false],
  ["https://evil.example/", false],
  ["about:blank", false],
  ["data:text/html,x", false],
  ["javascript:alert(1)", false],
  ["", false],
];

describe.skipIf(!hasJdk)("Android policy against the shared policy", () => {
  beforeAll(() => {
    classes = mkdtempSync(join(tmpdir(), "tadooer-policy-"));
    const compiled = spawnSync(
      "javac",
      ["-Xlint:all", "-Werror", "-d", classes, ...sources],
      { encoding: "utf8" },
    );
    expect(compiled.stderr).toBe("");
    expect(compiled.status).toBe(0);
  }, 120_000);

  afterAll(() => {
    if (classes !== undefined)
      rmSync(classes, { recursive: true, force: true });
  });

  it("classifies a canonical origin as the JavaScript does", () => {
    const inputs = [...origins, ...refusedOrigins];
    for (const consent of [false, true]) {
      const java = runJava(
        inputs.map((input) => ["classifyOrigin", input, consent]),
      );
      inputs.forEach((input, index) => {
        const shared = classifyServerAddress(input, {
          allowPrivateLanHttp: consent,
        });
        if (java[index] !== null) {
          // Never looser: accepted only in canonical form, same transport.
          expect(shared, input).toEqual({
            ok: true,
            origin: input,
            transport: java[index],
          });
        }
        if (origins.includes(input))
          expect(java[index], input).toBe(shared.ok ? shared.transport : null);
        else expect(java[index], input).toBeNull();
      });
    }
    expect(runJava([["classifyOrigin", null, true]])).toEqual([null]);
  });

  it("refuses the reserved host and IPv6 literals the desktop accepts", () => {
    // Deliberate differences, stated in ADR 0049.
    for (const input of [
      "https://localhost",
      "http://localhost:8080",
      "https://[2001:db8::1]",
    ])
      expect(classifyServerAddress(input).ok, input).toBe(true);
    expect(
      classifyServerAddress("http://[fd00::1]", { allowPrivateLanHttp: true })
        .ok,
    ).toBe(true);
  });

  it("resolves a deep link as the JavaScript does", () => {
    const inputs = [...deepLinks, ...refusedDeepLinks];
    const java = runJava(
      inputs.map((input) => ["deepLinkTarget", input, origin]),
    );
    inputs.forEach((input, index) => {
      const shared = deepLinkTarget(input, origin) ?? null;
      if (java[index] !== null) expect(java[index], input).toBe(shared);
      if (deepLinks.includes(input)) {
        expect(shared, input).not.toBeNull();
        expect(java[index], input).toBe(shared);
      } else expect(java[index], input).toBeNull();
    });
    expect(
      runJava([
        ["deepLinkTarget", null, origin],
        ["deepLinkTarget", "tadooer://open/today", null],
      ]),
    ).toEqual([null, null]);
  });

  it("hands only Google's authorization-code request to the browser", () => {
    const inputs = [...oauthUrls, ...refusedOauthUrls];
    const java = runJava(
      inputs.map((input) => ["allowedExternalOAuth", input]),
    );
    inputs.forEach((input, index) => {
      const shared = allowedExternalOAuth(input);
      if (java[index]) expect(shared, input).toBe(true);
      expect(java[index], input).toBe(oauthUrls.includes(input));
    });
  });

  it("keeps navigation on the configured origin", () => {
    const java = runJava(
      navigations.map(([url]) => ["sameOrigin", url, origin]),
    );
    navigations.forEach(([url, expected], index) => {
      expect(java[index], url).toBe(expected);
      if (java[index]) expect(allowedNavigation(url, origin), url).toBe(true);
    });
    expect(
      runJava([
        ["sameOrigin", null, origin],
        ["sameOrigin", `${origin}/`, null],
        ["sameOrigin", `${origin}/`, ""],
      ]),
    ).toEqual([false, false, false]);
  });
});
