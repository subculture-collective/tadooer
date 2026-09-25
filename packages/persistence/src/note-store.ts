import type { DatabaseSync } from "node:sqlite";

export interface NoteRecord {
  readonly id: string;
  readonly ownerId: string;
  readonly content: string;
  readonly projectId: string | null;
  readonly tagId: string | null;
  readonly pinnedToToday: boolean;
  readonly position: number;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface NoteCreateInput {
  readonly id: string;
  readonly content: string;
  readonly projectId: string | null;
  readonly tagId: string | null;
  readonly pinnedToToday: boolean;
}

export interface NotePatch {
  readonly content?: string | undefined;
  readonly projectId?: string | null | undefined;
  readonly tagId?: string | null | undefined;
  readonly pinnedToToday?: boolean | undefined;
}

export type NoteMutationResult =
  | { readonly kind: "applied"; readonly notes: readonly NoteRecord[] }
  | { readonly kind: "conflict" }
  | { readonly kind: "invalid" };

type Row = Record<string, string | number | null>;

const maxContent = 20_000;

/**
 * Owner-scoped project, tag and standalone notes. Notes are online HTTP
 * records: they are not part of the sync change feed or the offline cache
 * (ADR 0019). Mutations use savepoints so they nest inside automation
 * confirmation and import transactions.
 */
export class SqliteNoteStore {
  readonly #database: DatabaseSync;

  constructor(database: DatabaseSync) {
    this.#database = database;
  }

  list(ownerId: string): readonly NoteRecord[] {
    return (
      this.#database
        .prepare(
          "SELECT * FROM notes WHERE owner_id=? ORDER BY position, created_at, id",
        )
        .all(ownerId) as unknown as readonly Row[]
    ).map(fromRow);
  }

  get(ownerId: string, id: string): NoteRecord | undefined {
    const row = this.#database
      .prepare("SELECT * FROM notes WHERE owner_id=? AND id=?")
      .get(ownerId, id) as Row | undefined;
    return row === undefined ? undefined : fromRow(row);
  }

  /** Owner-checked association: archived projects/tags remain valid targets. */
  associationExists(
    ownerId: string,
    projectId: string | null,
    tagId: string | null,
  ): boolean {
    if (projectId !== null && tagId !== null) return false;
    if (projectId !== null)
      return (
        this.#database
          .prepare("SELECT 1 FROM projects WHERE owner_id=? AND id=?")
          .get(ownerId, projectId) !== undefined
      );
    if (tagId !== null)
      return (
        this.#database
          .prepare("SELECT 1 FROM tags WHERE owner_id=? AND id=?")
          .get(ownerId, tagId) !== undefined
      );
    return true;
  }

  /** Inserts one note at the end of the owner's order without a savepoint. */
  insert(
    ownerId: string,
    input: NoteCreateInput & {
      readonly createdAt: string;
      readonly updatedAt: string;
      readonly position?: number;
    },
  ): NoteRecord {
    const position =
      input.position ??
      Number(
        (
          this.#database
            .prepare(
              "SELECT coalesce(max(position) + 1, 0) AS next FROM notes WHERE owner_id=?",
            )
            .get(ownerId) as { next: unknown }
        ).next,
      );
    this.#database
      .prepare(
        "INSERT INTO notes (id,owner_id,project_id,tag_id,content,pinned_to_today,position,revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?,1,?,?)",
      )
      .run(
        input.id,
        ownerId,
        input.projectId,
        input.tagId,
        input.content,
        input.pinnedToToday ? 1 : 0,
        position,
        input.createdAt,
        input.updatedAt,
      );
    const created = this.get(ownerId, input.id);
    if (created === undefined) throw new Error("Created note is missing");
    return created;
  }

