import type { DatabaseSync } from "node:sqlite";
import { safeExternalUrl } from "@suite/contracts";

// Linked issues and task attachments (issue #30, ADR 0021). Both are online
// HTTP records outside the sync change feed, like notes (ADR 0019).

export const taskLinksMigration = {
  id: "0025_linked_issues_attachments",
  sql: `
      CREATE TABLE task_issue_links (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL REFERENCES owner_accounts(id) ON DELETE CASCADE,
        task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE CASCADE,
        source_kind TEXT NOT NULL CHECK(source_kind IN ('super_productivity')),
        provider_key TEXT CHECK(provider_key IS NULL OR length(provider_key) BETWEEN 1 AND 100),
        provider_source_id TEXT CHECK(provider_source_id IS NULL OR length(provider_source_id) BETWEEN 1 AND 200),
        provider_recorded INTEGER NOT NULL CHECK(provider_recorded IN (0,1)),
        issue_id TEXT NOT NULL CHECK(length(issue_id) BETWEEN 1 AND 500),
        display_url TEXT CHECK(display_url IS NULL OR length(display_url) <= 2048),
        last_updated_at TEXT,
        sync_metadata_json TEXT NOT NULL
          CHECK(json_valid(sync_metadata_json) AND json_type(sync_metadata_json) = 'object'
            AND length(sync_metadata_json) <= 65536),
        revision INTEGER NOT NULL CHECK(revision > 0),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX task_issue_links_by_owner ON task_issue_links(owner_id, task_id);
      CREATE TABLE task_attachments (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL REFERENCES owner_accounts(id) ON DELETE CASCADE,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK(kind IN ('link','note','file','image','command')),
        title TEXT NOT NULL CHECK(length(title) <= 500),
        url TEXT CHECK(url IS NULL OR length(url) <= 2048),
        text TEXT CHECK(text IS NULL OR length(text) <= 20000),
        source_path TEXT CHECK(source_path IS NULL OR length(source_path) <= 4096),
        unavailable_reason TEXT CHECK(unavailable_reason IS NULL
          OR unavailable_reason IN ('device_local','command_not_run','unsupported_address')),
        source_kind TEXT NOT NULL CHECK(source_kind IN ('suite','super_productivity')),
        position INTEGER NOT NULL CHECK(position >= 0),
        revision INTEGER NOT NULL CHECK(revision > 0),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        CHECK(kind <> 'note' OR (text IS NOT NULL AND url IS NULL AND unavailable_reason IS NULL)),
        CHECK(kind = 'note' OR text IS NULL),
        CHECK(kind NOT IN ('file','command') OR url IS NULL),
        CHECK(url IS NULL OR unavailable_reason IS NULL),
        CHECK(kind = 'note' OR url IS NOT NULL OR unavailable_reason IS NOT NULL)
      ) STRICT;
      CREATE INDEX task_attachments_by_task ON task_attachments(owner_id, task_id, position, id);
    `,
} as const;

export type TaskAttachmentKind = "link" | "note" | "file" | "image" | "command";
export type TaskAttachmentUnavailableReason =
  "device_local" | "command_not_run" | "unsupported_address";

