import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  automationPreviewResponseSchema,
  automationTokenScopeSchema,
  clientRegistrationResponseSchema,
  createAutomationTokenResponseSchema,
  dayOrderResponseSchema,
  syncRoundResponseSchema,
  syncSnapshotResponseSchema,
  taskMutationResponseSchema,
  type SavedDayOrder,
  type SyncRoundResponse,
} from "@suite/contracts";
import { withTemporaryDirectory } from "@suite/test-support";
import type { ServerConfig } from "./config.ts";
import { startSuiteServer, type RunningSuiteServer } from "./server.ts";

/** Saved day orders in the sync feed over real HTTP (ADR 0050, issue #114). */

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

const day = "2026-10-03";
const nextDay = "2026-10-04";

const signIn = async (server: RunningSuiteServer) => {
  const owner = {
    username: "orders",
    displayName: "Orders",
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
    method: "GET" | "POST" | "PUT" | "PATCH",
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

/** One device: its client proof, its cursor and the day orders it cached. */
class Device {
  cursor: string | null = null;
  readonly orders = new Map<string, SavedDayOrder>();
  #sequence = 0;
  readonly #call: Call;
  readonly proof: Record<string, string>;

  constructor(call: Call, proof: Record<string, string>) {
    this.#call = call;
    this.proof = proof;
  }

  reorder(date: string, baseRevision: number, taskIds: readonly string[]) {
    return {
      operationId: randomUUID(),
      clientSequence: ++this.#sequence,
      createdAt: new Date().toISOString(),
      requestHash: "a".repeat(43),
      kind: "day_order.reorder",
      date,
      baseRevision,
      taskIds,
    };
  }

  /** Sends operations and applies the pulled changes like a client cache. */
  async round(operations: unknown[] = []): Promise<SyncRoundResponse> {
    const response = await this.#call(
      "/api/sync/round",
      "POST",
      { cursor: this.cursor, operations, pullLimit: 100 },
      this.proof,
    );
    expect(response.status).toBe(200);
    const body = syncRoundResponseSchema.parse(await response.json());
    for (const change of body.changes)
      if (change.snapshot?.entityKind === "day_order")
        this.orders.set(change.entityId, change.snapshot.value);
    this.cursor = body.nextCursor;
    return body;
  }
}

const register = async (call: Call, label: string) => {
  const client = clientRegistrationResponseSchema.parse(
    await (await call("/api/clients", "POST", { label })).json(),
  );
  return new Device(call, {
    "X-Suite-Client-Id": client.client.id,
    "X-Suite-Client-Credential": client.clientCredential,
    "X-Suite-Sync-Version": "2",
  });
};

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

it("syncs a day-order reorder, a conflict, a reconciled membership and a replay between two clients", async () => {
  await withTemporaryDirectory(async (directory) => {
    await mkdir(join(directory, "web"));
    const server = await startSuiteServer(configuration(directory), {
      disableNotificationTimer: true,
    });
    try {
      const call = await signIn(server);
      const laptop = await register(call, "Laptop");
      const phone = await register(call, "Phone");
      const tasks = [
        await createTask(call, "First", day),
        await createTask(call, "Second", day),
        await createTask(call, "Third", day),
      ];
      const ids = tasks.map(({ id }) => id).toSorted();
      const [a, b, c] = ids as [string, string, string];
      await laptop.round();
      await phone.round();

      // The laptop reorders the day twice offline: the second reorder is
      // based on the revision the first one produces.
      const first = laptop.reorder(day, 0, [c, a, b]);
      const second = laptop.reorder(day, 1, [c, b, a]);
      const applied = await laptop.round([first, second]);
      expect(applied.outcomes).toMatchObject([
        { kind: "applied", entityId: day, entityRevision: 1 },
        { kind: "applied", entityId: day, entityRevision: 2 },
      ]);
      // The phone receives the saved order in its next round.
      await phone.round();
      expect(phone.orders.get(day)).toMatchObject({
        date: day,
        revision: 2,
        taskIds: [c, b, a],
      });
      // The HTTP read composes the same order.
      expect(
        dayOrderResponseSchema.parse(
          await (await call(`/api/day-orders/${day}`, "GET")).json(),
        ).dayOrder,
      ).toEqual({ date: day, revision: 2, taskIds: [c, b, a] });

      // Replaying the same operations changes nothing.
      expect((await laptop.round([first, second])).outcomes).toMatchObject([
        { kind: "replayed", entityId: day },
        { kind: "replayed", entityId: day, entityRevision: 2 },
      ]);
      expect((await phone.round()).changes).toEqual([]);
      expect(
        (await laptop.round([{ ...second, requestHash: "b".repeat(43) }]))
          .outcomes,
      ).toMatchObject([{ kind: "rejected", code: "IDEMPOTENCY_CONFLICT" }]);

      // Both devices reorder revision 2. The phone syncs first.
      const phoneOrder = phone.reorder(day, 2, [a, b, c]);
      expect((await phone.round([phoneOrder])).outcomes).toMatchObject([
        { kind: "applied", entityRevision: 3 },
      ]);
      const laptopOrder = laptop.reorder(day, 2, [b, a, c]);
      const conflicted = await laptop.round([laptopOrder]);
      expect(conflicted.outcomes).toEqual([
        {
          kind: "conflict",
          operationId: laptopOrder.operationId,
          code: "SYNC_RESOURCE_CONFLICT",
          entityKind: "day_order",
          taskId: day,
          taskRevision: 3,
          reasons: ["revision"],
        },
      ]);
      // Nothing was overwritten: the laptop is handed the phone's order and
      // still holds its own in the outbox operation.
      expect(laptop.orders.get(day)).toMatchObject({
        revision: 3,
        taskIds: [a, b, c],
      });
      expect((await laptop.round([laptopOrder])).outcomes).toMatchObject([
        { kind: "conflict", entityKind: "day_order", taskRevision: 3 },
      ]);

      // A task leaves the day and another joins it while the laptop is
      // offline. The laptop's reorder still names the first and does not
      // know the second: the server reconciles instead of refusing.
      const moved = await call(
        `/api/tasks/${a}`,
        "PATCH",
        { plannedDay: nextDay },
        { "If-Match": '"1"' },
      );
      expect(moved.status).toBe(200);
      const joined = await createTask(call, "Joined", day);
      const offline = laptop.reorder(day, 3, [c, a, b]);
      expect((await laptop.round([offline])).outcomes).toMatchObject([
        { kind: "applied", entityId: day, entityRevision: 4 },
      ]);
      expect(laptop.orders.get(day)).toMatchObject({
        revision: 4,
        taskIds: [c, b, joined.id],
      });
      await phone.round();
      expect(phone.orders.get(day)?.taskIds).toEqual([c, b, joined.id]);
    } finally {
      await server.close();
    }
  });
});

it("delivers day orders saved through the browser routes and the assistant to another client's round and snapshot", async () => {
  await withTemporaryDirectory(async (directory) => {
    await mkdir(join(directory, "web"));
    const server = await startSuiteServer(configuration(directory), {
      disableNotificationTimer: true,
    });
    try {
      const call = await signIn(server);
      const phone = await register(call, "Phone");
      const ids = [
        await createTask(call, "First", day),
        await createTask(call, "Second", day),
      ]
        .map(({ id }) => id)
        .toSorted();
      const inbox = await createTask(call, "Inbox");
      await phone.round();
      expect(phone.orders.size).toBe(0);

      // Browser route: full-list reorder.
      const reversed = ids.toReversed();
      expect(
        (
          await call(`/api/day-orders/${day}`, "PUT", {
            expectedRevision: 0,
            taskIds: reversed,
          })
        ).status,
      ).toBe(200);
      await phone.round();
      expect(phone.orders.get(day)).toMatchObject({
        revision: 1,
        taskIds: reversed,
      });
      // A refused browser reorder appends nothing.
      expect(
        (
          await call(`/api/day-orders/${day}`, "PUT", {
            expectedRevision: 0,
            taskIds: ids,
          })
        ).status,
      ).toBe(412);
      expect((await phone.round()).changes).toEqual([]);

      // Browser route: plan a task for the day. The task and the order both
      // arrive through the feed.
      expect(
        (
          await call(`/api/day-orders/${day}/tasks`, "POST", {
            expectedRevision: 1,
            tasks: [{ taskId: inbox.id, expectedRevision: inbox.revision }],
          })
        ).status,
      ).toBe(200);
      const planned = await phone.round();
      expect(
        planned.changes.map(({ entityKind }) => entityKind).toSorted(),
      ).toEqual(["day_order", "task"]);
      expect(phone.orders.get(day)).toMatchObject({
        revision: 2,
        taskIds: [...reversed, inbox.id],
      });

      // Assistant: day_order.reorder.
      const token = createAutomationTokenResponseSchema.parse(
        await (
          await call("/api/automation/tokens", "POST", {
            label: "Assistant",
            scopes: [...automationTokenScopeSchema.options],
            expiresAt: new Date(Date.now() + 3600000).toISOString(),
          })
        ).json(),
      ).token;
      const automation = (path: string, body: unknown) =>
        fetch(`${server.baseUrl}${path}`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        });
      const assistantOrder = [inbox.id, ...ids];
      const preview = automationPreviewResponseSchema.parse(
        await (
          await automation("/api/automation/v1/previews", {
            operation: "day_order.reorder",
            input: { date: day, expectedRevision: 2, taskIds: assistantOrder },
          })
        ).json(),
      ).preview;
      expect(
        (
          await automation(
            `/api/automation/v1/previews/${preview.id}/confirm`,
            { idempotencyKey: randomUUID() },
          )
        ).status,
      ).toBe(200);
      await phone.round();
      expect(phone.orders.get(day)).toMatchObject({
        revision: 3,
        taskIds: assistantOrder,
      });

      // A new device gets the saved order from the snapshot.
      const tablet = await register(call, "Tablet");
      const snapshot = syncSnapshotResponseSchema.parse(
        await (
          await call("/api/sync/snapshot", "GET", undefined, tablet.proof)
        ).json(),
      );
      expect(
        snapshot.snapshots.filter(
          ({ entityKind }) => entityKind === "day_order",
        ),
      ).toMatchObject([
        {
          entityKind: "day_order",
          value: { date: day, revision: 3, taskIds: assistantOrder },
        },
      ]);
    } finally {
      await server.close();
    }
  });
});
