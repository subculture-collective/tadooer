import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  apiErrorSchema,
  automationTokenScopeSchema,
  automationConfirmationResponseSchema,
  automationPreviewResponseSchema,
  automationTaskResourceSchema,
  createAutomationTokenResponseSchema,
  taskListResponseSchema,
  taskMutationResponseSchema,
} from "@suite/contracts";
import { withTemporaryDirectory } from "@suite/test-support";
import { SuiteDatabase } from "@suite/persistence";
import type { ServerConfig } from "./config.ts";
import { startSuiteServer, type RunningSuiteServer } from "./server.ts";

const davMultiStatus = (body: string): string =>
  `<?xml version="1.0"?><D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">${body}</D:multistatus>`;

const automationCalDav = () => {
  const resources = new Map<string, { rawIcs: string; etag: string }>();
  let failNextPutAfterCommit = false;
  const fetcher: typeof fetch = async (input, init) => {
    await Promise.resolve();
    const url =
      input instanceof URL
        ? input
        : new URL(typeof input === "string" ? input : input.url);
    const method = init?.method ?? "GET";
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
    if (method === "PUT") {
      resources.set(url.pathname, {
        rawIcs: typeof init?.body === "string" ? init.body : "",
        etag: '"automation-1"',
      });
      if (failNextPutAfterCommit) {
        failNextPutAfterCommit = false;
        throw new Error("synthetic response loss after commit");
      }
      return new Response(null, { status: 204 });
    }
    return new Response("", { status: 404 });
  };
  return {
    fetcher,
    resources,
    failNextPut: () => {
      failNextPutAfterCommit = true;
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
  method: "POST" | "PUT" | "DELETE",
  body?: unknown,
): Promise<Response> =>
  fetch(`${server.baseUrl}${path}`, {
    method,
    headers: {
      Origin: server.baseUrl,
      Cookie: cookie,
      "X-CSRF-Token": csrfToken,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
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

describe("Phase 4 automation HTTP integration", () => {
  it("requires scoped confirmation, preserves exact replay across restart, and revokes automation without disrupting the owner session", async () => {
    await withTemporaryDirectory(async (directory) => {
      await mkdir(join(directory, "web"));
      await writeFile(join(directory, "web", "index.html"), "<h1>Suite</h1>");
      const config = configuration(directory);
      const caldav = automationCalDav();
      let server = await startSuiteServer(config, {
        connectorFetch: caldav.fetcher,
      });
      try {
        const setup = await fetch(`${server.baseUrl}/api/setup`, {
          method: "POST",
          headers: {
            Origin: server.baseUrl,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            username: "owner",
            displayName: "Owner",
            password: "correct horse battery staple",
          }),
        });
        expect(setup.status).toBe(201);
        const login = await fetch(`${server.baseUrl}/api/auth/login`, {
          method: "POST",
          headers: {
            Origin: server.baseUrl,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            username: "owner",
            password: "correct horse battery staple",
          }),
        });
        expect(login.status).toBe(200);
        const cookie = login.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
        const session = (await login.json()) as { csrfToken: string };

        const connected = await browserRequest(
          server,
          cookie,
          session.csrfToken,
          "/api/connectors/baikal",
          "PUT",
          { username: "alice", password: "calendar password" },
        );
        expect(connected.status).toBe(200);
        const calendarId = (
          (await connected.json()) as { calendars: { id: string }[] }
        ).calendars[0]?.id;
        expect(calendarId).toBeTypeOf("string");

        const issued = await browserRequest(
          server,
          cookie,
          session.csrfToken,
          "/api/automation/tokens",
          "POST",
          {
            label: "Phase 4 integration",
            scopes: [
              "tasks:read",
              "tasks:write",
              "schedule:read",
              "schedule:write",
              "focus:read",
              "focus:write",
              "habits:read",
              "habits:write",
            ],
            expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          },
        );
        expect(issued.status).toBe(201);
        const credential = createAutomationTokenResponseSchema.parse(
          await issued.json(),
        );

        const scopedRead = await automationRequest(
          server,
          credential.token,
          "/api/automation/v1/resources/tasks",
          "GET",
        );
        expect(scopedRead.status).toBe(200);
        expect(
          automationTaskResourceSchema.parse(await scopedRead.json()).tasks,
        ).toEqual([]);

        const habitId = randomUUID();
        const habitPreview = async (input: unknown) => {
          const response = await automationRequest(
            server,
            credential.token,
            "/api/automation/v1/previews",
            "POST",
            { operation: "habits.mutate", input },
          );
          expect(response.status).toBe(201);
          return automationPreviewResponseSchema.parse(await response.json())
            .preview;
        };
        const confirmHabit = (id: string, key: string) =>
          automationRequest(
            server,
            credential.token,
            `/api/automation/v1/previews/${id}/confirm`,
            "POST",
            { idempotencyKey: key },
          );
        const hp = await habitPreview({
          kind: "habit.create",
          habit: {
            id: habitId,
            title: "Walk daily",
            cadence: { kind: "daily" },
            startedOn: "2026-01-01",
            timeZone: "UTC",
          },
        });
        const beforeHabits = await automationRequest(
          server,
          credential.token,
          "/api/automation/v1/resources/habits",
          "GET",
        );
        expect(await beforeHabits.json()).toEqual({
          habits: [],
          occurrences: [],
        });
        expect((await confirmHabit(hp.id, "habit-create-001")).status).toBe(
          200,
        );
        const completion = await habitPreview({
          kind: "habit.complete",
          habitId,
          baseRevision: 1,
          periodKey: "2026-01-01",
        });
        expect(completion.baseRevisions).toEqual([
          { entityKind: "habit", entityId: habitId, revision: 1 },
        ]);
        const completed = automationConfirmationResponseSchema.parse(
          await (
            await confirmHabit(completion.id, "habit-complete-001")
          ).json(),
        );
        const habitReplay = automationConfirmationResponseSchema.parse(
          await (
            await confirmHabit(completion.id, "habit-complete-001")
          ).json(),
        );
        expect(habitReplay).toEqual({ ...completed, replayed: true });
        const duplicate = await habitPreview({
          kind: "habit.complete",
          habitId,
          baseRevision: 1,
          periodKey: "2026-01-01",
        });
        const duplicateResult = automationConfirmationResponseSchema.parse(
          await (await confirmHabit(duplicate.id, "habit-complete-002")).json(),
        );
        expect(duplicateResult.result).toEqual(completed.result);
        const stale = await habitPreview({
          kind: "habit.archive",
          habitId,
          baseRevision: 1,
        });
        const rename = await habitPreview({
          kind: "habit.patch",
          habitId,
          baseRevision: 1,
          fields: { title: "Walk outside" },
        });
        expect((await confirmHabit(rename.id, "habit-rename-001")).status).toBe(
          200,
        );
        expect(
          (await confirmHabit(stale.id, "habit-archive-stale")).status,
        ).toBe(412);

        const previewInput = {
          operation: "tasks.create",
          input: {
            title: "Created by confirmed automation !December 31, 2027",
            notes: "",
            structured: true,
          },
        };
        const previewResponse = await automationRequest(
          server,
          credential.token,
          "/api/automation/v1/previews",
          "POST",
          previewInput,
        );
        expect(previewResponse.status).toBe(201);
        const preview = automationPreviewResponseSchema.parse(
          await previewResponse.json(),
        ).preview;
        expect(preview.operation).toBe("tasks.create");

        const beforeConfirmation = await automationRequest(
          server,
          credential.token,
          "/api/automation/v1/resources/tasks",
          "GET",
        );
        expect(
          automationTaskResourceSchema.parse(await beforeConfirmation.json())
            .tasks,
        ).toEqual([]);

        const operationKey = "phase4-confirm-task-001";
        const confirmed = await automationRequest(
          server,
          credential.token,
          `/api/automation/v1/previews/${preview.id}/confirm`,
          "POST",
          { idempotencyKey: operationKey },
        );
        expect(confirmed.status).toBe(200);
        const firstResult = automationConfirmationResponseSchema.parse(
          await confirmed.json(),
        );
        expect(firstResult).toMatchObject({
          previewId: preview.id,
          operation: "tasks.create",
          replayed: false,
          result: {
            replayed: false,
            task: {
              title: "Created by confirmed automation",
              deadline: { kind: "date", value: "2027-12-31" },
            },
          },
        });
        if (!("task" in firstResult.result)) {
          throw new Error("Task confirmation did not return a task result");
        }
        const firstTask = firstResult.result.task;

        const secondPreviewResponse = await automationRequest(
          server,
          credential.token,
          "/api/automation/v1/previews",
          "POST",
          {
            operation: "tasks.create",
            input: { title: "Must not be created", notes: "" },
          },
        );
        expect(secondPreviewResponse.status).toBe(201);
        const secondPreview = automationPreviewResponseSchema.parse(
          await secondPreviewResponse.json(),
        ).preview;
        const alteredPreview = await automationRequest(
          server,
          credential.token,
          `/api/automation/v1/previews/${secondPreview.id}/confirm`,
          "POST",
          { idempotencyKey: operationKey },
        );
        expect(alteredPreview.status).toBe(409);
        expect(apiErrorSchema.parse(await alteredPreview.json())).toMatchObject(
          {
            code: "IDEMPOTENCY_CONFLICT",
          },
        );

        await server.close();
        server = await startSuiteServer(config, {
          connectorFetch: caldav.fetcher,
        });
        const replay = await automationRequest(
          server,
          credential.token,
          `/api/automation/v1/previews/${preview.id}/confirm`,
          "POST",
          { idempotencyKey: operationKey },
        );
        expect(replay.status).toBe(200);
        expect(
          automationConfirmationResponseSchema.parse(await replay.json()),
        ).toMatchObject({
          previewId: preview.id,
          replayed: true,
          result: {
            task: { id: firstTask.id },
          },
        });

        const exactlyOnce = await automationRequest(
          server,
          credential.token,
          "/api/automation/v1/resources/tasks",
          "GET",
        );
        expect(
          automationTaskResourceSchema.parse(await exactlyOnce.json()).tasks,
        ).toEqual([
          expect.objectContaining({
            id: firstTask.id,
            title: "Created by confirmed automation",
          }),
        ]);

        if (calendarId === undefined)
          throw new Error("Calendar was not discovered");
        const schedulePreviewResponse = await automationRequest(
          server,
          credential.token,
          "/api/automation/v1/previews",
          "POST",
          {
            operation: "schedule.create_time_block",
            input: {
              taskId: firstTask.id,
              calendarId,
              startsAt: "2026-08-08T15:00:00.000Z",
              durationMinutes: 30,
            },
          },
        );
        expect(schedulePreviewResponse.status).toBe(201);
        const schedulePreview = automationPreviewResponseSchema.parse(
          await schedulePreviewResponse.json(),
        ).preview;
        caldav.failNextPut();
        const uncertainSchedule = await automationRequest(
          server,
          credential.token,
          `/api/automation/v1/previews/${schedulePreview.id}/confirm`,
          "POST",
          { idempotencyKey: "phase4-schedule-001" },
        );
        expect(uncertainSchedule.status).toBe(409);
        expect(caldav.resources.size).toBe(1);
        await server.close();
        server = await startSuiteServer(config, {
          connectorFetch: caldav.fetcher,
        });
        const reconciledSchedule = await automationRequest(
          server,
          credential.token,
          `/api/automation/v1/previews/${schedulePreview.id}/confirm`,
          "POST",
          { idempotencyKey: "phase4-schedule-001" },
        );
        expect(reconciledSchedule.status).toBe(200);
        const reconciledBody: unknown = await reconciledSchedule.json();
        expect(reconciledBody).toMatchObject({
          operation: "schedule.create_time_block",
          result: { mapping: { taskId: firstTask.id }, replayed: true },
        });
        automationConfirmationResponseSchema.parse(reconciledBody);
        expect(caldav.resources.size).toBe(1);

        const focusPreviewResponse = await automationRequest(
          server,
          credential.token,
          "/api/automation/v1/previews",
          "POST",
          {
            operation: "focus.start",
            input: { operation: "focus.start", taskId: firstTask.id },
          },
        );
        expect(focusPreviewResponse.status).toBe(201);
        const focusPreview = automationPreviewResponseSchema.parse(
          await focusPreviewResponse.json(),
        ).preview;
        const focusConfirmed = await automationRequest(
          server,
          credential.token,
          `/api/automation/v1/previews/${focusPreview.id}/confirm`,
          "POST",
          { idempotencyKey: "phase4-focus-start-001" },
        );
        expect(focusConfirmed.status).toBe(200);
        expect(
          automationConfirmationResponseSchema.parse(
            await focusConfirmed.json(),
          ),
        ).toMatchObject({
          operation: "focus.start",
          result: { session: { taskId: firstTask.id, state: "running" } },
        });
        const revoked = await browserRequest(
          server,
          cookie,
          session.csrfToken,
          `/api/automation/tokens/${credential.record.id}`,
          "DELETE",
        );
        expect(revoked.status).toBe(204);
        await server.close();
        const persisted = SuiteDatabase.open(config.databasePath);
        expect(
          persisted.getActiveSession(credential.record.ownerId),
        ).toMatchObject({
          state: "expired",
          controllerClientId: null,
        });
        persisted.close();
        server = await startSuiteServer(config, {
          connectorFetch: caldav.fetcher,
        });
        const denied = await automationRequest(
          server,
          credential.token,
          "/api/automation/v1/resources/tasks",
          "GET",
        );
        expect(denied.status).toBe(401);
        expect(apiErrorSchema.parse(await denied.json())).toMatchObject({
          code: "AUTOMATION_TOKEN_INVALID",
        });

        const interactiveCreate = await browserRequest(
          server,
          cookie,
          session.csrfToken,
          "/api/tasks",
          "POST",
          { title: "Browser remains signed in", notes: "" },
        );
        expect(interactiveCreate.status).toBe(400);
        expect(
          apiErrorSchema.parse(await interactiveCreate.json()),
        ).toMatchObject({
          code: "IDEMPOTENCY_KEY_REQUIRED",
        });
        const browserMutation = await fetch(`${server.baseUrl}/api/tasks`, {
          method: "POST",
          headers: {
            Origin: server.baseUrl,
            Cookie: cookie,
            "X-CSRF-Token": session.csrfToken,
            "Idempotency-Key": "phase4-browser-task-001",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            title: "Browser remains signed in",
            notes: "",
          }),
        });
        expect(browserMutation.status).toBe(201);
        taskMutationResponseSchema.parse(await browserMutation.json());
        const browserTasks = await fetch(`${server.baseUrl}/api/tasks`, {
          headers: { Cookie: cookie },
        });
        expect(browserTasks.status).toBe(200);
        expect(
          taskListResponseSchema.parse(await browserTasks.json()).tasks,
        ).toHaveLength(2);
      } finally {
        await server.close();
      }
    });
  });
});

describe("Assistant task changes", () => {
  it("previews edits and completion, rejects stale revisions, and replays exactly after restart", async () => {
    await withTemporaryDirectory(async (directory) => {
      await mkdir(join(directory, "web"));
      const config = configuration(directory);
      let server = await startSuiteServer(config);
      try {
        const owner = {
          username: "editor",
          displayName: "Editor",
          password: "a disposable sufficiently long password",
        };
        await fetch(`${server.baseUrl}/api/setup`, {
          method: "POST",
          headers: {
            Origin: server.baseUrl,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(owner),
        });
        const login = await fetch(`${server.baseUrl}/api/auth/login`, {
          method: "POST",
          headers: {
            Origin: server.baseUrl,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(owner),
        });
        const cookie = login.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
        const { csrfToken } = (await login.json()) as { csrfToken: string };
        const issue = async (scopes: string[]) => {
          const response = await browserRequest(
            server,
            cookie,
            csrfToken,
            "/api/automation/tokens",
            "POST",
            {
              label: "Task editor",
              scopes,
              expiresAt: new Date(Date.now() + 3600000).toISOString(),
            },
          );
          expect(response.status).toBe(201);
          return createAutomationTokenResponseSchema.parse(
            await response.json(),
          ).token;
        };
        const token = await issue([...automationTokenScopeSchema.options]);
        const readOnly = await issue(["tasks:read"]);
        const request = (path: string, body: unknown, credential = token) =>
          automationRequest(server, credential, path, "POST", body);
        const preview = async (operation: string, input: unknown) => {
          const response = await request("/api/automation/v1/previews", {
            operation,
            input,
          });
          expect(response.status).toBe(201);
          return automationPreviewResponseSchema.parse(await response.json())
            .preview;
        };
        const confirm = (id: string, key = randomUUID()) =>
          request(`/api/automation/v1/previews/${id}/confirm`, {
            idempotencyKey: key,
          });
        const createdPreview = await preview("tasks.create", {
          title: "Before",
          notes: "Keep notes",
        });
        const created = automationConfirmationResponseSchema.parse(
          await (await confirm(createdPreview.id)).json(),
        );
        if (!("task" in created.result)) throw new Error("Expected a task");
        const original = created.result.task;
        const editInput = {
          taskId: original.id,
          expectedRevision: original.revision,
          patch: {
            title: "After",
            deadline: { kind: "date", value: "2026-10-01" },
            plannedStart: "2026-09-22T14:00:00.000Z",
            estimateMinutes: 45,
          },
        };
        expect(
          (
            await request(
              "/api/automation/v1/previews",
              { operation: "tasks.update", input: editInput },
              readOnly,
            )
          ).status,
        ).toBe(403);
        const edit = await preview("tasks.update", editInput);
        const stale = await preview("tasks.set_completed", {
          taskId: original.id,
          expectedRevision: original.revision,
          completed: true,
        });
        const before = automationTaskResourceSchema.parse(
          await (
            await automationRequest(
              server,
              token,
              "/api/automation/v1/resources/tasks",
              "GET",
            )
          ).json(),
        );
        expect(before.tasks[0]?.title).toBe("Before");
        const fault = new DatabaseSync(config.databasePath);
        fault.exec(`CREATE TRIGGER fail_assistant_receipt BEFORE INSERT ON automation_audit_log
          WHEN NEW.phase='execute' AND NEW.operation='tasks.update'
          BEGIN SELECT RAISE(ABORT, 'synthetic receipt failure'); END;`);
        expect((await confirm(edit.id)).status).toBe(500);
        const afterFailure = automationTaskResourceSchema.parse(
          await (
            await automationRequest(
              server,
              token,
              "/api/automation/v1/resources/tasks",
              "GET",
            )
          ).json(),
        );
        expect(afterFailure.tasks).toEqual(before.tasks);
        expect(
          (
            fault
              .prepare("SELECT consumed_at FROM automation_previews WHERE id=?")
              .get(edit.id) as { consumed_at: unknown }
          ).consumed_at,
        ).toBeNull();
        fault.exec("DROP TRIGGER fail_assistant_receipt");
        fault.close();
        const key = randomUUID();
        const edited = automationConfirmationResponseSchema.parse(
          await (await confirm(edit.id, key)).json(),
        );
        expect(edited.result).toMatchObject({
          task: {
            title: "After",
            notes: "Keep notes",
            revision: original.revision + 1,
            estimateMinutes: 45,
            deadline: { kind: "date", value: "2026-10-01" },
          },
        });
        expect((await confirm(stale.id)).status).toBe(412);
        await server.close();
        server = await startSuiteServer(config);
        const replay = automationConfirmationResponseSchema.parse(
          await (await confirm(edit.id, key)).json(),
        );
        expect(replay).toEqual({ ...edited, replayed: true });
        const completed = await preview("tasks.set_completed", {
          taskId: original.id,
          expectedRevision: original.revision + 1,
          completed: true,
        });
        expect(
          automationConfirmationResponseSchema.parse(
            await (await confirm(completed.id)).json(),
          ).result,
        ).toMatchObject({
          task: { status: "completed", revision: original.revision + 2 },
        });
        const reopened = await preview("tasks.set_completed", {
          taskId: original.id,
          expectedRevision: original.revision + 2,
          completed: false,
        });
        expect(
          automationConfirmationResponseSchema.parse(
            await (await confirm(reopened.id)).json(),
          ).result,
        ).toMatchObject({
          task: {
            status: "open",
            revision: original.revision + 3,
            completedAt: null,
          },
        });
        const lifecycleInput = {
          taskId: original.id,
          expectedRevision: original.revision + 3,
        };
        expect(
          (
            await request(
              "/api/automation/v1/previews",
              { operation: "tasks.delete", input: lifecycleInput },
              readOnly,
            )
          ).status,
        ).toBe(403);
        const deletion = await preview("tasks.delete", lifecycleInput);
        const deleteKey = randomUUID();
        const removed = automationConfirmationResponseSchema.parse(
          await (await confirm(deletion.id, deleteKey)).json(),
        );
        expect(removed.result).toMatchObject({
          task: { revision: original.revision + 4 },
        });
        if (!("task" in removed.result))
          throw new Error("Expected deleted task");
        expect(typeof removed.result.task.deletedAt).toBe("string");
        const deletedRead = await automationRequest(
          server,
          token,
          "/api/automation/v1/resources/tasks/deleted",
          "GET",
        );
        expect(
          automationTaskResourceSchema
            .parse(await deletedRead.json())
            .tasks.map((task) => task.id),
        ).toEqual([original.id]);
        const activeRead = await automationRequest(
          server,
          token,
          "/api/automation/v1/resources/tasks",
          "GET",
        );
        expect(
          automationTaskResourceSchema.parse(await activeRead.json()).tasks,
        ).toEqual([]);
        const restore = await preview("tasks.restore", {
          taskId: original.id,
          expectedRevision: original.revision + 4,
        });
        const restored = automationConfirmationResponseSchema.parse(
          await (await confirm(restore.id)).json(),
        );
        expect(restored.result).toMatchObject({
          task: { deletedAt: null, revision: original.revision + 5 },
        });
        // Replaying an old deletion after restoration must not delete again.
        expect(
          automationConfirmationResponseSchema.parse(
            await (await confirm(deletion.id, deleteKey)).json(),
          ),
        ).toEqual({ ...removed, replayed: true });
        const pendingDelete = await preview("tasks.delete", {
          taskId: original.id,
          expectedRevision: original.revision + 5,
        });
        const start = await preview("focus.start", {
          operation: "focus.start",
          taskId: original.id,
        });
        expect((await confirm(start.id)).status).toBe(200);
        const blocked = await confirm(pendingDelete.id);
        expect(blocked.status).toBe(409);
        expect(apiErrorSchema.parse(await blocked.json()).code).toBe(
          "ACTIVE_SESSION_COMPLETE_REQUIRED",
        );
        const blockedPreview = await request("/api/automation/v1/previews", {
          operation: "tasks.delete",
          input: {
            taskId: original.id,
            expectedRevision: original.revision + 5,
          },
        });
        expect(blockedPreview.status).toBe(409);
      } finally {
        await server.close();
      }
    });
  });
});