export interface TaskAttachmentRecord {
  readonly id: string;
  readonly ownerId: string;
  readonly taskId: string;
  readonly kind: TaskAttachmentKind;
  readonly title: string;
  readonly url: string | null;
  readonly text: string | null;
  readonly sourcePath: string | null;
  readonly available: boolean;
  readonly unavailableReason: TaskAttachmentUnavailableReason | null;
  readonly source: "suite" | "super_productivity";
  readonly position: number;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface TaskIssueLinkRecord {
  readonly id: string;
  readonly ownerId: string;
  readonly taskId: string;
  readonly source: "super_productivity";
  readonly providerKey: string | null;
  readonly providerSourceId: string | null;
  readonly providerRecorded: boolean;
  readonly issueId: string;
  readonly displayUrl: string | null;
  readonly connection: "authorization_required";
  readonly lastUpdatedAt: string | null;
  readonly syncMetadata: Readonly<Record<string, unknown>>;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface TaskLinksRecord {
  readonly taskId: string;
  readonly issueLink: TaskIssueLinkRecord | null;
  readonly attachments: readonly TaskAttachmentRecord[];
}

/** Imported issue identity; see prepareSuperProductivityImport. */
export interface ImportedIssueLink {
  readonly providerKey: string | null;
  readonly providerSourceId: string | null;
  readonly providerRecorded: boolean;
  readonly issueId: string;
  readonly displayUrl: string | null;
  readonly lastUpdatedAt: string | null;
  readonly syncMetadata: Readonly<Record<string, unknown>>;
}

export interface ImportedAttachment {
  readonly kind: TaskAttachmentKind;
  readonly title: string;
  readonly url: string | null;
  readonly text: string | null;
  readonly sourcePath: string | null;
  readonly unavailableReason: TaskAttachmentUnavailableReason | null;
}

export type TaskAttachmentCreateInput =
  | {
      readonly kind: "link";
      readonly title: string;
      readonly url: string;
    }
  | {
      readonly kind: "note";
      readonly title: string;
      readonly text: string;
    };

export interface TaskAttachmentPatch {
  readonly title?: string | undefined;
  readonly url?: string | undefined;
  readonly text?: string | undefined;
}

export type TaskLinkMutationResult =
  | { readonly kind: "applied"; readonly links: TaskLinksRecord }
  | { readonly kind: "not_found" }
  | { readonly kind: "conflict" }
  | { readonly kind: "invalid" };

type Row = Record<string, string | number | null>;

const maxAttachments = 100;
const maxTitle = 500;
const maxText = 20_000;

/**
 * Owner-scoped task attachments and imported issue links. Every query binds
 * the owner; a record of another owner behaves as absent. Mutations use a
 * savepoint so they nest inside automation confirmation transactions.
 */
export class SqliteTaskLinkStore {
  readonly #database: DatabaseSync;

  constructor(database: DatabaseSync) {
    this.#database = database;
  }

  /** Links of an owned task, deleted or not; undefined for other owners. */
  get(ownerId: string, taskId: string): TaskLinksRecord | undefined {
    if (!this.#taskExists(ownerId, taskId, false)) return undefined;
    const link = this.#database
      .prepare("SELECT * FROM task_issue_links WHERE owner_id=? AND task_id=?")
      .get(ownerId, taskId) as Row | undefined;
    return {
      taskId,
      issueLink: link === undefined ? null : issueLinkFromRow(link),
      attachments: (
        this.#database
          .prepare(
            "SELECT * FROM task_attachments WHERE owner_id=? AND task_id=? ORDER BY position, created_at, id",
          )
          .all(ownerId, taskId) as unknown as readonly Row[]
      ).map(attachmentFromRow),
    };
  }

  getAttachment(ownerId: string, id: string): TaskAttachmentRecord | undefined {
    const row = this.#database
      .prepare("SELECT * FROM task_attachments WHERE owner_id=? AND id=?")
      .get(ownerId, id) as Row | undefined;
    return row === undefined ? undefined : attachmentFromRow(row);
  }

  getIssueLink(ownerId: string, id: string): TaskIssueLinkRecord | undefined {
    const row = this.#database
      .prepare("SELECT * FROM task_issue_links WHERE owner_id=? AND id=?")
      .get(ownerId, id) as Row | undefined;
    return row === undefined ? undefined : issueLinkFromRow(row);
  }

  /** Validates a create without writing; used by automation previews. */
  canCreateAttachment(
    ownerId: string,
    taskId: string,
    input: TaskAttachmentCreateInput,
  ): "ok" | "not_found" | "invalid" {
    if (!this.#taskExists(ownerId, taskId, true)) return "not_found";
    if (!validCreate(input) || this.#count(ownerId, taskId) >= maxAttachments)
      return "invalid";
    return "ok";
  }

  createAttachment(
    ownerId: string,
    taskId: string,
    id: string,
    input: TaskAttachmentCreateInput,
    now: string,
  ): TaskLinkMutationResult {
    return this.#transaction(() => {
      const allowed = this.canCreateAttachment(ownerId, taskId, input);
      if (allowed !== "ok") return { kind: allowed };
      if (
        this.#database
          .prepare("SELECT 1 FROM task_attachments WHERE id=?")
          .get(id) !== undefined
      )
        return { kind: "conflict" };
      this.#insertAttachment(
        ownerId,
        taskId,
        id,
        {
          kind: input.kind,
          title: input.title.trim(),
          url:
            input.kind === "link" ? (safeExternalUrl(input.url) ?? null) : null,
          text: input.kind === "note" ? input.text : null,
          sourcePath: null,
          unavailableReason: null,
        },
        "suite",
        now,
      );
      return this.#applied(ownerId, taskId);
    });
  }

  /** Validates an edit against the current attachment without writing. */
  checkAttachmentPatch(
    current: TaskAttachmentRecord,
    patch: TaskAttachmentPatch,
  ): boolean {
    if (Object.values(patch).every((value) => value === undefined))
      return false;
    if (patch.title !== undefined && patch.title.trim().length > maxTitle)
      return false;
    if (
      patch.url !== undefined &&
      (current.kind !== "link" || safeExternalUrl(patch.url) === undefined)
    )
      return false;
    if (
      patch.text !== undefined &&
      (current.kind !== "note" ||
        patch.text.trim() === "" ||
        patch.text.length > maxText)
    )
      return false;
    return true;
  }

  updateAttachment(
    ownerId: string,
    id: string,
    expectedRevision: number,
    patch: TaskAttachmentPatch,
    now: string,
  ): TaskLinkMutationResult {
    return this.#transaction(() => {
      const current = this.getAttachment(ownerId, id);
      if (current === undefined) return { kind: "not_found" };
      if (!this.#taskExists(ownerId, current.taskId, true))
        return { kind: "not_found" };
      if (current.revision !== expectedRevision) return { kind: "conflict" };
      if (!this.checkAttachmentPatch(current, patch))
        return { kind: "invalid" };
      const url =
        patch.url === undefined ? current.url : safeExternalUrl(patch.url);
      this.#database
        .prepare(
          "UPDATE task_attachments SET title=?,url=?,text=?,revision=revision+1,updated_at=? WHERE owner_id=? AND id=? AND revision=?",
        )
        .run(
          patch.title?.trim() ?? current.title,
          url ?? null,
          patch.text ?? current.text,
          now,
          ownerId,
          id,
          expectedRevision,
        );
      return this.#applied(ownerId, current.taskId);
    });
  }

  deleteAttachment(
    ownerId: string,
    id: string,
    expectedRevision: number,
  ): TaskLinkMutationResult {
    return this.#transaction(() => {
      const current = this.getAttachment(ownerId, id);
      if (current === undefined) return { kind: "not_found" };
      if (!this.#taskExists(ownerId, current.taskId, true))
        return { kind: "not_found" };
      if (current.revision !== expectedRevision) return { kind: "conflict" };
      this.#database
        .prepare(
          "DELETE FROM task_attachments WHERE owner_id=? AND id=? AND revision=?",
        )
        .run(ownerId, id, expectedRevision);
      return this.#applied(ownerId, current.taskId);
    });
  }

