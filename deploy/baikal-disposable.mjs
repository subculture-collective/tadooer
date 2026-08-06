#!/usr/bin/env node
/**
 * Disposable Baikal qualification helper.
 *
 * This is deliberately test-only: it drives Baikal's pinned 0.10.1 admin
 * surface to provision a synthetic DAV user, then uses the public CalDAV
 * endpoint for VEVENT operations. It never reaches into Baikal's SQLite
 * schema or emits credentials in its JSON output.
 *
 * Secrets are read from the environment (or, for the command-specific DAV
 * operations, stdin JSON) so callers do not put them in process arguments.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import process from "node:process";
import { Buffer } from "node:buffer";
import { URL, URLSearchParams } from "node:url";

const [command, rawBaseUrl] = process.argv.slice(2);

const usage = `Usage:
  BAIKAL_ADMIN_PASSWORD=... BAIKAL_DAV_PASSWORD=... \\
    node deploy/baikal-disposable.mjs bootstrap <base-url>
  node deploy/baikal-disposable.mjs <seed|get|put|delete|list> <base-url> < stdin.json

All stdin JSON DAV commands require { username, password, calendarHref }.
put additionally requires { href, ics } and accepts { ifMatch, ifNoneMatch }.
seed accepts { summary, start, end } and returns { href, etag, ics }.
get/delete require { href }; delete accepts { ifMatch }.`;

const fail = (message) => {
  throw new Error(`baikal-disposable: ${message}`);
};

const baseUrl = () => {
  if (rawBaseUrl === undefined) fail(usage);
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

const endpoint = (base, path) => new URL(path, base).href;

const readInput = () => {
  try {
    const parsed = JSON.parse(readFileSync(0, "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
      fail("stdin must be a JSON object");
    return parsed;
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith("baikal-disposable:")
    )
      throw error;
    fail("stdin must contain valid JSON");
  }
};

const text = (value, label) => {
  if (typeof value !== "string" || value === "") fail(`${label} is required`);
  return value;
};

const calendarUrl = (base, href) => {
  const result = new URL(text(href, "calendarHref"), base);
  if (result.origin !== base.origin || !result.pathname.startsWith("/dav.php/"))
    fail("calendarHref must be a same-origin DAV URL/path");
  return result;
};

const basicAuthorization = (username, password) =>
  `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;

const davRequest = async (base, input, path, options = {}) => {
  const response = await globalThis.fetch(new URL(path, base), {
    redirect: "manual",
    ...options,
    headers: {
      Authorization: basicAuthorization(
        text(input.username, "username"),
        text(input.password, "password"),
      ),
      ...options.headers,
    },
  });
  if (response.status === 401) fail("DAV authentication failed");
  if (response.status === 302 || response.status === 301)
    fail("DAV unexpectedly redirected");
  return response;
};

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

const htmlEntities = (value) =>
  value
    .replaceAll("&amp;", "&")
    .replaceAll("&#039;", "'")
    .replaceAll("&quot;", '"');

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

const bootstrap = async (base) => {
  const adminPassword = text(
    process.env.BAIKAL_ADMIN_PASSWORD,
    "BAIKAL_ADMIN_PASSWORD",
  );
  const davPassword = text(
    process.env.BAIKAL_DAV_PASSWORD,
    "BAIKAL_DAV_PASSWORD",
  );
  const username =
    process.env.BAIKAL_DAV_USERNAME ?? `suite-e2e-${randomUUID().slice(0, 8)}`;
  if (!/^[a-z0-9-]{3,64}$/.test(username))
    fail(
      "BAIKAL_DAV_USERNAME must be 3-64 lowercase letters, digits, or hyphens",
    );
  const jar = new CookieJar();
  const installUrl = endpoint(base, "/admin/install/");
  const install = await adminRequest(jar, installUrl);
  jar.add(install);
  const installHtml = await install.text();

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
    fail("Baikal admin login did not establish an authenticated session");
  // Baikal's QuestionMarkRewrite router intentionally encodes routes after
  // the query marker (for example /admin/?/users/new/1/), not as paths.
  const usersUrl = endpoint(base, "/admin/?/users/new/1/");
  const userHtml = await postAdminForm(jar, usersUrl, {
    "data[username]": username,
    "data[displayname]": "Synthetic Suite E2E",
    "data[email]": `${username}@invalid.test`,
    "data[password]": davPassword,
    "data[passwordconfirm]": davPassword,
  });
  if (/Authentication error|validation error/i.test(userHtml))
    fail("Baikal rejected the synthetic DAV user form");

  const usersHtml = await adminPage(jar, endpoint(base, "/admin/?/users/"));
  if (!usersHtml.includes(`>${username}<`))
    fail("Baikal did not persist the synthetic DAV user");

  const calendarHref = `/dav.php/calendars/${username}/default/`;
  const response = await davRequest(
    base,
    { username, password: davPassword },
    calendarHref,
    {
      method: "PROPFIND",
      headers: { Depth: "0", "Content-Type": "application/xml; charset=utf-8" },
      body: `<?xml version="1.0" encoding="utf-8"?><D:propfind xmlns:D="DAV:"><D:prop><D:resourcetype/></D:prop></D:propfind>`,
    },
  );
  if (response.status !== 207)
    fail(`synthetic calendar verification returned HTTP ${response.status}`);
  return { username, calendarHref, endpoint: endpoint(base, "/dav.php/") };
};

const eventHref = (calendar, href) => {
  const result = new URL(text(href, "href"), calendar);
  if (
    result.origin !== calendar.origin ||
    !result.pathname.startsWith(calendar.pathname)
  )
    fail("event href must be inside calendarHref");
  return result;
};

const getEvent = async (base, input) => {
  const calendar = calendarUrl(base, input.calendarHref);
  const href = eventHref(calendar, input.href);
  const response = await davRequest(base, input, href, { method: "GET" });
  if (response.status !== 200)
    fail(`VEVENT GET returned HTTP ${response.status}`);
  const etag = response.headers.get("etag");
  if (etag === null) fail("VEVENT GET did not return an ETag");
  return { href: href.pathname, etag, ics: await response.text() };
};

const putEvent = async (base, input) => {
  const calendar = calendarUrl(base, input.calendarHref);
  const href = eventHref(calendar, input.href);
  const headers = { "Content-Type": "text/calendar; charset=utf-8" };
  if (input.ifMatch !== undefined)
    headers["If-Match"] = text(input.ifMatch, "ifMatch");
  if (input.ifNoneMatch !== undefined)
    headers["If-None-Match"] = text(input.ifNoneMatch, "ifNoneMatch");
  const response = await davRequest(base, input, href, {
    method: "PUT",
    headers,
    body: text(input.ics, "ics"),
  });
  if (response.status !== 201 && response.status !== 204)
    fail(`VEVENT PUT returned HTTP ${response.status}`);
  const etag = response.headers.get("etag");
  if (etag === null) fail("VEVENT PUT did not return an ETag");
  return { href: href.pathname, etag };
};

const deleteEvent = async (base, input) => {
  const calendar = calendarUrl(base, input.calendarHref);
  const href = eventHref(calendar, input.href);
  const headers = {};
  if (input.ifMatch !== undefined)
    headers["If-Match"] = text(input.ifMatch, "ifMatch");
  const response = await davRequest(base, input, href, {
    method: "DELETE",
    headers,
  });
  if (response.status === 404) return { href: href.pathname, deleted: false };
  if (response.status !== 204)
    fail(`VEVENT DELETE returned HTTP ${response.status}`);
  return { href: href.pathname, deleted: true };
};

const listEvents = async (base, input) => {
  const calendar = calendarUrl(base, input.calendarHref);
  const response = await davRequest(base, input, calendar, {
    method: "REPORT",
    headers: { Depth: "1", "Content-Type": "application/xml; charset=utf-8" },
    body: `<?xml version="1.0" encoding="utf-8"?><C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:prop><D:getetag/><C:calendar-data/></D:prop><C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT"/></C:comp-filter></C:filter></C:calendar-query>`,
  });
  if (response.status !== 207)
    fail(`VEVENT REPORT returned HTTP ${response.status}`);
  const xml = await response.text();
  const hrefs = [
    ...xml.matchAll(/<(?:D:|d:)?href>([^<]+\.ics)<\/(?:D:|d:)?href>/g),
  ].map((match) => htmlEntities(match[1] ?? ""));
  return { calendarHref: calendar.pathname, hrefs, count: hrefs.length, xml };
};

const seedEvent = async (base, input) => {
  const uid = `suite-e2e-${randomUUID()}@invalid.test`;
  const href = `${calendarUrl(base, input.calendarHref).pathname}${uid}.ics`;
  const summary =
    typeof input.summary === "string"
      ? input.summary
      : "Synthetic external event";
  const start =
    typeof input.start === "string" ? input.start : "20300102T090000Z";
  const end = typeof input.end === "string" ? input.end : "20300102T100000Z";
  const ics = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Productivity Suite//Disposable Verification//EN\r\nBEGIN:VEVENT\r\nUID:${uid}\r\nDTSTAMP:20300101T000000Z\r\nDTSTART:${start}\r\nDTEND:${end}\r\nSUMMARY:${summary.replace(/[\r\n]/g, " ")}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;
  const stored = await putEvent(base, {
    ...input,
    href,
    ics,
    ifNoneMatch: "*",
  });
  return { ...stored, uid, ics };
};

const main = async () => {
  const base = baseUrl();
  if (command === "bootstrap") return bootstrap(base);
  const input = readInput();
  if (command === "get") return getEvent(base, input);
  if (command === "put") return putEvent(base, input);
  if (command === "delete") return deleteEvent(base, input);
  if (command === "list") return listEvents(base, input);
  if (command === "seed") return seedEvent(base, input);
  fail(usage);
};

main()
  .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
  .catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
