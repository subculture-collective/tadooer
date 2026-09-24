import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  apiErrorSchema,
  baikalStatusResponseSchema,
  buildResponseSchema,
  conditionalTaskMutationResponseSchema,
  healthResponseSchema,
  readinessResponseSchema,
  plannerResponseSchema,
  sessionResponseSchema,
  setupStatusResponseSchema,
  taskListResponseSchema,
  taskMutationResponseSchema,
  taskTimeBlockMutationResponseSchema,
} from "@suite/contracts";
import { withTemporaryDirectory } from "@suite/test-support";
import type { ServerConfig } from "./config.ts";
import { startSuiteServer } from "./server.ts";

const davMultiStatus = (body: string): string =>
  `<?xml version="1.0"?><D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">${body}</D:multistatus>`;

const phaseOneCalDav = () => {
  const resources = new Map<string, { rawIcs: string; etag: string }>([
    [
      "/dav.php/calendars/alice/work/existing.ics",
      {
        etag: '"seed-1"',
        rawIcs:
          "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:seed-event\r\nDTSTART:20260806T120000Z\r\nDTEND:20260806T130000Z\r\nSUMMARY:Existing appointment\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n",
      },
    ],
    [
      "/dav.php/calendars/alice/work/all-day.ics",
      {
        etag: '"all-day-1"',
        rawIcs:
          "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:all-day-event\r\nDTSTART;VALUE=DATE:20260806\r\nDTEND;VALUE=DATE:20260807\r\nSUMMARY:All-day planning\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n",
      },
    ],
    [
      "/dav.php/calendars/alice/work/provider-only-same-title.ics",
      {
        etag: '"provider-only-1"',
        rawIcs:
          "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:provider-only-same-title\r\nDTSTART:20260806T090000Z\r\nDTEND:20260806T093000Z\r\nSUMMARY:Plan focused work\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n",
      },
    ],
  ]);
  let version = 1;
  let failNextPutAfterCommit = false;
  const requests: { method: string; path: string }[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    await Promise.resolve();
    const url =
      input instanceof URL
        ? input
        : new URL(typeof input === "string" ? input : input.url);
    const method = init?.method ?? "GET";
    requests.push({ method, path: url.pathname });
    if (method === "PROPFIND" && url.pathname === "/dav.php/") {
      return new Response(
        davMultiStatus(
          `<D:response><D:href>/dav.php/</D:href><D:propstat><D:prop><D:current-user-principal><D:href>/dav.php/principals/alice/</D:href></D:current-user-principal></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`,
        ),
        { status: 207, headers: { "content-type": "application/xml" } },
      );
    }
    if (
      method === "PROPFIND" &&
      url.pathname === "/dav.php/principals/alice/"
    ) {
      return new Response(
        davMultiStatus(
          `<D:response><D:href>/dav.php/principals/alice/</D:href><D:propstat><D:prop><C:calendar-home-set><D:href>/dav.php/calendars/alice/</D:href></C:calendar-home-set></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`,
        ),
        { status: 207, headers: { "content-type": "application/xml" } },
      );
    }
    if (method === "PROPFIND" && url.pathname === "/dav.php/calendars/alice/") {
      return new Response(
        davMultiStatus(
          `<D:response><D:href>/dav.php/calendars/alice/work/</D:href><D:propstat><D:prop><D:resourcetype><D:collection/><C:calendar/></D:resourcetype><D:displayname>Work</D:displayname><C:supported-calendar-component-set><C:comp name="VEVENT"/></C:supported-calendar-component-set></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`,
        ),
        { status: 207, headers: { "content-type": "application/xml" } },
      );
    }
    if (
      method === "REPORT" &&
      url.pathname === "/dav.php/calendars/alice/work/"
    ) {
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
            headers: {
              etag: resource.etag,
              "content-type": "text/calendar",
            },
          });
    }
    if (method === "PUT") {
      const headers = new Headers(init?.headers);
      const existing = resources.get(url.pathname);
      if (headers.get("if-none-match") === "*" && existing !== undefined)
        return new Response("", { status: 412 });
      if (headers.has("if-match") && headers.get("if-match") !== existing?.etag)
        return new Response("", { status: 412 });
      const rawIcs = typeof init?.body === "string" ? init.body : "";
      version += 1;
      resources.set(url.pathname, { rawIcs, etag: `"v${String(version)}"` });
      if (failNextPutAfterCommit) {
        failNextPutAfterCommit = false;
        throw new Error("synthetic response loss after commit");
      }
      return new Response(null, { status: 204 });
    }
    if (method === "DELETE") {
      const headers = new Headers(init?.headers);
      const existing = resources.get(url.pathname);
      if (existing === undefined) return new Response("", { status: 404 });
      if (headers.get("if-match") !== existing.etag)
        return new Response("", { status: 412 });
      resources.delete(url.pathname);
      return new Response(null, { status: 204 });
    }
    return new Response("", { status: 404 });
  };
  return {
    fetcher,
    resources,
    requests,
    failNextPutAfterCommit: () => {
      failNextPutAfterCommit = true;
    },
  };
};

