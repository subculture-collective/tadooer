#!/usr/bin/env node
/**
 * Operator setup and verification for bundled or existing Baikal (ADR 0039).
 *
 * Secrets are read from owner-only files (mode 0600) named by *_FILE
 * environment variables; for disposable runs the matching plain variables
 * are accepted. No command writes a password, cookie, CSRF token or DAV
 * response body to stdout or stderr.
 */
import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import process from "node:process";
import { URL } from "node:url";
import {
  bootstrapBaikal,
  endpoint,
  normalizeBaseUrl,
  validDavUsername,
} from "./baikal-admin.mjs";

const usage = `Usage:
  node deploy/baikal-setup.mjs generate-password <new-file>
  node deploy/baikal-setup.mjs health <baikal-url>
  BAIKAL_ADMIN_PASSWORD_FILE=... BAIKAL_DAV_PASSWORD_FILE=... BAIKAL_DAV_USERNAME=... \\
    node deploy/baikal-setup.mjs bootstrap <baikal-url>
  SUITE_OWNER_USERNAME=... SUITE_OWNER_PASSWORD_FILE=... \\
  BAIKAL_DAV_USERNAME=... BAIKAL_DAV_PASSWORD_FILE=... \\
    node deploy/baikal-setup.mjs verify-suite <suite-url>

verify-suite probes the Suite's configured Baikal endpoint, then connects and
reads the status back unless SUITE_PROBE_ONLY=true; SUITE_STATUS_ONLY=true only
reads the saved connector status. SUITE_CREATE_OWNER=true
creates the owner first (fresh disposable Suites only). SUITE_EXPECT_FAILURE=CODE
instead requires the probe (or status) to fail with that error code.`;

const fail = (message) => {
  throw new Error(`baikal-setup: ${message}`);
};

/** Read a secret from an owner-only regular file, never following symlinks. */
export const readSecretFile = (path, label) => {
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    fail(`${label} file is unreadable`);
  }
  try {
    const status = fstatSync(descriptor);
    if (!status.isFile()) fail(`${label} file is not a regular file`);
    if ((status.mode & 0o077) !== 0)
      fail(`${label} file must be mode 0600 (owner-only)`);
    if (status.size > 4096) fail(`${label} file is too large`);
    const value = readFileSync(descriptor, "utf8").replace(/\r?\n$/, "");
    if (value === "") fail(`${label} file is empty`);
    return value;
  } finally {
    closeSync(descriptor);
  }
};

const secret = (name, label) => {
  const file = process.env[`${name}_FILE`];
  if (file !== undefined && file !== "") return readSecretFile(file, label);
  const value = process.env[name];
  if (value === undefined || value === "")
    fail(`${name}_FILE (or ${name} for disposable runs) is required`);
  return value;
};

