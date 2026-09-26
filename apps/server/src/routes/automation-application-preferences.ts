import type {
  AutomationConfirmationResponse,
  AutomationPreviewCommand,
} from "@suite/contracts";
import type { SuiteDatabase } from "@suite/persistence";
import {
  applicationPreferencesConflictMessage,
  applicationPreferencesResponse,
} from "./application-preferences.ts";

// Assistant read and update of application preferences (issue #67, ADR 0030),
// following planning.update_preferences: the preview freezes the record
// revision as a base revision, and confirmation applies the whole record with
// the same revision check inside its transaction.

export type ApplicationPreferencesCommand = Extract<
  AutomationPreviewCommand,
  { operation: "application.update_preferences" }
>;

type Result = AutomationConfirmationResponse["result"];

export const isApplicationPreferencesCommand = (
  command: AutomationPreviewCommand,
): command is ApplicationPreferencesCommand =>
  command.operation === "application.update_preferences";

export const applicationPreferencesEntityKind =
  "application_preferences" as const;

/** Names the changed settings without echoing the whole record. */
const changedKeys = (
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): string[] =>
  Object.keys(after).filter(
    (key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]),
  );

export type ApplicationPreferencesPreview =
  | {
      readonly ok: true;
      readonly summary: string;
      readonly revision: number;
    }
  | {
      readonly ok: false;
      readonly status: number;
      readonly code: string;
      readonly message: string;
    };

export const previewApplicationPreferences = (
  database: SuiteDatabase,
  ownerId: string,
  command: ApplicationPreferencesCommand,
): ApplicationPreferencesPreview => {
  const current = database.applicationPreferences.get(ownerId);
  if (current.revision !== command.input.expectedRevision)
    return {
      ok: false,
      status: 412,
      code: "REVISION_CONFLICT",
      message: applicationPreferencesConflictMessage,
    };
  const validated = database.applicationPreferences.validate(
    ownerId,
    command.input.preferences,
  );
  if (!validated.ok)
    return {
      ok: false,
      status: 400,
      code: "INVALID_APPLICATION_PREFERENCES",
      message: validated.message,
    };
  const changed = changedKeys(current.preferences, validated.preferences);
  const bindings = Object.keys(command.input.preferences.shortcuts).length;
  return {
    ok: true,
    revision: current.revision,
    summary:
      changed.length === 0
        ? "Save application preferences unchanged"
        : `Change application preferences: ${changed.join(", ")}${changed.includes("shortcuts") ? ` (${String(bindings)} shortcut ${bindings === 1 ? "override" : "overrides"})` : ""}. Theme, capture defaults, completion behaviour and reminder defaults change for every browser session.`,
  };
};

export const confirmApplicationPreferences = (
  database: SuiteDatabase,
  ownerId: string,
  command: ApplicationPreferencesCommand,
  now: () => string,
):
  | { readonly ok: true; readonly apply: () => Result }
  | {
      readonly ok: false;
      readonly status: number;
      readonly message: string;
    } => {
  const current = previewApplicationPreferences(database, ownerId, command);
  if (!current.ok)
    return { ok: false, status: current.status, message: current.message };
  return {
    ok: true,
    apply: () => {
      const result = database.applicationPreferences.mutate({
        ownerId,
        expectedRevision: command.input.expectedRevision,
        preferences: command.input.preferences,
        now: now(),
      });
      if (result.kind !== "applied")
        throw new Error(
          "Application preferences changed during atomic confirmation",
        );
      return {
        applicationPreferences: applicationPreferencesResponse(result.record),
      };
    },
  };
};
