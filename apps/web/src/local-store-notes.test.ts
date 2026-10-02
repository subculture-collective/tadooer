import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import {
  syncOperationSchema,
  syncRoundRequestSchema,
  type ClientRegistrationResponse,
  type Note,
  type SyncChange,
  type SyncOperation,
  type SyncRoundResponse,
} from "@suite/contracts";
import { LocalStore } from "./local-store.ts";
import { applyNoteOperation, type NoteOperation } from "./local-notes.ts";

/** Notes in the offline cache and the outbox (ADR 0046, issue #114). */

const registration: ClientRegistrationResponse = {
  client: {
    id: "1b34cc57-972c-42e8-bafa-0ba455dced20",
    ownerId: "728a504a-0997-4eb3-94dd-5d6ff8af5967",
    label: "Test browser",
    createdAt: "2026-10-02T16:00:00.000Z",
    lastSeenAt: "2026-10-02T16:00:00.000Z",
    revokedAt: null,
  },
  clientCredential: "A".repeat(43),
  protocolVersion: 2 as const,
  initialCursor: "sync-v1.epoch.0.tag",
};

const now = "2026-10-02T16:00:00.000Z";
const noteId = "6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f";
const projectId = "7a2d3e4f-5b6c-4d7e-9f8a-1b2c3d4e5f6a";

const serverNote = (overrides: Partial<Note> = {}): Note => ({
  id: noteId,
  ownerId: registration.client.ownerId,
  content: "Server text",
  projectId: null,
  tagId: null,
  pinnedToToday: false,
  position: 0,
  revision: 2,
  createdAt: now,
  updatedAt: now,
  ...overrides,
});

const snapshotResponse = (notes: readonly Note[], cursor = "cursor-1") => ({
  snapshots: notes.map((value) => ({ entityKind: "note" as const, value })),
  nextCursor: cursor,
  hasMore: false,
  protocolVersion: 2 as const,
  serverTimestamp: now,
});

const round = (
  overrides: Partial<SyncRoundResponse> = {},
): SyncRoundResponse => ({
  outcomes: [],
  changes: [],
  nextCursor: "cursor-2",
  hasMore: false,
  protocolVersion: 2 as const,
  serverTimestamp: now,
  ...overrides,
});

const upsert = (note: Note, sequence: number): SyncChange => ({
  sequence,
  entityKind: "note",
  entityId: note.id,
  kind: "upsert",
  entityRevision: note.revision,
  changedAt: now,
  snapshot: { entityKind: "note", value: note },
});

const applied = (operation: SyncOperation, revision: number) => ({
  kind: "applied" as const,
  operationId: operation.operationId,
  entityId: noteId,
  entityRevision: revision,
  changeSequence: 1,
});

const conflict = (operation: SyncOperation, revision: number) => ({
  kind: "conflict" as const,
  operationId: operation.operationId,
  code: "SYNC_RESOURCE_CONFLICT" as const,
  entityKind: "note" as const,
  taskId: noteId,
  taskRevision: revision,
});

const openStore = async (
  notes: readonly Note[] = [serverNote()],
  indexedDb = new IDBFactory(),
) => {
  const store = new LocalStore({ indexedDb, now: () => now });
  await store.ensureClient(() => Promise.resolve(registration));
  await store.replaceFromSnapshot(snapshotResponse(notes));
  return store;
};

const contents = async (store: LocalStore) =>
  (await store.loadCachedNotes()).map(({ content }) => content);

