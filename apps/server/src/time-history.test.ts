import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  activeSessionCommandResponseSchema,
  automationConfirmationResponseSchema,
  automationPreviewResponseSchema,
  automationTokenScopeSchema,
  clientRegistrationResponseSchema,
  createAutomationTokenResponseSchema,
  superProductivityPreviewSchema,
  taskMutationResponseSchema,
  timeEntryMutationResponseSchema,
  timeReportResponseSchema,
} from "@suite/contracts";
import { ManualSessionClock } from "@suite/domain";
import { withTemporaryDirectory } from "@suite/test-support";
import type { ServerConfig } from "./config.ts";
import { startSuiteServer, type RunningSuiteServer } from "./server.ts";

// Work history over HTTP and the assistant (issue #41, ADR 0024).
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
const minutes = (value: number) => value * 60_000;

const signIn = async (server: RunningSuiteServer) => {
  const owner = {
    username: "worklog",
    displayName: "Worklog",
    password: "a sufficiently long disposable password",
  };
  await fetch(`${server.baseUrl}/api/setup`, {
    method: "POST",
    headers: { Origin: server.baseUrl, "Content-Type": "application/json" },
    body: JSON.stringify(owner),
  });
  const login = await fetch(`${server.baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { Origin: server.baseUrl, "Content-Type": "application/json" },
    body: JSON.stringify(owner),
  });
  const cookie = login.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
  const { csrfToken } = (await login.json()) as { csrfToken: string };
  const call = (
    path: string,
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
    body?: unknown,
    headers: Record<string, string> = {},
  ) =>
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
  expect(
    (
      await call("/api/planning/preferences", "PUT", {
        workingDays: [1, 2, 3, 4, 5],
        workdayStart: "09:00",
        workdayEnd: "17:00",
        breakStart: null,
        breakEnd: null,
        timeZone: "America/Chicago",
      })
    ).status,
  ).toBe(200);
  return call;
};
type Call = Awaited<ReturnType<typeof signIn>>;

const createTask = async (call: Call, title: string) =>
  taskMutationResponseSchema.parse(
    await (
      await call(
        "/api/tasks",
        "POST",
        { title, estimateMinutes: 90 },
        { "Idempotency-Key": randomUUID() },
      )
    ).json(),
  ).task;

const report = async (call: Call, from: string, to = from) =>
  timeReportResponseSchema.parse(
    await (await call(`/api/time/report?from=${from}&to=${to}`, "GET")).json(),
  );

it("records manual time next to a running focus session and reports the worklog", async () => {
  await withTemporaryDirectory(async (directory) => {
    await mkdir(join(directory, "web"));
    // 10:00 CDT on Thursday, September 24.
    const clock = new ManualSessionClock("2026-09-24T15:00:00.000Z");
    const server = await startSuiteServer(configuration(directory), {
      sessionClock: clock,
    });
    try {
      const call = await signIn(server);
      const task = await createTask(call, "Write report");
      const client = clientRegistrationResponseSchema.parse(
        await (await call("/api/clients", "POST", { label: "Laptop" })).json(),
      );
      const proof = {
        "X-Suite-Client-Id": client.client.id,
        "X-Suite-Client-Credential": client.clientCredential,
      };
      const started = activeSessionCommandResponseSchema.parse(
        await (
          await call(
            "/api/active-session/command",
            "POST",
            { command: "start", idempotencyKey: randomUUID(), taskId: task.id },
            proof,
          )
        ).json(),
      );
      clock.advanceSeconds(60);

      const entryId = randomUUID();
      const body = {
        id: entryId,
        taskId: task.id,
        workDate: "2026-09-24",
        durationMs: minutes(30),
        note: "Call with the client",
      };
      const created = await call("/api/time/entries", "POST", body);
      expect(created.status).toBe(201);
      expect(created.headers.get("etag")).toBe('"1"');
      expect(
        timeEntryMutationResponseSchema.parse(await created.json()),
      ).toMatchObject({
        timeEntry: { id: entryId, source: "manual", revision: 1 },
        dayTotalMs: minutes(31),
      });
      // A retried create replays instead of adding the time twice.
      const retried = await call("/api/time/entries", "POST", body);
      expect(retried.status).toBe(200);
      expect((await report(call, "2026-09-24")).totalMs).toBe(minutes(31));

      // The running focus interval is read-only, and the day cannot be
      // lowered while it runs.
      const focusId = started.openedInterval?.id ?? "";
      const focusEdit = await call(
        `/api/time/entries/${focusId}`,
        "PATCH",
        { durationMs: minutes(1) },
        { "If-Match": '"1"' },
      );
      expect(focusEdit.status).toBe(409);
      expect(await focusEdit.json()).toMatchObject({
        code: "TIME_ENTRY_READ_ONLY",
      });
      const correction = {
        id: randomUUID(),
        taskId: task.id,
        workDate: "2026-09-24",
        durationMs: -minutes(5),
      };
      const refused = await call("/api/time/entries", "POST", correction);
      expect(refused.status).toBe(409);
      expect(await refused.json()).toMatchObject({
        code: "TIME_ENTRY_FOCUS_RUNNING",
      });

      const running = await report(call, "2026-09-21", "2026-09-27");
      expect(running).toMatchObject({
        timeZone: "America/Chicago",
        totalMs: minutes(31),
        bySource: { focus: minutes(1), import: 0, manual: minutes(30) },
        weeks: [
          { weekStart: "2026-09-21", totalMs: minutes(31), daysWorked: 1 },
        ],
        tasks: [
          {
            taskId: task.id,
            ownMs: minutes(31),
            estimateMinutes: 90,
            allTimeMs: minutes(31),
          },
        ],
        projects: [{ projectId: null, totalMs: minutes(31) }],
      });
      expect(
        running.entries.find((entry) => entry.id === focusId),
      ).toMatchObject({ source: "focus", running: true, revision: null });

      const completed = await call(
        "/api/active-session/command",
        "POST",
        {
          command: "complete",
          idempotencyKey: randomUUID(),
          sessionId: started.session.id,
          expectedRevision: started.session.revision,
        },
        proof,
      );
      expect(completed.status).toBe(200);
      expect((await call("/api/time/entries", "POST", correction)).status).toBe(
        201,
      );

      // Concurrent corrections: the second edit of revision 1 is stale.
      const edit = (revision: number, durationMs: number) =>
        call(
          `/api/time/entries/${entryId}`,
          "PATCH",
          { durationMs },
          { "If-Match": `"${String(revision)}"` },
        );
      const first = await edit(1, minutes(20));
      expect(first.status).toBe(200);
      expect(first.headers.get("etag")).toBe('"2"');
      const stale = await edit(1, minutes(25));
      expect(stale.status).toBe(412);
      expect(await stale.json()).toMatchObject({
        code: "TIME_ENTRY_REVISION_CONFLICT",
      });
      expect(
        (await call(`/api/time/entries/${entryId}`, "PATCH", { note: "x" }))
          .status,
      ).toBe(428);
      expect((await report(call, "2026-09-24")).totalMs).toBe(minutes(16));
      const remove = (id: string, revision: number) =>
        call(`/api/time/entries/${id}`, "DELETE", undefined, {
          "If-Match": `"${String(revision)}"`,
        });
      // Deleting the entry first would leave the correction below zero.
      const negative = await remove(entryId, 2);
      expect(negative.status).toBe(409);
      expect(await negative.json()).toMatchObject({
        code: "TIME_ENTRY_DAY_NEGATIVE",
      });
      expect((await remove(correction.id, 1)).status).toBe(200);
      const removed = await remove(entryId, 2);
      expect(removed.status).toBe(200);
      expect(
        timeEntryMutationResponseSchema.parse(await removed.json()),
      ).toEqual({
        timeEntry: null,
        deletedId: entryId,
        dayTotalMs: minutes(1),
      });

      for (const query of [
        "from=2026-09-30&to=2026-09-01",
        "from=2025-01-01&to=2026-09-01",
        "from=2026-02-30&to=2026-03-01",
      ])
        expect((await call(`/api/time/report?${query}`, "GET")).status).toBe(
          400,
        );
    } finally {
      await server.close();
    }
  });
});

it("imports Super Productivity work history once and keeps archived time read-only", async () => {
  await withTemporaryDirectory(async (directory) => {
    await mkdir(join(directory, "web"));
    const server = await startSuiteServer(configuration(directory));
    try {
      const call = await signIn(server);
      const state = (entities: Record<string, unknown>) => ({
        ids: Object.keys(entities),
        entities,
      });
      const done = {
        isDone: true,
        doneOn: 1758240000000,
        created: 1758000000000,
      };
      const exported = {
        task: state({
          live: {
            id: "live",
            title: "Live task",
            timeSpent: minutes(25),
            timeSpentOnDay: { "2026-09-22": minutes(25) },
          },
        }),
        project: state({ p: { id: "p", title: "Client work" } }),
        tag: state({ TODAY: { id: "TODAY", title: "Today" } }),
        timeTracking: {
          project: {},
          tag: {
            TODAY: { "2026-09-22": { s: 1758549600000, e: 1758582000000 } },
          },
        },
        archiveOld: {
          task: state({
            parent: {
              id: "parent",
              title: "Archived report",
              projectId: "p",
              subTaskIds: ["child"],
              timeSpent: minutes(70),
              timeSpentOnDay: { "2026-09-18": minutes(70) },
              ...done,
            },
            child: {
              id: "child",
              title: "Archived step",
              parentId: "parent",
              projectId: "p",
              timeSpent: minutes(60),
              timeSpentOnDay: { "2026-09-18": minutes(60) },
              ...done,
            },
            // One minute of timeSpent has no day.
            mismatch: {
              id: "mismatch",
              title: "Undated minute",
              timeSpent: minutes(1),
              timeSpentOnDay: {},
              ...done,
            },
          }),
          timeTracking: { project: {}, tag: {} },
        },
      };
      const preview = superProductivityPreviewSchema.parse(
        await (
          await call(
            "/api/imports/super-productivity/preview",
            "POST",
            exported,
          )
        ).json(),
      );
      expect(preview.canApply).toBe(true);
      expect(preview.totals.time).toMatchObject({
        sourceLeafMs: minutes(86),
        taskDayMs: minutes(85),
        parentResidualMs: minutes(10),
        undatedMs: minutes(1),
        workContextDays: 1,
      });
      const apply = () =>
        call("/api/imports/super-productivity/apply", "POST", exported, {
          "X-Import-Hash": preview.inputHash,
        });
      expect((await apply()).status).toBe(200);
      const before = await report(call, "2026-09-14", "2026-09-27");
      expect(await (await apply()).json()).toEqual({ created: 0, existing: 5 });
      const after = await report(call, "2026-09-14", "2026-09-27");
      // Replay adds nothing: 25 live + 60 child + 10 parent-own minutes.
      expect(after).toEqual({ ...before, generatedAt: after.generatedAt });
      expect(after.totalMs).toBe(minutes(95));
      expect(after.bySource).toEqual({
        focus: 0,
        import: minutes(95),
        manual: 0,
      });
      const byTitle = new Map(after.tasks.map((task) => [task.title, task]));
      expect(byTitle.get("Archived report")).toMatchObject({
        archived: true,
        ownMs: minutes(10),
        childrenMs: minutes(60),
        allTimeMs: minutes(70),
      });
      expect(
        after.days.find(({ date }) => date === "2026-09-22"),
      ).toMatchObject({
        workStart: new Date(1758549600000).toISOString(),
        workEnd: new Date(1758582000000).toISOString(),
      });
      const archivedEntry = after.entries.find(
        (entry) => entry.taskId === byTitle.get("Archived step")?.taskId,
      );
      const refused = await call(
        `/api/time/entries/${archivedEntry?.id ?? ""}`,
        "PATCH",
        { durationMs: minutes(1) },
        { "If-Match": '"1"' },
      );
      expect(refused.status).toBe(409);
      expect(await refused.json()).toMatchObject({
        code: "TIME_ENTRY_TASK_UNAVAILABLE",
      });
    } finally {
      await server.close();
    }
  });
});

it("reads the worklog and corrects entries through assistant previews", async () => {
  await withTemporaryDirectory(async (directory) => {
    await mkdir(join(directory, "web"));
    const server = await startSuiteServer(configuration(directory));
    try {
      const call = await signIn(server);
      const task = await createTask(call, "Plan trip");
      const token = createAutomationTokenResponseSchema.parse(
        await (
          await call("/api/automation/tokens", "POST", {
            label: "Assistant",
            scopes: [...automationTokenScopeSchema.options],
            expiresAt: new Date(Date.now() + 3600000).toISOString(),
          })
        ).json(),
      ).token;
      const automation = async (path: string, body?: unknown) => {
        const response = await fetch(`${server.baseUrl}${path}`, {
          method: body === undefined ? "GET" : "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            ...(body === undefined
              ? {}
              : { "Content-Type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        return {
          status: response.status,
          body: (await response.json()) as unknown,
        };
      };
      const preview = async (input: unknown) => {
        const response = await automation("/api/automation/v1/previews", {
          operation: "time_entries.mutate",
          input,
        });
        expect(response.status).toBe(201);
        return automationPreviewResponseSchema.parse(response.body).preview;
      };
      const confirm = (previewId: string) =>
        automation(`/api/automation/v1/previews/${previewId}/confirm`, {
          idempotencyKey: randomUUID(),
        });
      const id = randomUUID();
      const added = await preview({
        action: "add",
        id,
        taskId: task.id,
        workDate: "2026-09-23",
        durationMs: minutes(45),
      });
      expect(added.summary).toBe(
        'Add 0:45 to task "Plan trip" on 2026-09-23; the day\'s total becomes 0:45',
      );
      expect(added.affected).toEqual([
        { entityKind: "task", entityId: task.id },
        { entityKind: "time_entry", entityId: id },
      ]);
      const confirmed = await confirm(added.id);
      expect(confirmed.status).toBe(200);
      expect(
        automationConfirmationResponseSchema.parse(confirmed.body).result,
      ).toMatchObject({ timeEntry: { id, revision: 1, source: "manual" } });

      const worklog = await automation(
        "/api/automation/v1/resources/time-report?from=2026-09-21&to=2026-09-27",
      );
      expect(worklog.status).toBe(200);
      expect(timeReportResponseSchema.parse(worklog.body).totalMs).toBe(
        minutes(45),
      );
      expect(
        (await automation("/api/automation/v1/resources/time-report?from=x"))
          .status,
      ).toBe(400);

      // An edit previewed at revision 1 is stale once the owner edits first.
      const update = await preview({
        action: "update",
        id,
        expectedRevision: 1,
        patch: { durationMs: minutes(30) },
      });
      expect(update.summary).toContain("duration 0:45 to 0:30");
      expect(
        (
          await call(
            `/api/time/entries/${id}`,
            "PATCH",
            { note: "Booked" },
            { "If-Match": '"1"' },
          )
        ).status,
      ).toBe(200);
      const stale = await confirm(update.id);
      expect(stale.status).toBe(412);
      expect(stale.body).toMatchObject({ code: "AUTOMATION_PREVIEW_STALE" });

      const removal = await preview({
        action: "delete",
        id,
        expectedRevision: 2,
      });
      expect(removal.summary).toContain("Permanently delete the manual entry");
      expect((await confirm(removal.id)).status).toBe(200);
      expect((await report(call, "2026-09-23")).totalMs).toBe(0);

      const unknown = await automation("/api/automation/v1/previews", {
        operation: "time_entries.mutate",
        input: { action: "delete", id: randomUUID(), expectedRevision: 1 },
      });
      expect(unknown.status).toBe(404);
    } finally {
      await server.close();
    }
  });
});