  /**
   * Removes the task's link to an external issue. The import provenance row
   * keeps the original source fields, so the link stays inspectable there.
   */
  deleteIssueLink(
    ownerId: string,
    id: string,
    expectedRevision: number,
  ): TaskLinkMutationResult {
    return this.#transaction(() => {
      const current = this.getIssueLink(ownerId, id);
      if (current === undefined) return { kind: "not_found" };
      if (!this.#taskExists(ownerId, current.taskId, true))
        return { kind: "not_found" };
      if (current.revision !== expectedRevision) return { kind: "conflict" };
      this.#database
        .prepare(
          "DELETE FROM task_issue_links WHERE owner_id=? AND id=? AND revision=?",
        )
        .run(ownerId, id, expectedRevision);
      return this.#applied(ownerId, current.taskId);
    });
  }

  /**
   * Stores imported links for a task created in the same import transaction.
   * Runs without a savepoint; the caller owns the transaction.
   */
  insertImported(
    ownerId: string,
    taskId: string,
    issueLink: ImportedIssueLink | null,
    attachments: readonly ImportedAttachment[],
    newId: () => string,
    now: string,
  ): void {
    if (!this.#taskExists(ownerId, taskId, false))
      throw new Error("IMPORT_REFERENCE_MISSING");
    if (attachments.length > maxAttachments)
      throw new Error("IMPORT_ATTACHMENT_LIMIT");
    if (issueLink !== null)
      this.#database
        .prepare(
          "INSERT INTO task_issue_links (id,owner_id,task_id,source_kind,provider_key,provider_source_id,provider_recorded,issue_id,display_url,last_updated_at,sync_metadata_json,revision,created_at,updated_at) VALUES (?,?,?,'super_productivity',?,?,?,?,?,?,?,1,?,?)",
        )
        .run(
          newId(),
          ownerId,
          taskId,
          issueLink.providerKey,
          issueLink.providerSourceId,
          issueLink.providerRecorded ? 1 : 0,
          issueLink.issueId,
          issueLink.displayUrl,
          issueLink.lastUpdatedAt,
          JSON.stringify(issueLink.syncMetadata),
          now,
          now,
        );
    for (const attachment of attachments)
      this.#insertAttachment(
        ownerId,
        taskId,
        newId(),
        attachment,
        "super_productivity",
        now,
      );
  }

  #insertAttachment(
    ownerId: string,
    taskId: string,
    id: string,
    attachment: ImportedAttachment,
    source: "suite" | "super_productivity",
    now: string,
  ): void {
    const position = Number(
      (
        this.#database
          .prepare(
            "SELECT coalesce(max(position) + 1, 0) AS next FROM task_attachments WHERE owner_id=? AND task_id=?",
          )
          .get(ownerId, taskId) as { next: unknown }
      ).next,
    );
    this.#database
      .prepare(
        "INSERT INTO task_attachments (id,owner_id,task_id,kind,title,url,text,source_path,unavailable_reason,source_kind,position,revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,1,?,?)",
      )
      .run(
        id,
        ownerId,
        taskId,
        attachment.kind,
        attachment.title,
        attachment.url,
        attachment.text,
        attachment.sourcePath,
        attachment.unavailableReason,
        source,
        position,
        now,
        now,
      );
  }

  #taskExists(ownerId: string, taskId: string, active: boolean): boolean {
    return (
      this.#database
        .prepare(
          `SELECT 1 FROM tasks WHERE owner_id=? AND id=?${active ? " AND deleted_at IS NULL" : ""}`,
        )
        .get(ownerId, taskId) !== undefined
    );
  }

  #count(ownerId: string, taskId: string): number {
    return Number(
      (
        this.#database
          .prepare(
            "SELECT count(*) AS count FROM task_attachments WHERE owner_id=? AND task_id=?",
          )
          .get(ownerId, taskId) as { count: unknown }
      ).count,
    );
  }

  #applied(ownerId: string, taskId: string): TaskLinkMutationResult {
    const links = this.get(ownerId, taskId);
    if (links === undefined) throw new Error("Task links are missing");
    return { kind: "applied", links };
  }

  #transaction(work: () => TaskLinkMutationResult): TaskLinkMutationResult {
    this.#database.exec("SAVEPOINT task_link_mutation;");
    try {
      const result = work();
      if (result.kind === "applied")
        this.#database.exec("RELEASE SAVEPOINT task_link_mutation;");
      else
        this.#database.exec(
          "ROLLBACK TO SAVEPOINT task_link_mutation; RELEASE SAVEPOINT task_link_mutation;",
        );
      return result;
    } catch (error) {
      this.#database.exec(
        "ROLLBACK TO SAVEPOINT task_link_mutation; RELEASE SAVEPOINT task_link_mutation;",
      );
      throw error;
    }
  }
}

