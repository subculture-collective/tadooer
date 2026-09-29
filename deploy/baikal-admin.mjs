/**
 * Shared Baikal 0.10.1 admin driver (ADR 0039).
 *
 * Runs the upstream initialization wizard when needed, signs in as the Baikal
 * admin, creates one DAV user when it does not exist, and verifies its default
 * calendar through CalDAV. It never reaches into Baikal's SQLite schema and
 * never includes a password, cookie or CSRF token in a result or error.
 */
import { Buffer } from "node:buffer";
import { URL, URLSearchParams } from "node:url";

export const fail = (message) => {
  throw new Error(`baikal-admin: ${message}`);
};

export const normalizeBaseUrl = (rawBaseUrl) => {
  if (rawBaseUrl === undefined) fail("base URL is required");
  let result;
  try {
    result = new URL(rawBaseUrl);
  } catch {
    fail("base URL is invalid");
  }
  if (result.protocol !== "http:" && result.protocol !== "https:")
    fail("base URL must use HTTP(S)");
  if (result.username !== "" || result.password !== "")
    fail("base URL must not embed credentials");
  result.pathname = result.pathname.replace(/\/$/, "") || "/";
  result.search = "";
  result.hash = "";
  return result;
};

export const endpoint = (base, path) => new URL(path, base).href;

