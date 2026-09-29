import {
  calendarBridgeReviewListLimit,
  calendarBridgeStaleAfterMinutes,
  type CalendarBridgeAttention,
  type CalendarBridgeBlockedEvent,
  type CalendarBridgeCopyPreview,
  type CalendarBridgeCreateRefusal,
  type CalendarBridgeEventVersion,
  type CalendarBridgeMappingCreateRequest,
  type CalendarBridgeMappingPreviewResponse,
  type CalendarBridgeMappingState,
  type CalendarBridgeMappingSummary,
  type CalendarBridgeOverviewResponse,
  type CalendarBridgeReviewResponse,
  type GoogleConnectorStatusResponse,
} from "@suite/contracts";
import type {
  CalendarBridgeConflictRecord,
  CalendarBridgeLinkRecord,
  CalendarBridgeMappingRecord,
  CalendarBridgeOperationRecord,
  CalendarBridgeSideName,
  SuiteDatabase,
} from "@suite/persistence";
import type { GoogleConnectorService } from "../google-connector.ts";

/**
 * Bridge controls (issue #48, ADR 0044): owner and assistant views built from
 * the ADR 0041 read models. Pure reads: nothing here contacts a provider,
 * writes state or returns credentials or raw iCalendar.
 */

export interface BridgeControlDeps {
  readonly database: SuiteDatabase;
  readonly google: GoogleConnectorService;
}

const text = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

/**
 * Reads the retained normalized snapshot leniently (any envelope version):
 * only the displayed fields and the names of unsupported content.
 */
const snapshotFields = (
  snapshot: string | null,
): Omit<CalendarBridgeEventVersion, "kind" | "revision"> => {
  const empty = {
    summary: null,
    description: null,
    location: null,
    allDay: null,
    start: null,
    end: null,
    unsupported: [],
  };
  if (snapshot === null) return empty;
  try {
    const parsed = JSON.parse(snapshot) as unknown;
    if (typeof parsed !== "object" || parsed === null) return empty;
    const record = parsed as Record<string, unknown>;
    const unsupported =
      typeof record.unsupported === "object" && record.unsupported !== null
        ? Object.keys(record.unsupported).toSorted()
        : [];
    return {
      summary: text(record.summary),
      description: text(record.description),
      location: text(record.location),
      allDay: typeof record.allDay === "boolean" ? record.allDay : null,
      start: text(record.start),
      end: text(record.end),
      unsupported,
    };
  } catch {
    return empty;
  }
};

export const eventVersion = (state: {
  readonly kind: CalendarBridgeEventVersion["kind"];
  readonly revision: string | null;
  readonly snapshot: string | null;
}): CalendarBridgeEventVersion => ({
  kind: state.kind,
  revision: state.revision,
  ...(state.kind === "present"
    ? snapshotFields(state.snapshot)
    : snapshotFields(null)),
});

/** The best-known title and time: accepted, then Google, then Baikal. */
const describeLink = (
  link: CalendarBridgeLinkRecord,
): {
  readonly title: string | null;
  readonly start: string | null;
  readonly allDay: boolean | null;
} => {
  for (const snapshot of [
    link.acceptedSnapshot,
    link.google.snapshot,
    link.baikal.snapshot,
  ]) {
    const fields = snapshotFields(snapshot);
    if (fields.summary !== null || fields.start !== null)
      return {
        title: fields.summary,
        start: fields.start,
        allDay: fields.allDay,
      };
  }
  return { title: null, start: null, allDay: null };
};

const deletedSide = (
  link: CalendarBridgeLinkRecord,
): CalendarBridgeSideName | null =>
  link.google.kind === "deleted"
    ? "google"
    : link.baikal.kind === "deleted"
      ? "baikal"
      : null;

const counts = (
  links: readonly CalendarBridgeLinkRecord[],
  operations: readonly CalendarBridgeOperationRecord[],
  conflicts: readonly CalendarBridgeConflictRecord[],
): CalendarBridgeMappingSummary["counts"] => ({
  links: links.length,
  active: links.filter(({ status }) => status === "active").length,
  pendingWrites: operations.filter(({ state }) => state === "pending").length,
  inFlightWrites: operations.filter(({ state }) => state !== "pending").length,
  retryingWrites: operations.filter(({ lastError }) => lastError !== null)
    .length,
  blocked: links.filter(({ status }) => status === "blocked").length,
  pendingDeletions: links.filter(
    ({ status, statusReason, deletionApproval }) =>
      status === "blocked" &&
      statusReason === "deletion-approval" &&
      deletionApproval === null,
  ).length,
  conflicts: conflicts.length,
  excluded: links.filter(({ status }) => status === "excluded").length,
  tombstoned: links.filter(({ status }) => status === "tombstoned").length,
});

