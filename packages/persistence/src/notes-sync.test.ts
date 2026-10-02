import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { withTemporaryDirectory } from "@suite/test-support";
import { SuiteDatabase } from "./index.ts";

const owner = "owner-1";
const client = "client-1";
const now = "2026-10-02T12:00:00.000Z";
const later = "2026-10-02T13:00:00.000Z";
const noteId = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const projectId = "1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e";

const open = (directory: string): SuiteDatabase => {
  const database = SuiteDatabase.open(join(directory, "suite.sqlite"));
  // A reopened database already has its owner, client and project.
  if (
    !database.createOwner({
      id: owner,
      username: "owner",
      displayName: "Owner",
      passwordHash: "hash",
      createdAt: now,
    })
  )
    return database;
  database.registerSyncClient({
    id: client,
    ownerId: owner,
    label: "Laptop",
    credentialHash: "credential-hash",
    createdAt: now,
    lastSeenAt: now,
    revokedAt: null,
  });
  database.mutateOrganization(
    "project",
    owner,
    projectId,
    null,
    { title: "Garden" },
    now,
  );
  return database;
};

const envelope = (operationId: string, at = now) => ({
  ownerId: owner,
  clientId: client,
  operationId,
  requestHash: `${operationId}-hash`,
  now: at,
});

const noteChanges = (database: SuiteDatabase) =>
  database
    .listSyncChanges(owner, database.getSyncState(owner).epoch, 0)
    .filter(({ entityType }) => entityType === "note")
    .map(({ entityId, kind, revision }) => ({ entityId, kind, revision }));

const create = (id = noteId, content = "First draft") => ({
  action: "create" as const,
  id,
  content,
  projectId: null,
  tagId: null,
  pinnedToToday: false,
});