  create(
    ownerId: string,
    input: NoteCreateInput,
    now: string,
  ): NoteMutationResult {
    if (
      !validContent(input.content) ||
      !this.associationExists(ownerId, input.projectId, input.tagId)
    )
      return { kind: "invalid" };
    return this.#transaction(() => {
      if (
        this.#database
          .prepare("SELECT 1 FROM notes WHERE id=?")
          .get(input.id) !== undefined
      )
        return { kind: "conflict" };
      return {
        kind: "applied",
        notes: [
          this.insert(ownerId, { ...input, createdAt: now, updatedAt: now }),
        ],
      };
    });
  }

  update(
    ownerId: string,
    id: string,
    expectedRevision: number,
    patch: NotePatch,
    now: string,
  ): NoteMutationResult {
    if (
      Object.values(patch).every((value) => value === undefined) ||
      (patch.content !== undefined && !validContent(patch.content))
    )
      return { kind: "invalid" };
    return this.#transaction(() => {
      const current = this.get(ownerId, id);
      if (current?.revision !== expectedRevision) return { kind: "conflict" };
      // Choosing one association clears the other.
      const projectId =
        patch.projectId !== undefined
          ? patch.projectId
          : patch.tagId !== undefined && patch.tagId !== null
            ? null
            : current.projectId;
      const tagId =
        patch.tagId !== undefined
          ? patch.tagId
          : patch.projectId !== undefined && patch.projectId !== null
            ? null
            : current.tagId;
      if (!this.associationExists(ownerId, projectId, tagId))
        return { kind: "invalid" };
      this.#database
        .prepare(
          "UPDATE notes SET content=?,project_id=?,tag_id=?,pinned_to_today=?,revision=revision+1,updated_at=? WHERE owner_id=? AND id=? AND revision=?",
        )
        .run(
          patch.content ?? current.content,
          projectId,
          tagId,
          (patch.pinnedToToday ?? current.pinnedToToday) ? 1 : 0,
          now,
          ownerId,
          id,
          expectedRevision,
        );
      const updated = this.get(ownerId, id);
      if (updated === undefined) throw new Error("Updated note is missing");
      return { kind: "applied", notes: [updated] };
    });
  }

  delete(
    ownerId: string,
    id: string,
    expectedRevision: number,
  ): NoteMutationResult {
    return this.#transaction(() => {
      const changed = this.#database
        .prepare("DELETE FROM notes WHERE owner_id=? AND id=? AND revision=?")
        .run(ownerId, id, expectedRevision).changes;
      return changed === 1
        ? { kind: "applied", notes: [] }
        : { kind: "conflict" };
    });
  }

  /** Requires the complete owner membership with current revisions. */
  reorder(
    ownerId: string,
    items: readonly { readonly id: string; readonly revision: number }[],
    now: string,
  ): NoteMutationResult {
    return this.#transaction(() => {
      const current = this.list(ownerId);
      if (
        current.length !== items.length ||
        new Set(items.map(({ id }) => id)).size !== items.length ||
        items.some(
          (item) =>
            current.find(({ id }) => id === item.id)?.revision !==
            item.revision,
        )
      )
        return { kind: "conflict" };
      const update = this.#database.prepare(
        "UPDATE notes SET position=?,revision=revision+1,updated_at=? WHERE owner_id=? AND id=?",
      );
      items.forEach((item, position) => {
        const before = current.find(({ id }) => id === item.id);
        if (before?.position !== position)
          update.run(position, now, ownerId, item.id);
      });
      return { kind: "applied", notes: this.list(ownerId) };
    });
  }

  #transaction(work: () => NoteMutationResult): NoteMutationResult {
    this.#database.exec("SAVEPOINT note_mutation;");
    try {
      const result = work();
      if (result.kind === "applied")
        this.#database.exec("RELEASE SAVEPOINT note_mutation;");
      else
        this.#database.exec(
          "ROLLBACK TO SAVEPOINT note_mutation; RELEASE SAVEPOINT note_mutation;",
        );
      return result;
    } catch (error) {
      this.#database.exec(
        "ROLLBACK TO SAVEPOINT note_mutation; RELEASE SAVEPOINT note_mutation;",
      );
      throw error;
    }
  }
}

const validContent = (content: string): boolean =>
  content.trim().length > 0 && content.length <= maxContent;

const fromRow = (row: Row): NoteRecord => ({
  id: String(row.id),
  ownerId: String(row.owner_id),
  content: String(row.content),
  projectId: row.project_id === null ? null : String(row.project_id),
  tagId: row.tag_id === null ? null : String(row.tag_id),
  pinnedToToday: Number(row.pinned_to_today) === 1,
  position: Number(row.position),
  revision: Number(row.revision),
  createdAt: String(row.created_at),
  updatedAt: String(row.updated_at),
});
