import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  apiErrorSchema,
  automationConfirmationResponseSchema,
  automationPreviewResponseSchema,
  createAutomationTokenResponseSchema,
  taskMutationResponseSchema,
  taskTimeBlockMutationResponseSchema,
} from "@suite/contracts";
import { withTemporaryDirectory } from "@suite/test-support";
import { SuiteDatabase } from "@suite/persistence";
import type { ServerConfig } from "./config.ts";
import { startSuiteServer, type RunningSuiteServer } from "./server.ts";

// Issue #58 / ADR 0037: move and remove an existing task time block through
// the assistant. The fake Baikal honours If-Match on PUT and DELETE so remote
// edits, lost responses and restart reconciliation can be exercised offline.

const davMultiStatus = (body: string): string =>
  `<?xml version="1.0"?><D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">${body}</D:multistatus>`;

const conditionalCalDav = () => {
  const resources = new Map<string, { rawIcs: string; etag: string }>();
  const requests: { method: string; path: string }[] = [];
  let version = 1;
  let loseNextPut = false;
  let loseNextDelete = false;
  const fetcher: typeof fetch = async (input, init) => {
    await Promise.resolve();
    const url =
      input instanceof URL
        ? input
        : new URL(typeof input === "string" ? input : input.url);
    const method = init?.method ?? "GET";
    requests.push({ method, path: url.pathname });
    if (method === "PROPFIND" && url.pathname === "/dav.php/")
      return new Response(
        davMultiStatus(
          `<D:response><D:href>/dav.php/</D:href><D:propstat><D:prop><D:current-user-principal><D:href>/dav.php/principals/alice/</D:href></D:current-user-principal></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`,
        ),
        { status: 207, headers: { "content-type": "application/xml" } },
      );
    if (method === "PROPFIND" && url.pathname === "/dav.php/principals/alice/")
      return new Response(
        davMultiStatus(
          `<D:response><D:href>/dav.php/principals/alice/</D:href><D:propstat><D:prop><C:calendar-home-set><D:href>/dav.php/calendars/alice/</D:href></C:calendar-home-set></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`,
        ),
        { status: 207, headers: { "content-type": "application/xml" } },
      );
    if (method === "PROPFIND" && url.pathname === "/dav.php/calendars/alice/")
      return new Response(
        davMultiStatus(
          `<D:response><D:href>/dav.php/calendars/alice/work/</D:href><D:propstat><D:prop><D:resourcetype><D:collection/><C:calendar/></D:resourcetype><D:displayname>Work</D:displayname><C:supported-calendar-component-set><C:comp name="VEVENT"/></C:supported-calendar-component-set></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`,
        ),
        { status: 207, headers: { "content-type": "application/xml" } },
      );
    if (method === "REPORT") {
      const body = [...resources.entries()]
        .map(
          ([href, resource]) =>
            `<D:response><D:href>${href}</D:href><D:propstat><D:prop><D:getetag>${resource.etag}</D:getetag></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`,
        )
        .join("");
      return new Response(davMultiStatus(body), {
        status: 207,
        headers: { "content-type": "application/xml" },
      });
    }
    if (method === "GET") {
      const resource = resources.get(url.pathname);
      return resource === undefined
        ? new Response("", { status: 404 })
        : new Response(resource.rawIcs, {
            status: 200,
            headers: { etag: resource.etag, "content-type": "text/calendar" },
          });
    }
    const headers = new Headers(init?.headers);
    const existing = resources.get(url.pathname);
    if (method === "PUT") {
      if (headers.get("if-none-match") === "*" && existing !== undefined)
        return new Response("", { status: 412 });
      if (headers.has("if-match") && headers.get("if-match") !== existing?.etag)
        return new Response("", { status: 412 });
      version += 1;
      resources.set(url.pathname, {
        rawIcs: typeof init?.body === "string" ? init.body : "",
        etag: `"v${String(version)}"`,
      });
      if (loseNextPut) {
        loseNextPut = false;
        throw new Error("synthetic response loss after commit");
      }
      return new Response(null, { status: 204 });
    }
    if (method === "DELETE") {
      if (existing === undefined) return new Response("", { status: 404 });
      if (headers.get("if-match") !== existing.etag)
        return new Response("", { status: 412 });
      resources.delete(url.pathname);
      if (loseNextDelete) {
        loseNextDelete = false;
        throw new Error("synthetic response loss after delete");
      }
      return new Response(null, { status: 204 });
    }
    return new Response("", { status: 404 });
  };
  return {
    fetcher,
    resources,
    requests,
    loseNextPut: () => {
      loseNextPut = true;
    },
    loseNextDelete: () => {
      loseNextDelete = true;
    },
    /** Simulates an edit in another client: the ETag no longer matches. */
    editRemotely: (href: string) => {
      const resource = resources.get(href);
      if (resource === undefined) throw new Error(`No resource at ${href}`);
      resources.set(href, { ...resource, etag: '"external-edit"' });
    },
  };
};