describe("applyNoteOperation", () => {
  const base = {
    operationId: "00000000-0000-4000-8000-000000000001",
    clientSequence: 1,
    createdAt: now,
    requestHash: "a".repeat(43),
  };
  const parse = (operation: object) =>
    syncOperationSchema.parse({ ...base, ...operation }) as NoteOperation;

  it("predicts the server's result for create, patch and delete", () => {
    const created = applyNoteOperation(
      undefined,
      parse({
        kind: "note.create",
        note: {
          id: noteId,
          content: "New",
          projectId,
          tagId: null,
          pinnedToToday: true,
        },
      }),
      3,
    );
    expect(created).toMatchObject({
      id: noteId,
      content: "New",
      projectId,
      pinnedToToday: true,
      position: 3,
      revision: 1,
    });
    const tag = "8b3e4f5a-6c7d-4e8f-8a9b-2c3d4e5f6a7b";
    // Choosing a tag clears the project; the revision is the next one.
    expect(
      applyNoteOperation(
        serverNote({ projectId }),
        parse({
          kind: "note.patch",
          noteId,
          fields: { tagId: tag, content: "Edited", position: 5 },
          baseRevision: 2,
        }),
      ),
    ).toMatchObject({
      content: "Edited",
      projectId: null,
      tagId: tag,
      position: 5,
      revision: 3,
    });
    const remove = parse({ kind: "note.delete", noteId, baseRevision: 2 });
    expect(applyNoteOperation(serverNote(), remove)).toBeNull();
    // Nothing cached: nothing to patch or delete.
    expect(applyNoteOperation(undefined, remove)).toBeUndefined();
  });
});

