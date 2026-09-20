import type { DatabaseSync } from "node:sqlite";
import type {
  AutomationAuditRecord,
  AutomationOutcomeRecord,
} from "./index.js";
import type { AutomationAuditStore } from "./stores.js";

export class SqliteAutomationAuditStore implements AutomationAuditStore {
  constructor(private readonly db: DatabaseSync) {}

  insertOutcome(record: AutomationOutcomeRecord): void {
    this.db
      .prepare(
        `INSERT INTO automation_operation_outcomes
          (owner_id,token_id,operation,idempotency_key,request_hash,preview_id,response_json,created_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(
        record.ownerId,
        record.tokenId,
        record.operation,
        record.idempotencyKey,
        record.requestHash,
        record.previewId,
        JSON.stringify(record.response),
        record.createdAt,
      );
  }

  insertAudit(record: AutomationAuditRecord): void {
    this.db
      .prepare(
        `INSERT INTO automation_audit_log
          (id,owner_id,token_id,operation,phase,outcome,error_code,preview_id,
           affected_ids_json,request_hash,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        record.id,
        record.ownerId,
        record.tokenId,
        record.operation,
        record.phase,
        record.outcome,
        record.errorCode,
        record.previewId,
        JSON.stringify(record.affectedIds),
        record.requestHash,
        record.createdAt,
      );
  }

  listAudit(ownerId: string): readonly AutomationAuditRecord[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM automation_audit_log WHERE owner_id=? ORDER BY created_at,id",
      )
      .all(ownerId) as unknown as readonly Record<string, string | null>[];
    return rows.map((row) => ({
      id: String(row.id),
      ownerId: String(row.owner_id),
      tokenId: String(row.token_id),
      operation: String(row.operation),
      phase: String(row.phase) as AutomationAuditRecord["phase"],
      outcome: String(row.outcome) as AutomationAuditRecord["outcome"],
      errorCode: row.error_code ?? null,
      previewId: row.preview_id ?? null,
      affectedIds: JSON.parse(String(row.affected_ids_json)) as string[],
      requestHash: row.request_hash ?? null,
      createdAt: String(row.created_at),
    }));
  }

  getOutcome(
    ownerId: string,
    tokenId: string,
    operation: string,
    idempotencyKey: string,
  ): AutomationOutcomeRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM automation_operation_outcomes
         WHERE owner_id=? AND token_id=? AND operation=? AND idempotency_key=?`,
      )
      .get(ownerId, tokenId, operation, idempotencyKey) as unknown as
      Record<string, string> | undefined;
    return row === undefined
      ? undefined
      : {
          ownerId: String(row.owner_id),
          tokenId: String(row.token_id),
          operation: String(row.operation),
          idempotencyKey: String(row.idempotency_key),
          requestHash: String(row.request_hash),
          previewId: String(row.preview_id),
          response: JSON.parse(String(row.response_json)) as unknown,
          createdAt: String(row.created_at),
        };
  }
}
