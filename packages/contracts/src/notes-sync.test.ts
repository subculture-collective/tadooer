import { describe, expect, it } from "vitest";
import {
  liveSyncResourceFamilySchema,
  syncChangeSchema,
  syncDiagnosticOperationSchema,
  syncEntitySnapshotSchema,
  syncOperationEntity,
  syncOperationOutcomeSchema,
  syncOperationSchema,
  syncRoundRequestSchema,
} from "./index.ts";

const id = (tail: string): string =>
  `00000000-0000-4000-8000-0000000000${tail}`;
const at = "2026-10-02T12:00:00.000Z";
const base = {
  operationId: id("01"),
  clientSequence: 1,
  createdAt: at,
  requestHash: "a".repeat(43),
};
const note = {
  id: id("30"),
  ownerId: id("99"),
  content: "# Plan\n- [ ] water",
  projectId: null,
  tagId: id("11"),
  pinnedToToday: true,
  position: 2,
  revision: 3,
  createdAt: at,
  updatedAt: at,
};

describe("ADR 0046 note sync contracts", () => {
  it("describes note create, patch and delete with one base revision", () => {
    const create = {
      ...base,
      kind: "note.create",
      note: {
        id: id("30"),
        content: "Hello",
        projectId: id("10"),
        tagId: null,
        pinnedToToday: false,
      },
    };
    expect(syncOperationSchema.parse(create)).toEqual(create);
    // Every created field is explicit: no default can change the hash.
    for (const key of ["projectId", "tagId", "pinnedToToday"] as const)
      expect(
        syncOperationSchema.safeParse({
          ...create,
          note: Object.fromEntries(
            Object.entries(create.note).filter(([name]) => name !== key),
          ),
        }).success,
        key,
      ).toBe(false);
    const rejects = (operation: object) =>
      expect(
        syncOperationSchema.safeParse({ ...base, ...operation }).success,
      ).toBe(false);
    rejects({ ...create, note: { ...create.note, content: "   " } });
    rejects({
      ...create,
      note: { ...create.note, content: "x".repeat(20001) },
    });
    rejects({ ...create, note: { ...create.note, tagId: id("11") } });
    rejects({ ...create, note: { ...create.note, position: 1 } });

    const patch = {
      ...base,
      kind: "note.patch",
      noteId: id("30"),
      fields: { content: "Edited", pinnedToToday: true, position: 0 },
      baseRevision: 2,
    };
    expect(syncOperationSchema.parse(patch)).toEqual(patch);
    rejects({ ...patch, fields: {} });
    rejects({ ...patch, fields: { title: "No such field" } });
    rejects({ ...patch, fields: { projectId: id("10"), tagId: id("11") } });
    rejects({ ...patch, fields: { position: -1 } });
    rejects({ ...patch, baseRevision: 0 });
    rejects({ ...patch, baseRevision: undefined });
    // Clearing both associations makes the note standalone.
    expect(
      syncOperationSchema.safeParse({
        ...patch,
        fields: { projectId: null, tagId: null },
      }).success,
    ).toBe(true);

    const remove = {
      ...base,
      kind: "note.delete",
      noteId: id("30"),
      baseRevision: 3,
    };
    expect(syncOperationSchema.parse(remove)).toEqual(remove);
    rejects({ ...remove, baseRevision: undefined });

    expect(
      [create, patch, remove].map((operation) =>
        syncOperationEntity(syncOperationSchema.parse(operation)),
      ),
    ).toEqual([
      { entityKind: "note", entityId: id("30") },
      { entityKind: "note", entityId: id("30") },
      { entityKind: "note", entityId: id("30") },
    ]);
    expect(
      syncRoundRequestSchema.safeParse({
        cursor: null,
        pullLimit: 100,
        operations: [
          create,
          { ...patch, operationId: id("02"), clientSequence: 2 },
          { ...remove, operationId: id("03"), clientSequence: 3 },
        ],
      }).success,
    ).toBe(true);
  });

  it("carries a note as a snapshot, a feed change and a conflict", () => {
    expect(
      syncEntitySnapshotSchema.parse({ entityKind: "note", value: note }),
    ).toEqual({ entityKind: "note", value: note });
    expect(
      syncEntitySnapshotSchema.safeParse({
        entityKind: "note",
        value: { ...note, revision: 0 },
      }).success,
    ).toBe(false);
    const change = {
      sequence: 7,
      entityKind: "note",
      entityId: note.id,
      kind: "upsert",
      entityRevision: 3,
      changedAt: at,
      snapshot: { entityKind: "note", value: note },
    };
    expect(syncChangeSchema.parse(change)).toEqual(change);
    expect(
      syncChangeSchema.parse({ ...change, kind: "deleted", snapshot: null }),
    ).toMatchObject({ kind: "deleted", snapshot: null });
    expect(
      syncOperationOutcomeSchema.parse({
        kind: "conflict",
        operationId: id("01"),
        code: "SYNC_RESOURCE_CONFLICT",
        entityKind: "note",
        taskId: note.id,
        taskRevision: 3,
      }),
    ).toMatchObject({ entityKind: "note" });
    for (const kind of ["note.create", "note.patch", "note.delete"])
      expect(
        syncDiagnosticOperationSchema.safeParse({
          operationId: id("01"),
          entityId: note.id,
          kind,
          state: "conflicted",
          requestHash: "a".repeat(43),
          baseRevision: kind === "note.create" ? null : 3,
          safeErrorCode: "SYNC_RESOURCE_CONFLICT",
        }).success,
        kind,
      ).toBe(true);
  });

  it("keeps the retired notes resource family parseable", () => {
    // The server no longer emits it; an older server still may.
    expect(liveSyncResourceFamilySchema.safeParse("notes").success).toBe(true);
  });
});