const summarize = (
  deps: BridgeControlDeps,
  google: GoogleConnectorStatusResponse,
  mapping: CalendarBridgeMappingRecord,
  now: Date,
): CalendarBridgeMappingSummary => {
  const { database } = deps;
  const store = database.calendarBridge;
  const links = store.listLinks(mapping.id);
  const operations = store.listUnfinishedOperations(mapping.id);
  const conflicts = store.listOpenConflicts(mapping.id);
  const tally = counts(links, operations, conflicts);
  const googleCalendar = database.getOwnedCalendar(
    mapping.ownerId,
    mapping.googleCalendarId,
  );
  const baikalCalendar = database.getOwnedCalendar(
    mapping.ownerId,
    mapping.baikalCalendarId,
  );
  const attention: CalendarBridgeAttention[] = [];
  const reconnect: CalendarBridgeAttention[] = [];
  if (!mapping.enabled) attention.push("paused");
  if (google.state === "disconnected") reconnect.push("google-disconnected");
  else if (google.state === "reconnect_required")
    reconnect.push("google-reconnect-required");
  else if (!deps.google.hasBridgeConsent(mapping.ownerId))
    reconnect.push("google-consent-required");
  if (googleCalendar?.kind !== "google")
    reconnect.push("google-calendar-unavailable");
  else if (
    mapping.direction !== "google_to_baikal" &&
    google.capabilities.find(
      ({ calendarId }) => calendarId === googleCalendar.id,
    )?.reason === "read-only-calendar"
  )
    reconnect.push("google-calendar-read-only");
  if (
    baikalCalendar?.kind !== "baikal" ||
    database.getBaikalConnector(mapping.ownerId) === undefined
  )
    reconnect.push("baikal-unavailable");
  attention.push(...reconnect);
  const failing = mapping.lastErrorCode !== null;
  if (failing) attention.push("last-pass-failed");
  if (mapping.lastRunAt === null) attention.push("not-run");
  const stale =
    mapping.enabled &&
    (mapping.lastSuccessAt === null
      ? mapping.lastRunAt !== null
      : now.getTime() - Date.parse(mapping.lastSuccessAt) >
        calendarBridgeStaleAfterMinutes * 60_000);
  if (stale) attention.push("stale");
  if (tally.conflicts > 0) attention.push("conflicts");
  if (tally.pendingDeletions > 0) attention.push("deletions-awaiting-approval");
  if (tally.blocked > tally.pendingDeletions) attention.push("blocked-events");
  if (tally.retryingWrites > 0) attention.push("writes-retrying");
  if (tally.inFlightWrites > 0) attention.push("writes-unconfirmed");
  const review =
    tally.conflicts > 0 || tally.blocked > 0 || tally.retryingWrites > 0;
  const state: CalendarBridgeMappingState = !mapping.enabled
    ? "paused"
    : reconnect.length > 0
      ? "reconnect-required"
      : failing
        ? "failing"
        : review
          ? "needs-review"
          : mapping.lastRunAt === null
            ? "not-run"
            : "ok";
  return {
    id: mapping.id,
    revision: mapping.revision,
    googleCalendarId: mapping.googleCalendarId,
    googleCalendarRef: mapping.googleCalendarRef,
    baikalCalendarId: mapping.baikalCalendarId,
    baikalCalendarRef: mapping.baikalCalendarRef,
    direction: mapping.direction,
    initialSync: mapping.initialSync,
    enabled: mapping.enabled,
    firstPassAt: mapping.firstPassAt,
    lastRunAt: mapping.lastRunAt,
    lastSuccessAt: mapping.lastSuccessAt,
    lastErrorCode: mapping.lastErrorCode,
    createdAt: mapping.createdAt,
    updatedAt: mapping.updatedAt,
    googleCalendarName: googleCalendar?.displayName ?? null,
    baikalCalendarName: baikalCalendar?.displayName ?? null,
    state,
    stale,
    attention,
    counts: tally,
  };
};

export const bridgeOverview = (
  deps: BridgeControlDeps,
  ownerId: string,
  now: Date,
): CalendarBridgeOverviewResponse => {
  const google = deps.google.status(ownerId, now);
  return {
    staleAfterMinutes: calendarBridgeStaleAfterMinutes,
    mappings: deps.database.calendarBridge
      .listMappings(ownerId)
      .map((mapping) => summarize(deps, google, mapping, now)),
  };
};

