import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  automationConfirmationResponseSchema,
  automationPreviewResponseSchema,
  calendarSubscriptionConversionResponseSchema,
  calendarSubscriptionEventListResponseSchema,
  calendarSubscriptionEventMutationResponseSchema,
  calendarSubscriptionListResponseSchema,
  calendarSubscriptionMutationResponseSchema,
  calendarSubscriptionRefreshResponseSchema,
  calendarSubscriptionResourceSchema,
  createAutomationTokenResponseSchema,
  plannerResponseSchema,
  taskListResponseSchema,
} from "@suite/contracts";
import { ManualSessionClock } from "@suite/domain";
import { withTemporaryDirectory } from "@suite/test-support";
import type { ServerConfig } from "./config.ts";
import { startSuiteServer, type RunningSuiteServer } from "./server.ts";

// Read-only iCal subscriptions over HTTP and the assistant (#91, ADR 0032).
// The fake fetcher stands in for the network; the token in the feed address
// must never appear in any response, preview or resource.
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
  username: "subscriber",
  displayName: "Subscriber",
  password: "a sufficiently long disposable password",
};
const token = "SECRET-FEED-TOKEN-8f3a";
const feedUrl = `webcal://calendar.example.test/private/${token}/basic.ics`;
const now = "2026-09-25T15:00:00.000Z";

const calendar = (...events: readonly string[]): string =>
  [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Test//EN",
    ...events.flatMap((event) => [
      "BEGIN:VEVENT",
      ...event.split("\n"),
      "END:VEVENT",
    ]),
    "END:VCALENDAR",
    "",
  ].join("\r\n");

const standup =
  "UID:standup@example\nSUMMARY:Standup\nDTSTART:20260925T160000Z\nDTEND:20260925T163000Z\nURL:https://calendar.example.test/e/standup";
const review =
  "UID:review@example\nSUMMARY:Design review\nDTSTART:20260925T190000Z\nDTEND:20260925T200000Z";
const lunch =
  "UID:lunch@example\nSUMMARY:Lunch\nDTSTART:20260925T170000Z\nDTEND:20260925T180000Z";
const holiday =
  "UID:holiday@example\nSUMMARY:Holiday\nDTSTART;VALUE=DATE:20260926";

interface Feed {
  body: string;
  etag: string;
}

const href = (input: RequestInfo | URL): string =>
  typeof input === "string"
    ? input
    : input instanceof URL
      ? input.href
      : input.url;

