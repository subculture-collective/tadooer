import type {
  CalendarBridgeAttention,
  CalendarBridgeBlockedEvent,
  CalendarBridgeCreateRefusal,
  CalendarBridgeDirection,
  CalendarBridgeEventVersion,
  CalendarBridgeInitialSyncChoice,
  CalendarBridgeLink,
  CalendarBridgeMapping,
  CalendarBridgeMappingCreateRequest,
  CalendarBridgeMappingPreviewResponse,
  CalendarBridgeMappingState,
  CalendarBridgeMappingSummary,
  CalendarBridgeOperation,
  CalendarBridgeOverviewResponse,
  CalendarBridgeReviewResponse,
  CalendarBridgeRunResponse,
  CalendarBridgeSide,
  CalendarCollection,
  GoogleConnectorStatusResponse,
} from "@suite/contracts";

// Browser-side helpers for the Google-Baikal bridge controls (issue #48,
// ADR 0044). The API is injectable so the view logic is testable without a
// server. Nothing here handles credentials.

export interface CalendarBridgeApi {
  readonly overview: () => Promise<CalendarBridgeOverviewResponse>;
  readonly preview: (
    input: CalendarBridgeMappingCreateRequest,
    csrfToken: string,
  ) => Promise<CalendarBridgeMappingPreviewResponse>;
  readonly create: (
    input: CalendarBridgeMappingCreateRequest,
    csrfToken: string,
  ) => Promise<CalendarBridgeMapping>;
  readonly setEnabled: (
    id: string,
    revision: number,
    enabled: boolean,
    csrfToken: string,
  ) => Promise<CalendarBridgeMapping>;
  readonly remove: (
    id: string,
    revision: number,
    cancelPendingWork: boolean,
    csrfToken: string,
  ) => Promise<void>;
  readonly run: (
    id: string,
    csrfToken: string,
  ) => Promise<CalendarBridgeRunResponse>;
  readonly review: (id: string) => Promise<CalendarBridgeReviewResponse>;
  readonly decideDeletion: (
    mappingId: string,
    linkId: string,
    linkRevision: number,
    decision: "approve" | "decline",
    csrfToken: string,
  ) => Promise<CalendarBridgeLink>;
  readonly resolveConflict: (
    mappingId: string,
    conflictId: string,
    linkRevision: number,
    keep: CalendarBridgeSide,
    csrfToken: string,
  ) => Promise<CalendarBridgeOperation>;
}

export const sideName = (side: CalendarBridgeSide): string =>
  side === "google" ? "Google" : "Baikal";

export const directionLabel = (direction: CalendarBridgeDirection): string =>
  direction === "two_way"
    ? "Both ways"
    : direction === "google_to_baikal"
      ? "Google to Baikal only"
      : "Baikal to Google only";

export const initialSyncLabel = (
  initialSync: CalendarBridgeInitialSyncChoice,
): string =>
  initialSync === "copy_existing"
    ? "Copy existing events"
    : "Only events created from now on";

export const stateLabel: Readonly<Record<CalendarBridgeMappingState, string>> =
  {
    ok: "In sync",
    paused: "Paused",
    "reconnect-required": "Reconnect needed",
    failing: "Last pass failed",
    "needs-review": "Needs review",
    "not-run": "Not run yet",
  };

export const stateVariant = (
  state: CalendarBridgeMappingState,
): "success" | "warning" | "destructive" | "outline" | "info" =>
  state === "ok"
    ? "success"
    : state === "paused"
      ? "outline"
      : state === "not-run"
        ? "info"
        : state === "needs-review"
          ? "warning"
          : "destructive";

const attentionTexts: Readonly<Record<CalendarBridgeAttention, string>> = {
  paused: "Paused: no pass runs until you resume it.",
  "google-disconnected": "Google is not connected. Connect it above.",
  "google-reconnect-required":
    "Google rejected the stored grant. Reconnect Google above; pending writes are kept.",
  "google-consent-required":
    'Google event changes are not allowed. Use "Allow event changes" above; pending writes are kept.',
  "google-calendar-unavailable":
    "The Google calendar is no longer available to this account.",
  "google-calendar-read-only":
    "The Google calendar is now read-only for this account, so changes cannot be written to it.",
  "baikal-unavailable":
    "The Baikal calendar or its credential is no longer available.",
  "last-pass-failed": "The last pass stopped before finishing.",
  "not-run": "No pass has run yet.",
  stale: "No successful pass in the last 24 hours.",
  conflicts: "Both calendars changed the same event; choose a version.",
  "deletions-awaiting-approval":
    "An event was deleted on one side; approve the deletion or keep the other copy.",
  "blocked-events": "Some events cannot be copied; see the reasons.",
  "writes-retrying": "Some writes failed and will be retried on the next pass.",
  "writes-unconfirmed":
    "A write's outcome is unconfirmed; the next pass checks it before sending anything.",
};

export const attentionText = (code: CalendarBridgeAttention): string =>
  attentionTexts[code];

