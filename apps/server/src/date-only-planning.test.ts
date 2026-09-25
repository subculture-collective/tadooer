import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  apiErrorSchema,
  baikalStatusResponseSchema,
  conditionalTaskMutationResponseSchema,
  notificationStatusResponseSchema,
  plannerResponseSchema,
  taskListResponseSchema,
  taskMutationResponseSchema,
  taskTimeBlockMutationResponseSchema,
} from "@suite/contracts";
import { withTemporaryDirectory } from "@suite/test-support";
import type { ServerConfig } from "./config.ts";
import {
  startSuiteServer,
  type RunningSuiteServer,
  type SuiteServerOptions,
} from "./server.ts";

const davMultiStatus = (body: string): string =>
  `<?xml version="1.0"?><D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">${body}</D:multistatus>`;

/** A Baikal fake with one timed and one all-day event on August 6, 2026. */
const calendarWithEvents = (): typeof fetch => {
  const resources = new Map<string, { rawIcs: string; etag: string }>([
    [
      "/dav.php/calendars/alice/work/meeting.ics",
      {
        etag: '"meeting-1"',
        rawIcs:
          "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:meeting\r\nDTSTART:20260806T150000Z\r\nDTEND:20260806T160000Z\r\nSUMMARY:Team meeting\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n",
      },
    ],
    [
      "/dav.php/calendars/alice/work/holiday.ics",
      {
        etag: '"holiday-1"',
        rawIcs:
          "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:holiday\r\nDTSTART;VALUE=DATE:20260806\r\nDTEND;VALUE=DATE:20260807\r\nSUMMARY:Offsite\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n",
      },
    ],
  ]);
  let version = 1;
  return async (input, init) => {
    await Promise.resolve();
    const url =
      input instanceof URL
        ? input
        : new URL(typeof input === "string" ? input : input.url);
    const method = init?.method ?? "GET";
    const multi = (body: string) =>
      new Response(davMultiStatus(body), {
        status: 207,
        headers: { "content-type": "application/xml" },
      });
    if (method === "PROPFIND" && url.pathname === "/dav.php/")
      return multi(
        `<D:response><D:href>/dav.php/</D:href><D:propstat><D:prop><D:current-user-principal><D:href>/dav.php/principals/alice/</D:href></D:current-user-principal></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`,
      );
    if (method === "PROPFIND" && url.pathname === "/dav.php/principals/alice/")
      return multi(
        `<D:response><D:href>/dav.php/principals/alice/</D:href><D:propstat><D:prop><C:calendar-home-set><D:href>/dav.php/calendars/alice/</D:href></C:calendar-home-set></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`,
      );
    if (method === "PROPFIND" && url.pathname === "/dav.php/calendars/alice/")
      return multi(
        `<D:response><D:href>/dav.php/calendars/alice/work/</D:href><D:propstat><D:prop><D:resourcetype><D:collection/><C:calendar/></D:resourcetype><D:displayname>Work</D:displayname><C:supported-calendar-component-set><C:comp name="VEVENT"/></C:supported-calendar-component-set></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`,
      );
    if (method === "REPORT")
      return multi(
        [...resources.entries()]
          .map(
            ([href, resource]) =>
              `<D:response><D:href>${href}</D:href><D:propstat><D:prop><D:getetag>${resource.etag}</D:getetag></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`,
          )
          .join(""),
      );
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
      const headers = new Headers(init?.headers);
      if (headers.get("if-none-match") === "*" && resources.has(url.pathname))
        return new Response("", { status: 412 });
      version += 1;
      resources.set(url.pathname, {
        rawIcs: typeof init?.body === "string" ? init.body : "",
        etag: `"v${String(version)}"`,
      });
      return new Response(null, { status: 204 });
    }
    return new Response("", { status: 404 });
  };
};

interface Owner {
  readonly server: RunningSuiteServer;
  readonly cookie: string;
  readonly csrfToken: string;
}

const write = (
  { server, cookie, csrfToken }: Owner,
  path: string,
  method: "POST" | "PUT" | "PATCH",
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): Promise<Response> =>
  fetch(`${server.baseUrl}${path}`, {
    method,
    headers: {
      Origin: server.baseUrl,
      Cookie: cookie,
      "X-CSRF-Token": csrfToken,
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });

const signIn = async (server: RunningSuiteServer): Promise<Owner> => {
  const headers = {
    Origin: server.baseUrl,
    "Content-Type": "application/json",
  };
  await fetch(`${server.baseUrl}/api/setup`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      username: "owner",
      displayName: "Owner",
      password: "correct horse battery staple",
    }),
  });
  return login(server);
};

