import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  automationPreviewResponseSchema,
  automationTokenScopeSchema,
  clientRegistrationResponseSchema,
  createAutomationTokenResponseSchema,
  syncRoundResponseSchema,
  syncSnapshotResponseSchema,
  syncTimeEntryWindowDays,
  syncTimeEntryWindowStart,
  taskMutationResponseSchema,
  timeEntryMutationResponseSchema,
  timeReportResponseSchema,
  type SyncRoundResponse,
  type TimeEntry,
} from "@suite/contracts";
import { ManualSessionClock } from "@suite/domain";
import { withTemporaryDirectory } from "@suite/test-support";
import type { ServerConfig } from "./config.ts";
import { startSuiteServer, type RunningSuiteServer } from "./server.ts";

/** Stored time entries in the sync feed over real HTTP (ADR 0050, #114). */

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

const clockAt = "2026-10-02T12:00:00.000Z";
const day = "2026-10-02";
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
type Call = Awaited<ReturnType<typeof signIn>>;

/** One device: its client proof, its cursor and the entries it cached. */
class Device {
  cursor: string | null = null;
  readonly entries = new Map<string, TimeEntry>();
  #sequence = 0;
  readonly #call: Call;
  readonly proof: Record<string, string>;

  constructor(call: Call, proof: Record<string, string>) {
    this.#call = call;
    this.proof = proof;
  }