describe("LocalStore notes", () => {
  it("caches notes from the snapshot and the feed without a schema change", async () => {
    const indexedDb = new IDBFactory();
    const pinned = serverNote({
      id: "9c4f5a6b-7d8e-4f9a-8b0c-3d4e5f6a7b8c",
      content: "Pinned",
      pinnedToToday: true,
      position: 1,
    });
    const store = await openStore([pinned, serverNote()], indexedDb);
    // Sorted by position, whatever order the snapshot had.
    expect(await contents(store)).toEqual(["Server text", "Pinned"]);
    await store.applySyncRound(
      round({
        changes: [
          upsert(serverNote({ content: "Edited elsewhere", revision: 3 }), 5),
          {
            sequence: 6,
            entityKind: "note",
            entityId: pinned.id,
            kind: "deleted",
            entityRevision: 3,
            changedAt: now,
            snapshot: null,
          },
        ],
      }),
    );
    expect(await store.loadCachedNotes()).toEqual([
      serverNote({ content: "Edited elsewhere", revision: 3 }),
    ]);
    await store.close();

    // The cache survives a restart and the database is still version 2:
    // notes use the existing entity store, so no upgrade ran and existing
    // outboxes were not touched.
    const reopened = new LocalStore({ indexedDb, now: () => now });
    expect(await contents(reopened)).toEqual(["Edited elsewhere"]);
    await reopened.close();
    const databases = await indexedDb.databases();
    expect(databases).toEqual([{ name: "suite-local-v1", version: 2 }]);
  });

  it("queues create, edit, pin, move and delete offline and shows them at once", async () => {
    const store = await openStore();
    const create = await store.queueNoteCreate({
      content: "Written offline",
      projectId,
      pinnedToToday: true,
    });
    if (create.kind !== "note.create") throw new Error("expected create");
    expect(create.note).toMatchObject({
      content: "Written offline",
      projectId,
      tagId: null,
      pinnedToToday: true,
    });
    const created = create.note.id;
    // Rendered from the cache with no connection, after the server note.
    expect(await store.loadCachedNotes()).toMatchObject([
      { id: noteId, position: 0 },
      { id: created, position: 1, revision: 1, pinnedToToday: true },
    ]);

    // Two edits in a row: the second is based on the first's revision, so
    // they cannot conflict with each other.
    const edit = await store.queueNotePatch(created, { content: "Edit one" });
    const again = await store.queueNotePatch(created, {
      content: "Edit two",
      pinnedToToday: false,
    });
    expect(edit).toMatchObject({ kind: "note.patch", baseRevision: 1 });
    expect(again).toMatchObject({ kind: "note.patch", baseRevision: 2 });
    // Moving swaps two positions with two revisioned patches.
    const up = await store.queueNotePatch(created, { position: 0 });
    const down = await store.queueNotePatch(noteId, { position: 1 });
    expect(up).toMatchObject({ baseRevision: 3 });
    expect(down).toMatchObject({ baseRevision: 2 });
    expect(await store.loadCachedNotes()).toMatchObject([
      { id: created, content: "Edit two", pinnedToToday: false, revision: 4 },
      { id: noteId, content: "Server text", revision: 3 },
    ]);
    const remove = await store.queueNoteDelete(noteId);
    expect(remove).toMatchObject({ kind: "note.delete", baseRevision: 3 });
    expect(await contents(store)).toEqual(["Edit two"]);

    const outbox = await store.loadOutbox();
    expect(
      outbox.map(({ operation, state }) => [operation.kind, state]),
    ).toEqual([
      ["note.create", "queued"],
      ["note.patch", "queued"],
      ["note.patch", "queued"],
      ["note.patch", "queued"],
      ["note.patch", "queued"],
      ["note.delete", "queued"],
    ]);
    expect(outbox.map(({ operation }) => operation.clientSequence)).toEqual([
      1, 2, 3, 4, 5, 6,
    ]);
    // The queue is a valid sync round as it stands.
    expect(
      syncRoundRequestSchema.safeParse({
        cursor: null,
        operations: outbox.map(({ operation }) => operation),
        pullLimit: 100,
      }).success,
    ).toBe(true);
    await expect(
      store.queueNotePatch(noteId, { content: "Gone" }),
    ).rejects.toThrow("not present in the local cache");
    // The recovery manifest names operations, never note text.
    const manifest = JSON.stringify(await store.recoverySupportManifest());
    expect(manifest).toContain("note.create");
    expect(manifest).not.toContain("Written offline");
    expect(manifest).not.toContain("Edit two");
  });

  it("replays queued note operations over a snapshot after a cursor reset", async () => {
    const store = await openStore();
    const create = await store.queueNoteCreate({ content: "Offline note" });
    if (create.kind !== "note.create") throw new Error("expected create");
    await store.queueNotePatch(noteId, { content: "Local edit" });
    const doomed = serverNote({
      id: "9c4f5a6b-7d8e-4f9a-8b0c-3d4e5f6a7b8c",
      content: "To delete",
      position: 1,
    });

    // The server reset its epoch (migration 0049, a restore, or pruning).
    await store.markResetRequired();
    expect(await store.requiresSnapshot()).toBe(true);
    await store.replaceFromSnapshot(
      snapshotResponse([serverNote(), doomed], "cursor-after-reset"),
    );
    expect(await store.requiresSnapshot()).toBe(false);
    // The canonical notes arrive and the pending writes are re-applied.
    expect(await store.loadCachedNotes()).toMatchObject([
      { id: noteId, content: "Local edit", revision: 3 },
      { id: doomed.id, content: "To delete" },
      { id: create.note.id, content: "Offline note", revision: 1 },
    ]);
    expect((await store.clientIdentity())?.cursor).toBe("cursor-after-reset");

    await store.queueNoteDelete(doomed.id);
    await store.replaceFromSnapshot(
      snapshotResponse([serverNote(), doomed], "cursor-again"),
    );
    expect(await contents(store)).toEqual(["Local edit", "Offline note"]);
    // The outbox itself is immutable through both resets.
    expect((await store.loadOutbox()).map(({ state }) => state)).toEqual([
      "queued",
      "queued",
      "queued",
    ]);
  });

  it("keeps an edit queued during a round on top of the canonical note", async () => {
    const store = await openStore();
    const first = await store.queueNotePatch(noteId, { content: "First" });
    // Queued while the round carrying `first` was in flight.
    const second = await store.queueNotePatch(noteId, { content: "Second" });
    await store.applySyncRound(
      round({
        outcomes: [applied(first, 3)],
        changes: [upsert(serverNote({ content: "First", revision: 3 }), 4)],
      }),
    );
    // The pending edit is still visible and the next one builds on it.
    expect(await store.loadCachedNotes()).toMatchObject([
      { content: "Second", revision: 4 },
    ]);
    const third = await store.queueNotePatch(noteId, { content: "Third" });
    expect(second).toMatchObject({ baseRevision: 3 });
    expect(third).toMatchObject({ baseRevision: 4 });
  });

  it("shows both versions of a conflicted edit and keeps the server's on dismissal", async () => {
    const store = await openStore();
    const edit = await store.queueNotePatch(noteId, {
      content: "My text",
      pinnedToToday: true,
    });
    const theirs = serverNote({ content: "Their text", revision: 3 });
    await store.applySyncRound(
      round({ outcomes: [conflict(edit, 3)], changes: [upsert(theirs, 4)] }),
    );
    // The cache shows the server's note; nothing was merged.
    expect(await store.loadCachedNotes()).toEqual([theirs]);
    const [review] = await store.loadConflictReviews();
    expect(review).toMatchObject({
      conflict: { entityKind: "note", taskId: noteId, taskRevision: 3 },
      retryLocalSupported: true,
      note: {
        canonical: { content: "Their text", revision: 3 },
        attempted: "patch",
        local: { content: "My text", pinnedToToday: true },
        keepBothSupported: true,
      },
    });
    const input = {
      operationId: edit.operationId,
      reviewedFieldVersions: {},
    };
    // A review of an older revision is refused.
    await expect(
      store.resolveTaskConflict({
        ...input,
        choice: "keep-current",
        reviewedTaskRevision: 2,
      }),
    ).rejects.toThrow("review the latest values");
    expect(
      await store.resolveTaskConflict({
        ...input,
        choice: "keep-current",
        reviewedTaskRevision: 3,
      }),
    ).toBeNull();
    expect(await store.loadConflicts()).toEqual([]);
    expect(await store.loadCachedNotes()).toEqual([theirs]);
    // The original operation stays in the outbox as an audit record.
    expect(await store.loadOutbox()).toMatchObject([
      {
        operation: { operationId: edit.operationId },
        state: "resolved",
        resolutionChoice: "keep-current",
      },
    ]);
  });

  it("saves the local text as a new note when the owner keeps both", async () => {
    const store = await openStore();
    const edit = await store.queueNotePatch(noteId, {
      content: "My text",
      projectId,
    });
    const theirs = serverNote({ content: "Their text", revision: 3 });
    await store.applySyncRound(
      round({ outcomes: [conflict(edit, 3)], changes: [upsert(theirs, 4)] }),
    );
    const copy = await store.resolveTaskConflict({
      operationId: edit.operationId,
      choice: "keep-both",
      reviewedTaskRevision: 3,
      reviewedFieldVersions: {},
    });
    if (copy?.kind !== "note.create") throw new Error("expected a new note");
    expect(copy.note).toMatchObject({ content: "My text", projectId });
    expect(copy.note.id).not.toBe(noteId);
    // Both versions exist: the server's note untouched, mine beside it.
    expect(await store.loadCachedNotes()).toMatchObject([
      { id: noteId, content: "Their text", revision: 3 },
      { id: copy.note.id, content: "My text", projectId, revision: 1 },
    ]);
    expect(await store.loadConflicts()).toEqual([]);
    expect(await store.loadOutbox()).toMatchObject([
      {
        state: "resolved",
        resolutionChoice: "keep-both",
        replacementOperationId: copy.operationId,
      },
      { operation: { kind: "note.create" }, state: "queued" },
    ]);
  });

  it("replaces the server's note only when the owner retries the local edit", async () => {
    const store = await openStore();
    const edit = await store.queueNotePatch(noteId, { content: "My text" });
    const theirs = serverNote({ content: "Their text", revision: 3 });
    await store.applySyncRound(
      round({ outcomes: [conflict(edit, 3)], changes: [upsert(theirs, 4)] }),
    );
    // A newer pending edit of the same note blocks the retry.
    await store.queueNotePatch(noteId, { pinnedToToday: true });
    expect((await store.loadConflictReviews())[0]).toMatchObject({
      retryLocalSupported: false,
      retryLocalUnavailableReason: "pending-local-sync",
    });
    const resolve = () =>
      store.resolveTaskConflict({
        operationId: edit.operationId,
        choice: "retry-local",
        reviewedTaskRevision: 4,
        reviewedFieldVersions: {},
      });
    await expect(resolve()).rejects.toThrow("must finish syncing");
    const pin = (await store.loadOutbox()).at(-1)?.operation;
    if (pin === undefined) throw new Error("missing pin");
    await store.applySyncRound(
      round({
        outcomes: [applied(pin, 4)],
        changes: [upsert({ ...theirs, pinnedToToday: true, revision: 4 }, 5)],
      }),
    );
    const retry = await resolve();
    // The same fields, now against the revision the owner reviewed.
    expect(retry).toMatchObject({
      kind: "note.patch",
      noteId,
      fields: { content: "My text" },
      baseRevision: 4,
    });
    expect(await store.loadCachedNotes()).toMatchObject([
      { content: "My text", pinnedToToday: true, revision: 5 },
    ]);
    expect(await store.loadConflicts()).toEqual([]);
  });

  it("handles a note that is gone on the server and a stale delete", async () => {
    const store = await openStore();
    const edit = await store.queueNotePatch(noteId, { content: "My text" });
    await store.applySyncRound(
      round({
        outcomes: [conflict(edit, 1)],
        changes: [
          {
            sequence: 4,
            entityKind: "note",
            entityId: noteId,
            kind: "deleted",
            entityRevision: 3,
            changedAt: now,
            snapshot: null,
          },
        ],
      }),
    );
    expect(await store.loadCachedNotes()).toEqual([]);
    expect((await store.loadConflictReviews())[0]).toMatchObject({
      retryLocalSupported: false,
      note: {
        canonical: null,
        local: { content: "My text" },
        keepBothSupported: true,
      },
    });
    await expect(
      store.resolveTaskConflict({
        operationId: edit.operationId,
        choice: "retry-local",
        reviewedTaskRevision: 1,
        reviewedFieldVersions: {},
      }),
    ).rejects.toThrow("cannot be retried locally");
    // The text is not lost: it becomes a new note.
    const copy = await store.resolveTaskConflict({
      operationId: edit.operationId,
      choice: "keep-both",
      reviewedTaskRevision: 1,
      reviewedFieldVersions: {},
    });
    expect(copy).toMatchObject({ kind: "note.create" });
    expect(await contents(store)).toEqual(["My text"]);

    // A delete of a note that changed elsewhere brings the note back.
    const other = await openStore();
    const remove = await other.queueNoteDelete(noteId);
    expect(await other.loadCachedNotes()).toEqual([]);
    const theirs = serverNote({ content: "Their text", revision: 3 });
    await other.applySyncRound(
      round({ outcomes: [conflict(remove, 3)], changes: [upsert(theirs, 4)] }),
    );
    expect(await other.loadCachedNotes()).toEqual([theirs]);
    expect((await other.loadConflictReviews())[0]).toMatchObject({
      retryLocalSupported: true,
      note: { attempted: "delete", local: null, keepBothSupported: false },
    });
    await expect(
      other.resolveTaskConflict({
        operationId: remove.operationId,
        choice: "keep-both",
        reviewedTaskRevision: 3,
        reviewedFieldVersions: {},
      }),
    ).rejects.toThrow("no local note text");
    expect(
      await other.resolveTaskConflict({
        operationId: remove.operationId,
        choice: "retry-local",
        reviewedTaskRevision: 3,
        reviewedFieldVersions: {},
      }),
    ).toMatchObject({ kind: "note.delete", baseRevision: 3 });
    expect(await other.loadCachedNotes()).toEqual([]);
  });

  it("removes a created note the server refused", async () => {
    const store = await openStore([]);
    const create = await store.queueNoteCreate({
      content: "For a project that is gone",
      projectId,
    });
    if (create.kind !== "note.create") throw new Error("expected create");
    expect(await contents(store)).toEqual(["For a project that is gone"]);
    await store.applySyncRound(
      round({
        outcomes: [{ ...conflict(create, 1), taskId: create.note.id }],
      }),
    );
    // Not in the cache as if it had synced, and not lost either.
    expect(await store.loadCachedNotes()).toEqual([]);
    expect((await store.loadConflictReviews())[0]).toMatchObject({
      retryLocalSupported: false,
      note: {
        canonical: null,
        attempted: "create",
        local: { content: "For a project that is gone" },
        keepBothSupported: true,
      },
    });
  });
});