const errorTexts: Readonly<Record<string, string>> = {
  "google-not-connected": "Google is not connected",
  "google-consent-required": "Google event changes are not allowed",
  "google-reconnect-required": "Google needs to be reconnected",
  "google-unavailable": "Google did not answer",
  "calendar-unavailable": "a mapped calendar is gone",
  "baikal-credential-unavailable": "the Baikal credential cannot be used",
  "google-reset": "Google asked for a full re-read twice",
  "baikal-reset": "Baikal asked for a full re-read",
};

export const lastErrorText = (code: string): string => errorTexts[code] ?? code;

const blockedTexts: Readonly<Record<string, string>> = {
  unsupported:
    "Uses content the bridge does not copy yet (for example repeats, reminders or attachments).",
  invitation: "Has guests; copying it could send invitations.",
  permission: "The destination calendar is not writable.",
  "identity-collision":
    "An event with the same identity already exists on the other side or in another mapping.",
  unavailable: "The other calendar could not be read.",
  disabled: "The mapping is paused.",
};

export const blockedReasonText = (event: CalendarBridgeBlockedEvent): string =>
  event.reason === "deletion-approval"
    ? event.approved
      ? `Deletion in ${sideName(event.deletedOn ?? "google")} approved; the next pass deletes the other copy.`
      : `Deleted in ${sideName(event.deletedOn ?? "google")}. The other copy stays until you decide.`
    : (blockedTexts[event.reason ?? ""] ??
      `Blocked (${event.reason ?? "unknown reason"}).`);

const refusalTexts: Readonly<Record<CalendarBridgeCreateRefusal, string>> = {
  "consent-required":
    'Allow Google event changes first ("Allow event changes" above).',
  "google-calendar-not-writable":
    "This Google calendar is read-only for your account; choose Google to Baikal only or another calendar.",
  "calendar-in-use": "One of these calendars already belongs to a mapping.",
  "invalid-calendar": "Choose one Google calendar and one Baikal calendar.",
};

export const refusalText = (refusal: CalendarBridgeCreateRefusal): string =>
  refusalTexts[refusal];

const dayFormat = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});
const timeFormat = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

export const formatWhen = (
  start: string | null,
  allDay: boolean | null,
): string | null => {
  if (start === null) return null;
  const parsed = Date.parse(start);
  if (Number.isNaN(parsed)) return start;
  return allDay === true
    ? `${dayFormat.format(new Date(parsed))} (all day)`
    : timeFormat.format(new Date(parsed));
};

export const formatInstant = (value: string | null): string =>
  value === null ? "never" : timeFormat.format(new Date(value));

/** One line per displayed field of a conflict version. */
export const versionLines = (
  version: CalendarBridgeEventVersion,
): readonly string[] => {
  if (version.kind === "deleted") return ["Deleted"];
  if (version.kind === "unknown") return ["Not read"];
  const when = formatWhen(version.start, version.allDay);
  const end = formatWhen(version.end, version.allDay);
  return [
    `Title: ${version.summary ?? "(none)"}`,
    `When: ${when ?? "unknown"}${end === null || version.allDay === true ? "" : ` to ${end}`}`,
    ...(version.location === null ? [] : [`Where: ${version.location}`]),
    ...(version.description === null
      ? []
      : [
          `Notes: ${version.description.length > 200 ? `${version.description.slice(0, 197)}...` : version.description}`,
        ]),
    ...(version.unsupported.length === 0
      ? []
      : [`Not copied: ${version.unsupported.join(", ")}`]),
  ];
};

export interface GoogleCalendarChoice {
  readonly id: string;
  readonly name: string;
  readonly writable: boolean;
  readonly reason: string | null;
}

export const googleCalendarChoices = (
  status: GoogleConnectorStatusResponse | undefined,
): readonly GoogleCalendarChoice[] =>
  status === undefined
    ? []
    : status.calendars
        .filter(({ supportsEvents }) => supportsEvents)
        .map((calendar) => {
          const capability = status.capabilities.find(
            ({ calendarId }) => calendarId === calendar.id,
          );
          return {
            id: calendar.id,
            name: calendar.displayName,
            writable: capability?.writable ?? false,
            reason: capability?.reason ?? "role-unknown",
          };
        });

export const baikalCalendarChoices = (
  calendars: readonly CalendarCollection[],
): readonly CalendarCollection[] =>
  calendars.filter(({ supportsEvents }) => supportsEvents);

/** Directions a Google calendar allows; a read-only one only feeds Baikal. */
export const allowedDirections = (
  choice: GoogleCalendarChoice | undefined,
): readonly CalendarBridgeDirection[] =>
  choice === undefined || choice.writable
    ? ["two_way", "google_to_baikal", "baikal_to_google"]
    : ["google_to_baikal"];

export interface MappingFormValues {
  readonly googleCalendarId: string;
  readonly baikalCalendarId: string;
  readonly direction: CalendarBridgeDirection | "";
  readonly initialSync: CalendarBridgeInitialSyncChoice | "";
}

export const emptyMappingForm: MappingFormValues = {
  googleCalendarId: "",
  baikalCalendarId: "",
  direction: "",
  initialSync: "",
};

