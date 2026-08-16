#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import process from "node:process";
import console from "node:console";

const [mode, baseUrl, statePath] = process.argv.slice(2);
if (!["initial", "restart", "restore"].includes(mode) || !baseUrl || !statePath)
  throw new Error(
    "Usage: phase7-runtime.mjs <initial|restart|restore> <base-url> <state-path>",
  );
const request = (path, init = {}) =>
  globalThis.fetch(`${baseUrl}${path}`, init);
const ownerPassword = process.env.PHASE7_OWNER_PASSWORD;
const davUsername = process.env.BAIKAL_DAV_USERNAME;
const davPassword = process.env.BAIKAL_DAV_PASSWORD;
if (!ownerPassword || !davUsername || !davPassword)
  throw new Error("Phase 7 synthetic credentials are required");

if (mode === "initial") {
  const json = { Origin: baseUrl, "Content-Type": "application/json" };
  if (
    (
      await request("/api/setup", {
        method: "POST",
        headers: json,
        body: JSON.stringify({
          username: "phase7-owner",
          displayName: "Phase 7 Owner",
          password: ownerPassword,
        }),
      })
    ).status !== 201
  )
    throw new Error("Setup failed");
  const login = await request("/api/auth/login", {
    method: "POST",
    headers: json,
    body: JSON.stringify({ username: "phase7-owner", password: ownerPassword }),
  });
  const cookie = login.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
  const session = await login.json();
  const unsafe = { ...json, Cookie: cookie, "X-CSRF-Token": session.csrfToken };
  const connected = await request("/api/connectors/baikal", {
    method: "PUT",
    headers: unsafe,
    body: JSON.stringify({ username: davUsername, password: davPassword }),
  });
  const calendarId = (await connected.json()).calendars?.[0]?.id;
  if (!connected.ok || !calendarId) throw new Error("Baikal connection failed");
  const rawIcs =
    "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:phase7-runtime-recurring\r\nDTSTART:20260807T120000Z\r\nDTEND:20260807T130000Z\r\nSUMMARY:Phase 7 preserved migration\r\nRRULE:FREQ=WEEKLY;COUNT=3\r\nATTENDEE:mailto:fixture@example.test\r\nX-GOOGLE-CONFERENCE:https://fixture.invalid/meeting\r\nBEGIN:VALARM\r\nACTION:DISPLAY\r\nTRIGGER:-PT10M\r\nEND:VALARM\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
  const previewResponse = await request("/api/imports/preview", {
    method: "POST",
    headers: unsafe,
    body: JSON.stringify({ source: "google_ics", calendarId, rawIcs }),
  });
  const preview = await previewResponse.json();
  if (
    previewResponse.status !== 201 ||
    preview.job.report.totals.recurring !== 1 ||
    preview.job.report.totals.unknownProperties !== 1
  )
    throw new Error("Import reconciliation report failed");
  const apply = await request(`/api/imports/${preview.job.id}/apply`, {
    method: "POST",
    headers: unsafe,
  });
  if (!apply.ok || (await apply.json()).job.state !== "applied")
    throw new Error("Import apply failed");
  const exported = await request(`/api/calendars/${calendarId}/export.ics`, {
    headers: { Cookie: cookie },
  });
  const exportedBody = await exported.text();
  if (
    !exported.ok ||
    !exportedBody.includes("RRULE:FREQ=WEEKLY") ||
    !exportedBody.includes("BEGIN:VALARM")
  )
    throw new Error("Authenticated export lost preserved fields");
  const issued = await request("/api/calendar-feeds", {
    method: "POST",
    headers: unsafe,
    body: JSON.stringify({ calendarId, label: "Qualified read-only feed" }),
  });
  const feed = await issued.json();
  if (issued.status !== 201 || !feed.url) throw new Error("Feed issue failed");
  if (
    (await request(feed.url)).status !== 200 ||
    (await request(feed.url, { method: "POST" })).status !== 405
  )
    throw new Error("Feed is not GET-only");
  await writeFile(
    statePath,
    JSON.stringify({
      cookie,
      csrfToken: session.csrfToken,
      calendarId,
      jobId: preview.job.id,
      feedId: feed.capability.id,
      feedUrl: feed.url,
    }),
    "utf8",
  );
  console.log("Phase 7 initial migration and publication verified");
} else {
  const state = JSON.parse(await readFile(statePath, "utf8"));
  const unsafe = {
    Origin: baseUrl,
    Cookie: state.cookie,
    "X-CSRF-Token": state.csrfToken,
    "Content-Type": "application/json",
  };
  const replay = await request(`/api/imports/${state.jobId}/apply`, {
    method: "POST",
    headers: unsafe,
  });
  const replayBody = await replay.json();
  if (
    !replay.ok ||
    replayBody.replayed !== true ||
    replayBody.job.items.filter(
      ({ state: itemState }) => itemState === "applied",
    ).length !== 1
  )
    throw new Error(`${mode} import replay failed`);
  if ((await request(state.feedUrl)).status !== 200)
    throw new Error(`${mode} feed unavailable`);
  const exported = await request(
    `/api/calendars/${state.calendarId}/export.ics`,
    { headers: { Cookie: state.cookie } },
  );
  if (
    !exported.ok ||
    !(await exported.text()).includes("phase7-runtime-recurring")
  )
    throw new Error(`${mode} export unavailable`);
  if (mode === "restore") {
    if (
      (
        await request(`/api/calendar-feeds/${state.feedId}`, {
          method: "DELETE",
          headers: unsafe,
        })
      ).status !== 204
    )
      throw new Error("Feed revocation failed");
    if ((await request(state.feedUrl)).status !== 404)
      throw new Error("Revoked feed remained available");
  }
  console.log(`Phase 7 ${mode} replay and publication verified`);
}