  operation<T extends object>(payload: T) {
    return {
      operationId: randomUUID(),
      clientSequence: ++this.#sequence,
      createdAt: new Date().toISOString(),
      requestHash: "a".repeat(43),
      ...payload,
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
    for (const change of body.changes) {
      if (change.entityKind !== "time_entry") continue;
      if (change.snapshot?.entityKind === "time_entry")
        this.entries.set(change.entityId, change.snapshot.value);
      else this.entries.delete(change.entityId);
    }
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

const createTask = async (call: Call, title: string) =>
  taskMutationResponseSchema.parse(
    await (
      await call(
        "/api/tasks",
        "POST",
        { title },
        {
          "Idempotency-Key": randomUUID(),
        },
      )
    ).json(),
  ).task;

const start = async (directory: string) => {
  await mkdir(join(directory, "web"));
  return startSuiteServer(configuration(directory), {
    disableNotificationTimer: true,
    sessionClock: new ManualSessionClock(clockAt),
  });
};

it("syncs a time entry create, edit, conflict, rule refusal, delete and replay between two clients", async () => {
  await withTemporaryDirectory(async (directory) => {
    const server = await start(directory);
    try {
      const call = await signIn(server);
      const laptop = await register(call, "Laptop");
      const phone = await register(call, "Phone");
      const task = await createTask(call, "Write report");
      await laptop.round();
      await phone.round();
      const entryId = randomUUID();

      // The laptop adds time offline and corrects it before reconnecting:
      // the second operation is based on the revision the first produces.
      const create = laptop.operation({
        kind: "time_entry.create",
        timeEntry: {
          id: entryId,
          taskId: task.id,
          workDate: day,
          durationMs: minutes(30),
          note: "",
        },
      });
      const edit = laptop.operation({
        kind: "time_entry.patch",
        timeEntryId: entryId,
        fields: { durationMs: minutes(45), note: "Review" },
        baseRevision: 1,
      });
      expect((await laptop.round([create, edit])).outcomes).toMatchObject([
        { kind: "applied", entityId: entryId, entityRevision: 1 },
        { kind: "applied", entityId: entryId, entityRevision: 2 },
      ]);
      // The phone receives the entry in its next round.
      await phone.round();
      expect(phone.entries.get(entryId)).toMatchObject({
        taskId: task.id,
        workDate: day,
        durationMs: minutes(45),
        note: "Review",
        source: "manual",
        revision: 2,
      });
      // The online report shows the same entry.
      const report = timeReportResponseSchema.parse(
        await (
          await call(`/api/time/report?from=${day}&to=${day}`, "GET")
        ).json(),
      );
      expect(report.totalMs).toBe(minutes(45));

      // Replaying the same operations changes nothing.
      expect((await laptop.round([create, edit])).outcomes).toMatchObject([
        { kind: "replayed", entityId: entryId },
        { kind: "replayed", entityId: entryId, entityRevision: 2 },
      ]);
      expect((await phone.round()).changes).toEqual([]);
      expect(
        (await laptop.round([{ ...edit, requestHash: "b".repeat(43) }]))
          .outcomes,
      ).toMatchObject([{ kind: "rejected", code: "IDEMPOTENCY_CONFLICT" }]);

      // Both devices edit revision 2. The phone syncs first.
      const phoneEdit = phone.operation({
        kind: "time_entry.patch",
        timeEntryId: entryId,
        fields: { durationMs: minutes(60) },
        baseRevision: 2,
      });
      expect((await phone.round([phoneEdit])).outcomes).toMatchObject([
        { kind: "applied", entityRevision: 3 },
      ]);
      const laptopEdit = laptop.operation({
        kind: "time_entry.patch",
        timeEntryId: entryId,
        fields: { durationMs: minutes(20) },
        baseRevision: 2,
      });
      expect((await laptop.round([laptopEdit])).outcomes).toEqual([
        {
          kind: "conflict",
          operationId: laptopEdit.operationId,
          code: "SYNC_RESOURCE_CONFLICT",
          entityKind: "time_entry",
          taskId: entryId,
          taskRevision: 3,
          reasons: ["revision"],
        },
      ]);
      // Nothing was overwritten; the laptop is handed the phone's value,
      // and the phone sees the re-sent entry as a change of nothing new.
      expect(laptop.entries.get(entryId)).toMatchObject({
        durationMs: minutes(60),
        revision: 3,
      });
      expect((await phone.round()).changes).toMatchObject([
        { entityId: entryId, entityRevision: 3 },
      ]);

      // A day rule the client cannot check: a correction below zero. The
      // refusal names the rule and writes nothing.
      const tooLow = laptop.operation({
        kind: "time_entry.create",
        timeEntry: {
          id: randomUUID(),
          taskId: task.id,
          workDate: day,
          durationMs: -minutes(90),
          note: "",
        },
      });
      const refused = await laptop.round([tooLow]);
      expect(refused.outcomes).toMatchObject([
        {
          kind: "conflict",
          code: "SYNC_RESOURCE_CONFLICT",
          entityKind: "time_entry",
          reasons: ["day_total_negative"],
        },
      ]);
      expect(refused.changes).toEqual([]);
      expect((await phone.round()).changes).toEqual([]);

      // A delete of the current revision applies, and the phone sees it go.
      const remove = laptop.operation({
        kind: "time_entry.delete",
        timeEntryId: entryId,
        baseRevision: 3,
      });
      expect((await laptop.round([remove])).outcomes).toMatchObject([
        { kind: "applied", entityId: entryId, entityRevision: 4 },
      ]);
      expect((await laptop.round([remove])).outcomes).toMatchObject([
        { kind: "replayed", entityId: entryId, entityRevision: 4 },
      ]);
      const gone = await phone.round();
      expect(gone.changes.at(-1)).toMatchObject({
        entityKind: "time_entry",
        entityId: entryId,
        kind: "deleted",
        snapshot: null,
      });
      expect(phone.entries.has(entryId)).toBe(false);
      // Editing the deleted entry is a conflict that creates nothing.
      const late = phone.operation({
        kind: "time_entry.patch",
        timeEntryId: entryId,
        fields: { note: "Too late" },
        baseRevision: 3,
      });
      expect((await phone.round([late])).outcomes).toMatchObject([
        { kind: "conflict", entityKind: "time_entry", reasons: ["record"] },
      ]);
    } finally {
      await server.close();
    }
  });
});

it("delivers entries written through the browser routes and the assistant, and bounds the snapshot to the window", async () => {
  await withTemporaryDirectory(async (directory) => {
    const server = await start(directory);
    try {
      const call = await signIn(server);
      const phone = await register(call, "Phone");
      const task = await createTask(call, "Write report");
      await phone.round();

      // Browser routes: create, edit and delete.
      const post = async (workDate: string, durationMs: number) => {
        const response = await call("/api/time/entries", "POST", {
          id: randomUUID(),
          taskId: task.id,
          workDate,
          durationMs,
        });
        expect(response.status).toBe(201);
        const entry = timeEntryMutationResponseSchema.parse(
          await response.json(),
        ).timeEntry;
        if (entry === null) throw new Error("entry was not created");
        return entry;
      };
      const first = await post(day, minutes(25));
      const removed = await post(day, minutes(5));
      await phone.round();
      expect(phone.entries.size).toBe(2);
      expect(
        (
          await call(
            `/api/time/entries/${first.id}`,
            "PATCH",
            { durationMs: minutes(35) },
            { "If-Match": '"1"' },
          )
        ).status,
      ).toBe(200);
      expect(
        (
          await call(`/api/time/entries/${removed.id}`, "DELETE", undefined, {
            "If-Match": '"1"',
          })
        ).status,
      ).toBe(200);
      // A refused browser write appends nothing.
      expect(
        (
          await call(
            `/api/time/entries/${first.id}`,
            "PATCH",
            { durationMs: minutes(1) },
            { "If-Match": '"1"' },
          )
        ).status,
      ).toBe(412);
      const pulled = await phone.round();
      expect(
        pulled.changes.map(({ entityId, kind }) => [entityId, kind]),
      ).toEqual([
        [first.id, "upsert"],
        [removed.id, "deleted"],
      ]);
      expect(phone.entries.get(first.id)).toMatchObject({
        durationMs: minutes(35),
        revision: 2,
      });
      expect(phone.entries.has(removed.id)).toBe(false);

      // Assistant: time_entries.mutate.
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
      const assistantEntry = randomUUID();
      const preview = automationPreviewResponseSchema.parse(
        await (
          await automation("/api/automation/v1/previews", {
            operation: "time_entries.mutate",
            input: {
              action: "add",
              id: assistantEntry,
              taskId: task.id,
              workDate: day,
              durationMs: minutes(15),
              note: "From the assistant",
            },
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
      expect(phone.entries.get(assistantEntry)).toMatchObject({
        note: "From the assistant",
        durationMs: minutes(15),
      });

      // History at the edge of the window and beyond it. The feed delivers
      // both changes; only the snapshot is bounded.
      const edge = syncTimeEntryWindowStart(day);
      const beyond = syncTimeEntryWindowStart(day, syncTimeEntryWindowDays + 1);
      const atEdge = await post(edge, minutes(10));
      const old = await post(beyond, minutes(10));
      await phone.round();
      expect(phone.entries.has(old.id)).toBe(true);

      const tablet = await register(call, "Tablet");
      const snapshot = syncSnapshotResponseSchema.parse(
        await (
          await call("/api/sync/snapshot", "GET", undefined, tablet.proof)
        ).json(),
      );
      const ids = snapshot.snapshots.flatMap((item) =>
        item.entityKind === "time_entry" ? [item.value.id] : [],
      );
      expect(ids.toSorted()).toEqual(
        [first.id, assistantEntry, atEdge.id].toSorted(),
      );
      // Older history stays available online through the report.
      const report = timeReportResponseSchema.parse(
        await (
          await call(`/api/time/report?from=${beyond}&to=${day}`, "GET")
        ).json(),
      );
      expect(report.entries.map(({ id }) => id)).toContain(old.id);
    } finally {
      await server.close();
    }
  });
});
