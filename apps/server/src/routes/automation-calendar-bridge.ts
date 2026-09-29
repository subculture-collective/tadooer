import { randomUUID } from "node:crypto";
import type {
  AutomationCalendarBridgeResource,
  AutomationConfirmationResponse,
  AutomationPreviewCommand,
  CalendarBridgeEventVersion,
} from "@suite/contracts";
import type {
  CalendarBridgeLinkRecord,
  CalendarBridgeOperationRecord,
  SuiteDatabase,
} from "@suite/persistence";
import {
  bridgeOverview,
  bridgeReview,
  eventVersion,
} from "../calendar-bridge/controls.ts";
import type { GoogleConnectorService } from "../google-connector.ts";

// Assistant calendar bridge review (issue #48, ADR 0044). automation.ts keeps
// the shared preview/confirm protocol. The assistant reads mapping status and
// decides one pending deletion or one conflict at a time, bound to the link
// revision it previewed; the store repeats that check inside its transaction.
// Creating, pausing, removing and running a mapping stay owner-only.

export type BridgeCommand = Extract<
  AutomationPreviewCommand,
  {
    operation:
      "calendar_bridge.decide_deletion" | "calendar_bridge.resolve_conflict";
  }
>;

type Result = AutomationConfirmationResponse["result"];

export const isBridgeCommand = (
  command: AutomationPreviewCommand,
): command is BridgeCommand =>
  command.operation === "calendar_bridge.decide_deletion" ||
  command.operation === "calendar_bridge.resolve_conflict";

interface Deps {
  readonly database: SuiteDatabase;
  readonly google: GoogleConnectorService;
}

export const bridgeResourceBody = (
  deps: Deps,
  ownerId: string,
  mappingId: string | undefined,
  now: Date,
):
  | { readonly ok: true; readonly body: AutomationCalendarBridgeResource }
  | { readonly ok: false } => {
  const review =
    mappingId === undefined
      ? null
      : bridgeReview(deps, ownerId, mappingId, now);
  if (review === undefined) return { ok: false };
  return { ok: true, body: { ...bridgeOverview(deps, ownerId, now), review } };
};

const side = (value: "google" | "baikal"): string =>
  value === "google" ? "Google" : "Baikal";

const clip = (value: string, length: number): string =>
  value.length > length ? `${value.slice(0, length - 3)}...` : value;

const quoted = (value: string | null): string =>
  value === null || value === "" ? "an untitled event" : `"${clip(value, 60)}"`;

const describeVersion = (version: CalendarBridgeEventVersion): string => {
  if (version.kind === "deleted") return "deleted";
  const parts = [
    quoted(version.summary),
    version.start === null
      ? null
      : `${version.start}${version.allDay === true ? " (all day)" : ""}`,
    version.location === null ? null : `at ${clip(version.location, 40)}`,
  ].filter((part): part is string => part !== null);
  return parts.join(" ");
};

const linkTitle = (link: CalendarBridgeLinkRecord): string | null =>
  [link.acceptedSnapshot, link.google.snapshot, link.baikal.snapshot]
    .map(
      (snapshot) =>
        eventVersion({ kind: "present", revision: null, snapshot }).summary,
    )
    .find((summary) => summary !== null) ?? null;

export type BridgePreview =
  | {
      readonly ok: true;
      readonly summary: string;
      readonly affected: readonly {
        readonly entityKind:
          | "calendar_bridge_mapping"
          | "calendar_bridge_link"
          | "calendar_bridge_conflict";
        readonly entityId: string;
      }[];
    }
  | {
      readonly ok: false;
      readonly status: number;
      readonly code: string;
      readonly message: string;
    };

const failure = (
  status: number,
  code: string,
  message: string,
): BridgePreview => ({ ok: false, status, code, message });

