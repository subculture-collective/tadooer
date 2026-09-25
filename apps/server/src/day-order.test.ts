import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  automationConfirmationResponseSchema,
  automationPreviewResponseSchema,
  automationTokenScopeSchema,
  createAutomationTokenResponseSchema,
  dayOrderListResponseSchema,
  dayOrderPlanResponseSchema,
  dayOrderResponseSchema,
  planningPreferencesSchema,
  taskMutationResponseSchema,
} from "@suite/contracts";
import { ManualSessionClock } from "@suite/domain";
import { withTemporaryDirectory } from "@suite/test-support";
import type { ServerConfig } from "./config.ts";
import { startSuiteServer, type RunningSuiteServer } from "./server.ts";

// Saved Today and planner-day order over HTTP and the assistant (#98, ADR 0027).
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

const owner = {
  username: "orderer",
  displayName: "Orderer",
  password: "a sufficiently long disposable password",
};

const signIn = async (server: RunningSuiteServer, setup: boolean) => {
  if (setup)
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
    method: "GET" | "POST" | "PUT",
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

const createTask = async (call: Call, title: string, plannedDay?: string) =>
  taskMutationResponseSchema.parse(
    await (
      await call(
        "/api/tasks",
        "POST",
        { title, ...(plannedDay === undefined ? {} : { plannedDay }) },
        { "Idempotency-Key": randomUUID() },
      )
    ).json(),
  ).task;

const readOrder = async (call: Call, date: string) =>
  dayOrderResponseSchema.parse(
    await (await call(`/api/day-orders/${date}`, "GET")).json(),
  ).dayOrder;

it("saves a full-list day order, rejects stale or partial lists and plans tomorrow", async () => {
  await withTemporaryDirectory(async (directory) => {
    await mkdir(join(directory, "web"));
    // 02:00 CDT on Friday, September 25: before a 04:00 day start.
    const clock = new ManualSessionClock("2026-09-25T07:00:00.000Z");
    const config = configuration(directory);
    let server = await startSuiteServer(config, { sessionClock: clock });
    try {
      let call = await signIn(server, true);
      expect(
        (
          await call("/api/planning/preferences", "PUT", {
            workingDays: [1, 2, 3, 4, 5],
            workdayStart: "09:00",
            workdayEnd: "17:00",
            breakStart: null,
            breakEnd: null,
            timeZone: "America/Chicago",
            dayStartsAt: "04:00",
          })
        ).status,
      ).toBe(200);
      const today = "2026-09-24";
      const tomorrow = "2026-09-25";
      const tasks = [
        await createTask(call, "First", today),
        await createTask(call, "Second", today),
        await createTask(call, "Third", today),
      ];
      const derived = tasks.map(({ id }) => id).toSorted();
      expect(await readOrder(call, today)).toEqual({
        date: today,
        revision: 0,
        taskIds: derived,
      });
      const reversed = derived.toReversed();
      const put = (expectedRevision: number, taskIds: readonly string[]) =>
        call(`/api/day-orders/${today}`, "PUT", { expectedRevision, taskIds });

      const partial = await put(0, reversed.slice(1));
      expect(partial.status).toBe(412);
      expect(await partial.json()).toMatchObject({
        code: "DAY_ORDER_CONFLICT",
      });
      expect((await put(3, reversed)).status).toBe(412);
      expect((await put(0, [...reversed, randomUUID()])).status).toBe(412);
      const saved = await put(0, reversed);
      expect(saved.status).toBe(200);
      expect(dayOrderResponseSchema.parse(await saved.json()).dayOrder).toEqual(
        { date: today, revision: 1, taskIds: reversed },
      );
      // Replaying the same request after it succeeded is stale.
      expect((await put(0, reversed)).status).toBe(412);
      expect(await readOrder(call, today)).toMatchObject({
        revision: 1,
        taskIds: reversed,
      });

      // Writes need the CSRF token; reads validate their range.
      expect(
        (
          await call(
            `/api/day-orders/${today}`,
            "PUT",
            { expectedRevision: 1, taskIds: reversed },
            { "X-CSRF-Token": "wrong" },
          )
        ).status,
      ).toBe(403);
      expect(
        (await call("/api/day-orders?from=2026-01-01&to=2026-12-31", "GET"))
          .status,
      ).toBe(400);

      // Plan tomorrow: two tasks, in the order picked.
      const inbox = await createTask(call, "Inbox");
      const moved = tasks[0];
      if (moved === undefined) throw new Error("missing task");
      const stale = await call(`/api/day-orders/${tomorrow}/tasks`, "POST", {
        expectedRevision: 0,
        tasks: [{ taskId: inbox.id, expectedRevision: 9 }],
      });
      expect(stale.status).toBe(412);
      const planned = dayOrderPlanResponseSchema.parse(
        await (
          await call(`/api/day-orders/${tomorrow}/tasks`, "POST", {
            expectedRevision: 0,
            tasks: [
              { taskId: inbox.id, expectedRevision: inbox.revision },
              { taskId: moved.id, expectedRevision: moved.revision },
            ],
          })
        ).json(),
      );
      expect(planned.dayOrder).toEqual({
        date: tomorrow,
        revision: 1,
        taskIds: [inbox.id, moved.id],
      });
      expect(planned.tasks.map(({ plannedDay }) => plannedDay)).toEqual([
        tomorrow,
        tomorrow,
      ]);
      // The moved task left today's order without an error.
      expect(await readOrder(call, today)).toEqual({
        date: today,
        revision: 1,
        taskIds: reversed.filter((id) => id !== moved.id),
      });
      expect(
        dayOrderListResponseSchema
          .parse(
            await (
              await call(`/api/day-orders?from=${today}&to=${tomorrow}`, "GET")
            ).json(),
          )
          .dayOrders.map(({ date, revision }) => [date, revision]),
      ).toEqual([
        [today, 1],
        [tomorrow, 1],
      ]);

      // Orders and the day start survive a restart.
      await server.close();
      server = await startSuiteServer(config, { sessionClock: clock });
      call = await signIn(server, false);
      expect(await readOrder(call, tomorrow)).toMatchObject({
        revision: 1,
        taskIds: [inbox.id, moved.id],
      });
      expect(
        planningPreferencesSchema.parse(
          await (await call("/api/planning/preferences", "GET")).json(),
        ).dayStartsAt,
      ).toBe("04:00");
    } finally {
      await server.close();
    }
  });
});

it("lets the assistant read today's order and reorder it with preview and confirmation", async () => {
  await withTemporaryDirectory(async (directory) => {
    await mkdir(join(directory, "web"));
    // 02:00 CDT: with a 04:00 day start, today is still September 24.
    const clock = new ManualSessionClock("2026-09-25T07:00:00.000Z");
    const server = await startSuiteServer(configuration(directory), {
      sessionClock: clock,
    });
    try {
      const call = await signIn(server, true);
      await call("/api/planning/preferences", "PUT", {
        workingDays: [1, 2, 3, 4, 5],
        workdayStart: "09:00",
        workdayEnd: "17:00",
        breakStart: null,
        breakEnd: null,
        timeZone: "America/Chicago",
        dayStartsAt: "04:00",
      });
      const today = "2026-09-24";
      const a = await createTask(call, "Alpha", today);
      const b = await createTask(call, "Beta", today);
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
      const current = dayOrderResponseSchema.parse(
        (await automation("/api/automation/v1/resources/day-order")).body,
      ).dayOrder;
      expect(current).toEqual({
        date: today,
        revision: 0,
        taskIds: [a.id, b.id].toSorted(),
      });
      expect(
        (await automation("/api/automation/v1/resources/day-order?date=soon"))
          .status,
      ).toBe(400);

      const order = [...current.taskIds].toReversed();
      const partial = await automation("/api/automation/v1/previews", {
        operation: "day_order.reorder",
        input: { date: today, expectedRevision: 0, taskIds: order.slice(1) },
      });
      expect(partial.status).toBe(412);
      const preview = async (expectedRevision: number, taskIds: string[]) => {
        const response = await automation("/api/automation/v1/previews", {
          operation: "day_order.reorder",
          input: { date: today, expectedRevision, taskIds },
        });
        expect(response.status).toBe(201);
        return automationPreviewResponseSchema.parse(response.body).preview;
      };
      const first = await preview(0, order);
      expect(first.summary).toMatch(
        /^Order the 2 tasks planned for 2026-09-24: "(Alpha|Beta)", "(Alpha|Beta)"$/,
      );
      const key = randomUUID();
      const confirm = (previewId: string, idempotencyKey: string) =>
        automation(`/api/automation/v1/previews/${previewId}/confirm`, {
          idempotencyKey,
        });
      const confirmed = await confirm(first.id, key);
      expect(confirmed.status).toBe(200);
      const parsed = automationConfirmationResponseSchema.parse(confirmed.body);
      expect(parsed.result).toEqual({
        dayOrder: { date: today, revision: 1, taskIds: order },
      });
      // Replaying the confirmation returns the stored result.
      expect(
        automationConfirmationResponseSchema.parse(
          (await confirm(first.id, key)).body,
        ),
      ).toEqual({ ...parsed, replayed: true });

      // A browser reorder between preview and confirmation makes it stale.
      const second = await preview(1, [...order].toReversed());
      expect(
        (
          await call(`/api/day-orders/${today}`, "PUT", {
            expectedRevision: 1,
            taskIds: [...order].toReversed(),
          })
        ).status,
      ).toBe(200);
      const staleConfirm = await confirm(second.id, randomUUID());
      expect(staleConfirm.status).toBe(412);
      expect(staleConfirm.body).toMatchObject({
        code: "AUTOMATION_PREVIEW_STALE",
      });
      expect(await readOrder(call, today)).toMatchObject({ revision: 2 });
    } finally {
      await server.close();
    }
  });
});
