import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  automationConfirmationResponseSchema,
  automationPreviewResponseSchema,
  clientRegistrationResponseSchema,
  createAutomationTokenResponseSchema,
  noteListResponseSchema,
  noteResponseSchema,
  syncRoundResponseSchema,
  syncSnapshotResponseSchema,
  type SyncRoundResponse,
} from "@suite/contracts";
import { withTemporaryDirectory } from "@suite/test-support";
import type { ServerConfig } from "./config.ts";
import { startSuiteServer, type RunningSuiteServer } from "./server.ts";

/** Notes in the sync feed over real HTTP (ADR 0046, issue #114). */

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
    username: "notes",
    displayName: "Notes",
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

type Proof = Record<string, string>;

/** One device: its client proof, its cursor and the notes it has cached. */
class Device {
  cursor: string | null = null;
  readonly notes = new Map<string, { content: string; revision: number }>();
  #sequence = 0;
  readonly #call: Awaited<ReturnType<typeof signIn>>;
  readonly proof: Proof;

  constructor(call: Awaited<ReturnType<typeof signIn>>, proof: Proof) {
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
      if (change.entityKind !== "note") continue;
      if (change.snapshot?.entityKind === "note")
        this.notes.set(change.entityId, {
          content: change.snapshot.value.content,
          revision: change.snapshot.value.revision,
        });
      else this.notes.delete(change.entityId);
    }
    this.cursor = body.nextCursor;
    return body;
  }
}

