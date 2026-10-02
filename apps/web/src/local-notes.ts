import { noteSchema, type Note, type SyncOperation } from "@suite/contracts";

/**
 * Notes in the offline cache (ADR 0046). One pure function says what a queued
 * note operation does to a cached note. The local store uses it in three
 * places, so they cannot drift apart: the optimistic write when an operation
 * is queued, the replay of the outbox over a fresh snapshot, and the rebase
 * of still-pending operations after a sync round delivered the canonical
 * note.
 */
export type NoteOperation = Extract<
  SyncOperation,
  { readonly kind: "note.create" | "note.patch" | "note.delete" }
>;

export const isNoteOperation = (
  operation: SyncOperation,
): operation is NoteOperation =>
  operation.kind === "note.create" ||
  operation.kind === "note.patch" ||
  operation.kind === "note.delete";

export const noteIdForOperation = (operation: NoteOperation): string =>
  operation.kind === "note.create" ? operation.note.id : operation.noteId;

/** The owner's order: position, then creation time, then ID. */
export const compareNotes = (left: Note, right: Note): number =>
  left.position - right.position ||
  left.createdAt.localeCompare(right.createdAt) ||
  left.id.localeCompare(right.id);

/** Where a note created now goes: after every cached note. */
export const nextNotePosition = (notes: readonly Note[]): number =>
  notes.reduce((next, note) => Math.max(next, note.position + 1), 0);

/**
 * The cached note after one queued operation: the new value, `null` when the
 * operation deletes it, or `undefined` when there is nothing to change (a
 * patch or delete of a note that is not cached).
 *
 * A patched note takes the revision the server will give it (`baseRevision`
 * plus one), so a second offline edit is queued against the revision the
 * first one produces instead of conflicting with it.
 */
export const applyNoteOperation = (
  current: Note | undefined,
  operation: NoteOperation,
  /** Position of a created note; the server assigns the canonical one. */
  createdPosition: number = Number.MAX_SAFE_INTEGER,
): Note | null | undefined => {
  if (operation.kind === "note.create")
    return (
      current ??
      noteSchema.parse({
        ...operation.note,
        // The cache does not know the owner ID; the canonical note replaces
        // this placeholder after the next round.
        ownerId: operation.note.id,
        position: createdPosition,
        revision: 1,
        createdAt: operation.createdAt,
        updatedAt: operation.createdAt,
      })
    );
  if (current === undefined) return undefined;
  if (operation.kind === "note.delete") return null;
  const { fields } = operation;
  // Choosing one association clears the other, as the server does.
  const projectId =
    fields.projectId !== undefined
      ? fields.projectId
      : fields.tagId != null
        ? null
        : current.projectId;
  const tagId =
    fields.tagId !== undefined
      ? fields.tagId
      : fields.projectId != null
        ? null
        : current.tagId;
  return {
    ...current,
    content: fields.content ?? current.content,
    projectId,
    tagId,
    pinnedToToday: fields.pinnedToToday ?? current.pinnedToToday,
    position: fields.position ?? current.position,
    revision: operation.baseRevision + 1,
    updatedAt: operation.createdAt,
  };
};
