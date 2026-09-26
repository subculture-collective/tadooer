import { randomUUID } from "node:crypto";
import type {
  AutomationConfirmationResponse,
  AutomationPreviewCommand,
} from "@suite/contracts";
import {
  applyIdleDisposition,
  formatClockDuration,
  type SessionClock,
} from "@suite/domain";
import type { SuiteDatabase } from "@suite/persistence";
import { observeOwnerSession } from "../focus-timer.ts";
import {
  activeResponse,
  eventsFromActive,
  intervalsFromActive,
  recordFromActive,
} from "./shared.ts";

// Assistant focus preferences and idle disposition (issue #65, ADR 0029).
// automation.ts keeps the shared preview/confirm protocol; this module
// supplies the checks. Preferences bind the focus preference revision like
// planning preferences. An idle disposition binds the session revision and
// is applied for the owner: the controlling device stays the interval's
// actor, and the automation audit records the token.

export type FocusParityCommand = Extract<
  AutomationPreviewCommand,
  { operation: "focus.update_preferences" | "focus.idle_disposition" }
>;

export const isFocusParityCommand = (
  command: AutomationPreviewCommand,
): command is FocusParityCommand =>
  command.operation === "focus.update_preferences" ||
  command.operation === "focus.idle_disposition";

interface Affected {
  readonly entityKind: "focus_preferences" | "active_session";
  readonly entityId: string;
}
export type FocusParityPreview =
  | {
      readonly ok: true;
      readonly summary: string;
      readonly affected: readonly Affected[];
      readonly baseRevisions: readonly (Affected & {
        readonly revision: number;
      })[];
    }
  | {
      readonly ok: false;
      readonly status: number;
      readonly code: string;
      readonly message: string;
    };

export const previewFocusParity = (
  database: SuiteDatabase,
  sessionClock: SessionClock,
  ownerId: string,
  command: FocusParityCommand,
): FocusParityPreview => {
  if (command.operation === "focus.update_preferences") {
    const revision = database.focus.getRevision(ownerId);
    if (revision !== command.input.expectedRevision)
      return {
        ok: false,
        status: 412,
        code: "REVISION_CONFLICT",
        message: "Focus preferences changed before preview",
      };
    const entity = {
      entityKind: "focus_preferences" as const,
      entityId: ownerId,
    };
    return {
      ok: true,
      summary: `Change focus preferences to ${JSON.stringify(command.input.preferences)}. Running sessions keep their current plan; idle detection and break reminders follow the new values.`,
      affected: [entity],
      baseRevisions: [{ ...entity, revision }],
    };
  }
  const session = observeOwnerSession(database, sessionClock, ownerId);
  if (
    session?.id !== command.input.sessionId ||
    session.state === "completed" ||
    session.state === "expired"
  )
    return {
      ok: false,
      status: 404,
      code: "ACTIVE_SESSION_NOT_FOUND",
      message: "Active session not found",
    };
  if (session.revision !== command.input.expectedRevision)
    return {
      ok: false,
      status: 412,
      code: "REVISION_CONFLICT",
      message: "The session changed before preview",
    };
  const dryRun = applyIdleDisposition(
    session,
    {
      actorClientId: session.controllerClientId ?? "",
      expectedRevision: session.revision,
      idleStartedAt: command.input.idleStartedAt,
      disposition: command.input.disposition,
    },
    sessionClock,
    { intervalId: () => "preview" },
  );
  if (!dryRun.ok)
    return {
      ok: false,
      status: dryRun.reason === "invalid-idle-span" ? 400 : 409,
      code:
        dryRun.reason === "invalid-idle-span"
          ? "INVALID_IDLE_DISPOSITION"
          : "ACTIVE_SESSION_CONFLICT",
      message: dryRun.reason,
    };
  const span = formatClockDuration(
    Date.parse(dryRun.correction.idleEndedAt) -
      Date.parse(dryRun.correction.idleStartedAt),
  );
  const effect =
    dryRun.correction.disposition === "assign"
      ? "keep it as focus time on the task"
      : dryRun.correction.disposition === "break"
        ? "record it as a break and resume focus now"
        : "remove it from the session so it counts for nothing";
  const entity = {
    entityKind: "active_session" as const,
    entityId: session.id,
  };
  return {
    ok: true,
    summary: `Idle since ${dryRun.correction.idleStartedAt} (${span}, measured at confirmation): ${effect}. No time is added; ${formatClockDuration(dryRun.correction.trimmedMs)} of focus time is removed from the task.`,
    affected: [entity],
    baseRevisions: [{ ...entity, revision: session.revision }],
  };
};

export const confirmFocusParity = (
  database: SuiteDatabase,
  sessionClock: SessionClock,
  ownerId: string,
  tokenId: string,
  internalKey: string,
  requestHash: string,
  command: FocusParityCommand,
): AutomationConfirmationResponse["result"] => {
  const now = sessionClock.now().toISOString();
  if (command.operation === "focus.update_preferences") {
    const saved = database.focus.putPreferences(
      ownerId,
      command.input.expectedRevision,
      command.input.preferences,
      now,
    );
    if (saved === undefined)
      throw new Error("Focus preferences changed during confirmation");
    return {
      focusPreferences: { ...saved.preferences, revision: saved.revision },
    };
  }
  const session = observeOwnerSession(database, sessionClock, ownerId);
  if (
    session?.id !== command.input.sessionId ||
    session.state === "completed" ||
    session.state === "expired"
  )
    throw new Error("The session ended during confirmation");
  const actor = session.controllerClientId ?? tokenId;
  const result = applyIdleDisposition(
    session,
    {
      actorClientId: actor,
      expectedRevision: command.input.expectedRevision,
      idleStartedAt: command.input.idleStartedAt,
      disposition: command.input.disposition,
    },
    sessionClock,
    { intervalId: () => randomUUID() },
  );
  if (!result.ok) throw new Error(`Idle disposition failed: ${result.reason}`);
  const next = result.session;
  const applied = database.applyActiveSessionTransition({
    session: recordFromActive(next),
    expectedRevision: session.revision,
    clientId: actor,
    idempotencyKey: internalKey,
    requestHash,
    intervals: intervalsFromActive(next),
    events: eventsFromActive(next),
    now: next.updatedAt,
    inTransaction: () => {
      database.focus.recordIdleDisposition({
        id: randomUUID(),
        sessionId: next.id,
        ownerId,
        revision: next.revision,
        disposition: result.correction.disposition,
        idleStartedAt: result.correction.idleStartedAt,
        idleEndedAt: result.correction.idleEndedAt,
        trimmedMs: result.correction.trimmedMs,
        actorClientId: actor,
        createdAt: next.updatedAt,
      });
    },
  });
  if (applied.kind === "conflict" || applied.kind === "stale")
    throw new Error("The session changed during confirmation");
  return {
    session: activeResponse(next),
    correction: result.correction,
    replayed: applied.kind === "replayed",
  };
};