const login = async (server: RunningSuiteServer): Promise<Owner> => {
  const response = await fetch(`${server.baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { Origin: server.baseUrl, "Content-Type": "application/json" },
    body: JSON.stringify({
      username: "owner",
      password: "correct horse battery staple",
    }),
  });
  const { csrfToken } = (await response.json()) as { csrfToken: string };
  return {
    server,
    cookie: response.headers.get("set-cookie")?.split(";", 1)[0] ?? "",
    csrfToken,
  };
};

const createTask = async (
  owner: Owner,
  key: string,
  body: Record<string, unknown>,
) => {
  const response = await write(owner, "/api/tasks", "POST", body, {
    "Idempotency-Key": key,
  });
  expect(response.status).toBe(201);
  return taskMutationResponseSchema.parse(await response.json()).task;
};

const withServer = async (
  run: (input: {
    readonly config: ServerConfig;
    readonly directory: string;
  }) => Promise<void>,
): Promise<void> =>
  withTemporaryDirectory(async (directory) => {
    const webRoot = join(directory, "web");
    await mkdir(webRoot);
    await writeFile(join(webRoot, "index.html"), "<h1>Suite</h1>");
    const ntfyConfigPath = join(directory, "ntfy.json");
    await writeFile(
      ntfyConfigPath,
      JSON.stringify({
        baseUrl: "http://ntfy",
        topic: "tadooer-reminders",
        token: "tk_issue29_secret_that_must_not_escape",
      }),
      { mode: 0o600 },
    );
    await run({
      directory,
      config: {
        host: "127.0.0.1",
        port: 0,
        databasePath: join(directory, "suite.sqlite"),
        webRoot,
        baikalEndpoint: "http://baikal.test/dav.php/",
        credentialKeyPath: join(directory, "credential.key"),
        ntfyPublisherConfigPath: ntfyConfigPath,
        secureCookies: false,
        build: { version: "test", revision: "test", builtAt: null },
      },
    });
  });

describe("Date-only planning over HTTP (issue #29)", () => {
  it("plans a task for an owner-zone day beside calendar events and defers to a calendar block", async () => {
    await withServer(async ({ config }) => {
      const server = await startSuiteServer(config, {
        connectorFetch: calendarWithEvents(),
        disableNotificationTimer: true,
      });
      try {
        const owner = await signIn(server);
        const connected = baikalStatusResponseSchema.parse(
          await (
            await write(owner, "/api/connectors/baikal", "PUT", {
              username: "alice",
              password: "calendar password",
            })
          ).json(),
        );
        const calendarId = connected.calendars[0]?.id ?? "";
        expect(
          (
            await write(owner, "/api/planning/preferences", "PUT", {
              workingDays: [1, 2, 3, 4, 5],
              workdayStart: "09:00",
              workdayEnd: "17:00",
              breakStart: null,
              breakEnd: null,
              timeZone: "America/Chicago",
            })
          ).status,
        ).toBe(200);

        const task = await createTask(owner, "issue29-day", {
          title: "Pack for the offsite",
          plannedDay: "2026-08-06",
        });
        expect(task).toMatchObject({
          plannedDay: "2026-08-06",
          plannedStart: null,
          startReminder: { kind: "default" },
          deadlineReminder: null,
        });
        const both = await write(
          owner,
          "/api/tasks",
          "POST",
          {
            title: "Contradictory",
            plannedDay: "2026-08-06",
            plannedStart: "2026-08-06T15:00:00.000Z",
          },
          { "Idempotency-Key": "issue29-both" },
        );
        expect(both.status).toBe(400);

        // The Chicago day is 05:00Z to 05:00Z; events on that day do not
        // conflict with a task that has no time.
        const planner = plannerResponseSchema.parse(
          await (
            await fetch(
              `${server.baseUrl}/api/planner?from=2026-08-06T05%3A00%3A00.000Z&to=2026-08-07T05%3A00%3A00.000Z`,
              { headers: { Cookie: owner.cookie } },
            )
          ).json(),
        );
        expect(planner.tasks.map(({ id }) => id)).toEqual([task.id]);
        expect(planner.events.map(({ summary }) => summary).toSorted()).toEqual(
          ["Offsite", "Team meeting"],
        );
        const nextDay = plannerResponseSchema.parse(
          await (
            await fetch(
              `${server.baseUrl}/api/planner?from=2026-08-07T05%3A00%3A00.000Z&to=2026-08-08T05%3A00%3A00.000Z`,
              { headers: { Cookie: owner.cookie } },
            )
          ).json(),
        );
        expect(nextDay.tasks).toEqual([]);

        const invalidReminder = await write(
          owner,
          `/api/tasks/${task.id}`,
          "PATCH",
          { deadlineReminder: { minutes: 15 } },
          { "If-Match": '"1"' },
        );
        expect(invalidReminder.status).toBe(400);
        const invalidBoth = await write(
          owner,
          `/api/tasks/${task.id}`,
          "PATCH",
          {
            plannedDay: "2026-08-07",
            plannedStart: "2026-08-07T15:00:00.000Z",
          },
          { "If-Match": '"1"' },
        );
        expect(invalidBoth.status).toBe(400);

        // A calendar block's exact start supersedes the date-only plan.
        const blockResponse = await write(
          owner,
          `/api/tasks/${task.id}/time-block`,
          "POST",
          {
            calendarId,
            startsAt: "2026-08-06T17:00:00.000Z",
            durationMinutes: 30,
          },
          { "If-Match": '"1"', "Idempotency-Key": "issue29-block" },
        );
        expect(blockResponse.status).toBe(201);
        const block = taskTimeBlockMutationResponseSchema.parse(
          await blockResponse.json(),
        );
        expect(block.task).toMatchObject({
          plannedStart: "2026-08-06T17:00:00.000Z",
          plannedDay: null,
          revision: 2,
        });
        const blocked = await write(
          owner,
          `/api/tasks/${task.id}`,
          "PATCH",
          { plannedDay: "2026-08-07" },
          { "If-Match": '"2"' },
        );
        expect(blocked.status).toBe(409);
        expect(apiErrorSchema.parse(await blocked.json()).code).toBe(
          "TIME_BLOCK_REMOVE_REQUIRED",
        );
        const listed = taskListResponseSchema.parse(
          await (
            await fetch(`${server.baseUrl}/api/tasks`, {
              headers: { Cookie: owner.cookie },
            })
          ).json(),
        );
        expect(listed.tasks.find(({ id }) => id === task.id)).toMatchObject({
          plannedStart: "2026-08-06T17:00:00.000Z",
          plannedDay: null,
        });

        // Without a block, choosing a day replaces an exact start.
        const other = await createTask(owner, "issue29-timed", {
          title: "Timed without a block",
          plannedStart: "2026-08-06T18:00:00.000Z",
        });
        const redated = conditionalTaskMutationResponseSchema.parse(
          await (
            await write(
              owner,
              `/api/tasks/${other.id}`,
              "PATCH",
              { plannedDay: "2026-08-07" },
              { "If-Match": '"1"' },
            )
          ).json(),
        );
        expect(redated.task).toMatchObject({
          plannedStart: null,
          plannedDay: "2026-08-07",
          revision: 2,
        });
      } finally {
        await server.close();
      }
    });
  });

  it("delivers per-task and deadline reminders once across offset edits and restart", async () => {
    await withServer(async ({ config }) => {
      let now = new Date("2026-08-10T14:00:00.000Z");
      const published: string[] = [];
      const options: SuiteServerOptions = {
        connectorFetch: calendarWithEvents(),
        disableNotificationTimer: true,
        sessionClock: { now: () => now },
        notificationFetch: async (_input, init) => {
          await Promise.resolve();
          published.push(typeof init?.body === "string" ? init.body : "");
          return new Response("{}", { status: 200 });
        },
      };
      let server = await startSuiteServer(config, options);
      try {
        let owner = await signIn(server);
        await write(owner, "/api/connectors/baikal", "PUT", {
          username: "alice",
          password: "calendar password",
        });
        const early = await createTask(owner, "issue29-early", {
          title: "Thirty minute heads-up",
          plannedStart: "2026-08-10T15:00:00.000Z",
          startReminder: { kind: "before_start", minutes: 30 },
        });
        await createTask(owner, "issue29-silent", {
          title: "Silent task",
          plannedStart: "2026-08-10T15:00:00.000Z",
          startReminder: { kind: "none" },
        });
        await createTask(owner, "issue29-deadline", {
          title: "Submit report",
          deadline: { kind: "instant", value: "2026-08-10T16:00:00.000Z" },
          deadlineReminder: { minutes: 60 },
        });
        expect(
          (
            await write(owner, "/api/notifications/preferences", "PUT", {
              enabled: true,
              leadReminderEnabled: true,
              atStartReminderEnabled: true,
              detailedContentEnabled: true,
            })
          ).status,
        ).toBe(200);
        expect(published).toEqual([]);

        now = new Date("2026-08-10T14:30:00.000Z");
        await server.runNotifications();
        expect(published).toHaveLength(1);
        expect(published[0]).toContain("Thirty minute heads-up");

        // The lead reminder for this start was delivered; a new offset does
        // not produce a second lead reminder.
        expect(
          (
            await write(
              owner,
              `/api/tasks/${early.id}`,
              "PATCH",
              { startReminder: { kind: "before_start", minutes: 15 } },
              { "If-Match": '"1"' },
            )
          ).status,
        ).toBe(200);
        now = new Date("2026-08-10T14:45:00.000Z");
        await server.runNotifications();
        expect(published).toHaveLength(1);

        now = new Date("2026-08-10T15:00:00.000Z");
        await server.runNotifications();
        expect(published).toHaveLength(2);
        expect(published[1]).toContain("Deadline · Submit report");

        await server.close();
        server = await startSuiteServer(config, options);
        owner = await login(server);
        await server.runNotifications();
        now = new Date("2026-08-10T15:30:00.000Z");
        await server.runNotifications();
        expect(published).toHaveLength(2);

        const status = notificationStatusResponseSchema.parse(
          await (
            await fetch(`${server.baseUrl}/api/notifications/status`, {
              headers: { Cookie: owner.cookie },
            })
          ).json(),
        );
        expect(status).toMatchObject({ pendingCount: 0, failedCount: 0 });
      } finally {
        await server.close();
      }
    });
  });
});