describe("ADR 0046 notes in the sync feed", () => {
  it("creates, patches and deletes a note from the outbox idempotently", async () => {
    await withTemporaryDirectory((directory) => {
      const database = open(directory);
      const created = { ...envelope("create"), command: create() };
      expect(database.applyNoteSync(created)).toMatchObject({
        kind: "applied",
        revision: 1,
        record: { id: noteId, content: "First draft", position: 0 },
      });
      // A replay returns the stored outcome and writes nothing.
      expect(database.applyNoteSync(created)).toMatchObject({
        kind: "replayed",
        revision: 1,
      });
      // The same operation ID with another payload is refused.
      expect(
        database.applyNoteSync({ ...created, requestHash: "other" }).kind,
      ).toBe("idempotency-conflict");
      expect(
        database.applyNoteSync({
          ...envelope("patch", later),
          command: {
            action: "update",
            id: noteId,
            baseRevision: 1,
            patch: {
              content: "Second draft",
              projectId,
              pinnedToToday: true,
              position: 4,
            },
          },
        }),
      ).toMatchObject({
        kind: "applied",
        revision: 2,
        record: {
          content: "Second draft",
          projectId,
          pinnedToToday: true,
          position: 4,
          updatedAt: later,
        },
      });
      const remove = {
        ...envelope("delete", later),
        command: { action: "delete" as const, id: noteId, baseRevision: 2 },
      };
      // A deletion leaves no record; the outcome still carries a revision.
      expect(database.applyNoteSync(remove)).toEqual({
        kind: "applied",
        revision: 3,
      });
      expect(database.applyNoteSync(remove)).toEqual({
        kind: "replayed",
        revision: 3,
      });
      expect(database.notes.get(owner, noteId)).toBeUndefined();
      expect(noteChanges(database)).toEqual([
        { entityId: noteId, kind: "upsert", revision: 1 },
        { entityId: noteId, kind: "upsert", revision: 2 },
        { entityId: noteId, kind: "deleted", revision: 3 },
      ]);
      database.close();
    });
  });

  it("turns a stale, missing or invalid note write into a conflict that changes nothing", async () => {
    await withTemporaryDirectory((directory) => {
      let database = open(directory);
      database.applyNoteSync({ ...envelope("create"), command: create() });
      // Another device edits the note first.
      database.notes.update(owner, noteId, 1, { content: "Theirs" }, later);
      const stale = {
        ...envelope("stale", later),
        command: {
          action: "update" as const,
          id: noteId,
          baseRevision: 1,
          patch: { content: "Mine" },
        },
      };
      expect(database.applyNoteSync(stale)).toMatchObject({
        kind: "conflict",
        fields: ["revision"],
        revision: 2,
        record: { content: "Theirs", revision: 2 },
      });
      // Nothing was overwritten, and the canonical note is re-sent so the
      // client can show both versions.
      expect(database.notes.get(owner, noteId)?.content).toBe("Theirs");
      expect(noteChanges(database)).toEqual([
        { entityId: noteId, kind: "upsert", revision: 1 },
        { entityId: noteId, kind: "upsert", revision: 2 },
        { entityId: noteId, kind: "upsert", revision: 2 },
      ]);
      expect(
        database.applyNoteSync({
          ...envelope("stale-delete", later),
          command: { action: "delete", id: noteId, baseRevision: 1 },
        }),
      ).toMatchObject({ kind: "conflict", fields: ["revision"] });
      expect(
        database.applyNoteSync({
          ...envelope("duplicate"),
          command: create(noteId, "Again"),
        }),
      ).toMatchObject({ kind: "conflict", fields: ["record"] });
      const unknown = "2c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f";
      expect(
        database.applyNoteSync({
          ...envelope("no-project"),
          command: { ...create(unknown), projectId: unknown },
        }),
      ).toMatchObject({ kind: "conflict", fields: ["project"] });
      expect(
        database.applyNoteSync({
          ...envelope("no-tag", later),
          command: {
            action: "update",
            id: noteId,
            baseRevision: 2,
            patch: { tagId: unknown },
          },
        }),
      ).toMatchObject({ kind: "conflict", fields: ["tag"] });
      expect(
        database.applyNoteSync({
          ...envelope("gone", later),
          command: {
            action: "update",
            id: unknown,
            baseRevision: 1,
            patch: { content: "Lost" },
          },
        }),
      ).toEqual({ kind: "conflict", fields: ["record"] });
      expect(database.notes.list(owner)).toMatchObject([
        { id: noteId, content: "Theirs", revision: 2 },
      ]);

      // A stored conflict replays as the same conflict after a restart.
      database.close();
      database = open(directory);
      const changes = noteChanges(database).length;
      expect(database.applyNoteSync(stale)).toMatchObject({
        kind: "conflict",
        fields: ["revision"],
        record: { content: "Theirs" },
      });
      expect(noteChanges(database)).toHaveLength(changes);
      database.close();
    });
  });

  it("carries notes in the snapshot and appends a change on every store path", async () => {
    await withTemporaryDirectory((directory) => {
      const database = open(directory);
      const second = "3d4e5f6a-7b8c-4d9e-8f1a-2b3c4d5e6f7a";
      // The browser route and the assistant both call the store.
      database.notes.create(owner, create(), now);
      database.notes.create(owner, create(second, "Second"), now);
      database.notes.update(owner, noteId, 1, { pinnedToToday: true }, later);
      database.notes.reorder(
        owner,
        [
          { id: second, revision: 1 },
          { id: noteId, revision: 2 },
        ],
        later,
      );
      expect(database.fullSyncSnapshot(owner).notes).toMatchObject([
        { id: second, position: 0, revision: 2 },
        { id: noteId, position: 1, revision: 3, pinnedToToday: true },
      ]);
      database.notes.delete(owner, second, 2, later);
      expect(noteChanges(database)).toEqual([
        { entityId: noteId, kind: "upsert", revision: 1 },
        { entityId: second, kind: "upsert", revision: 1 },
        { entityId: noteId, kind: "upsert", revision: 2 },
        { entityId: second, kind: "upsert", revision: 2 },
        { entityId: noteId, kind: "upsert", revision: 3 },
        { entityId: second, kind: "deleted", revision: 3 },
      ]);
      // A refused write appends nothing.
      const before = noteChanges(database).length;
      expect(
        database.notes.update(owner, noteId, 1, { content: "Stale" }, later)
          .kind,
      ).toBe("conflict");
      expect(database.notes.delete(owner, noteId, 1, later).kind).toBe(
        "conflict",
      );
      expect(noteChanges(database)).toHaveLength(before);
      database.close();
    });
  });

  it("resets the sync epoch once so existing clients receive existing notes", async () => {
    await withTemporaryDirectory((directory) => {
      const path = join(directory, "suite.sqlite");
      let database = open(directory);
      database.notes.create(owner, create(), now);
      const before = database.getSyncState(owner);
      expect(before.cursor).toBeGreaterThan(0);
      database.close();
      // A database from before migration 0049: the note exists but no feed
      // change announces it, and the retained floor is above zero.
      const legacy = new DatabaseSync(path);
      legacy.exec(
        "DELETE FROM sync_changes WHERE entity_type='note'; UPDATE sync_owner_state SET retained_floor=1; DELETE FROM schema_migrations WHERE id='0049_sync_notes_epoch_reset';",
      );
      legacy.close();

      database = open(directory);
      try {
        expect(database.state().appliedMigrationCount).toBe(
          database.state().expectedMigrationCount,
        );
        const after = database.getSyncState(owner);
        expect(after.epoch).not.toBe(before.epoch);
        expect(after.cursor).toBe(0);
        expect(database.getSyncRetention(owner).floor).toBe(0);
        // The old cursor cannot be served: the client takes a snapshot,
        // which carries the note.
        expect(
          database.pageSyncChanges(owner, before.epoch, before.cursor)
            .resetRequired,
        ).toBe(true);
        expect(database.fullSyncSnapshot(owner).notes).toMatchObject([
          { id: noteId, content: "First draft" },
        ]);
        // Operation outcomes survive, so a queued replay stays idempotent.
        database.applyNoteSync({
          ...envelope("after-reset", later),
          command: {
            action: "update",
            id: noteId,
            baseRevision: 1,
            patch: { content: "Edited" },
          },
        });
        expect(noteChanges(database)).toEqual([
          { entityId: noteId, kind: "upsert", revision: 2 },
        ]);
      } finally {
        database.close();
      }
    });
  });
});
