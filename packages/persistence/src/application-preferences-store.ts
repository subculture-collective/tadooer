import type { DatabaseSync } from "node:sqlite";
import {
  applicationPreferencesSchema,
  defaultApplicationPreferences,
  normalizeShortcutOverrides,
  type ApplicationPreferences,
} from "@suite/contracts";

/**
 * Application preferences and shortcut bindings (issue #67, ADR 0030). One
 * owner-scoped record, stored as a validated JSON document with its own
 * revision. Unstored owners read the defaults at revision 0; every browser or
 * assistant write checks the revision it read and advances it by one.
 * Preferences are online-only and outside the sync change feed.
 */
export const applicationPreferencesMigration = {
  id: "0034_application_preferences",
  sql: `
      CREATE TABLE owner_application_preferences (
        owner_id TEXT PRIMARY KEY REFERENCES owner_accounts(id) ON DELETE CASCADE,
        preferences_json TEXT NOT NULL CHECK (json_valid(preferences_json)),
        revision INTEGER NOT NULL CHECK (revision > 0),
        updated_at TEXT NOT NULL
      ) STRICT;
    `,
};

export interface ApplicationPreferencesRecord {
  /** 0 until the owner's first save. */
  readonly revision: number;
  readonly preferences: ApplicationPreferences;
}

export type ApplicationPreferencesMutationResult =
  | { readonly kind: "applied"; readonly record: ApplicationPreferencesRecord }
  | { readonly kind: "conflict"; readonly record: ApplicationPreferencesRecord }
  | { readonly kind: "invalid"; readonly message: string };

export interface ApplicationPreferencesStoreDeps {
  /** True when the project exists for the owner and is not archived. */
  readonly projectActive: (ownerId: string, projectId: string) => boolean;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export class SqliteApplicationPreferencesStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly deps: ApplicationPreferencesStoreDeps,
  ) {}

  get(ownerId: string): ApplicationPreferencesRecord {
    const row = this.db
      .prepare(
        "SELECT preferences_json, revision FROM owner_application_preferences WHERE owner_id=?",
      )
      .get(ownerId) as
      { preferences_json: string; revision: number } | undefined;
    if (row === undefined)
      return { revision: 0, preferences: defaultApplicationPreferences };
    const stored: unknown = JSON.parse(row.preferences_json);
    // Keys added after the row was written fall back to their defaults.
    const parsed = applicationPreferencesSchema.safeParse({
      ...defaultApplicationPreferences,
      ...(isObject(stored) ? stored : {}),
    });
    return {
      revision: row.revision,
      preferences: parsed.success ? parsed.data : defaultApplicationPreferences,
    };
  }

  /** Validates the whole record; the caller reports the message unchanged. */
  validate(
    ownerId: string,
    preferences: unknown,
  ):
    | { readonly ok: true; readonly preferences: ApplicationPreferences }
    | {
        readonly ok: false;
        readonly message: string;
      } {
    const parsed = applicationPreferencesSchema.safeParse(preferences);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return {
        ok: false,
        message:
          issue === undefined
            ? "Application preferences are invalid"
            : `${issue.path.join(".") || "preferences"}: ${issue.message}`,
      };
    }
    if (
      parsed.data.defaultProjectId !== null &&
      !this.deps.projectActive(ownerId, parsed.data.defaultProjectId)
    )
      return {
        ok: false,
        message: "defaultProjectId: choose an active project",
      };
    return {
      ok: true,
      preferences: {
        ...parsed.data,
        shortcuts: normalizeShortcutOverrides(parsed.data.shortcuts),
      },
    };
  }

  mutate(input: {
    readonly ownerId: string;
    readonly expectedRevision: number;
    readonly preferences: unknown;
    readonly now: string;
  }): ApplicationPreferencesMutationResult {
    const validated = this.validate(input.ownerId, input.preferences);
    if (!validated.ok) return { kind: "invalid", message: validated.message };
    if (
      !Number.isSafeInteger(input.expectedRevision) ||
      input.expectedRevision < 0
    )
      return {
        kind: "invalid",
        message: "expectedRevision: use a whole number",
      };
    this.db.exec("SAVEPOINT application_preferences;");
    try {
      const current = this.get(input.ownerId);
      if (current.revision !== input.expectedRevision) {
        this.db.exec("RELEASE SAVEPOINT application_preferences;");
        return { kind: "conflict", record: current };
      }
      this.#write(
        input.ownerId,
        validated.preferences,
        current.revision + 1,
        input.now,
      );
      this.db.exec("RELEASE SAVEPOINT application_preferences;");
      return { kind: "applied", record: this.get(input.ownerId) };
    } catch (error) {
      this.db.exec(
        "ROLLBACK TO SAVEPOINT application_preferences; RELEASE SAVEPOINT application_preferences;",
      );
      throw error;
    }
  }

  /**
   * Imported settings apply once, only while the owner has never saved
   * application preferences, so a repeat import never overwrites edits.
   * Runs inside the caller's import transaction. Returns the number of
   * imported fields applied.
   */
  importInTransaction(
    ownerId: string,
    patch: Readonly<Partial<ApplicationPreferences>>,
    now: string,
  ): number {
    const entries = Object.entries(patch as Record<string, unknown>).filter(
      ([, value]) => value !== undefined,
    );
    if (entries.length === 0 || this.get(ownerId).revision > 0) return 0;
    const candidate: Record<string, unknown> = {
      ...defaultApplicationPreferences,
      ...Object.fromEntries(entries),
    };
    if (
      typeof candidate.defaultProjectId === "string" &&
      !this.deps.projectActive(ownerId, candidate.defaultProjectId)
    ) {
      candidate.defaultProjectId = null;
      entries.splice(
        entries.findIndex(([key]) => key === "defaultProjectId"),
        1,
      );
    }
    const parsed = applicationPreferencesSchema.safeParse(candidate);
    if (!parsed.success) throw new Error("Imported preferences are invalid");
    this.#write(
      ownerId,
      {
        ...parsed.data,
        shortcuts: normalizeShortcutOverrides(parsed.data.shortcuts),
      },
      1,
      now,
    );
    return entries.length;
  }

  #write(
    ownerId: string,
    preferences: ApplicationPreferences,
    revision: number,
    now: string,
  ): void {
    this.db
      .prepare(
        `INSERT INTO owner_application_preferences (owner_id, preferences_json, revision, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(owner_id) DO UPDATE SET
           preferences_json = excluded.preferences_json,
           revision = excluded.revision,
           updated_at = excluded.updated_at`,
      )
      .run(ownerId, JSON.stringify(preferences), revision, now);
  }
}