export const basicAuthorization = (username, password) =>
  `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;

export const htmlEntities = (value) =>
  value
    .replaceAll("&amp;", "&")
    .replaceAll("&#039;", "'")
    .replaceAll("&quot;", '"');

class CookieJar {
  #cookies = new Map();

  add(response) {
    const values =
      typeof response.headers.getSetCookie === "function"
        ? response.headers.getSetCookie()
        : response.headers.get("set-cookie") === null
          ? []
          : [response.headers.get("set-cookie")];
    for (const value of values) {
      const first = value.split(";", 1)[0];
      const marker = first.indexOf("=");
      if (marker > 0)
        this.#cookies.set(first.slice(0, marker), first.slice(marker + 1));
    }
  }

  header() {
    return [...this.#cookies.entries()]
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
  }
}

const formInputs = (html) => {
  const values = new URLSearchParams();
  for (const match of html.matchAll(/<input\b[^>]*>/gi)) {
    const tag = match[0];
    const name = /\bname="([^"]+)"/i.exec(tag)?.[1];
    if (name === undefined) continue;
    const type = /\btype="([^"]+)"/i.exec(tag)?.[1]?.toLowerCase();
    if (type === "checkbox" && !/\bchecked(?:=|\s|>)/i.test(tag)) continue;
    values.set(name, htmlEntities(/\bvalue="([^"]*)"/i.exec(tag)?.[1] ?? ""));
  }
  return values;
};

const requiredCsrf = (fields, html = "") => {
  if (!fields.has("CSRF_TOKEN")) {
    const heading = /<h1[^>]*>([\s\S]*?)<\/h1>/i
      .exec(html)?.[1]
      ?.replace(/<[^>]+>/g, "")
      .trim();
    fail(
      `pinned Baikal admin form did not include CSRF_TOKEN${heading === undefined ? "" : ` (page: ${heading.trim()})`}`,
    );
  }
};

const adminRequest = async (jar, url, init = {}) => {
  const response = await globalThis.fetch(url, {
    redirect: "manual",
    ...init,
    headers: {
      ...(jar.header() === "" ? {} : { Cookie: jar.header() }),
      ...init.headers,
    },
  });
  jar.add(response);
  return response;
};

const adminPage = async (jar, url) => {
  let next = url;
  let response;
  for (let redirects = 0; redirects < 4; redirects += 1) {
    response = await adminRequest(jar, next);
    if (response.status < 300 || response.status > 399) break;
    const location = response.headers.get("location");
    if (location === null) fail("admin redirected without a Location header");
    const resolved = new URL(location, next);
    const current = new URL(next);
    if (resolved.origin !== current.origin) {
      // Baikal may advertise its Docker-internal hostname in admin redirects.
      // Preserve the tested public origin while accepting only a credentialless
      // HTTP(S) path/query redirect; never follow the advertised host.
      if (
        (resolved.protocol !== "http:" && resolved.protocol !== "https:") ||
        resolved.username !== "" ||
        resolved.password !== ""
      )
        fail("admin redirected to an unsafe origin");
      resolved.protocol = current.protocol;
      resolved.host = current.host;
    }
    next = resolved.href;
  }
  if (response === undefined) fail("admin redirect handling failed");
  if (response.status >= 300 && response.status <= 399)
    fail("admin redirected too many times");
  if (!response.ok) fail(`admin page failed with HTTP ${response.status}`);
  return response.text();
};

const postAdminForm = async (jar, url, overrides) => {
  const html = await adminPage(jar, url);
  const fields = formInputs(html);
  requiredCsrf(fields, html);
  for (const [name, value] of Object.entries(overrides))
    fields.set(name, value);
  const response = await adminRequest(jar, url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: fields,
  });
  if (response.status >= 400)
    fail(`admin form failed with HTTP ${response.status}`);
  return response.text();
};

const formAction = (html, fallback) => {
  const action = /<form\b[^>]*\baction="([^"]*)"/i.exec(html)?.[1];
  return action === undefined || action === ""
    ? fallback
    : new URL(htmlEntities(action), fallback).href;
};

export const validDavUsername = (username) =>
  typeof username === "string" && /^[a-z0-9-]{3,64}$/.test(username);

const requireSecret = (value, label) => {
  if (typeof value !== "string" || value === "") fail(`${label} is required`);
  if (value.length < 12) fail(`${label} must be at least 12 characters`);
  return value;
};

/**
 * Initialize (when needed) and provision one DAV user.
 * Returns { username, calendarHref, endpoint, installed, userCreated }.
 */
export const bootstrapBaikal = async ({
  base,
  adminPassword: rawAdminPassword,
  davPassword: rawDavPassword,
  username,
}) => {
  const adminPassword = requireSecret(rawAdminPassword, "admin password");
  const davPassword = requireSecret(rawDavPassword, "DAV password");
  if (!validDavUsername(username))
    fail("DAV username must be 3-64 lowercase letters, digits, or hyphens");
  const jar = new CookieJar();
  const installUrl = endpoint(base, "/admin/install/");
  const install = await adminRequest(jar, installUrl);
  const installHtml = await install.text();
  let installed = false;

  if (installHtml.includes("Baïkal initialization wizard")) {
    const fields = formInputs(installHtml);
    requiredCsrf(fields, installHtml);
    fields.set("Baikal_Model_Config_Standard::submitted", "1");
    fields.set("refreshed", "0");
    fields.set("data[timezone]", "UTC");
    fields.set("data[card_enabled]", "1");
    fields.set("data[cal_enabled]", "1");
    fields.set("data[invite_from]", "noreply@invalid.test");
    fields.set("data[dav_auth_type]", "Basic");
    fields.set("data[admin_passwordhash]", adminPassword);
    fields.set("data[admin_passwordhash_confirm]", adminPassword);
    const response = await adminRequest(jar, installUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: fields,
    });
    if (response.status >= 400)
      fail(`Baikal install failed with HTTP ${response.status}`);
    const databaseLocation = response.headers.get("location");
    if (databaseLocation === null)
      fail("Baikal install did not continue to database setup");
    const databaseUrl = new URL(databaseLocation, installUrl);
    databaseUrl.protocol = base.protocol;
    databaseUrl.host = base.host;
    await postAdminForm(jar, databaseUrl.href, {
      "data[backend]": "sqlite",
      "data[sqlite_file]": "/var/www/baikal/Specific/db/db.sqlite",
    });
    installed = true;
  }

  const adminUrl = endpoint(base, "/admin/");
  const loginHtml = await adminPage(jar, adminUrl);
  const loginResponse = await adminRequest(
    jar,
    formAction(loginHtml, adminUrl),
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        auth: "1",
        login: "admin",
        password: adminPassword,
      }),
    },
  );
  if (loginResponse.status >= 400)
    fail(`Baikal admin login failed with HTTP ${loginResponse.status}`);
  const authenticatedHtml = await adminPage(jar, adminUrl);
  if (!authenticatedHtml.includes("Users and resources"))
    fail(
      "Baikal admin login did not establish an authenticated session; check the admin password",
    );

  // Baikal's QuestionMarkRewrite router intentionally encodes routes after
  // the query marker (for example /admin/?/users/new/1/), not as paths.
  const listUrl = endpoint(base, "/admin/?/users/");
  let userCreated = false;
  if (!(await adminPage(jar, listUrl)).includes(`>${username}<`)) {
    const userHtml = await postAdminForm(
      jar,
      endpoint(base, "/admin/?/users/new/1/"),
      {
        "data[username]": username,
        "data[displayname]": "Productivity Suite",
        "data[email]": `${username}@invalid.test`,
        "data[password]": davPassword,
        "data[passwordconfirm]": davPassword,
      },
    );
    if (/Authentication error|validation error/i.test(userHtml))
      fail("Baikal rejected the DAV user form");
    if (!(await adminPage(jar, listUrl)).includes(`>${username}<`))
      fail("Baikal did not persist the DAV user");
    userCreated = true;
  }

  const calendarHref = `/dav.php/calendars/${username}/default/`;
  const response = await globalThis.fetch(new URL(calendarHref, base), {
    method: "PROPFIND",
    redirect: "manual",
    headers: {
      Authorization: basicAuthorization(username, davPassword),
      Depth: "0",
      "Content-Type": "application/xml; charset=utf-8",
    },
    body: `<?xml version="1.0" encoding="utf-8"?><D:propfind xmlns:D="DAV:"><D:prop><D:resourcetype/></D:prop></D:propfind>`,
  });
  await response.body?.cancel();
  if (response.status === 401)
    fail(
      "the existing DAV user rejected the supplied DAV password; reset it in Baikal's admin interface",
    );
  if (response.status !== 207)
    fail(`DAV calendar verification returned HTTP ${response.status}`);
  return {
    username,
    calendarHref,
    endpoint: endpoint(base, "/dav.php/"),
    installed,
    userCreated,
  };
};