/** The initial-sync choice is explicit: there is no default. */
export const mappingInputFromForm = (
  values: MappingFormValues,
): CalendarBridgeMappingCreateRequest | { readonly error: string } => {
  if (values.googleCalendarId === "")
    return { error: "Choose a Google calendar." };
  if (values.baikalCalendarId === "")
    return { error: "Choose a Baikal calendar." };
  if (values.direction === "") return { error: "Choose a direction." };
  if (values.initialSync === "")
    return { error: "Choose what happens to existing events." };
  return {
    googleCalendarId: values.googleCalendarId,
    baikalCalendarId: values.baikalCalendarId,
    direction: values.direction,
    initialSync: values.initialSync,
  };
};

export const previewMatches = (
  preview: CalendarBridgeMappingPreviewResponse | null,
  input: CalendarBridgeMappingCreateRequest | { readonly error: string },
  previewed: CalendarBridgeMappingCreateRequest | null,
): boolean =>
  preview !== null &&
  previewed !== null &&
  !("error" in input) &&
  previewed.googleCalendarId === input.googleCalendarId &&
  previewed.baikalCalendarId === input.baikalCalendarId &&
  previewed.direction === input.direction &&
  previewed.initialSync === input.initialSync;

export const copySummary = (
  preview: CalendarBridgeMappingPreviewResponse,
): readonly string[] =>
  preview.copies.map((copy) => {
    const from = sideName(copy.from);
    const to = sideName(copy.to);
    const read =
      copy.readAt === null
        ? `Tadooer has not read the ${from} calendar yet; the first pass reads it`
        : `from the ${from} events Tadooer last read (${formatInstant(copy.readAt)})`;
    const repeating =
      copy.repeating === 0
        ? ""
        : ` ${String(copy.repeating)} repeating event${copy.repeating === 1 ? "" : "s"} may be held for review instead.`;
    return preview.initialSync === "new_only"
      ? `${from} to ${to}: none of the ${String(copy.existing)} existing event${copy.existing === 1 ? "" : "s"} are copied; only events created after the first pass (${read}).`
      : `${from} to ${to}: ${String(copy.copied)} existing event${copy.copied === 1 ? "" : "s"} would be copied (${read}).${repeating}`;
  });

export type RemovalPlan =
  | { readonly kind: "in-flight"; readonly count: number }
  | { readonly kind: "pending"; readonly count: number }
  | { readonly kind: "clear" };

export const removalPlan = (
  mapping: CalendarBridgeMappingSummary,
): RemovalPlan =>
  mapping.counts.inFlightWrites > 0
    ? { kind: "in-flight", count: mapping.counts.inFlightWrites }
    : mapping.counts.pendingWrites > 0
      ? { kind: "pending", count: mapping.counts.pendingWrites }
      : { kind: "clear" };

export const runOutcomeText = (result: CalendarBridgeRunResponse): string => {
  if (result.outcome === "disabled")
    return "The mapping is paused; nothing ran.";
  if (result.outcome === "blocked")
    return `The pass could not start: ${lastErrorText(result.reason ?? "unknown")}.`;
  const counts = result.counts;
  const parts =
    counts === null
      ? []
      : [
          `${String(counts.applied)} written`,
          `${String(counts.enqueued)} queued`,
          `${String(counts.conflicts)} conflict${counts.conflicts === 1 ? "" : "s"}`,
          `${String(counts.blocked)} blocked`,
        ];
  return result.outcome === "failed"
    ? `The pass stopped: ${lastErrorText(result.reason ?? "unknown")}. ${parts.join(", ")}.`
    : `Pass finished: ${parts.join(", ")}.`;
};

export type PendingReviewAction =
  | {
      readonly kind: "deletion";
      readonly mappingId: string;
      readonly event: CalendarBridgeBlockedEvent;
      readonly decision: "approve" | "decline";
    }
  | {
      readonly kind: "resolve";
      readonly mappingId: string;
      readonly conflictId: string;
      readonly linkRevision: number;
      readonly title: string | null;
      readonly keep: CalendarBridgeSide;
      readonly keptDeleted: boolean;
    };

const eventName = (title: string | null): string =>
  title === null || title === "" ? "this event" : `"${title}"`;

/** The confirmation text names the effect before anything is sent. */
export const reviewActionText = (action: PendingReviewAction): string => {
  if (action.kind === "deletion") {
    const deleted = action.event.deletedOn ?? "google";
    const other = deleted === "google" ? "baikal" : "google";
    return action.decision === "approve"
      ? `Delete the ${sideName(other)} copy of ${eventName(action.event.title)} too? The next pass deletes it if it has not changed since. Tadooer cannot restore it.`
      : `Keep the ${sideName(other)} copy of ${eventName(action.event.title)}? The deletion is not copied, and the bridge stops syncing this event. Nothing is written to either calendar.`;
  }
  const other = action.keep === "google" ? "baikal" : "google";
  return action.keptDeleted
    ? `Keep the ${sideName(action.keep)} deletion of ${eventName(action.title)}? The next pass deletes the ${sideName(other)} copy if it has not changed since.`
    : `Keep the ${sideName(action.keep)} version of ${eventName(action.title)}? The next pass writes it over the ${sideName(other)} copy if that copy has not changed since.`;
};