const validCreate = (input: TaskAttachmentCreateInput): boolean =>
  input.title.trim().length <= maxTitle &&
  (input.kind === "link"
    ? safeExternalUrl(input.url) !== undefined
    : input.text.trim() !== "" && input.text.length <= maxText);

const attachmentFromRow = (row: Row): TaskAttachmentRecord => ({
  id: String(row.id),
  ownerId: String(row.owner_id),
  taskId: String(row.task_id),
  kind: String(row.kind) as TaskAttachmentKind,
  title: String(row.title),
  url: row.url === null ? null : String(row.url),
  text: row.text === null ? null : String(row.text),
  sourcePath: row.source_path === null ? null : String(row.source_path),
  available: row.unavailable_reason === null,
  unavailableReason:
    row.unavailable_reason === null
      ? null
      : (String(row.unavailable_reason) as TaskAttachmentUnavailableReason),
  source: String(row.source_kind) as TaskAttachmentRecord["source"],
  position: Number(row.position),
  revision: Number(row.revision),
  createdAt: String(row.created_at),
  updatedAt: String(row.updated_at),
});

const issueLinkFromRow = (row: Row): TaskIssueLinkRecord => ({
  id: String(row.id),
  ownerId: String(row.owner_id),
  taskId: String(row.task_id),
  source: "super_productivity",
  providerKey: row.provider_key === null ? null : String(row.provider_key),
  providerSourceId:
    row.provider_source_id === null ? null : String(row.provider_source_id),
  providerRecorded: Number(row.provider_recorded) === 1,
  issueId: String(row.issue_id),
  displayUrl: row.display_url === null ? null : String(row.display_url),
  connection: "authorization_required",
  lastUpdatedAt:
    row.last_updated_at === null ? null : String(row.last_updated_at),
  syncMetadata: JSON.parse(String(row.sync_metadata_json)) as Record<
    string,
    unknown
  >,
  revision: Number(row.revision),
  createdAt: String(row.created_at),
  updatedAt: String(row.updated_at),
});
