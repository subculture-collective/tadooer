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
import { URL } from "node:url";
import {
  basicAuthorization,
  bootstrapBaikal,
  htmlEntities,
  normalizeBaseUrl,
} from "./baikal-admin.mjs";

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
  return normalizeBaseUrl(rawBaseUrl);
};

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

const bootstrap = async (base) => {
  const username =
    process.env.BAIKAL_DAV_USERNAME ?? `suite-e2e-${randomUUID().slice(0, 8)}`;
  const { calendarHref, endpoint } = await bootstrapBaikal({
    base,
    adminPassword: text(
      process.env.BAIKAL_ADMIN_PASSWORD,
      "BAIKAL_ADMIN_PASSWORD",
    ),
    davPassword: text(process.env.BAIKAL_DAV_PASSWORD, "BAIKAL_DAV_PASSWORD"),
    username,
  });
  return { username, calendarHref, endpoint };
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