it("syncs note create, edit, conflict, delete and replay between two clients", async () => {
  await withTemporaryDirectory(async (directory) => {
    await mkdir(join(directory, "web"));
    const server = await startSuiteServer(configuration(directory), {
      disableNotificationTimer: true,
    });
    try {
      const call = await signIn(server);
      const register = async (label: string) => {
        const client = clientRegistrationResponseSchema.parse(
          await (await call("/api/clients", "POST", { label })).json(),
        );
        return new Device(call, {
          "X-Suite-Client-Id": client.client.id,
          "X-Suite-Client-Credential": client.clientCredential,
          "X-Suite-Sync-Version": "2",
        });
      };
      const laptop = await register("Laptop");
      const phone = await register("Phone");
      const noteId = randomUUID();

      // The laptop writes a note offline and edits it before reconnecting:
      // the second operation is based on the revision the first produces.
      const create = laptop.operation({
        kind: "note.create",
        note: {
          id: noteId,
          content: "Draft",
          projectId: null,
          tagId: null,
          pinnedToToday: false,
        },
      });
      const edit = laptop.operation({
        kind: "note.patch",
        noteId,
        fields: { content: "Draft, expanded", pinnedToToday: true },
        baseRevision: 1,
      });
      const first = await laptop.round([create, edit]);
      expect(first.outcomes).toMatchObject([
        { kind: "applied", entityId: noteId, entityRevision: 1 },
        { kind: "applied", entityId: noteId, entityRevision: 2 },
      ]);
      // The phone receives the note with its content in its next round.
      const pulled = await phone.round();
      expect(
        pulled.changes.filter((c) => c.entityKind === "note"),
      ).toHaveLength(2);
      expect(phone.notes.get(noteId)).toEqual({
        content: "Draft, expanded",
        revision: 2,
      });

      // Replaying the same operations changes nothing.
      const replay = await laptop.round([create, edit]);
      expect(replay.outcomes).toMatchObject([
        { kind: "replayed", entityId: noteId },
        { kind: "replayed", entityId: noteId },
      ]);
      expect((await phone.round()).changes).toEqual([]);
      // The same operation ID with another payload is rejected.
      expect(
        (await laptop.round([{ ...edit, requestHash: "b".repeat(43) }]))
          .outcomes,
      ).toMatchObject([{ kind: "rejected", code: "IDEMPOTENCY_CONFLICT" }]);

      // Both devices edit revision 2. The phone syncs first.
      const phoneEdit = phone.operation({
        kind: "note.patch",
        noteId,
        fields: { content: "Phone version" },
        baseRevision: 2,
      });
      expect((await phone.round([phoneEdit])).outcomes).toMatchObject([
        { kind: "applied", entityRevision: 3 },
      ]);
      const laptopEdit = laptop.operation({
        kind: "note.patch",
        noteId,
        fields: { content: "Laptop version" },
        baseRevision: 2,
      });
      const conflicted = await laptop.round([laptopEdit]);
      expect(conflicted.outcomes).toEqual([
        {
          kind: "conflict",
          operationId: laptopEdit.operationId,
          code: "SYNC_RESOURCE_CONFLICT",
          entityKind: "note",
          taskId: noteId,
          taskRevision: 3,
          // ADR 0050: record conflicts say why.
          reasons: ["revision"],
        },
      ]);
      // Nothing was overwritten: the laptop is handed the phone's text and
      // still holds its own in the immutable outbox operation.
      expect(laptop.notes.get(noteId)).toEqual({
        content: "Phone version",
        revision: 3,
      });
      // The conflict replays as the same conflict.
      expect((await laptop.round([laptopEdit])).outcomes).toMatchObject([
        { kind: "conflict", entityKind: "note", taskRevision: 3 },
      ]);

      // A stale delete conflicts too; a delete of the current revision
      // applies, and the phone sees the note go.
      const staleDelete = phone.operation({
        kind: "note.delete",
        noteId,
        baseRevision: 2,
      });
      expect((await phone.round([staleDelete])).outcomes).toMatchObject([
        { kind: "conflict", entityKind: "note", taskRevision: 3 },
      ]);
      const remove = laptop.operation({
        kind: "note.delete",
        noteId,
        baseRevision: 3,
      });
      expect((await laptop.round([remove])).outcomes).toEqual([
        {
          kind: "applied",
          operationId: remove.operationId,
          entityId: noteId,
          entityRevision: 4,
          changeSequence: expect.any(Number) as number,
        },
      ]);
      expect((await laptop.round([remove])).outcomes).toMatchObject([
        { kind: "replayed", entityId: noteId, entityRevision: 4 },
      ]);
      const gone = await phone.round();
      expect(gone.changes.at(-1)).toMatchObject({
        entityKind: "note",
        entityId: noteId,
        kind: "deleted",
        snapshot: null,
      });
      expect(phone.notes.has(noteId)).toBe(false);
      // Editing the deleted note is a conflict that creates nothing.
      const late = phone.operation({
        kind: "note.patch",
        noteId,
        fields: { content: "Too late" },
        baseRevision: 3,
      });
      expect((await phone.round([late])).outcomes).toMatchObject([
        { kind: "conflict", entityKind: "note", taskId: noteId },
      ]);
      expect(
        noteListResponseSchema.parse(
          await (await call("/api/notes", "GET")).json(),
        ).notes,
      ).toEqual([]);
    } finally {
      await server.close();
    }
  });
});