export const bridgeReview = (
  deps: BridgeControlDeps,
  ownerId: string,
  mappingId: string,
  now: Date,
): CalendarBridgeReviewResponse | undefined => {
  const store = deps.database.calendarBridge;
  const mapping = store.getMapping(ownerId, mappingId);
  if (mapping === undefined) return undefined;
  const links = store.listLinks(mapping.id);
  const byId = new Map(links.map((link) => [link.id, link]));
  const blocked: CalendarBridgeBlockedEvent[] = links
    .filter(({ status }) => status === "blocked")
    .slice(0, calendarBridgeReviewListLimit)
    .map((link) => {
      const described = describeLink(link);
      return {
        linkId: link.id,
        linkRevision: link.revision,
        title: described.title,
        start: described.start,
        allDay: described.allDay,
        origin: link.origin,
        reason: link.statusReason,
        deletedOn:
          link.statusReason === "deletion-approval" ? deletedSide(link) : null,
        approved: link.deletionApproval !== null,
      };
    });
  return {
    mapping: summarize(deps, deps.google.status(ownerId, now), mapping, now),
    blocked,
    conflicts: store
      .listOpenConflicts(mapping.id)
      .slice(0, calendarBridgeReviewListLimit)
      .map((conflict) => {
        const link = byId.get(conflict.linkId);
        const google = eventVersion(conflict.google);
        const baikal = eventVersion(conflict.baikal);
        return {
          id: conflict.id,
          linkId: conflict.linkId,
          linkRevision: link?.revision ?? 1,
          reason: conflict.reason,
          title:
            google.summary ??
            baikal.summary ??
            (link === undefined ? null : describeLink(link).title),
          createdAt: conflict.createdAt,
          google,
          baikal,
        };
      }),
    operations: store
      .listUnfinishedOperations(mapping.id)
      .slice(0, calendarBridgeReviewListLimit)
      .map((operation) => {
        const link = byId.get(operation.linkId);
        return {
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
          title:
            snapshotFields(operation.payload).summary ??
            (link === undefined ? null : describeLink(link).title),
        };
      }),
  };
};

/**
 * What a new mapping would copy (ADR 0044), from the events Tadooer last read
 * from each calendar. Mirrors the refusals of `CalendarBridgeService.
 * createMapping` and the store without writing anything.
 */
export const previewBridgeMapping = (
  deps: BridgeControlDeps,
  ownerId: string,
  input: CalendarBridgeMappingCreateRequest,
): CalendarBridgeMappingPreviewResponse => {
  const { database } = deps;
  const refusals: CalendarBridgeCreateRefusal[] = [];
  if (!deps.google.hasBridgeConsent(ownerId)) refusals.push("consent-required");
  else if (
    input.direction !== "google_to_baikal" &&
    !deps.google.writeCapability(ownerId, input.googleCalendarId).writable
  )
    refusals.push("google-calendar-not-writable");
  const google = database.getOwnedCalendar(ownerId, input.googleCalendarId);
  const baikal = database.getOwnedCalendar(ownerId, input.baikalCalendarId);
  if (
    google?.kind !== "google" ||
    baikal?.kind !== "baikal" ||
    !google.supportsEvents ||
    !baikal.supportsEvents
  )
    refusals.push("invalid-calendar");
  else if (
    database.calendarBridge
      .listMappings(ownerId)
      .some(
        (mapping) =>
          mapping.googleCalendarId === input.googleCalendarId ||
          mapping.baikalCalendarId === input.baikalCalendarId,
      )
  )
    refusals.push("calendar-in-use");
  const events = database.listCalendarEvents(
    ownerId,
    "0001-01-01T00:00:00.000Z",
    "9999-12-31T23:59:59.999Z",
  );
  const googleSync = database
    .listGoogleCalendarSync(ownerId)
    .find(({ calendarId }) => calendarId === input.googleCalendarId);
  const copy = (
    from: CalendarBridgeSideName,
    calendarId: string,
  ): CalendarBridgeCopyPreview => {
    const own = events.filter((event) => event.calendarId === calendarId);
    const first = new Map<string, (typeof own)[number]>();
    const repeating = new Set<string>();
    for (const event of own) {
      if (!first.has(event.uid)) first.set(event.uid, event);
      if (event.recurrence === "instance") repeating.add(event.uid);
    }
    const distinct = [...first.values()];
    const projectedAt = own
      .map((event) => event.projectedAt)
      .toSorted()
      .at(-1);
    return {
      from,
      to: from === "google" ? "baikal" : "google",
      existing: distinct.length,
      copied: input.initialSync === "new_only" ? 0 : distinct.length,
      repeating: repeating.size,
      sample: distinct.slice(0, 10).map((event) => ({
        summary: event.summary,
        startsAt: event.startsAt,
        allDay: event.allDay,
      })),
      readAt:
        (from === "google" ? googleSync?.lastSuccessfulSyncAt : undefined) ??
        projectedAt ??
        null,
    };
  };
  const copies: CalendarBridgeCopyPreview[] = [];
  if (input.direction !== "baikal_to_google")
    copies.push(copy("google", input.googleCalendarId));
  if (input.direction !== "google_to_baikal")
    copies.push(copy("baikal", input.baikalCalendarId));
  return {
    direction: input.direction,
    initialSync: input.initialSync,
    refusals,
    copies,
  };
};
