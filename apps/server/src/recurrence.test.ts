import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  automationConfirmationResponseSchema,
  automationPreviewResponseSchema,
  automationTokenScopeSchema,
  clientRegistrationResponseSchema,
  createAutomationTokenResponseSchema,
  recurringSeriesListResponseSchema,
  recurringSeriesMutationResponseSchema,
  syncRoundResponseSchema,
  taskListResponseSchema,
} from "@suite/contracts";
import { withTemporaryDirectory } from "@suite/test-support";
import type { ServerConfig } from "./config.ts";
import { startSuiteServer, type RunningSuiteServer } from "./server.ts";

// Recurring series over HTTP, the reminder tick, sync and the assistant
// (issue #42, ADR 0023).
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

const signIn = async (server: RunningSuiteServer) => {
  const owner = {
    username: "recurrence",
    displayName: "Recurrence",
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
  return (
    path: string,
    method: "GET" | "POST" | "PATCH",
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
};
type Call = Awaited<ReturnType<typeof signIn>>;

const tasks = async (call: Call) =>
  taskListResponseSchema.parse(await (await call("/api/tasks", "GET")).json())
    .tasks;

const series = {
  title: "Stand-up notes",
  rule: { cycle: "daily", interval: 1 },
  startDate: "2026-09-01",
  estimateMinutes: 10,
};

describe("recurring series over HTTP", () => {
  it("creates, edits, skips, pauses and ends a series and generates on the tick", async () => {
    await withTemporaryDirectory(async (directory) => {
      await mkdir(join(directory, "web"));
      let now = new Date("2026-09-24T12:00:00.000Z");
      const server = await startSuiteServer(configuration(directory), {
        disableNotificationTimer: true,
        sessionClock: { now: () => now },
      });
      try {
        const call = await signIn(server);
        const anonymous = await fetch(`${server.baseUrl}/api/recurring-series`);
        expect(anonymous.status).toBe(401);
        const key = randomUUID();
        const create = (body: unknown, idempotencyKey = key) =>
          call("/api/recurring-series", "POST", body, {
            "Idempotency-Key": idempotencyKey,
          });
        expect(
          (
            await create(
              {
                ...series,
                rule: { cycle: "weekly", interval: 1, weekdays: [] },
              },
              randomUUID(),
            )
          ).status,
        ).toBe(400);
        expect(
          (
            await create(
              {
                ...series,
                startReminder: { kind: "before_start", minutes: 5 },
              },
              randomUUID(),
            )
          ).status,
        ).toBe(400);
        const created = await create(series);
        expect(created.status).toBe(201);
        const first = recurringSeriesMutationResponseSchema.parse(
          await created.json(),
        );
        expect(first.generatedTaskIds).toHaveLength(1);
        expect(first.series).toMatchObject({
          state: "active",
          cursorDate: "2026-09-24",
          floorDate: "2026-09-24",
          instanceCount: 1,
          source: "tadooer",
        });
        expect(first.series.upcoming.map(({ date }) => date)).toEqual([
          "2026-09-25",
          "2026-09-26",
          "2026-09-27",
          "2026-09-28",
          "2026-09-29",
        ]);
        const replay = await create(series);
        expect(replay.status).toBe(200);
        expect(
          recurringSeriesMutationResponseSchema.parse(await replay.json())
            .replayed,
        ).toBe(true);
        expect((await create({ ...series, title: "Other" })).status).toBe(409);
        const [instance] = await tasks(call);
        expect(instance).toMatchObject({
          title: "Stand-up notes",
          plannedDay: "2026-09-24",
          recurrence: {
            seriesId: first.series.id,
            occurrenceDate: "2026-09-24",
          },
        });

        const id = first.series.id;
        const write = (
          path: string,
          method: "POST" | "PATCH",
          body: unknown,
          revision: number,
        ) => call(path, method, body, { "If-Match": `"${String(revision)}"` });
        expect(
          (
            await write(
              `/api/recurring-series/${id}`,
              "PATCH",
              { title: "Stand-up" },
              9,
            )
          ).status,
        ).toBe(412);
        const edited = recurringSeriesMutationResponseSchema.parse(
          await (
            await write(
              `/api/recurring-series/${id}`,
              "PATCH",
              { title: "Stand-up" },
              1,
            )
          ).json(),
        );
        expect(edited.updatedTaskIds).toEqual([instance?.id]);
        expect((await tasks(call))[0]?.title).toBe("Stand-up");

        const skipped = await write(
          `/api/recurring-series/${id}/occurrences/2026-09-26`,
          "POST",
          { action: "skip" },
          2,
        );
        expect(skipped.status).toBe(200);
        const skippedBody = recurringSeriesMutationResponseSchema.parse(
          await skipped.json(),
        );
        expect(skippedBody.series.exceptions).toEqual([
          { date: "2026-09-26", state: "skipped" },
        ]);
        expect(
          skippedBody.series.upcoming.find(({ date }) => date === "2026-09-26"),
        ).toEqual({ date: "2026-09-26", skipped: true });
        const processed = await write(
          `/api/recurring-series/${id}/occurrences/2026-09-24`,
          "POST",
          { action: "skip" },
          3,
        );
        expect(processed.status).toBe(409);

        now = new Date("2026-09-25T12:00:00.000Z");
        await server.runNotifications();
        now = new Date("2026-09-26T12:00:00.000Z");
        await server.runNotifications();
        expect(
          (await tasks(call))
            .map((task) => task.recurrence?.occurrenceDate)
            .toSorted(),
        ).toEqual(["2026-09-24", "2026-09-25"]);

        const state = (action: string, revision: number) =>
          write(
            `/api/recurring-series/${id}/state`,
            "POST",
            { action },
            revision,
          );
        expect((await state("pause", 3)).status).toBe(200);
        now = new Date("2026-09-27T12:00:00.000Z");
        await server.runNotifications();
        expect(await tasks(call)).toHaveLength(2);
        const resumed = recurringSeriesMutationResponseSchema.parse(
          await (await state("resume", 4)).json(),
        );
        expect(resumed.generatedTaskIds).toHaveLength(1);
        expect(resumed.series.floorDate).toBe("2026-09-27");
        expect((await state("end", 5)).status).toBe(200);
        const ended = await write(
          `/api/recurring-series/${id}`,
          "PATCH",
          { title: "Late" },
          6,
        );
        expect(ended.status).toBe(409);
        expect(await ended.json()).toMatchObject({
          code: "RECURRENCE_SERIES_ENDED",
        });
        const list = recurringSeriesListResponseSchema.parse(
          await (await call("/api/recurring-series", "GET")).json(),
        );
        expect(list.series).toHaveLength(1);
        expect(list.series[0]).toMatchObject({
          state: "ended",
          instanceCount: 3,
          upcoming: [],
        });
      } finally {
        await server.close();
      }
    });
  });

  it("sends generated instances through the sync feed as ordinary tasks", async () => {
    await withTemporaryDirectory(async (directory) => {
      await mkdir(join(directory, "web"));
      let now = new Date("2026-09-24T12:00:00.000Z");
      const server = await startSuiteServer(configuration(directory), {
        disableNotificationTimer: true,
        sessionClock: { now: () => now },
      });
      try {
        const call = await signIn(server);
        const client = clientRegistrationResponseSchema.parse(
          await (
            await call("/api/clients", "POST", { label: "Laptop" })
          ).json(),
        );
        const round = async (cursor: unknown) =>
          syncRoundResponseSchema.parse(
            await (
              await call(
                "/api/sync/round",
                "POST",
                { cursor, operations: [], pullLimit: 100 },
                {
                  "X-Suite-Client-Id": client.client.id,
                  "X-Suite-Client-Credential": client.clientCredential,
                  "X-Suite-Sync-Version": "2",
                },
              )
            ).json(),
          );
        const start = await round(null);
        await call("/api/recurring-series", "POST", series, {
          "Idempotency-Key": randomUUID(),
        });
        now = new Date("2026-09-25T12:00:00.000Z");
        await server.runNotifications();
        const pulled = await round(start.nextCursor);
        const snapshots = pulled.changes.flatMap((change) =>
          change.snapshot?.entityKind === "task" ? [change.snapshot.value] : [],
        );
        expect(
          snapshots.map((snapshot) => snapshot.task.recurrence?.occurrenceDate),
        ).toEqual(["2026-09-24", "2026-09-25"]);
      } finally {
        await server.close();
      }
    });
  });
});

describe("recurring series through the assistant", () => {
  it("previews, freezes revisions and confirms series operations", async () => {
    await withTemporaryDirectory(async (directory) => {
      await mkdir(join(directory, "web"));
      const server = await startSuiteServer(configuration(directory), {
        disableNotificationTimer: true,
      });
      try {
        const call = await signIn(server);
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
          return { status: response.status, body: await response.json() };
        };
        const preview = (operation: string, input: unknown) =>
          automation("/api/automation/v1/previews", { operation, input });
        const confirm = (previewId: string) =>
          automation(`/api/automation/v1/previews/${previewId}/confirm`, {
            idempotencyKey: randomUUID(),
          });

        const invalid = await preview("recurrence.create", {
          ...series,
          rule: {
            cycle: "monthly",
            interval: 0,
            monthly: { kind: "last_day" },
          },
        });
        expect(invalid.status).toBe(400);
        const createPreview = await preview("recurrence.create", {
          ...series,
          rule: { cycle: "daily", interval: 1 },
          startDate: "2020-01-01",
        });
        expect(createPreview.status).toBe(201);
        const created = automationPreviewResponseSchema.parse(
          createPreview.body,
        ).preview;
        expect(created.summary).toContain(
          'Create recurring series "Stand-up notes" repeating every day',
        );
        const createdResult = automationConfirmationResponseSchema.parse(
          (await confirm(created.id)).body,
        ).result;
        const seriesId =
          recurringSeriesMutationResponseSchema.parse(createdResult).series.id;

        const listed = await automation(
          "/api/automation/v1/resources/recurrence",
        );
        expect(listed.status).toBe(200);
        expect(
          recurringSeriesListResponseSchema.parse(listed.body).series[0]?.id,
        ).toBe(seriesId);

        expect(
          (
            await preview("recurrence.set_state", {
              seriesId,
              expectedRevision: 7,
              action: "pause",
            })
          ).status,
        ).toBe(412);
        const pause = automationPreviewResponseSchema.parse(
          (
            await preview("recurrence.set_state", {
              seriesId,
              expectedRevision: 1,
              action: "pause",
            })
          ).body,
        ).preview;
        expect(pause.baseRevisions).toEqual([
          { entityKind: "recurring_series", entityId: seriesId, revision: 1 },
        ]);
        // A browser edit after the preview makes the confirmation stale.
        await call(
          `/api/recurring-series/${seriesId}`,
          "PATCH",
          { notes: "Keep it short" },
          { "If-Match": '"1"' },
        );
        const stale = await confirm(pause.id);
        expect(stale.status).toBe(412);
        expect(stale.body).toMatchObject({ code: "AUTOMATION_PREVIEW_STALE" });

        const [instance] = taskListResponseSchema.parse(
          await (await call("/api/tasks", "GET")).json(),
        ).tasks;
        const occurrenceDate = instance?.recurrence?.occurrenceDate ?? "";
        const remove = automationPreviewResponseSchema.parse(
          (
            await preview("recurrence.occurrence", {
              seriesId,
              expectedRevision: 2,
              date: occurrenceDate,
              action: "delete_instance",
            })
          ).body,
        ).preview;
        expect(remove.baseRevisions).toEqual([
          { entityKind: "recurring_series", entityId: seriesId, revision: 2 },
          {
            entityKind: "task",
            entityId: instance?.id,
            revision: instance?.revision,
          },
        ]);
        const removed = await confirm(remove.id);
        expect(removed.status).toBe(200);
        expect(
          recurringSeriesMutationResponseSchema.parse(
            automationConfirmationResponseSchema.parse(removed.body).result,
          ).series.exceptions,
        ).toEqual([{ date: occurrenceDate, state: "deleted" }]);
        expect(
          taskListResponseSchema.parse(
            await (await call("/api/tasks", "GET")).json(),
          ).tasks,
        ).toEqual([]);
      } finally {
        await server.close();
      }
    });
  });
});