describe("Suite HTTP server", () => {
  it("serves valid health, readiness, build, and web responses", async () => {
    await withTemporaryDirectory(async (directory) => {
      const webRoot = join(directory, "web");
      await mkdir(webRoot);
      await writeFile(join(webRoot, "index.html"), "<h1>Suite shell</h1>");

      const config: ServerConfig = {
        host: "127.0.0.1",
        port: 0,
        databasePath: join(directory, "suite.sqlite"),
        webRoot,
        baikalEndpoint: "http://baikal.test/dav.php/",
        credentialKeyPath: join(directory, "credential.key"),
        secureCookies: false,
        build: {
          version: "0.0.0-test",
          revision: "test-revision",
          builtAt: "2026-08-05T00:00:00.000Z",
        },
      };
      const server = await startSuiteServer(config);

      try {
        const health = await fetch(`${server.baseUrl}/api/health`);
        expect(health.status).toBe(200);
        healthResponseSchema.parse(await health.json());

        const ready = await fetch(`${server.baseUrl}/api/ready`);
        expect(ready.status).toBe(200);
        const readiness = readinessResponseSchema.parse(await ready.json());
        expect(readiness.checks).toEqual({
          database: "ok",
          migrations: "current",
        });
        expect(readiness.migrationCount).toBe(21);

        const build = await fetch(`${server.baseUrl}/api/build`);
        expect(build.status).toBe(200);
        buildResponseSchema.parse(await build.json());

        const shell = await fetch(server.baseUrl);
        const shellHtml = await shell.text();
        expect(shellHtml).toContain("Suite shell");
        const nonce = /name="style-nonce" content="([^"]+)"/.exec(
          shellHtml,
        )?.[1];
        expect(nonce).toBeTruthy();
        if (nonce === undefined) throw new Error("Missing style nonce");
        expect(shell.headers.get("content-security-policy")).toContain(
          `style-src 'self' 'nonce-${nonce}'`,
        );
        expect(shell.headers.get("content-security-policy")).not.toContain(
          "unsafe-inline",
        );
        expect(shell.headers.get("cache-control")).toBe("no-store");
        const secondShell = await fetch(`${server.baseUrl}/planner`);
        expect(secondShell.headers.get("content-security-policy")).not.toBe(
          shell.headers.get("content-security-policy"),
        );
        expect(await secondShell.text()).toContain("Suite shell");

        const missingApi = await fetch(`${server.baseUrl}/api/nope`);
        expect(missingApi.status).toBe(404);
      } finally {
        await server.close();
      }
    });
  });

  it("enforces first-run, origin, cookie, CSRF, and logout boundaries", async () => {
    await withTemporaryDirectory(async (directory) => {
      const webRoot = join(directory, "web");
      await mkdir(webRoot);
      await writeFile(join(webRoot, "index.html"), "<h1>Suite shell</h1>");
      const config: ServerConfig = {
        host: "127.0.0.1",
        port: 0,
        databasePath: join(directory, "suite.sqlite"),
        webRoot,
        baikalEndpoint: "http://baikal.test/dav.php/",
        credentialKeyPath: join(directory, "credential.key"),
        secureCookies: false,
        build: { version: "test", revision: "test", builtAt: null },
      };
      const server = await startSuiteServer(config);
      const jsonHeaders = { "Content-Type": "application/json" };

      try {
        const initial = await fetch(`${server.baseUrl}/api/setup/status`);
        expect(setupStatusResponseSchema.parse(await initial.json())).toEqual({
          setupRequired: true,
        });

        const crossOriginSetup = await fetch(`${server.baseUrl}/api/setup`, {
          method: "POST",
          headers: jsonHeaders,
          body: JSON.stringify({
            username: "owner",
            displayName: "Owner",
            password: "correct horse battery staple",
          }),
        });
        expect(crossOriginSetup.status).toBe(403);

        const setup = await fetch(`${server.baseUrl}/api/setup`, {
          method: "POST",
          headers: { ...jsonHeaders, Origin: server.baseUrl },
          body: JSON.stringify({
            username: "owner",
            displayName: "Owner",
            password: "correct horse battery staple",
          }),
        });
        expect(setup.status).toBe(201);

        const duplicate = await fetch(`${server.baseUrl}/api/setup`, {
          method: "POST",
          headers: { ...jsonHeaders, Origin: server.baseUrl },
          body: JSON.stringify({
            username: "other",
            displayName: "Other",
            password: "another correct horse password",
          }),
        });
        expect(duplicate.status).toBe(409);

        const unauthenticatedTasks = await fetch(`${server.baseUrl}/api/tasks`);
        expect(unauthenticatedTasks.status).toBe(401);

        const login = await fetch(`${server.baseUrl}/api/auth/login`, {
          method: "POST",
          headers: { ...jsonHeaders, Origin: server.baseUrl },
          body: JSON.stringify({
            username: "owner",
            password: "correct horse battery staple",
          }),
        });
        expect(login.status).toBe(200);
        const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
        expect(cookie).toMatch(/^suite_session=/);
        const loggedIn = sessionResponseSchema.parse(await login.json());

        const resumedResponse = await fetch(
          `${server.baseUrl}/api/auth/session`,
          {
            headers: { Cookie: cookie ?? "" },
          },
        );
        expect(resumedResponse.status).toBe(200);
        const resumed = sessionResponseSchema.parse(
          await resumedResponse.json(),
        );
        expect(resumed.owner).toEqual(loggedIn.owner);
        expect(resumed.csrfToken).not.toBe(loggedIn.csrfToken);

        const connector = await fetch(
          `${server.baseUrl}/api/connectors/baikal`,
          {
            headers: { Cookie: cookie ?? "" },
          },
        );
        expect(connector.status).toBe(200);
        expect(await connector.json()).toMatchObject({
          connected: false,
          calendars: [],
        });

        const rejectedTaskRequests = [
          {
            headers: {
              ...jsonHeaders,
              Origin: server.baseUrl,
              "X-CSRF-Token": resumed.csrfToken,
              "Idempotency-Key": "capture-request-no-session",
            },
            expectedCode: "AUTH_REQUIRED",
          },
          {
            headers: {
              ...jsonHeaders,
              Cookie: cookie ?? "",
              "X-CSRF-Token": resumed.csrfToken,
              "Idempotency-Key": "capture-request-cross-origin",
            },
            expectedCode: "ORIGIN_REQUIRED",
          },
          {
            headers: {
              ...jsonHeaders,
              Cookie: cookie ?? "",
              Origin: server.baseUrl,
              "Idempotency-Key": "capture-request-no-csrf",
            },
            expectedCode: "CSRF_INVALID",
          },
          {
            headers: {
              ...jsonHeaders,
              Cookie: cookie ?? "",
              Origin: server.baseUrl,
              "X-CSRF-Token": "B".repeat(43),
              "Idempotency-Key": "capture-request-stale-csrf",
            },
            expectedCode: "CSRF_INVALID",
          },
          {
            headers: {
              ...jsonHeaders,
              Cookie: cookie ?? "",
              Origin: server.baseUrl,
              "X-CSRF-Token": resumed.csrfToken,
            },
            expectedCode: "IDEMPOTENCY_KEY_REQUIRED",
          },
          {
            headers: {
              ...jsonHeaders,
              Cookie: cookie ?? "",
              Origin: server.baseUrl,
              "X-CSRF-Token": resumed.csrfToken,
              "Idempotency-Key": "bad key",
            },
            expectedCode: "IDEMPOTENCY_KEY_REQUIRED",
          },
        ];
        for (const rejected of rejectedTaskRequests) {
          const response = await fetch(`${server.baseUrl}/api/tasks`, {
            method: "POST",
            headers: rejected.headers,
            body: JSON.stringify({ title: "Must not be created" }),
          });
          expect([400, 401, 403]).toContain(response.status);
          expect(await response.json()).toMatchObject({
            code: rejected.expectedCode,
          });
        }

        const taskHeaders = {
          ...jsonHeaders,
          Cookie: cookie ?? "",
          Origin: server.baseUrl,
          "X-CSRF-Token": resumed.csrfToken,
          "Idempotency-Key": "capture-request-0001",
        };
        const taskBody = JSON.stringify({
          title: "Capture the first task",
          notes: "Prove the Phase 0 contract",
        });
        const createdTask = await fetch(`${server.baseUrl}/api/tasks`, {
          method: "POST",
          headers: taskHeaders,
          body: taskBody,
        });
        expect(createdTask.status).toBe(201);
        expect(createdTask.headers.get("etag")).toBe('"1"');
        const created = taskMutationResponseSchema.parse(
          await createdTask.json(),
        );
        expect(created.replayed).toBe(false);

        const replayedTask = await fetch(`${server.baseUrl}/api/tasks`, {
          method: "POST",
          headers: taskHeaders,
          body: taskBody,
        });
        expect(replayedTask.status).toBe(200);
        const replayed = taskMutationResponseSchema.parse(
          await replayedTask.json(),
        );
        expect(replayed).toEqual({ ...created, replayed: true });

        const idempotencyConflict = await fetch(`${server.baseUrl}/api/tasks`, {
          method: "POST",
          headers: taskHeaders,
          body: JSON.stringify({ title: "A different task" }),
        });
        expect(idempotencyConflict.status).toBe(409);
        expect(await idempotencyConflict.json()).toMatchObject({
          code: "IDEMPOTENCY_CONFLICT",
        });

        const maximumNotes = "n".repeat(20_000);
        const taskAtContractLimit = await fetch(`${server.baseUrl}/api/tasks`, {
          method: "POST",
          headers: {
            ...taskHeaders,
            "Idempotency-Key": "capture-request-maximum-notes",
          },
          body: JSON.stringify({
            title: "Task at the notes boundary",
            notes: maximumNotes,
          }),
        });
        expect(taskAtContractLimit.status).toBe(201);
        expect(
          taskMutationResponseSchema.parse(await taskAtContractLimit.json())
            .task.notes,
        ).toHaveLength(20_000);

        const tasks = await fetch(`${server.baseUrl}/api/tasks`, {
          headers: { Cookie: cookie ?? "" },
        });
        const listedTasks = taskListResponseSchema.parse(
          await tasks.json(),
        ).tasks;
        expect(listedTasks).toHaveLength(2);
        expect(listedTasks).toContainEqual(created.task);

        const missingPrecondition = await fetch(
          `${server.baseUrl}/api/tasks/${created.task.id}`,
          {
            method: "PATCH",
            headers: {
              ...jsonHeaders,
              Cookie: cookie ?? "",
              Origin: server.baseUrl,
              "X-CSRF-Token": resumed.csrfToken,
            },
            body: JSON.stringify({ title: "Rename" }),
          },
        );
        expect(missingPrecondition.status).toBe(428);

        const mutateTask = (
          path: string,
          revision: number,
          method: "PATCH" | "POST" | "DELETE",
          body: unknown = {},
        ): Promise<Response> =>
          fetch(`${server.baseUrl}${path}`, {
            method,
            headers: {
              ...jsonHeaders,
              Cookie: cookie ?? "",
              Origin: server.baseUrl,
              "X-CSRF-Token": resumed.csrfToken,
              "If-Match": `"${String(revision)}"`,
            },
            body: JSON.stringify(body),
          });
        const renamed = await mutateTask(
          `/api/tasks/${created.task.id}`,
          1,
          "PATCH",
          { title: "Renamed task", estimateMinutes: 30 },
        );
        expect(renamed.status).toBe(200);
        expect(await renamed.json()).toMatchObject({
          task: { title: "Renamed task", revision: 2, estimateMinutes: 30 },
        });
        const staleRename = await mutateTask(
          `/api/tasks/${created.task.id}`,
          1,
          "PATCH",
          { title: "Stale rename" },
        );
        expect(staleRename.status).toBe(412);
        const completedTask = await mutateTask(
          `/api/tasks/${created.task.id}/complete`,
          2,
          "POST",
        );
        expect(await completedTask.json()).toMatchObject({
          task: { status: "completed", revision: 3 },
        });
        const reopenedTask = await mutateTask(
          `/api/tasks/${created.task.id}/reopen`,
          3,
          "POST",
        );
        expect(await reopenedTask.json()).toMatchObject({
          task: { status: "open", revision: 4 },
        });
        const deletedTask = await mutateTask(
          `/api/tasks/${created.task.id}`,
          4,
          "DELETE",
        );
        const deleted = conditionalTaskMutationResponseSchema.parse(
          await deletedTask.json(),
        );
        expect(deleted.task.revision).toBe(5);
        expect(deleted.task.deletedAt).toEqual(expect.any(String));
        const recovery = await fetch(`${server.baseUrl}/api/tasks/recovery`, {
          headers: { Cookie: cookie ?? "" },
        });
        expect(await recovery.json()).toMatchObject({
          tasks: [{ id: created.task.id, revision: 5 }],
        });
        const restoredTask = await mutateTask(
          `/api/tasks/${created.task.id}/restore`,
          5,
          "POST",
        );
        expect(await restoredTask.json()).toMatchObject({
          task: { id: created.task.id, revision: 6, deletedAt: null },
        });

        const unavailablePlanner = await fetch(
          `${server.baseUrl}/api/planner?from=2026-08-06T00%3A00%3A00.000Z&to=2026-08-07T00%3A00%3A00.000Z`,
          { headers: { Cookie: cookie ?? "" } },
        );
        expect(unavailablePlanner.status).toBe(200);
        expect(await unavailablePlanner.json()).toMatchObject({
          events: [],
          freshness: { state: "unavailable" },
        });

        const staleCsrf = await fetch(`${server.baseUrl}/api/auth/logout`, {
          method: "POST",
          headers: {
            Cookie: cookie ?? "",
            Origin: server.baseUrl,
            "X-CSRF-Token": loggedIn.csrfToken,
          },
        });
        expect(staleCsrf.status).toBe(403);
        apiErrorSchema.parse(await staleCsrf.json());

        const logout = await fetch(`${server.baseUrl}/api/auth/logout`, {
          method: "POST",
          headers: {
            Cookie: cookie ?? "",
            Origin: server.baseUrl,
            "X-CSRF-Token": resumed.csrfToken,
          },
        });
        expect(logout.status).toBe(200);

        const revoked = await fetch(`${server.baseUrl}/api/auth/session`, {
          headers: { Cookie: cookie ?? "" },
        });
        expect(revoked.status).toBe(401);
      } finally {
        await server.close();
      }
    });
  });

  it("projects an existing event, plans one block, and preserves an external ETag conflict", async () => {
    await withTemporaryDirectory(async (directory) => {
      const webRoot = join(directory, "web");
      await mkdir(webRoot);
      await writeFile(join(webRoot, "index.html"), "<h1>Suite shell</h1>");
      const caldav = phaseOneCalDav();
      const server = await startSuiteServer(
        {
          host: "127.0.0.1",
          port: 0,
          databasePath: join(directory, "suite.sqlite"),
          webRoot,
          baikalEndpoint: "http://baikal.test/dav.php/",
          credentialKeyPath: join(directory, "credential.key"),
          secureCookies: false,
          build: { version: "test", revision: "test", builtAt: null },
        },
        { connectorFetch: caldav.fetcher },
      );
      const jsonHeaders = {
        "Content-Type": "application/json",
        Origin: server.baseUrl,
      };
      try {
        await fetch(`${server.baseUrl}/api/setup`, {
          method: "POST",
          headers: jsonHeaders,
          body: JSON.stringify({
            username: "planner",
            displayName: "Planner",
            password: "correct horse battery staple",
          }),
        });
        const login = await fetch(`${server.baseUrl}/api/auth/login`, {
          method: "POST",
          headers: jsonHeaders,
          body: JSON.stringify({
            username: "planner",
            password: "correct horse battery staple",
          }),
        });
        const cookie = login.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
        const session = sessionResponseSchema.parse(await login.json());
        const unsafeHeaders = {
          ...jsonHeaders,
          Cookie: cookie,
          "X-CSRF-Token": session.csrfToken,
        };
        const connectedResponse = await fetch(
          `${server.baseUrl}/api/connectors/baikal`,
          {
            method: "PUT",
            headers: unsafeHeaders,
            body: JSON.stringify({ username: "alice", password: "secret" }),
          },
        );
        const connected = baikalStatusResponseSchema.parse(
          await connectedResponse.json(),
        );
        const calendarId = connected.calendars[0]?.id ?? "";
        expect(calendarId).toMatch(/^[0-9a-f-]{36}$/);

        const taskResponse = await fetch(`${server.baseUrl}/api/tasks`, {
          method: "POST",
          headers: {
            ...unsafeHeaders,
            "Idempotency-Key": "phase1-task-create",
          },
          body: JSON.stringify({ title: "Plan focused work" }),
        });
        const created = taskMutationResponseSchema.parse(
          await taskResponse.json(),
        );

        const plannerResponse = await fetch(
          `${server.baseUrl}/api/planner?from=2026-08-06T00%3A00%3A00.000Z&to=2026-08-07T00%3A00%3A00.000Z`,
          { headers: { Cookie: cookie } },
        );
        const planner = plannerResponseSchema.parse(
          await plannerResponse.json(),
        );
        expect(planner.freshness.state).toBe("fresh");
        expect(planner.events).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ summary: "Existing appointment" }),
            expect.objectContaining({
              summary: "All-day planning",
              startsAt: "2026-08-06T00:00:00.000Z",
              endsAt: "2026-08-07T00:00:00.000Z",
              allDay: true,
            }),
          ]),
        );

        const blockResponse = await fetch(
          `${server.baseUrl}/api/tasks/${created.task.id}/time-block`,
          {
            method: "POST",
            headers: {
              ...unsafeHeaders,
              "If-Match": '"1"',
              "Idempotency-Key": "phase1-block-create",
            },
            body: JSON.stringify({
              calendarId,
              startsAt: "2026-08-06T14:00:00.000Z",
              durationMinutes: 45,
            }),
          },
        );
        const blockBody: unknown = await blockResponse.json();
        expect({ status: blockResponse.status, body: blockBody }).toMatchObject(
          {
            status: 201,
          },
        );
        let block = taskTimeBlockMutationResponseSchema.parse(blockBody);
        expect(block.task).toMatchObject({
          plannedStart: "2026-08-06T14:00:00.000Z",
          estimateMinutes: 45,
          revision: 2,
        });
        expect(
          [...caldav.resources.keys()].filter((href) =>
            href.endsWith(block.mapping.href.split("/").at(-1) ?? ""),
          ),
        ).toHaveLength(1);

        const linkedPlannerResponse = await fetch(
          `${server.baseUrl}/api/planner?from=2026-08-06T00%3A00%3A00.000Z&to=2026-08-07T00%3A00%3A00.000Z`,
          { headers: { Cookie: cookie } },
        );
        expect(linkedPlannerResponse.status).toBe(200);
        const linkedPlanner = plannerResponseSchema.parse(
          await linkedPlannerResponse.json(),
        );
        expect(
          linkedPlanner.events.find(
            (event) => event.href === block.mapping.href,
          ),
        ).toMatchObject({ linkedTaskId: created.task.id });
        expect(
          linkedPlanner.events.find(
            (event) =>
              event.href ===
              "/dav.php/calendars/alice/work/provider-only-same-title.ics",
          ),
        ).not.toHaveProperty("linkedTaskId");

        const replayResponse = await fetch(
          `${server.baseUrl}/api/tasks/${created.task.id}/time-block`,
          {
            method: "POST",
            headers: {
              ...unsafeHeaders,
              "If-Match": '"1"',
              "Idempotency-Key": "phase1-block-create",
            },
            body: JSON.stringify({
              calendarId,
              startsAt: "2026-08-06T14:00:00.000Z",
              durationMinutes: 45,
            }),
          },
        );
        expect(replayResponse.status).toBe(200);
        expect(await replayResponse.json()).toMatchObject({
          replayed: true,
          mapping: { href: block.mapping.href },
        });

        const moveResponse = await fetch(
          `${server.baseUrl}/api/tasks/${created.task.id}/time-block`,
          {
            method: "POST",
            headers: {
              ...unsafeHeaders,
              "If-Match": '"2"',
              "Idempotency-Key": "phase1-block-move",
            },
            body: JSON.stringify({
              calendarId,
              startsAt: "2026-08-06T14:30:00.000Z",
              durationMinutes: 45,
            }),
          },
        );
        expect(moveResponse.status).toBe(201);
        block = taskTimeBlockMutationResponseSchema.parse(
          await moveResponse.json(),
        );
        expect(block.task).toMatchObject({
          plannedStart: "2026-08-06T14:30:00.000Z",
          revision: 3,
        });

        const externallyChanged = caldav.resources.get(block.mapping.href);
        if (externallyChanged === undefined)
          throw new Error("Suite event was not written to CalDAV");
        caldav.resources.set(block.mapping.href, {
          rawIcs: externallyChanged.rawIcs.replace(
            "SUMMARY:Plan focused work",
            "SUMMARY:External edit",
          ),
          etag: '"external-v3"',
        });
        const conflict = await fetch(
          `${server.baseUrl}/api/tasks/${created.task.id}/time-block`,
          {
            method: "POST",
            headers: {
              ...unsafeHeaders,
              "If-Match": '"3"',
              "Idempotency-Key": "phase1-block-reschedule",
            },
            body: JSON.stringify({
              calendarId,
              startsAt: "2026-08-06T15:00:00.000Z",
              durationMinutes: 45,
            }),
          },
        );
        expect(conflict.status).toBe(409);
        expect(await conflict.json()).toMatchObject({
          code: "CALENDAR_EVENT_CONFLICT",
          action: "refresh_and_replan",
        });
        expect(caldav.resources.get(block.mapping.href)?.rawIcs).toContain(
          "SUMMARY:External edit",
        );
        const conflictedPlannerResponse = await fetch(
          `${server.baseUrl}/api/planner?from=2026-08-06T00%3A00%3A00.000Z&to=2026-08-07T00%3A00%3A00.000Z`,
          { headers: { Cookie: cookie } },
        );
        expect(conflictedPlannerResponse.status).toBe(200);
        expect(
          plannerResponseSchema
            .parse(await conflictedPlannerResponse.json())
            .events.find((event) => event.href === block.mapping.href),
        ).not.toHaveProperty("linkedTaskId");

        const removableTaskResponse = await fetch(
          `${server.baseUrl}/api/tasks`,
          {
            method: "POST",
            headers: {
              ...unsafeHeaders,
              "Idempotency-Key": "phase1-removable-task",
            },
            body: JSON.stringify({ title: "Remove my block" }),
          },
        );
        const removableTask = taskMutationResponseSchema.parse(
          await removableTaskResponse.json(),
        );
        const removableBlockResponse = await fetch(
          `${server.baseUrl}/api/tasks/${removableTask.task.id}/time-block`,
          {
            method: "POST",
            headers: {
              ...unsafeHeaders,
              "If-Match": '"1"',
              "Idempotency-Key": "phase1-removable-block",
            },
            body: JSON.stringify({
              calendarId,
              startsAt: "2026-08-06T16:00:00.000Z",
              durationMinutes: 30,
            }),
          },
        );
        const removableBlock = taskTimeBlockMutationResponseSchema.parse(
          await removableBlockResponse.json(),
        );
        const blockedDelete = await fetch(
          `${server.baseUrl}/api/tasks/${removableTask.task.id}`,
          {
            method: "DELETE",
            headers: { ...unsafeHeaders, "If-Match": '"2"' },
            body: "{}",
          },
        );
        expect(blockedDelete.status).toBe(409);
        expect(await blockedDelete.json()).toMatchObject({
          code: "TIME_BLOCK_REMOVE_REQUIRED",
        });
        const removeBlock = await fetch(
          `${server.baseUrl}/api/tasks/${removableTask.task.id}/time-block`,
          {
            method: "DELETE",
            headers: { ...unsafeHeaders, "If-Match": '"2"' },
            body: "{}",
          },
        );
        expect(removeBlock.status).toBe(200);
        expect(
          conditionalTaskMutationResponseSchema.parse(await removeBlock.json()),
        ).toMatchObject({
          task: { plannedStart: null, estimateMinutes: null, revision: 3 },
        });
        expect(caldav.resources.has(removableBlock.mapping.href)).toBe(false);
        expect(
          caldav.requests.filter(
            (request) =>
              request.method === "DELETE" &&
              request.path === removableBlock.mapping.href,
          ),
        ).toHaveLength(1);
        const putsAfterRemoval = caldav.requests.filter(
          (request) => request.method === "PUT",
        ).length;
        const releasedReplay = await fetch(
          `${server.baseUrl}/api/tasks/${removableTask.task.id}/time-block`,
          {
            method: "POST",
            headers: {
              ...unsafeHeaders,
              "If-Match": '"1"',
              "Idempotency-Key": "phase1-removable-block",
            },
            body: JSON.stringify({
              calendarId,
              startsAt: "2026-08-06T16:00:00.000Z",
              durationMinutes: 30,
            }),
          },
        );
        expect(releasedReplay.status).toBe(409);
        expect(await releasedReplay.json()).toMatchObject({
          code: "TIME_BLOCK_RELEASED",
        });
        expect(
          caldav.requests.filter((request) => request.method === "PUT"),
        ).toHaveLength(putsAfterRemoval);

        const uncertainTaskResponse = await fetch(
          `${server.baseUrl}/api/tasks`,
          {
            method: "POST",
            headers: {
              ...unsafeHeaders,
              "Idempotency-Key": "phase1-uncertain-task",
            },
            body: JSON.stringify({ title: "Reconcile uncertain block" }),
          },
        );
        const uncertainTask = taskMutationResponseSchema.parse(
          await uncertainTaskResponse.json(),
        );
        caldav.failNextPutAfterCommit();
        const uncertainInput = JSON.stringify({
          calendarId,
          startsAt: "2026-08-06T17:00:00.000Z",
          durationMinutes: 30,
        });
        const uncertainUrl = `${server.baseUrl}/api/tasks/${uncertainTask.task.id}/time-block`;
        const uncertainHeaders = {
          ...unsafeHeaders,
          "If-Match": '"1"',
          "Idempotency-Key": "phase1-uncertain-block",
        };
        const uncertain = await fetch(uncertainUrl, {
          method: "POST",
          headers: uncertainHeaders,
          body: uncertainInput,
        });
        expect(uncertain.status).toBe(502);
        const putCount = caldav.requests.filter(
          (request) => request.method === "PUT",
        ).length;
        const reconciled = await fetch(uncertainUrl, {
          method: "POST",
          headers: uncertainHeaders,
          body: uncertainInput,
        });
        expect(reconciled.status).toBe(201);
        expect(await reconciled.json()).toMatchObject({
          replayed: true,
          task: { revision: 2 },
        });
        expect(
          caldav.requests.filter((request) => request.method === "PUT"),
        ).toHaveLength(putCount);
      } finally {
        await server.close();
      }
    });
  });
});
