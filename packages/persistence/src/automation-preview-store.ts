import type { DatabaseSync } from "node:sqlite";
import type { AutomationPreviewRecord } from "./index.js";
import type { AutomationPreviewStore } from "./stores.js";

export class SqliteAutomationPreviewStore implements AutomationPreviewStore {
  constructor(private readonly db: DatabaseSync) {}

  insertPreview(record: AutomationPreviewRecord): void {
    this.db
      .prepare(
        `INSERT INTO automation_previews
          (id,owner_id,token_id,operation,input_hash,input_json,summary,affected_ids_json,
           base_revisions_json,expires_at,consumed_at,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        record.id,
        record.ownerId,
        record.tokenId,
        record.operation,
        record.inputHash,
        JSON.stringify(record.input),
        record.summary,
        JSON.stringify(record.affectedIds),
        JSON.stringify(record.baseRevisions),
        record.expiresAt,
        record.consumedAt,
        record.createdAt,
      );
  }

  getPreview(
    _ownerId: string,
    previewId: string,
  ): AutomationPreviewRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM automation_previews WHERE id=?")
      .get(previewId) as unknown as Record<string, string | null> | undefined;
    if (row === undefined) return undefined;
    return {
      id: String(row.id),
      ownerId: String(row.owner_id),
      tokenId: String(row.token_id),
      operation: String(row.operation),
      inputHash: String(row.input_hash),
      input: JSON.parse(String(row.input_json)) as unknown,
      summary: String(row.summary),
      affectedIds: JSON.parse(String(row.affected_ids_json)) as string[],
      baseRevisions: JSON.parse(String(row.base_revisions_json)) as Record<
        string,
        number
      >,
      expiresAt: String(row.expires_at),
      consumedAt: row.consumed_at ?? null,
      createdAt: String(row.created_at),
    };
  }

  consumePreview(_ownerId: string, previewId: string, now: string): boolean {
    return (
      this.db
        .prepare(
          "UPDATE automation_previews SET consumed_at=? WHERE id=? AND consumed_at IS NULL AND expires_at>?",
        )
        .run(now, previewId, now).changes === 1
    );
  }
}