export const previewBridge = (
  database: SuiteDatabase,
  ownerId: string,
  command: BridgeCommand,
): BridgePreview => {
  const store = database.calendarBridge;
  const mapping = store.getMapping(ownerId, command.input.mappingId);
  if (mapping === undefined)
    return failure(
      404,
      "BRIDGE_MAPPING_NOT_FOUND",
      "Calendar mapping not found",
    );
  const calendars = `${quoted(
    database.getOwnedCalendar(ownerId, mapping.googleCalendarId)?.displayName ??
      null,
  )} (Google) and ${quoted(
    database.getOwnedCalendar(ownerId, mapping.baikalCalendarId)?.displayName ??
      null,
  )} (Baikal)`;
  if (command.operation === "calendar_bridge.decide_deletion") {
    const link = store.getLink(command.input.linkId);
    if (link?.ownerId !== ownerId || link.mappingId !== mapping.id)
      return failure(404, "BRIDGE_LINK_NOT_FOUND", "Event link not found");
    if (link.revision !== command.input.expectedRevision)
      return failure(
        412,
        "BRIDGE_REVISION_CONFLICT",
        "The event link changed; read calendar_bridge.status again",
      );
    const deleted =
      link.google.kind === "deleted"
        ? ("google" as const)
        : link.baikal.kind === "deleted"
          ? ("baikal" as const)
          : undefined;
    if (
      link.status !== "blocked" ||
      link.statusReason !== "deletion-approval" ||
      deleted === undefined
    )
      return failure(
        409,
        "BRIDGE_NO_PENDING_DELETION",
        "This event has no deletion waiting for approval",
      );
    const other = deleted === "google" ? "baikal" : "google";
    const title = quoted(linkTitle(link));
    return {
      ok: true,
      summary:
        command.input.decision === "approve"
          ? `Approve the deletion of ${title} in ${side(deleted)} for the mapping between ${calendars}. The next pass deletes the ${side(other)} copy if it is still unchanged; it cannot be restored by Tadooer. Nothing was written during preview.`
          : `Keep the ${side(other)} copy of ${title}, deleted in ${side(deleted)}, for the mapping between ${calendars}. The deletion is not propagated and the bridge stops syncing this event; nothing is written to either calendar.`,
      affected: [
        { entityKind: "calendar_bridge_mapping", entityId: mapping.id },
        { entityKind: "calendar_bridge_link", entityId: link.id },
      ],
    };
  }
  const conflict = store
    .listOpenConflicts(mapping.id)
    .find(({ id }) => id === command.input.conflictId);
  if (conflict === undefined)
    return failure(
      404,
      "BRIDGE_CONFLICT_NOT_FOUND",
      "Open conflict not found; it may have been resolved or superseded",
    );
  const link = store.getLink(conflict.linkId);
  if (link === undefined)
    return failure(404, "BRIDGE_LINK_NOT_FOUND", "Event link not found");
  if (link.revision !== command.input.expectedLinkRevision)
    return failure(
      412,
      "BRIDGE_REVISION_CONFLICT",
      "The event changed; read calendar_bridge.status again",
    );
  if (store.unfinishedOperationForLink(link.id) !== undefined)
    return failure(
      409,
      "BRIDGE_WORK_PENDING",
      "Earlier work for this event has not finished",
    );
  const keep = command.input.keep;
  const other = keep === "google" ? "baikal" : "google";
  const kept = eventVersion(conflict[keep]);
  const replaced = eventVersion(conflict[other]);
  const effect =
    kept.kind === "deleted"
      ? `deletes the ${side(other)} copy`
      : `writes the ${side(keep)} version over the ${side(other)} copy`;
  return {
    ok: true,
    summary: clip(
      `Resolve the conflict for ${quoted(kept.summary ?? replaced.summary ?? linkTitle(link))} in the mapping between ${calendars} by keeping the ${side(keep)} version. The next pass ${effect}, only if it still has the revision recorded in the conflict. ${side(keep)}: ${describeVersion(kept)}. ${side(other)}: ${describeVersion(replaced)}. Nothing was written during preview.`,
      1_000,
    ),
    affected: [
      { entityKind: "calendar_bridge_mapping", entityId: mapping.id },
      { entityKind: "calendar_bridge_link", entityId: link.id },
      { entityKind: "calendar_bridge_conflict", entityId: conflict.id },
    ],
  };
};

const linkBody = (link: CalendarBridgeLinkRecord) => ({
  id: link.id,
  revision: link.revision,
  origin: link.origin,
  googleEventId: link.googleEventId,
  googleIcalUid: link.googleIcalUid,
  baikalHref: link.baikalHref,
  baikalUid: link.baikalUid,
  google: {
    kind: link.google.kind,
    revision: link.google.revision,
    digest: link.google.digest,
  },
  baikal: {
    kind: link.baikal.kind,
    revision: link.baikal.revision,
    digest: link.baikal.digest,
  },
  acceptedKind: link.acceptedKind,
  acceptedDigest: link.acceptedDigest,
  status: link.status,
  statusReason: link.statusReason,
  deletionApproval: link.deletionApproval,
  updatedAt: link.updatedAt,
});

const operationBody = (operation: CalendarBridgeOperationRecord) => ({
  id: operation.id,
  linkId: operation.linkId,
  sequence: operation.sequence,
  target: operation.target,
  action: operation.action,
  reason: operation.reason,
  state: operation.state,
  attempts: operation.attempts,
  lastError: operation.lastError,
  updatedAt: operation.updatedAt,
});

/**
 * Confirmation repeats the preview check and applies inside the confirmation
 * transaction; the store checks the previewed link revision again.
 */
export const confirmBridge = (
  database: SuiteDatabase,
  ownerId: string,
  command: BridgeCommand,
  now: () => string,
):
  | { readonly ok: true; readonly apply: () => Result }
  | {
      readonly ok: false;
      readonly status: number;
      readonly message: string;
    } => {
  const current = previewBridge(database, ownerId, command);
  if (!current.ok)
    return { ok: false, status: current.status, message: current.message };
  const store = database.calendarBridge;
  if (command.operation === "calendar_bridge.decide_deletion") {
    const input = command.input;
    return {
      ok: true,
      apply: () => {
        const request = {
          ownerId,
          mappingId: input.mappingId,
          linkId: input.linkId,
          expectedRevision: input.expectedRevision,
          now: now(),
        };
        const decided =
          input.decision === "approve"
            ? store.approveDeletion(request)
            : store.declineDeletion(request);
        if (decided.kind !== "approved" && decided.kind !== "declined")
          throw new Error("Event link changed during confirmation");
        return { link: linkBody(decided.link) };
      },
    };
  }
  const input = command.input;
  return {
    ok: true,
    apply: () => {
      const resolved = store.resolveConflict({
        ownerId,
        mappingId: input.mappingId,
        conflictId: input.conflictId,
        keep: input.keep,
        operationId: randomUUID(),
        now: now(),
        expectedLinkRevision: input.expectedLinkRevision,
      });
      if (resolved.kind !== "resolved")
        throw new Error("Conflict changed during confirmation");
      return { operation: operationBody(resolved.operation) };
    },
  };
};