const signIn = async (server: RunningSuiteServer) => {
  const post = (path: string, body: unknown) =>
    fetch(`${server.baseUrl}${path}`, {
      method: "POST",
      headers: { Origin: server.baseUrl, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  await post("/api/setup", owner);
  const login = await post("/api/auth/login", owner);
  const cookie = login.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
  const { csrfToken } = (await login.json()) as { csrfToken: string };
  return (
    path: string,
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
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

it("subscribes to a feed, projects and hides events, converts once and auto-imports with tombstones", async () => {
  await withTemporaryDirectory(async (directory) => {
    await mkdir(join(directory, "web"));
    const feeds = new Map<string, Feed>([
      [
        `https://calendar.example.test/private/${token}/basic.ics`,
        { body: calendar(standup, review, lunch, holiday), etag: '"v1"' },
      ],
      [
        "https://moved.example.test/feed.ics",
        { body: calendar(review), etag: '"moved"' },
      ],
    ]);
    const requested: string[] = [];
    const fakeFetch: typeof fetch = (input, init) => {
      const url = href(input);
      requested.push(url);
      const headers = new Headers(init?.headers);
      if (url === "https://redirect.example.test/feed.ics")
        return Promise.resolve(
          new Response(null, {
            status: 302,
            headers: { Location: "https://moved.example.test/feed.ics" },
          }),
        );
      if (url === "https://loop.example.test/feed.ics")
        return Promise.resolve(
          new Response(null, {
            status: 302,
            headers: { Location: "http://127.0.0.1:8080/internal.ics" },
          }),
        );
      const feed = feeds.get(url);
      if (feed === undefined)
        return Promise.resolve(new Response("missing", { status: 404 }));
      if (headers.get("If-None-Match") === feed.etag)
        return Promise.resolve(new Response(null, { status: 304 }));
      return Promise.resolve(
        new Response(feed.body, {
          status: 200,
          headers: { ETag: feed.etag, "Content-Type": "text/calendar" },
        }),
      );
    };
    const lookups: string[] = [];
    const clock = new ManualSessionClock(now);
    const server = await startSuiteServer(configuration(directory), {
      subscriptionFetch: fakeFetch,
      subscriptionLookup: (hostname) => {
        lookups.push(hostname);
        if (hostname === "evil.example.test")
          return Promise.resolve(["127.0.0.1"]);
        if (hostname === "unknown.example.test")
          return Promise.reject(new Error("ENOTFOUND"));
        return Promise.resolve(["10.0.0.56"]);
      },
      sessionClock: clock,
      disableNotificationTimer: true,
    });
    try {
      const call = await signIn(server);
      await call("/api/planning/preferences", "PUT", {
        workingDays: [1, 2, 3, 4, 5],
        workdayStart: "08:00",
        workdayEnd: "17:00",
        breakStart: "12:00",
        breakEnd: "13:00",
        timeZone: "America/Chicago",
      });

      // Rejected addresses never reach the fetcher.
      for (const url of [
        "http://127.0.0.1/x.ics",
        "http://169.254.169.254/latest/meta-data",
        "file:///etc/passwd",
        "https://user:pw@calendar.example.test/x.ics",
      ]) {
        const rejected = await call("/api/calendar-subscriptions", "POST", {
          name: "Bad",
          url,
        });
        expect(rejected.status, url).toBe(400);
        expect(((await rejected.json()) as { code: string }).code).toBe(
          "INVALID_SUBSCRIPTION_URL",
        );
      }
      expect(requested).toEqual([]);

      // A subscription is created, fetched at once and answers with the host.
      const createResponse = await call("/api/calendar-subscriptions", "POST", {
        name: "Team calendar",
        url: feedUrl,
        refreshIntervalMinutes: 60,
      });
      expect(createResponse.status).toBe(201);
      const createText = await createResponse.text();
      expect(createText).not.toContain(token);
      const created = calendarSubscriptionRefreshResponseSchema.parse(
        JSON.parse(createText),
      );
      expect(created.subscription).toMatchObject({
        name: "Team calendar",
        urlHost: "calendar.example.test",
        refreshIntervalMinutes: 60,
        eventCount: 4,
        freshness: { state: "fresh" },
        lastErrorClass: null,
      });
      expect(created.fetch).toMatchObject({ kind: "fetched", events: 4 });
      expect(requested).toEqual([
        `https://calendar.example.test/private/${token}/basic.ics`,
      ]);
      expect(lookups).toEqual(["calendar.example.test"]);
      const subscription = created.subscription;

      // Resolved loopback addresses and DNS failures are classified, not
      // followed; a redirect to a blocked address is refused too.
      const evil = calendarSubscriptionRefreshResponseSchema.parse(
        await (
          await call("/api/calendar-subscriptions", "POST", {
            name: "Evil",
            url: "https://evil.example.test/x.ics",
          })
        ).json(),
      );
      expect(evil.fetch).toEqual({
        kind: "failed",
        errorClass: "blocked_address",
      });
      expect(evil.subscription.freshness.state).toBe("unavailable");
      const loop = calendarSubscriptionRefreshResponseSchema.parse(
        await (
          await call("/api/calendar-subscriptions", "POST", {
            name: "Loop",
            url: "https://loop.example.test/feed.ics",
          })
        ).json(),
      );
      expect(loop.fetch).toEqual({
        kind: "failed",
        errorClass: "blocked_address",
      });
      const unknown = calendarSubscriptionRefreshResponseSchema.parse(
        await (
          await call("/api/calendar-subscriptions", "POST", {
            name: "Unknown",
            url: "https://unknown.example.test/feed.ics",
          })
        ).json(),
      );
      expect(unknown.fetch).toEqual({
        kind: "failed",
        errorClass: "dns_failed",
      });
      const missing = calendarSubscriptionRefreshResponseSchema.parse(
        await (
          await call("/api/calendar-subscriptions", "POST", {
            name: "Missing",
            url: "https://calendar.example.test/nothing.ics",
          })
        ).json(),
      );
      expect(missing.fetch).toEqual({ kind: "failed", errorClass: "http_404" });
      // Redirects are followed with the same checks.
      const moved = calendarSubscriptionRefreshResponseSchema.parse(
        await (
          await call("/api/calendar-subscriptions", "POST", {
            name: "Redirected",
            url: "https://redirect.example.test/feed.ics",
          })
        ).json(),
      );
      expect(moved.fetch).toMatchObject({ kind: "fetched", events: 1 });
      expect(moved.subscription.urlHost).toBe("redirect.example.test");
      for (const record of [evil, loop, unknown, missing, moved])
        expect(
          (
            await call(
              `/api/calendar-subscriptions/${record.subscription.id}`,
              "DELETE",
              undefined,
              { "If-Match": `"${String(record.subscription.revision)}"` },
            )
          ).status,
        ).toBe(204);
      expect(
        (
          await call("/api/calendar-subscriptions", "POST", {
            name: "Bad filter",
            url: "https://calendar.example.test/other.ics",
            includePattern: "(a+)+",
          })
        ).status,
      ).toBe(400);

      // Subscription events join the planner projection as "ical".
      const listText = await (
        await call("/api/calendar-subscriptions", "GET")
      ).text();
      expect(listText).not.toContain(token);
      const list = calendarSubscriptionListResponseSchema.parse(
        JSON.parse(listText),
      );
      expect(list.subscriptions.map(({ name }) => name)).toEqual([
        "Team calendar",
      ]);
      const window =
        "from=2026-09-25T05:00:00.000Z&to=2026-09-27T05:00:00.000Z";
      const planner = plannerResponseSchema.parse(
        await (await call(`/api/planner?${window}`, "GET")).json(),
      );
      expect(
        planner.events.map(({ summary, source }) => [
          summary,
          source.providerKind,
          source.calendarName,
        ]),
      ).toEqual([
        ["Standup", "ical", "Team calendar"],
        ["Lunch", "ical", "Team calendar"],
        ["Design review", "ical", "Team calendar"],
        ["Holiday", "ical", "Team calendar"],
      ]);
      expect(planner.events[0]?.identity.providerId).toBe(subscription.id);

      // Hiding an event keeps it in the owner's list and out of the planner.
      const hiddenResponse = await call(
        `/api/calendar-subscriptions/${subscription.id}/events/hidden`,
        "PUT",
        {
          uid: "lunch@example",
          occurrenceStart: "2026-09-25T17:00:00.000Z",
          hidden: true,
        },
      );
      expect(hiddenResponse.status).toBe(200);
      expect(
        calendarSubscriptionEventMutationResponseSchema.parse(
          await hiddenResponse.json(),
        ).event,
      ).toMatchObject({ summary: "Lunch", hidden: true, tombstoned: false });
      const events = calendarSubscriptionEventListResponseSchema.parse(
        await (
          await call(`/api/calendar-subscriptions/events?${window}`, "GET")
        ).json(),
      );
      expect(
        events.events.map(({ summary, hidden }) => [summary, hidden]),
      ).toEqual([
        ["Standup", false],
        ["Lunch", true],
        ["Design review", false],
        ["Holiday", false],
      ]);
      expect(
        plannerResponseSchema
          .parse(await (await call(`/api/planner?${window}`, "GET")).json())
          .events.map(({ summary }) => summary),
      ).not.toContain("Lunch");

      // A title filter applies on read without a refetch.
      const filtered = await call(
        `/api/calendar-subscriptions/${subscription.id}`,
        "PATCH",
        { excludePattern: "review" },
        { "If-Match": `"${String(subscription.revision)}"` },
      );
      expect(filtered.status).toBe(200);
      const filteredRecord = calendarSubscriptionMutationResponseSchema.parse(
        await filtered.json(),
      ).subscription;
      expect(filteredRecord.revision).toBe(subscription.revision + 1);
      expect(
        calendarSubscriptionEventListResponseSchema
          .parse(
            await (
              await call(`/api/calendar-subscriptions/events?${window}`, "GET")
            ).json(),
          )
          .events.map(({ summary }) => summary),
      ).toEqual(["Standup", "Lunch", "Holiday"]);
      expect(
        (
          await call(
            `/api/calendar-subscriptions/${subscription.id}`,
            "PATCH",
            { excludePattern: null },
            { "If-Match": `"${String(subscription.revision)}"` },
          )
        ).status,
      ).toBe(412);
      const unfiltered = calendarSubscriptionMutationResponseSchema.parse(
        await (
          await call(
            `/api/calendar-subscriptions/${subscription.id}`,
            "PATCH",
            { excludePattern: null },
            { "If-Match": `"${String(filteredRecord.revision)}"` },
          )
        ).json(),
      ).subscription;

      // Converting an event creates one task with the event's time; a
      // second conversion returns the same task.
      const convert = () =>
        call(
          `/api/calendar-subscriptions/${subscription.id}/events/convert`,
          "POST",
          {
            uid: "standup@example",
            occurrenceStart: "2026-09-25T16:00:00.000Z",
          },
        );
      const first = await convert();
      expect(first.status).toBe(201);
      const converted = calendarSubscriptionConversionResponseSchema.parse(
        await first.json(),
      );
      expect(converted.replayed).toBe(false);
      expect(converted.task).toMatchObject({
        title: "Standup",
        plannedStart: "2026-09-25T16:00:00.000Z",
        estimateMinutes: 30,
      });
      expect(converted.task.notes).toContain("Team calendar");
      expect(converted.event).toMatchObject({
        taskId: converted.task.id,
        tombstoned: true,
      });
      const second = await convert();
      expect(second.status).toBe(200);
      const again = calendarSubscriptionConversionResponseSchema.parse(
        await second.json(),
      );
      expect(again.replayed).toBe(true);
      expect(again.task.id).toBe(converted.task.id);
      const holidayTask = calendarSubscriptionConversionResponseSchema.parse(
        await (
          await call(
            `/api/calendar-subscriptions/${subscription.id}/events/convert`,
            "POST",
            {
              uid: "holiday@example",
              occurrenceStart: "2026-09-26",
            },
          )
        ).json(),
      );
      expect(holidayTask.task).toMatchObject({
        plannedDay: "2026-09-26",
        plannedStart: null,
      });
      const listTasks = async () =>
        taskListResponseSchema.parse(
          await (await call("/api/tasks", "GET")).json(),
        ).tasks;
      expect((await listTasks()).map(({ title }) => title).toSorted()).toEqual([
        "Holiday",
        "Standup",
      ]);

      // Dismissal is a tombstone: auto-import creates today's remaining
      // visible events only, never a dismissed, hidden or converted one, and
      // never again after the task is deleted.
      const dismissed = await call(
        `/api/calendar-subscriptions/${subscription.id}/events/dismiss`,
        "POST",
        { uid: "review@example", occurrenceStart: "2026-09-25T19:00:00.000Z" },
      );
      expect(dismissed.status).toBe(200);
      expect(
        calendarSubscriptionEventMutationResponseSchema.parse(
          await dismissed.json(),
        ).event,
      ).toMatchObject({ tombstoned: true, taskId: null });
      const auto = calendarSubscriptionMutationResponseSchema.parse(
        await (
          await call(
            `/api/calendar-subscriptions/${subscription.id}`,
            "PATCH",
            { autoImport: true },
            { "If-Match": `"${String(unfiltered.revision)}"` },
          )
        ).json(),
      ).subscription;
      await server.runNotifications();
      expect((await listTasks()).map(({ title }) => title).toSorted()).toEqual([
        "Holiday",
        "Standup",
      ]);
      // Unhide lunch: the next tick imports it, once.
      await call(
        `/api/calendar-subscriptions/${subscription.id}/events/hidden`,
        "PUT",
        {
          uid: "lunch@example",
          occurrenceStart: "2026-09-25T17:00:00.000Z",
          hidden: false,
        },
      );
      await server.runNotifications();
      await server.runNotifications();
      const withLunch = await listTasks();
      expect(withLunch.map(({ title }) => title).toSorted()).toEqual([
        "Holiday",
        "Lunch",
        "Standup",
      ]);
      const lunchTask = withLunch.find(({ title }) => title === "Lunch");
      if (lunchTask === undefined) throw new Error("lunch task");
      expect(
        (
          await call(`/api/tasks/${lunchTask.id}`, "DELETE", undefined, {
            "If-Match": `"${String(lunchTask.revision)}"`,
          })
        ).status,
      ).toBe(200);
      await server.runNotifications();
      expect((await listTasks()).map(({ title }) => title).toSorted()).toEqual([
        "Holiday",
        "Standup",
      ]);

      // Conditional refresh: unchanged, then a changed feed replaces events.
      const unchanged = calendarSubscriptionRefreshResponseSchema.parse(
        await (
          await call(
            `/api/calendar-subscriptions/${subscription.id}/refresh`,
            "POST",
          )
        ).json(),
      );
      expect(unchanged.fetch).toEqual({ kind: "unchanged" });
      feeds.set(`https://calendar.example.test/private/${token}/basic.ics`, {
        body: calendar(standup, holiday),
        etag: '"v2"',
      });
      const changed = calendarSubscriptionRefreshResponseSchema.parse(
        await (
          await call(
            `/api/calendar-subscriptions/${subscription.id}/refresh`,
            "POST",
          )
        ).json(),
      );
      expect(changed.fetch).toMatchObject({ kind: "fetched", events: 2 });
      expect(changed.subscription.eventCount).toBe(2);
      // The converted event keeps its task link across refreshes.
      expect(
        calendarSubscriptionEventListResponseSchema
          .parse(
            await (
              await call(`/api/calendar-subscriptions/events?${window}`, "GET")
            ).json(),
          )
          .events.map(({ summary, taskId }) => [summary, taskId]),
      ).toEqual([
        ["Standup", converted.task.id],
        ["Holiday", holidayTask.task.id],
      ]);

      // A new address discards the previous feed; the tick fetches it.
      const readdressed = calendarSubscriptionMutationResponseSchema.parse(
        await (
          await call(
            `/api/calendar-subscriptions/${subscription.id}`,
            "PATCH",
            { url: "https://moved.example.test/feed.ics" },
            { "If-Match": `"${String(auto.revision)}"` },
          )
        ).json(),
      ).subscription;
      expect(readdressed).toMatchObject({
        urlHost: "moved.example.test",
        eventCount: 0,
        freshness: { state: "never" },
      });
      await server.runNotifications();
      const fetchedAgain = calendarSubscriptionListResponseSchema.parse(
        await (await call("/api/calendar-subscriptions", "GET")).json(),
      ).subscriptions[0];
      expect(fetchedAgain).toMatchObject({
        eventCount: 1,
        freshness: { state: "fresh" },
      });
      expect(
        (
          await call(
            `/api/calendar-subscriptions/${subscription.id}`,
            "DELETE",
            undefined,
            {
              "If-Match": '"1"',
            },
          )
        ).status,
      ).toBe(412);
      expect(
        (
          await call(
            `/api/calendar-subscriptions/${subscription.id}`,
            "DELETE",
            undefined,
            {
              "If-Match": `"${String(readdressed.revision)}"`,
            },
          )
        ).status,
      ).toBe(204);
      expect(
        calendarSubscriptionListResponseSchema.parse(
          await (await call("/api/calendar-subscriptions", "GET")).json(),
        ).subscriptions,
      ).toEqual([]);
      expect(requested.join("\n")).toContain(token);
    } finally {
      await server.close();
    }
  });
});

it("lets the assistant read subscriptions, convert an event once, hide it and refresh with a current revision", async () => {
  await withTemporaryDirectory(async (directory) => {
    await mkdir(join(directory, "web"));
    let etag = '"v1"';
    const fakeFetch: typeof fetch = (input) => {
      const url = href(input);
      return Promise.resolve(
        url.includes(token)
          ? new Response(calendar(standup, review), {
              status: 200,
              headers: { ETag: etag },
            })
          : new Response("missing", { status: 404 }),
      );
    };
    const server = await startSuiteServer(configuration(directory), {
      subscriptionFetch: fakeFetch,
      subscriptionLookup: () => Promise.resolve(["10.0.0.56"]),
      sessionClock: new ManualSessionClock(now),
      disableNotificationTimer: true,
    });
    try {
      const call = await signIn(server);
      const created = calendarSubscriptionRefreshResponseSchema.parse(
        await (
          await call("/api/calendar-subscriptions", "POST", {
            name: "Team calendar",
            url: feedUrl,
          })
        ).json(),
      ).subscription;
      const issued = createAutomationTokenResponseSchema.parse(
        await (
          await call("/api/automation/tokens", "POST", {
            label: "Calendar assistant",
            scopes: ["schedule:read", "schedule:write", "tasks:write"],
            expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          })
        ).json(),
      );
      const automation = (
        path: string,
        method: "GET" | "POST",
        body?: unknown,
      ) =>
        fetch(`${server.baseUrl}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${issued.token}`,
            ...(body === undefined
              ? {}
              : { "Content-Type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      const resourceText = await (
        await automation(
          "/api/automation/v1/resources/calendar-subscriptions?from=2026-09-25T05:00:00.000Z&to=2026-09-26T05:00:00.000Z",
          "GET",
        )
      ).text();
      expect(resourceText).not.toContain(token);
      const resource = calendarSubscriptionResourceSchema.parse(
        JSON.parse(resourceText),
      );
      expect(resource.subscriptions.map(({ urlHost }) => urlHost)).toEqual([
        "calendar.example.test",
      ]);
      expect(resource.events.map(({ summary }) => summary)).toEqual([
        "Standup",
        "Design review",
      ]);
      expect(
        (
          await automation(
            "/api/automation/v1/resources/calendar-subscriptions?from=2026-09-25T05:00:00.000Z",
            "GET",
          )
        ).status,
      ).toBe(400);

      const preview = async (operation: string, input: unknown) => {
        const response = await automation(
          "/api/automation/v1/previews",
          "POST",
          {
            operation,
            input,
          },
        );
        return { status: response.status, text: await response.text() };
      };
      const confirm = async (previewId: string) =>
        automationConfirmationResponseSchema.parse(
          await (
            await automation(
              `/api/automation/v1/previews/${previewId}/confirm`,
              "POST",
              {
                idempotencyKey: randomUUID(),
              },
            )
          ).json(),
        );
      const event = {
        subscriptionId: created.id,
        uid: "standup@example",
        occurrenceStart: "2026-09-25T16:00:00.000Z",
      };
      const firstPreview = await preview(
        "calendar_subscriptions.convert_event",
        event,
      );
      expect(firstPreview.status).toBe(201);
      expect(firstPreview.text).not.toContain(token);
      const firstParsed = automationPreviewResponseSchema.parse(
        JSON.parse(firstPreview.text),
      );
      expect(firstParsed.preview.summary).toContain('Create a task "Standup"');
      const firstConfirm = await confirm(firstParsed.preview.id);
      expect(firstConfirm.result).toMatchObject({
        replayed: false,
        task: { title: "Standup" },
        event: { tombstoned: true },
      });
      const taskId =
        "task" in firstConfirm.result ? firstConfirm.result.task.id : "";
      const secondPreview = automationPreviewResponseSchema.parse(
        JSON.parse(
          (await preview("calendar_subscriptions.convert_event", event)).text,
        ),
      );
      expect(secondPreview.preview.summary).toContain("already has the task");
      expect(secondPreview.preview.affected).toContainEqual({
        entityKind: "task",
        entityId: taskId,
      });
      const secondConfirm = await confirm(secondPreview.preview.id);
      expect(secondConfirm.result).toMatchObject({
        replayed: true,
        task: { id: taskId },
      });

      const hidePreview = automationPreviewResponseSchema.parse(
        JSON.parse(
          (
            await preview("calendar_subscriptions.hide_event", {
              ...event,
              hidden: true,
            })
          ).text,
        ),
      );
      expect(hidePreview.preview.summary).toContain('Hide the event "Standup"');
      expect((await confirm(hidePreview.preview.id)).result).toMatchObject({
        event: { hidden: true },
      });
      expect(
        (
          await preview("calendar_subscriptions.hide_event", {
            ...event,
            uid: "nobody@example",
            hidden: true,
          })
        ).status,
      ).toBe(404);

      const stale = await preview("calendar_subscriptions.refresh", {
        subscriptionId: created.id,
        expectedRevision: created.revision + 1,
      });
      expect(stale.status).toBe(412);
      etag = '"v2"';
      const refreshPreview = automationPreviewResponseSchema.parse(
        JSON.parse(
          (
            await preview("calendar_subscriptions.refresh", {
              subscriptionId: created.id,
              expectedRevision: created.revision,
            })
          ).text,
        ),
      );
      expect(refreshPreview.preview.summary).toContain("calendar.example.test");
      expect(refreshPreview.preview.summary).not.toContain(token);
      const refreshed = await confirm(refreshPreview.preview.id);
      expect(refreshed.result).toMatchObject({
        fetch: { kind: "fetched", events: 2 },
        subscription: { urlHost: "calendar.example.test" },
      });
      // Adding or removing subscriptions is not in the catalog.
      const denied = await automation("/api/automation/v1/previews", "POST", {
        operation: "calendar_subscriptions.create",
        input: { url: feedUrl },
      });
      expect(denied.status).toBe(400);
    } finally {
      await server.close();
    }
  });
});