it("delivers notes written through the browser routes and the assistant to another client's round and snapshot", async () => {
  await withTemporaryDirectory(async (directory) => {
    await mkdir(join(directory, "web"));
    const server = await startSuiteServer(configuration(directory), {
      disableNotificationTimer: true,
    });
    try {
      const call = await signIn(server);
      const client = clientRegistrationResponseSchema.parse(
        await (await call("/api/clients", "POST", { label: "Phone" })).json(),
      );
      const phone = new Device(call, {
        "X-Suite-Client-Id": client.client.id,
        "X-Suite-Client-Credential": client.clientCredential,
        "X-Suite-Sync-Version": "2",
      });
      await phone.round();

      // Browser routes: create, pin, reorder and delete.
      const post = async (content: string) =>
        noteResponseSchema.parse(
          await (await call("/api/notes", "POST", { content })).json(),
        ).note;
      const first = await post("From the browser");
      const second = await post("Second");
      await phone.round();
      expect([...phone.notes.values()].map(({ content }) => content)).toEqual([
        "From the browser",
        "Second",
      ]);
      expect(
        (
          await call(
            `/api/notes/${first.id}`,
            "PATCH",
            { content: "Edited in the browser", pinnedToToday: true },
            { "If-Match": '"1"' },
          )
        ).status,
      ).toBe(200);
      expect(
        (
          await call("/api/notes/order", "PUT", {
            items: [
              { id: second.id, revision: 1 },
              { id: first.id, revision: 2 },
            ],
          })
        ).status,
      ).toBe(200);
      const moved = await phone.round();
      // The edit, then one change per moved note.
      expect(
        moved.changes.map(({ entityId, entityRevision }) => [
          entityId,
          entityRevision,
        ]),
      ).toEqual([
        [first.id, 2],
        [second.id, 2],
        [first.id, 3],
      ]);
      expect(phone.notes.get(first.id)).toEqual({
        content: "Edited in the browser",
        revision: 3,
      });
      // A refused browser write appends nothing.
      expect(
        (
          await call(
            `/api/notes/${first.id}`,
            "PATCH",
            { content: "Stale" },
            { "If-Match": '"1"' },
          )
        ).status,
      ).toBe(412);
      expect((await phone.round()).changes).toEqual([]);
      expect(
        (
          await call(`/api/notes/${second.id}`, "DELETE", undefined, {
            "If-Match": '"2"',
          })
        ).status,
      ).toBe(204);
      expect((await phone.round()).changes).toMatchObject([
        { entityKind: "note", entityId: second.id, kind: "deleted" },
      ]);

      // The assistant: preview, then confirm.
      const { token } = createAutomationTokenResponseSchema.parse(
        await (
          await call("/api/automation/tokens", "POST", {
            label: "Assistant",
            scopes: ["notes:read", "notes:write"],
            expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          })
        ).json(),
      );
      const automation = async (path: string, body: unknown) =>
        fetch(`${server.baseUrl}${path}`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        });
      const assistantNote = randomUUID();
      const mutate = async (input: unknown) => {
        const previewed = await automation("/api/automation/v1/previews", {
          operation: "notes.mutate",
          input,
        });
        expect(previewed.status).toBe(201);
        const { preview } = automationPreviewResponseSchema.parse(
          await previewed.json(),
        );
        // A preview writes nothing, so the feed does not move.
        expect((await phone.round()).changes).toEqual([]);
        const confirmed = await automation(
          `/api/automation/v1/previews/${preview.id}/confirm`,
          { idempotencyKey: randomUUID() },
        );
        expect(confirmed.status).toBe(200);
        automationConfirmationResponseSchema.parse(await confirmed.json());
      };
      await mutate({
        action: "create",
        id: assistantNote,
        content: "From the assistant",
      });
      await phone.round();
      expect(phone.notes.get(assistantNote)).toEqual({
        content: "From the assistant",
        revision: 1,
      });
      await mutate({
        action: "update",
        id: assistantNote,
        expectedRevision: 1,
        patch: { content: "Assistant edit" },
      });
      await phone.round();
      expect(phone.notes.get(assistantNote)?.content).toBe("Assistant edit");
      await mutate({
        action: "delete",
        id: assistantNote,
        expectedRevision: 2,
      });
      await phone.round();
      expect(phone.notes.has(assistantNote)).toBe(false);

      // A new device starts from a snapshot that carries the notes.
      const fresh = clientRegistrationResponseSchema.parse(
        await (await call("/api/clients", "POST", { label: "Tablet" })).json(),
      );
      const snapshot = syncSnapshotResponseSchema.parse(
        await (
          await call("/api/sync/snapshot", "GET", undefined, {
            "X-Suite-Client-Id": fresh.client.id,
            "X-Suite-Client-Credential": fresh.clientCredential,
            "X-Suite-Sync-Version": "2",
          })
        ).json(),
      );
      expect(
        snapshot.snapshots.filter(({ entityKind }) => entityKind === "note"),
      ).toMatchObject([
        {
          entityKind: "note",
          value: {
            id: first.id,
            content: "Edited in the browser",
            pinnedToToday: true,
            revision: 3,
          },
        },
      ]);
      expect(snapshot.nextCursor).toBe(phone.cursor);
    } finally {
      await server.close();
    }
  });
});