const configuration = (directory: string): ServerConfig => ({
  host: "127.0.0.1",
  port: 0,
  databasePath: join(directory, "suite.sqlite"),
  webRoot: join(directory, "web"),
  baikalEndpoint: "http://baikal.test/dav.php/",
  credentialKeyPath: join(directory, "credential.key"),
  secureCookies: false,
  build: { version: "test", revision: "test", builtAt: null },
});

const browserRequest = (
  server: RunningSuiteServer,
  cookie: string,
  csrfToken: string,
  path: string,
  method: "POST" | "PUT" | "PATCH" | "DELETE",
  body?: unknown,
  headers: Readonly<Record<string, string>> = {},
): Promise<Response> =>
  fetch(`${server.baseUrl}${path}`, {
    method,
    headers: {
      Origin: server.baseUrl,
      Cookie: cookie,
      "X-CSRF-Token": csrfToken,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const automationRequest = (
  server: RunningSuiteServer,
  token: string,
  path: string,
  method: "GET" | "POST",
  body?: unknown,
): Promise<Response> =>
  fetch(`${server.baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

/** Signs in, connects the fake Baikal and issues a token with `scopes`. */
const bootstrap = async (
  server: RunningSuiteServer,
  scopes: readonly string[],
) => {
  const setup = await fetch(`${server.baseUrl}/api/setup`, {
    method: "POST",
    headers: { Origin: server.baseUrl, "Content-Type": "application/json" },
    body: JSON.stringify({
      username: "owner",
      displayName: "Owner",
      password: "correct horse battery staple",
    }),
  });
  expect(setup.status).toBe(201);
  const login = await fetch(`${server.baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { Origin: server.baseUrl, "Content-Type": "application/json" },
    body: JSON.stringify({
      username: "owner",
      password: "correct horse battery staple",
    }),
  });
  expect(login.status).toBe(200);
  const cookie = login.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
  const { csrfToken } = (await login.json()) as { csrfToken: string };
  const connected = await browserRequest(
    server,
    cookie,
    csrfToken,
    "/api/connectors/baikal",
    "PUT",
    { username: "alice", password: "calendar password" },
  );
  expect(connected.status).toBe(200);
  const calendarId = (
    (await connected.json()) as { calendars: { id: string }[] }
  ).calendars[0]?.id;
  if (calendarId === undefined) throw new Error("Calendar was not discovered");
  const issued = await browserRequest(
    server,
    cookie,
    csrfToken,
    "/api/automation/tokens",
    "POST",
    {
      label: "Time blocks",
      scopes,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    },
  );
  expect(issued.status).toBe(201);
  const credential = createAutomationTokenResponseSchema.parse(
    await issued.json(),
  );
  const created = await browserRequest(
    server,
    cookie,
    csrfToken,
    "/api/tasks",
    "POST",
    { title: "Write the release notes" },
    { "Idempotency-Key": "time-block-task" },
  );
  expect(created.status).toBe(201);
  const task = taskMutationResponseSchema.parse(await created.json()).task;
  return {
    cookie,
    csrfToken,
    calendarId,
    token: credential.token,
    ownerId: credential.record.ownerId,
    task,
  };
};

const preview = async (
  server: RunningSuiteServer,
  token: string,
  command: unknown,
) => {
  const response = await automationRequest(
    server,
    token,
    "/api/automation/v1/previews",
    "POST",
    command,
  );
  return { status: response.status, body: (await response.json()) as unknown };
};

const confirm = async (
  server: RunningSuiteServer,
  token: string,
  previewId: string,
  idempotencyKey: string,
) => {
  const response = await automationRequest(
    server,
    token,
    `/api/automation/v1/previews/${previewId}/confirm`,
    "POST",
    { idempotencyKey },
  );
  return { status: response.status, body: (await response.json()) as unknown };
};

const previewed = (body: unknown) =>
  automationPreviewResponseSchema.parse(body).preview;

const scopes = ["tasks:read", "tasks:write", "schedule:read", "schedule:write"];

describe("assistant time-block move and remove (ADR 0037)", () => {
  it("moves a block with the task revision, reports remote edits and reconciles a lost write across restart", async () => {
    await withTemporaryDirectory(async (directory) => {
      await mkdir(join(directory, "web"));
      await writeFile(join(directory, "web", "index.html"), "<h1>Suite</h1>");
      const config = configuration(directory);
      const caldav = conditionalCalDav();
      let server = await startSuiteServer(config, {
        connectorFetch: caldav.fetcher,
      });
      try {
        const { calendarId, token, ownerId, task } = await bootstrap(
          server,
          scopes,
        );

        const createPreview = await preview(server, token, {
          operation: "schedule.create_time_block",
          input: {
            taskId: task.id,
            calendarId,
            startsAt: "2026-08-08T15:00:00.000Z",
            durationMinutes: 30,
          },
        });
        expect(createPreview.status).toBe(201);
        expect(previewed(createPreview.body).summary).toBe(
          'Schedule task "Write the release notes" on calendar "Work" at 2026-08-08T15:00:00Z to 2026-08-08T15:30:00Z (30 min)',
        );
        const created = await confirm(
          server,
          token,
          previewed(createPreview.body).id,
          "create-001",
        );
        expect(created.status).toBe(200);
        const block = taskTimeBlockMutationResponseSchema.parse(
          automationConfirmationResponseSchema.parse(created.body).result,
        );
        expect(block.task.revision).toBe(2);
        expect(caldav.resources.size).toBe(1);

        // A stale task revision is refused before anything is frozen.
        const stale = await preview(server, token, {
          operation: "schedule.move_time_block",
          input: {
            taskId: task.id,
            expectedRevision: 1,
            startsAt: "2026-08-08T16:00:00.000Z",
            durationMinutes: 45,
          },
        });
        expect(stale.status).toBe(412);
        expect(apiErrorSchema.parse(stale.body).code).toBe(
          "TASK_REVISION_CONFLICT",
        );

        // The calendar is fixed for the life of the block, as in the browser.
        const otherCalendar = await preview(server, token, {
          operation: "schedule.move_time_block",
          input: {
            taskId: task.id,
            expectedRevision: 2,
            calendarId: randomUUID(),
            startsAt: "2026-08-08T16:00:00.000Z",
            durationMinutes: 45,
          },
        });
        expect(otherCalendar.status).toBe(409);
        expect(apiErrorSchema.parse(otherCalendar.body).code).toBe(
          "TIME_BLOCK_CALENDAR_FIXED",
        );

        const movePreview = await preview(server, token, {
          operation: "schedule.move_time_block",
          input: {
            taskId: task.id,
            expectedRevision: 2,
            calendarId,
            startsAt: "2026-08-08T16:00:00.000Z",
            durationMinutes: 45,
          },
        });
        expect(movePreview.status).toBe(201);
        expect(previewed(movePreview.body)).toMatchObject({
          operation: "schedule.move_time_block",
          summary:
            'Move the time block for task "Write the release notes" on calendar "Work" from 2026-08-08T15:00:00Z to 2026-08-08T15:30:00Z (30 min) to 2026-08-08T16:00:00Z to 2026-08-08T16:45:00Z (45 min)',
          baseRevisions: [
            { entityKind: "task", entityId: task.id, revision: 2 },
          ],
        });
        const moved = await confirm(
          server,
          token,
          previewed(movePreview.body).id,
          "move-001",
        );
        expect(moved.status).toBe(200);
        const movedBlock = taskTimeBlockMutationResponseSchema.parse(
          automationConfirmationResponseSchema.parse(moved.body).result,
        );
        expect(movedBlock).toMatchObject({
          replayed: false,
          task: {
            revision: 3,
            plannedStart: "2026-08-08T16:00:00.000Z",
            estimateMinutes: 45,
          },
          mapping: { href: block.mapping.href, uid: block.mapping.uid },
        });
        expect(movedBlock.mapping.etag).not.toBe(block.mapping.etag);
        expect(caldav.resources.size).toBe(1);
        expect(caldav.resources.get(block.mapping.href)?.rawIcs).toContain(
          "DTSTART:20260808T160000Z",
        );

        // Someone edited the event elsewhere: the conditional PUT fails and
        // the assistant is told to refresh, with the mapping to refresh.
        caldav.editRemotely(block.mapping.href);
        const conflictedPreview = await preview(server, token, {
          operation: "schedule.move_time_block",
          input: {
            taskId: task.id,
            expectedRevision: 3,
            startsAt: "2026-08-08T17:00:00.000Z",
            durationMinutes: 45,
          },
        });
        expect(conflictedPreview.status).toBe(201);
        const conflicted = await confirm(
          server,
          token,
          previewed(conflictedPreview.body).id,
          "move-002",
        );
        expect(conflicted.status).toBe(409);
        expect(conflicted.body).toMatchObject({
          code: "CALENDAR_EVENT_CONFLICT",
          action: "refresh_and_replan",
          mappingId: block.mapping.id,
        });
        expect(caldav.resources.get(block.mapping.href)?.rawIcs).toContain(
          "DTSTART:20260808T160000Z",
        );

        // A lost response after the provider stored the event: the first
        // attempt reports uncertainty, and the same key after a restart
        // reconciles from the calendar without a second event.
        const resource = caldav.resources.get(block.mapping.href);
        if (resource === undefined) throw new Error("Block resource missing");
        caldav.resources.set(block.mapping.href, {
          ...resource,
          etag: movedBlock.mapping.etag,
        });
        const lostPreview = await preview(server, token, {
          operation: "schedule.move_time_block",
          input: {
            taskId: task.id,
            expectedRevision: 3,
            startsAt: "2026-08-08T18:00:00.000Z",
            durationMinutes: 20,
          },
        });
        expect(lostPreview.status).toBe(201);
        caldav.loseNextPut();
        const lost = await confirm(
          server,
          token,
          previewed(lostPreview.body).id,
          "move-003",
        );
        expect(lost.status).toBe(409);
        expect(apiErrorSchema.parse(lost.body).code).toBe(
          "CALENDAR_WRITE_RECONCILIATION_REQUIRED",
        );
        await server.close();
        server = await startSuiteServer(config, {
          connectorFetch: caldav.fetcher,
        });
        const reconciled = await confirm(
          server,
          token,
          previewed(lostPreview.body).id,
          "move-003",
        );
        expect(reconciled.status).toBe(200);
        expect(
          automationConfirmationResponseSchema.parse(reconciled.body),
        ).toMatchObject({
          operation: "schedule.move_time_block",
          result: {
            replayed: true,
            task: {
              revision: 4,
              plannedStart: "2026-08-08T18:00:00.000Z",
              estimateMinutes: 20,
            },
            mapping: { href: block.mapping.href },
          },
        });
        expect(caldav.resources.size).toBe(1);
        // Replaying the receipt never calls the provider again.
        const providerCalls = caldav.requests.length;
        const replayed = await confirm(
          server,
          token,
          previewed(lostPreview.body).id,
          "move-003",
        );
        expect(replayed.status).toBe(200);
        expect(replayed.body).toMatchObject({ replayed: true });
        expect(caldav.requests.length).toBe(providerCalls);

        await server.close();
        const persisted = SuiteDatabase.open(config.databasePath);
        try {
          const audit = persisted
            .listAutomationAudit(ownerId)
            .filter(({ operation }) => operation === "schedule.move_time_block")
            .map(({ phase, outcome, errorCode }) => ({
              phase,
              outcome,
              errorCode,
            }));
          expect(audit).toEqual([
            { phase: "preview", outcome: "succeeded", errorCode: null },
            { phase: "execute", outcome: "succeeded", errorCode: null },
            { phase: "preview", outcome: "succeeded", errorCode: null },
            {
              phase: "execute",
              outcome: "failed",
              errorCode: "CALENDAR_EVENT_CONFLICT",
            },
            { phase: "preview", outcome: "succeeded", errorCode: null },
            {
              phase: "execute",
              outcome: "failed",
              errorCode: "CALENDAR_WRITE_RECONCILIATION_REQUIRED",
            },
            { phase: "execute", outcome: "succeeded", errorCode: null },
            { phase: "confirm", outcome: "replayed", errorCode: null },
          ]);
        } finally {
          persisted.close();
        }
      } finally {
        await server.close().catch(() => undefined);
      }
    });
  });

  it("removes a block only with schedule:write, a fresh task revision and a confirmed provider delete", async () => {
    await withTemporaryDirectory(async (directory) => {
      await mkdir(join(directory, "web"));
      await writeFile(join(directory, "web", "index.html"), "<h1>Suite</h1>");
      const config = configuration(directory);
      const caldav = conditionalCalDav();
      let server = await startSuiteServer(config, {
        connectorFetch: caldav.fetcher,
      });
      try {
        const { cookie, csrfToken, calendarId, token, ownerId, task } =
          await bootstrap(server, scopes);
        const readOnly = await browserRequest(
          server,
          cookie,
          csrfToken,
          "/api/automation/tokens",
          "POST",
          {
            label: "Read only",
            scopes: ["tasks:read", "schedule:read"],
            expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          },
        );
        const readOnlyToken = createAutomationTokenResponseSchema.parse(
          await readOnly.json(),
        ).token;

        // No block yet.
        const missing = await preview(server, token, {
          operation: "schedule.remove_time_block",
          input: { taskId: task.id, expectedRevision: 1 },
        });
        expect(missing.status).toBe(404);
        expect(apiErrorSchema.parse(missing.body).code).toBe(
          "TIME_BLOCK_NOT_FOUND",
        );

        const blocked = await browserRequest(
          server,
          cookie,
          csrfToken,
          `/api/tasks/${task.id}/time-block`,
          "POST",
          {
            calendarId,
            startsAt: "2026-08-09T09:00:00.000Z",
            durationMinutes: 60,
          },
          { "If-Match": '"1"', "Idempotency-Key": "browser-block" },
        );
        expect(blocked.status).toBe(201);
        const block = taskTimeBlockMutationResponseSchema.parse(
          await blocked.json(),
        );
        expect(block.task.revision).toBe(2);

        const denied = await preview(server, readOnlyToken, {
          operation: "schedule.remove_time_block",
          input: { taskId: task.id, expectedRevision: 2 },
        });
        expect(denied.status).toBe(403);
        expect(apiErrorSchema.parse(denied.body).code).toBe(
          "AUTOMATION_SCOPE_DENIED",
        );

        const stale = await preview(server, token, {
          operation: "schedule.remove_time_block",
          input: { taskId: task.id, expectedRevision: 1 },
        });
        expect(stale.status).toBe(412);
        expect(apiErrorSchema.parse(stale.body).code).toBe(
          "TASK_REVISION_CONFLICT",
        );

        const removePreview = await preview(server, token, {
          operation: "schedule.remove_time_block",
          input: { taskId: task.id, expectedRevision: 2 },
        });
        expect(removePreview.status).toBe(201);
        expect(previewed(removePreview.body)).toMatchObject({
          summary:
            'Remove the time block for task "Write the release notes" at 2026-08-09T09:00:00Z to 2026-08-09T10:00:00Z (60 min) from calendar "Work"; the task keeps its title and notes but loses its planned start and estimate',
          affected: [
            { entityKind: "task", entityId: task.id },
            { entityKind: "calendar", entityId: calendarId },
          ],
          baseRevisions: [
            { entityKind: "task", entityId: task.id, revision: 2 },
          ],
        });
        const removeId = previewed(removePreview.body).id;

        // Remote edit: the conditional DELETE fails and nothing is released.
        caldav.editRemotely(block.mapping.href);
        const conflicted = await confirm(server, token, removeId, "remove-001");
        expect(conflicted.status).toBe(409);
        expect(conflicted.body).toMatchObject({
          code: "CALENDAR_EVENT_CONFLICT",
          action: "refresh_and_replan",
          mappingId: block.mapping.id,
        });
        expect(caldav.resources.size).toBe(1);

        // Lost response after the provider deleted the event: uncertain, then
        // the retry sees 404 and releases the block with the receipt.
        const resource = caldav.resources.get(block.mapping.href);
        if (resource === undefined) throw new Error("Block resource missing");
        caldav.resources.set(block.mapping.href, {
          ...resource,
          etag: block.mapping.etag,
        });
        caldav.loseNextDelete();
        const uncertain = await confirm(server, token, removeId, "remove-001");
        expect(uncertain.status).toBe(502);
        expect(apiErrorSchema.parse(uncertain.body).code).toBe(
          "CALENDAR_DELETE_UNCERTAIN",
        );
        expect(caldav.resources.size).toBe(0);
        await server.close();
        server = await startSuiteServer(config, {
          connectorFetch: caldav.fetcher,
        });
        const removed = await confirm(server, token, removeId, "remove-001");
        expect(removed.status).toBe(200);
        expect(
          automationConfirmationResponseSchema.parse(removed.body),
        ).toMatchObject({
          operation: "schedule.remove_time_block",
          replayed: false,
          result: {
            replayed: false,
            task: { revision: 3, plannedStart: null, estimateMinutes: null },
          },
        });
        const providerCalls = caldav.requests.length;
        const replayed = await confirm(server, token, removeId, "remove-001");
        expect(replayed.status).toBe(200);
        expect(replayed.body).toMatchObject({
          replayed: true,
          result: { task: { revision: 3 } },
        });
        expect(caldav.requests.length).toBe(providerCalls);

        // A browser edit between preview and confirmation makes it stale.
        const reblocked = await browserRequest(
          server,
          cookie,
          csrfToken,
          `/api/tasks/${task.id}/time-block`,
          "POST",
          {
            calendarId,
            startsAt: "2026-08-10T09:00:00.000Z",
            durationMinutes: 30,
          },
          { "If-Match": '"3"', "Idempotency-Key": "browser-block-2" },
        );
        expect(reblocked.status).toBe(201);
        const stalePreview = await preview(server, token, {
          operation: "schedule.remove_time_block",
          input: { taskId: task.id, expectedRevision: 4 },
        });
        expect(stalePreview.status).toBe(201);
        const renamed = await browserRequest(
          server,
          cookie,
          csrfToken,
          `/api/tasks/${task.id}`,
          "PATCH",
          { title: "Write and send the release notes" },
          { "If-Match": '"4"' },
        );
        expect(renamed.status).toBe(200);
        const staleConfirm = await confirm(
          server,
          token,
          previewed(stalePreview.body).id,
          "remove-002",
        );
        expect(staleConfirm.status).toBe(412);
        expect(apiErrorSchema.parse(staleConfirm.body).code).toBe(
          "AUTOMATION_PREVIEW_STALE",
        );
        expect(caldav.resources.size).toBe(1);

        await server.close();
        const persisted = SuiteDatabase.open(config.databasePath);
        try {
          expect(
            persisted.getTaskCalendarBlock(ownerId, task.id),
          ).toMatchObject({ state: "active" });
          const audit = persisted
            .listAutomationAudit(ownerId)
            .filter(
              ({ operation }) => operation === "schedule.remove_time_block",
            )
            .map(({ phase, outcome, errorCode }) => ({
              phase,
              outcome,
              errorCode,
            }));
          expect(audit).toEqual([
            {
              phase: "preview",
              outcome: "denied",
              errorCode: "AUTOMATION_SCOPE_DENIED",
            },
            { phase: "preview", outcome: "succeeded", errorCode: null },
            {
              phase: "execute",
              outcome: "failed",
              errorCode: "CALENDAR_EVENT_CONFLICT",
            },
            {
              phase: "execute",
              outcome: "failed",
              errorCode: "CALENDAR_DELETE_UNCERTAIN",
            },
            { phase: "execute", outcome: "succeeded", errorCode: null },
            { phase: "confirm", outcome: "replayed", errorCode: null },
            { phase: "preview", outcome: "succeeded", errorCode: null },
            {
              phase: "confirm",
              outcome: "denied",
              errorCode: "AUTOMATION_PREVIEW_STALE",
            },
          ]);
        } finally {
          persisted.close();
        }
      } finally {
        await server.close().catch(() => undefined);
      }
    });
  });
});
