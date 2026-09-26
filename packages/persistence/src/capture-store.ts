import type { DatabaseSync } from "node:sqlite";

/**
 * Capture settings and the atomic boundary for structured capture (issue
 * #90, ADR 0031). The URL behavior is the owner's `shortSyntax.urlBehavior`
 * equivalent; it has its own revision so edits conflict visibly.
 */
export const captureMigration = {
  id: "0035_capture_preferences",
  sql: `
      CREATE TABLE owner_capture_preferences (
        owner_id TEXT PRIMARY KEY REFERENCES owner_accounts(id) ON DELETE CASCADE,
        url_behavior TEXT NOT NULL CHECK(url_behavior IN ('keep','extract','keep_and_attach')),
        revision INTEGER NOT NULL CHECK(revision > 0),
        updated_at TEXT NOT NULL
      ) STRICT;
    `,
};

export type CaptureUrlBehavior = "keep" | "extract" | "keep_and_attach";
export const captureUrlBehaviors: readonly CaptureUrlBehavior[] = [
  "keep",
  "extract",
  "keep_and_attach",
];

export interface CapturePreferencesRecord {
  readonly urlBehavior: CaptureUrlBehavior;
  /** 0 until the owner saves the settings once. */
  readonly revision: number;
}

export const defaultCapturePreferences: CapturePreferencesRecord = {
  urlBehavior: "keep_and_attach",
  revision: 0,
};

let savepointCounter = 0;

export class SqliteCaptureStore {
  constructor(private readonly db: DatabaseSync) {}

  getPreferences(ownerId: string): CapturePreferencesRecord {
    const row = this.db
      .prepare(
        "SELECT url_behavior, revision FROM owner_capture_preferences WHERE owner_id=?",
      )
      .get(ownerId) as
      { url_behavior: CaptureUrlBehavior; revision: number } | undefined;
    return row === undefined
      ? defaultCapturePreferences
      : { urlBehavior: row.url_behavior, revision: row.revision };
  }

  /** Saves when `expectedRevision` matches; undefined on a stale revision. */
  updatePreferences(
    ownerId: string,
    expectedRevision: number,
    preferences: Pick<CapturePreferencesRecord, "urlBehavior">,
    now: string,
  ): CapturePreferencesRecord | undefined {
    if (!captureUrlBehaviors.includes(preferences.urlBehavior))
      return undefined;
    return this.atomically(() => {
      const current = this.getPreferences(ownerId);
      if (current.revision !== expectedRevision) return undefined;
      this.db
        .prepare(
          `INSERT INTO owner_capture_preferences (owner_id, url_behavior, revision, updated_at)
           VALUES (?, ?, 1, ?)
           ON CONFLICT(owner_id) DO UPDATE SET url_behavior=excluded.url_behavior,
             revision=revision+1, updated_at=excluded.updated_at`,
        )
        .run(ownerId, preferences.urlBehavior, now);
      return this.getPreferences(ownerId);
    });
  }

  /**
   * Runs `work` inside a savepoint so several stores commit or roll back
   * together. Nests inside other savepoints and confirmation transactions.
   */
  atomically<T>(work: () => T): T {
    savepointCounter += 1;
    const name = `capture_${String(savepointCounter)}`;
    this.db.exec(`SAVEPOINT ${name};`);
    try {
      const result = work();
      this.db.exec(`RELEASE SAVEPOINT ${name};`);
      return result;
    } catch (error) {
      this.db.exec(`ROLLBACK TO SAVEPOINT ${name}; RELEASE SAVEPOINT ${name};`);
      throw error;
    }
  }
}
