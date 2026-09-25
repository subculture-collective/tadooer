import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  automationConfirmationResponseSchema,
  automationPreviewResponseSchema,
  automationTokenScopeSchema,
  counterHistoryResponseSchema,
  counterMutationResponseSchema,
  createAutomationTokenResponseSchema,
  evaluationListResponseSchema,
  evaluationMutationResponseSchema,
  superProductivityPreviewSchema,
  taskImportApplyResponseSchema,
  timeReportResponseSchema,
} from "@suite/contracts";
import { ManualSessionClock } from "@suite/domain";
import { withTemporaryDirectory } from "@suite/test-support";
import type { ServerConfig } from "./config.ts";
import { startSuiteServer, type RunningSuiteServer } from "./server.ts";

// Counters and daily evaluations over HTTP and the assistant (issue #64,
// ADR 0025).
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

const signIn = async (server: RunningSuiteServer, setup = true) => {
  const owner = {
    username: "counter",
    displayName: "Counter",
    password: "a sufficiently long disposable password",
  };
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
  if (setup)
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

const history = async (call: Call, from: string, to = from) =>
  counterHistoryResponseSchema.parse(
    await (await call(`/api/counters?from=${from}&to=${to}`, "GET")).json(),
  );

it("records counters, rejects stale writes and runs a stopwatch across midnight", async () => {
  await withTemporaryDirectory(async (directory) => {
    await mkdir(join(directory, "web"));
    // 23:30 CDT on Wednesday, September 23.
    const clock = new ManualSessionClock("2026-09-24T04:30:00.000Z");
    const server = await startSuiteServer(configuration(directory), {
      sessionClock: clock,
    });
    try {
      const call = await signIn(server);
      const water = randomUUID();
      const body = {
        id: water,
        title: "Water",
        kind: "click",
        streak: {
          enabled: true,
          minValue: 1,
          mode: "weekdays",
          weekdays: [0, 1, 2, 3, 4, 5, 6],
          weeklyFrequency: 3,
        },
      };
      const created = await call("/api/counters", "POST", body);
      expect(created.status).toBe(201);
      expect(created.headers.get("etag")).toBe('"1"');
      expect((await call("/api/counters", "POST", body)).status).toBe(200);
      expect(
        (await call("/api/counters", "POST", { ...body, title: "Tea" })).status,
      ).toBe(409);
      expect(
        (
          await call("/api/counters", "POST", {
            ...body,
            id: randomUUID(),
            countdownMs: 60_000,
          })
        ).status,
      ).toBe(400);

      const step = (expectedRevision: number, delta = 1, day = "2026-09-23") =>
        call(`/api/counters/${water}/days/${day}`, "POST", {
          action: "increment",
          delta,
          expectedRevision,
        });
      expect(
        counterMutationResponseSchema.parse(await (await step(0)).json()),
      ).toMatchObject({
        counter: { currentStreak: 1 },
        values: [{ day: "2026-09-23", value: 1, revision: 1 }],
      });
      // A second device that read revision 0 is refused.
      const stale = await step(0);
      expect(stale.status).toBe(412);
      expect(await stale.json()).toMatchObject({
        code: "COUNTER_REVISION_CONFLICT",
      });
      expect((await step(1, -5)).status).toBe(200);
      expect((await history(call, "2026-09-23")).values).toEqual([
        expect.objectContaining({ value: 0, revision: 2 }),
      ]);
      expect(
        (
          await call(`/api/counters/${water}/days/2026-09-23`, "POST", {
            action: "set",
            value: -1,
            expectedRevision: 2,
          })
        ).status,
      ).toBe(400);

      const desk = randomUUID();
      expect(
        (
          await call("/api/counters", "POST", {
            id: desk,
            title: "Standing desk",
            kind: "stopwatch",
          })
        ).status,
      ).toBe(201);
      const control = (action: "start" | "stop", revision: number) =>
        call(
          `/api/counters/${desk}/stopwatch`,
          "POST",
          { action },
          {
            "If-Match": `"${String(revision)}"`,
          },
        );
      expect(
        (
          await call(`/api/counters/${desk}/stopwatch`, "POST", {
            action: "start",
          })
        ).status,
      ).toBe(428);
      expect((await control("start", 1)).status).toBe(200);
      clock.advanceSeconds(45 * 60);
      const stopped = counterMutationResponseSchema.parse(
        await (await control("stop", 2)).json(),
      );
      expect(stopped.values).toEqual([
        expect.objectContaining({ day: "2026-09-23", value: minutes(30) }),
        expect.objectContaining({ day: "2026-09-24", value: minutes(15) }),
      ]);
      expect((await control("stop", 3)).status).toBe(409);
      const week = await history(call, "2026-09-21", "2026-09-27");
      expect(week.today).toBe("2026-09-24");
      expect(week.timeZone).toBe("America/Chicago");
      expect(week.counters.map(({ title }) => title)).toEqual([
        "Water",
        "Standing desk",
      ]);

      // The spring-forward day has 23 hours in the owner's zone.
      expect(
        (
          await call(`/api/counters/${desk}/days/2026-03-08`, "POST", {
            action: "set",
            value: minutes(23 * 60 + 1),
            expectedRevision: 0,
          })
        ).status,
      ).toBe(409);

      const removed = await call(
        `/api/counters/${water}`,
        "DELETE",
        undefined,
        {
          "If-Match": '"1"',
        },
      );
      expect(removed.status).toBe(200);
      expect((await step(0)).status).toBe(404);
      expect(
        (await history(call, "2026-09-21", "2026-09-27")).counters.map(
          ({ title }) => title,
        ),
      ).toEqual(["Standing desk"]);
      expect(
        (await call("/api/counters?from=2026-01-01&to=2027-06-01", "GET"))
          .status,
      ).toBe(400);
    } finally {
      await server.close();
    }
  });
});

it("keeps daily evaluations with imported focus sessions out of the worklog", async () => {
  await withTemporaryDirectory(async (directory) => {
    await mkdir(join(directory, "web"));
    let server = await startSuiteServer(configuration(directory));
    try {
      let call = await signIn(server);
      const state = (entities: Record<string, unknown>) => ({
        ids: Object.keys(entities),
        entities,
      });
      const exported = {
        task: state({ t: { id: "t", title: "Task" } }),
        simpleCounter: state({
          coffee: {
            id: "coffee",
            title: "Coffee",
            type: "ClickCounter",
            isEnabled: true,
            isTrackStreaks: true,
            streakMinValue: 1,
            streakMode: "specific-days",
            streakWeekDays: {
              0: true,
              1: true,
              2: true,
              3: true,
              4: true,
              5: true,
              6: true,
            },
            countOnDay: { "2026-09-20": 2, "2026-09-21": 1 },
          },
        }),
        metric: state({
          "2026-09-20": {
            id: "2026-09-20",
            focusSessions: [minutes(25), minutes(50)],
            remindTomorrow: false,
            reflections: [{ text: "Calm day", created: 1758400000000 }],
            impactOfWork: 4,
            energyCheckin: 3,
          },
        }),
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
      expect(preview.totals.counters).toMatchObject({
        definitions: 1,
        dayValues: 2,
        evaluations: 1,
        focusSessionMs: minutes(75),
      });
      const apply = (active: Call) =>
        active("/api/imports/super-productivity/apply", "POST", exported, {
          "X-Import-Hash": preview.inputHash,
        });
      const first = taskImportApplyResponseSchema.parse(
        await (await apply(call)).json(),
      );
      expect(first.counters).toEqual({
        created: 1,
        existing: 0,
        dayValuesCreated: 2,
        dayValuesExisting: 0,
        evaluationsCreated: 1,
        evaluationsExisting: 0,
      });

      // After a restart the same export adds nothing.
      await server.close();
      server = await startSuiteServer(configuration(directory));
      call = await signIn(server, false);
      expect(
        taskImportApplyResponseSchema.parse(await (await apply(call)).json())
          .counters,
      ).toMatchObject({
        created: 0,
        existing: 1,
        dayValuesCreated: 0,
        evaluationsCreated: 0,
      });

      const list = evaluationListResponseSchema.parse(
        await (
          await call("/api/evaluations?from=2026-09-14&to=2026-09-20", "GET")
        ).json(),
      );
      expect(list.evaluations).toEqual([
        expect.objectContaining({
          day: "2026-09-20",
          reflection: "Calm day",
          impact: 4,
          energy: 3,
          importedFocusSessionsMs: [minutes(25), minutes(50)],
          provenance: { source: "super_productivity", sourceDay: "2026-09-20" },
          revision: 1,
        }),
      ]);
      // Imported focus sessions are not work history.
      expect(list.focus).toEqual([]);
      const worklog = timeReportResponseSchema.parse(
        await (
          await call("/api/time/report?from=2026-09-20&to=2026-09-20", "GET")
        ).json(),
      );
      expect(worklog.totalMs).toBe(0);

      const write = (day: string, body: unknown) =>
        call(`/api/evaluations/${day}`, "PUT", body);
      const edited = evaluationMutationResponseSchema.parse(
        await (
          await write("2026-09-20", { expectedRevision: 1, energy: 2 })
        ).json(),
      );
      expect(edited.evaluation).toMatchObject({
        energy: 2,
        impact: 4,
        revision: 2,
      });
      expect(
        (await write("2026-09-20", { expectedRevision: 1, energy: 1 })).status,
      ).toBe(412);
      expect((await write("2026-09-21", { expectedRevision: 0 })).status).toBe(
        400,
      );
      expect(
        (await write("2026-09-21", { expectedRevision: 0, impact: 5 })).status,
      ).toBe(400);
      expect(
        (
          await write("2026-09-21", {
            expectedRevision: 0,
            remindTomorrow: true,
          })
        ).status,
      ).toBe(200);
    } finally {
      await server.close();
    }
  });
});

it("reads counters and evaluations and records them through assistant previews", async () => {
  await withTemporaryDirectory(async (directory) => {
    await mkdir(join(directory, "web"));
    const clock = new ManualSessionClock("2026-09-24T15:00:00.000Z");
    const server = await startSuiteServer(configuration(directory), {
      sessionClock: clock,
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
        return {
          status: response.status,
          body: (await response.json()) as unknown,
        };
      };
      const preview = async (operation: string, input: unknown) => {
        const response = await automation("/api/automation/v1/previews", {
          operation,
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
      const created = await preview("counters.mutate", {
        action: "create",
        id,
        title: "Push-ups",
        kind: "click",
      });
      expect(created.summary).toBe('Create the click counter "Push-ups"');
      expect((await confirm(created.id)).status).toBe(200);

      const increment = await preview("counters.record", {
        action: "increment",
        counterId: id,
        day: "2026-09-24",
        delta: 3,
        expectedRevision: 0,
      });
      expect(increment.summary).toBe(
        'Increase the counter "Push-ups" on 2026-09-24 from 0 to 3',
      );
      expect(
        automationConfirmationResponseSchema.parse(
          (await confirm(increment.id)).body,
        ).result,
      ).toMatchObject({
        values: [{ day: "2026-09-24", value: 3, revision: 1 }],
      });

      // A set previewed at revision 1 is stale once the owner records first.
      const set = await preview("counters.record", {
        action: "set",
        counterId: id,
        day: "2026-09-24",
        value: 10,
        expectedRevision: 1,
      });
      expect(
        (
          await call(`/api/counters/${id}/days/2026-09-24`, "POST", {
            action: "increment",
            delta: 1,
            expectedRevision: 1,
          })
        ).status,
      ).toBe(200);
      const stale = await confirm(set.id);
      expect(stale.status).toBe(412);
      expect(stale.body).toMatchObject({ code: "AUTOMATION_PREVIEW_STALE" });

      const evaluation = await preview("evaluations.write", {
        day: "2026-09-24",
        expectedRevision: 0,
        impact: 3,
        reflection: "Good focus",
      });
      expect(evaluation.summary).toBe(
        "Create the daily evaluation for 2026-09-24: reflection, impact 3 of 4",
      );
      expect(
        automationConfirmationResponseSchema.parse(
          (await confirm(evaluation.id)).body,
        ).result,
      ).toMatchObject({ evaluation: { impact: 3, revision: 1 } });

      const counters = await automation(
        "/api/automation/v1/resources/counters?from=2026-09-21&to=2026-09-27",
      );
      expect(counters.status).toBe(200);
      expect(counterHistoryResponseSchema.parse(counters.body).values).toEqual([
        expect.objectContaining({ value: 4, revision: 2 }),
      ]);
      const evaluations = await automation(
        "/api/automation/v1/resources/evaluations?from=2026-09-21&to=2026-09-27",
      );
      expect(
        evaluationListResponseSchema.parse(evaluations.body).evaluations,
      ).toHaveLength(1);
      expect(
        (await automation("/api/automation/v1/resources/counters?from=x"))
          .status,
      ).toBe(400);

      const removal = await preview("counters.mutate", {
        action: "delete",
        id,
        expectedRevision: 1,
      });
      expect(removal.summary).toBe(
        'Permanently delete the counter "Push-ups" and all of its recorded days',
      );
      expect((await confirm(removal.id)).status).toBe(200);
      const missing = await automation("/api/automation/v1/previews", {
        operation: "counters.record",
        input: {
          action: "increment",
          counterId: id,
          day: "2026-09-24",
          delta: 1,
          expectedRevision: 0,
        },
      });
      expect(missing.status).toBe(404);

      // A token without the metrics scopes cannot read or write counters.
      const narrow = createAutomationTokenResponseSchema.parse(
        await (
          await call("/api/automation/tokens", "POST", {
            label: "Tasks only",
            scopes: ["tasks:read"],
            expiresAt: new Date(Date.now() + 3600000).toISOString(),
          })
        ).json(),
      ).token;
      const denied = await fetch(
        `${server.baseUrl}/api/automation/v1/resources/counters?from=2026-09-21&to=2026-09-27`,
        { headers: { Authorization: `Bearer ${narrow}` } },
      );
      expect(denied.status).toBe(403);
    } finally {
      await server.close();
    }
  });
});