const generatePassword = (path) => {
  if (path === undefined) fail(usage);
  let descriptor;
  try {
    descriptor = openSync(
      path,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
  } catch {
    fail("password file already exists or cannot be created");
  }
  try {
    writeFileSync(descriptor, `${randomBytes(24).toString("base64url")}\n`);
  } finally {
    closeSync(descriptor);
  }
  return { created: path, mode: "0600" };
};

const health = async (base) => {
  const admin = await globalThis.fetch(endpoint(base, "/admin/"), {
    redirect: "manual",
  });
  await admin.body?.cancel();
  // A fresh Baikal redirects every route to its installer until bootstrap.
  const installer = (response) =>
    response.status >= 300 &&
    response.status <= 399 &&
    (response.headers.get("location") ?? "").includes("/admin/install");
  const dav = await globalThis.fetch(endpoint(base, "/dav.php/"), {
    method: "PROPFIND",
    redirect: "manual",
    headers: { Depth: "0" },
  });
  await dav.body?.cancel();
  if (installer(admin) && installer(dav))
    return { admin: admin.status, initialized: false };
  if (admin.status === 200 && dav.status === 401)
    return {
      admin: admin.status,
      initialized: true,
      davRequiresAuthentication: true,
    };
  fail(
    `Baikal is not healthy (admin HTTP ${admin.status}, unauthenticated DAV HTTP ${dav.status}; expected 200 and 401, or the installer redirect before bootstrap)`,
  );
};

const davUsername = () => {
  const username = process.env.BAIKAL_DAV_USERNAME ?? "tadooer";
  if (!validDavUsername(username))
    fail(
      "BAIKAL_DAV_USERNAME must be 3-64 lowercase letters, digits, or hyphens",
    );
  return username;
};

const bootstrap = (base) =>
  bootstrapBaikal({
    base,
    adminPassword: secret("BAIKAL_ADMIN_PASSWORD", "admin password"),
    davPassword: secret("BAIKAL_DAV_PASSWORD", "DAV password"),
    username: davUsername(),
  });

const suiteOrigin = (raw) => {
  const origin = normalizeBaseUrl(raw);
  if (origin.pathname !== "/") fail("Suite URL must be an origin");
  return origin.origin;
};

const verifySuite = async (rawSuiteUrl) => {
  const origin = suiteOrigin(rawSuiteUrl);
  const ownerUsername = process.env.SUITE_OWNER_USERNAME;
  if (ownerUsername === undefined || ownerUsername === "")
    fail("SUITE_OWNER_USERNAME is required");
  const ownerPassword = secret("SUITE_OWNER_PASSWORD", "owner password");
  const username = davUsername();
  const password = secret("BAIKAL_DAV_PASSWORD", "DAV password");
  const json = { Origin: origin, "Content-Type": "application/json" };
  const call = (path, init = {}) =>
    globalThis.fetch(new URL(path, origin), { redirect: "manual", ...init });

  if (process.env.SUITE_CREATE_OWNER === "true") {
    const setup = await call("/api/setup", {
      method: "POST",
      headers: json,
      body: JSON.stringify({
        username: ownerUsername,
        displayName: "Baikal setup owner",
        password: ownerPassword,
      }),
    });
    await setup.body?.cancel();
    if (setup.status !== 201 && setup.status !== 409)
      fail(`owner setup returned HTTP ${setup.status}`);
  }
  const login = await call("/api/auth/login", {
    method: "POST",
    headers: json,
    body: JSON.stringify({ username: ownerUsername, password: ownerPassword }),
  });
  if (!login.ok) fail(`owner sign-in returned HTTP ${login.status}`);
  const cookie = login.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
  const { csrfToken } = await login.json();
  const unsafe = { ...json, Cookie: cookie, "X-CSRF-Token": csrfToken };
  const credentials = JSON.stringify({ username, password });
  const leaks = (text) => text.includes(password);
  const expected = process.env.SUITE_EXPECT_FAILURE;

  if (process.env.SUITE_STATUS_ONLY === "true") {
    const status = await call("/api/connectors/baikal", {
      headers: { Cookie: cookie },
    });
    const statusBody = JSON.parse(await status.text());
    if (expected !== undefined && expected !== "") {
      if (status.ok || statusBody.code !== expected)
        fail(
          `expected status failure ${expected}, got HTTP ${status.status} ${statusBody.code ?? "success"}`,
        );
      return { status: "failed-as-expected", code: statusBody.code };
    }
    if (!status.ok || !statusBody.connected)
      fail(`status is not connected (HTTP ${status.status})`);
    return {
      connected: true,
      statusCalendars: statusBody.calendars.length,
    };
  }

  const probe = await call("/api/connectors/baikal/probe", {
    method: "POST",
    headers: unsafe,
    body: credentials,
  });
  const probeText = await probe.text();
  if (leaks(probeText)) fail("probe response contained the DAV password");
  const probeBody = JSON.parse(probeText);
  if (expected !== undefined && expected !== "") {
    if (probe.ok || probeBody.code !== expected)
      fail(
        `expected probe failure ${expected}, got HTTP ${probe.status} ${probeBody.code ?? "success"}`,
      );
    return {
      probe: "failed-as-expected",
      status: probe.status,
      code: probeBody.code,
      messageMentionsUsername: probeBody.message.includes(username),
    };
  }
  if (!probe.ok)
    fail(`probe failed with HTTP ${probe.status} ${probeBody.code}`);
  const summary = {
    davCalendarAccess: probeBody.davClasses.includes("calendar-access"),
    calendars: probeBody.calendars.length,
    writableEventCalendars: probeBody.writableEventCalendars,
    calendarsWithReportedPrivileges: probeBody.calendars.filter(
      (calendar) => calendar.privileges !== null,
    ).length,
  };
  if (process.env.SUITE_PROBE_ONLY === "true") return { probe: summary };

  const connect = await call("/api/connectors/baikal", {
    method: "PUT",
    headers: unsafe,
    body: credentials,
  });
  const connectText = await connect.text();
  if (leaks(connectText)) fail("connect response contained the DAV password");
  if (!connect.ok)
    fail(
      `connect failed with HTTP ${connect.status} ${JSON.parse(connectText).code}`,
    );
  const status = await call("/api/connectors/baikal", {
    headers: { Cookie: cookie },
  });
  const statusText = await status.text();
  if (leaks(statusText)) fail("status response contained the DAV password");
  if (!status.ok)
    fail(
      `status failed with HTTP ${status.status} ${JSON.parse(statusText).code}`,
    );
  const statusBody = JSON.parse(statusText);
  if (!statusBody.connected) fail("status is not connected after connect");
  return {
    probe: summary,
    connected: true,
    statusCalendars: statusBody.calendars.length,
    statusEventCalendars: statusBody.calendars.filter(
      (calendar) => calendar.supportsEvents,
    ).length,
  };
};

const main = async () => {
  const [command, argument] = process.argv.slice(2);
  if (command === "generate-password") return generatePassword(argument);
  if (command === "verify-suite") return verifySuite(argument);
  if (command === "health") return health(normalizeBaseUrl(argument));
  if (command === "bootstrap") return bootstrap(normalizeBaseUrl(argument));
  fail(usage);
};

if (process.argv[1] !== undefined && import.meta.filename === process.argv[1])
  main()
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    });
