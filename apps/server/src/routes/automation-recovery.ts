import type {
  AutomationCalendarFeed,
  AutomationCalendarFeedResource,
  AutomationCalendarImportJob,
  AutomationCalendarImportResource,
  AutomationCalendarImportSummary,
  AutomationConfirmationResponse,
  AutomationConnectorStatusResource,
  AutomationPreviewCommand,
  AutomationRecoveryStep,
} from "@suite/contracts";
import { calendarImportReportSchema } from "@suite/contracts";
import type {
  CalendarFeedCapabilityRecord,
  CalendarImportJobRecord,
  SuiteDatabase,
} from "@suite/persistence";
import type { BaikalConnectorService } from "../connector.ts";
import type { GoogleConnectorService } from "../google-connector.ts";

// Assistant import, publication and connector recovery (issue #60, ADR 0038).
// automation.ts keeps the shared preview/confirm protocol. Everything that
// reveals or rotates a secret stays owner-only: Baikal credentials, Google
// consent and disconnect, feed creation (the address is shown once) and the
// Super Productivity export upload. The assistant reads status, applies a
// calendar import the owner already previewed, revokes a feed and retries a
// Google sync with the stored grant. Nothing here returns a credential, a
// capability secret or a feed address, and candidates omit rawIcs. None of
// the three records is revisioned, so confirmation repeats the state check.

export type RecoveryCommand = Extract<
  AutomationPreviewCommand,
  {
    operation: "imports.apply" | "calendar_feeds.revoke" | "connectors.resync";
  }
>;

type Result = AutomationConfirmationResponse["result"];

export const isRecoveryCommand = (
  command: AutomationPreviewCommand,
): command is RecoveryCommand =>
  command.operation === "imports.apply" ||
  command.operation === "calendar_feeds.revoke" ||
  command.operation === "connectors.resync";

const quoted = (value: string): string =>
  `"${value.length > 60 ? `${value.slice(0, 57)}...` : value}"`;

const plural = (count: number, noun: string): string =>
  `${String(count)} ${noun}${count === 1 ? "" : "s"}`;

/* Resources */

const importSummary = (
  database: SuiteDatabase,
  job: CalendarImportJobRecord,
): AutomationCalendarImportSummary => {
  const report = calendarImportReportSchema.parse(job.report);
  const counts = {
    pending: 0,
    applied: 0,
    reconciliationRequired: 0,
    skipped: 0,
  };
  for (const item of job.items)
    if (item.state === "reconciliation_required")
      counts.reconciliationRequired += 1;
    else counts[item.state] += 1;
  return {
    id: job.id,
    calendarId: job.calendarId,
    calendarName:
      database.getOwnedCalendar(job.ownerId, job.calendarId)?.displayName ??
      null,
    source: job.source,
    inputHash: job.inputHash,
    state: job.state,
    createdAt: job.createdAt,
    appliedAt: job.appliedAt,
    totals: report.totals,
    itemCounts: counts,
  };
};

/** One job with its report and item states; no rawIcs anywhere. */
export const importJobBody = (
  database: SuiteDatabase,
  job: CalendarImportJobRecord,
): AutomationCalendarImportJob => {
  const report = calendarImportReportSchema.parse(job.report);
  return {
    ...importSummary(database, job),
    report: {
      ...report,
      candidates: report.candidates.map(({ rawIcs: _raw, ...candidate }) => {
        void _raw;
        return candidate;
      }),
    },
    items: job.items.map((item) => ({
      externalId: item.externalId,
      uid: item.uid,
      href: item.href,
      state: item.state,
      appliedAt: item.appliedAt,
    })),
  };
};

export const importResourceBody = (
  database: SuiteDatabase,
  ownerId: string,
  jobId: string | undefined,
):
  | { readonly ok: true; readonly body: AutomationCalendarImportResource }
  | { readonly ok: false } => {
  const job =
    jobId === undefined
      ? undefined
      : database.getCalendarImportJob(ownerId, jobId);
  if (jobId !== undefined && job === undefined) return { ok: false };
  const provenance = database.summarizeTaskImportSources(ownerId);
  return {
    ok: true,
    body: {
      jobs: database
        .listCalendarImportJobs(ownerId)
        .map((record) => importSummary(database, record)),
      job: job === undefined ? null : importJobBody(database, job),
      superProductivity: {
        lastImportedAt:
          provenance.length === 0
            ? null
            : (provenance
                .map(({ lastImportedAt }) => lastImportedAt)
                .toSorted()
                .at(-1) ?? null),
        entities: provenance.map((entry) => ({ ...entry })),
      },
    },
  };
};

const feedBody = (
  database: SuiteDatabase,
  record: CalendarFeedCapabilityRecord,
): AutomationCalendarFeed => ({
  id: record.id,
  calendarId: record.calendarId,
  calendarName:
    database.getOwnedCalendar(record.ownerId, record.calendarId)?.displayName ??
    null,
  label: record.label,
  createdAt: record.createdAt,
  revokedAt: record.revokedAt,
  active: record.revokedAt === null,
});

export const feedResourceBody = (
  database: SuiteDatabase,
  ownerId: string,
): AutomationCalendarFeedResource => {
  const capabilities = database.listCalendarFeedCapabilities(ownerId);
  return {
    feeds: capabilities.map((record) => feedBody(database, record)),
    calendars: database.listOwnedCalendars(ownerId).map((calendar) => ({
      calendarId: calendar.id,
      displayName: calendar.displayName,
      providerKind: calendar.kind,
      publishedEvents: database.listPublishedCalendarRaw(ownerId, calendar.id)
        .length,
      activeFeeds: capabilities.filter(
        (record) =>
          record.calendarId === calendar.id && record.revokedAt === null,
      ).length,
    })),
  };
};

const ownerReconnect = (reason: string): boolean =>
  reason === "credential-unavailable" ||
  reason === "authentication-required" ||
  reason === "authorization-denied";

export const connectorStatusBody = async (
  database: SuiteDatabase,
  baikal: BaikalConnectorService,
  google: GoogleConnectorService,
  ownerId: string,
  now: Date,
): Promise<AutomationConnectorStatusResource> => {
  const recovery: AutomationRecoveryStep[] = [];
  const verified = await baikal.status(ownerId);
  const stored = database.getBaikalConnector(ownerId);
  const baikalStatus: AutomationConnectorStatusResource["baikal"] = verified.ok
    ? {
        state: verified.status.connected ? "connected" : "disconnected",
        reason: null,
        providerId: verified.status.providerId,
        endpointHost: new URL(verified.status.endpoint).host,
        username: verified.status.username,
        verifiedAt: verified.status.verifiedAt,
        calendars: verified.status.calendars,
      }
    : {
        state: "unavailable",
        reason: verified.reason,
        providerId: null,
        endpointHost:
          stored === undefined ? "unknown" : new URL(stored.endpoint).host,
        username: stored?.username ?? null,
        verifiedAt: stored?.verifiedAt ?? null,
        calendars: [],
      };
  if (baikalStatus.state === "disconnected")
    recovery.push({
      connector: "baikal",
      actor: "owner",
      operation: null,
      message:
        "Baikal is not connected. The owner enters the CalDAV username and password in the browser; the assistant cannot supply credentials.",
    });
  else if (baikalStatus.state === "unavailable")
    recovery.push({
      connector: "baikal",
      actor: ownerReconnect(baikalStatus.reason ?? "") ? "owner" : "none",
      operation: null,
      message: ownerReconnect(baikalStatus.reason ?? "")
        ? `Baikal rejected or cannot use the stored credential (${baikalStatus.reason ?? "unknown"}). The owner must enter the credential again in the browser; a retry will not repair this.`
        : `Baikal did not answer (${baikalStatus.reason ?? "unknown"}). Read the status again later; the stored credential is unchanged and no action is needed yet.`,
    });

  const googleStatus = google.status(ownerId, now);
  if (!googleStatus.configured)
    recovery.push({
      connector: "google",
      actor: "owner",
      operation: null,
      message:
        "Google OAuth configuration is not installed on the server, so no grant can be used or requested.",
    });
  else if (googleStatus.state === "disconnected")
    recovery.push({
      connector: "google",
      actor: "owner",
      operation: null,
      message:
        "Google is not authorized. The owner completes the consent flow in the browser; the assistant cannot request consent.",
    });
  else if (googleStatus.state === "reconnect_required")
    recovery.push({
      connector: "google",
      actor: "owner",
      operation: null,
      message:
        "Google rejected the stored grant. The owner must authorize again in the browser; a resync cannot repair a revoked grant.",
    });
  else if (
    googleStatus.state === "stale" ||
    googleStatus.freshness.some(({ state }) => state !== "fresh")
  )
    recovery.push({
      connector: "google",
      actor: "assistant",
      operation: "connectors.resync",
      message:
        "The last Google sync did not complete or the projection is stale. Retry with connectors.resync using the stored grant; no new authorization is requested.",
    });
  return { baikal: baikalStatus, google: googleStatus, recovery };
};

/* Preview */

export type RecoveryPreview =
  | {
      readonly ok: true;
      readonly summary: string;
      readonly affected: readonly {
        readonly entityKind:
          "calendar_import" | "calendar_feed" | "connector" | "calendar";
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
): RecoveryPreview => ({ ok: false, status, code, message });

export const previewRecovery = (
  database: SuiteDatabase,
  google: GoogleConnectorService,
  ownerId: string,
  command: RecoveryCommand,
  now: Date,
): RecoveryPreview => {
  if (command.operation === "imports.apply") {
    const job = database.getCalendarImportJob(ownerId, command.input.jobId);
    if (job === undefined)
      return failure(404, "IMPORT_NOT_FOUND", "Calendar import not found");
    if (job.inputHash !== command.input.expectedInputHash)
      return failure(
        409,
        "IMPORT_PREVIEW_CHANGED",
        "The fingerprint differs from the owner's previewed upload. Read imports.list again; nothing was written.",
      );
    const calendar = database.getOwnedCalendar(ownerId, job.calendarId);
    if (calendar === undefined)
      return failure(
        404,
        "CALENDAR_NOT_FOUND",
        "The destination calendar of this import is no longer available",
      );
    const affected = [
      { entityKind: "calendar_import" as const, entityId: job.id },
      { entityKind: "calendar" as const, entityId: job.calendarId },
    ];
    if (job.state === "applied")
      return {
        ok: true,
        summary: `The ${job.source} import previewed at ${job.createdAt} was already applied to ${quoted(calendar.displayName)} at ${job.appliedAt ?? "an unknown time"}; confirmation returns it without writing anything.`,
        affected,
      };
    const remaining = job.items.filter(({ state }) => state !== "applied");
    const report = calendarImportReportSchema.parse(job.report);
    return {
      ok: true,
      summary: `Write ${plural(remaining.length, "event")} from the ${job.source} import the owner previewed at ${job.createdAt} (fingerprint ${job.inputHash.slice(0, 12)}) into the ${quoted(calendar.displayName)} calendar; ${plural(report.totals.skipped, "component")} stay skipped. Nothing was written during preview.`,
      affected,
    };
  }
  if (command.operation === "calendar_feeds.revoke") {
    const feed = database.getCalendarFeedCapability(command.input.feedId);
    if (feed?.ownerId !== ownerId)
      return failure(404, "FEED_NOT_FOUND", "Calendar feed not found");
    if (feed.revokedAt !== null)
      return failure(
        409,
        "FEED_ALREADY_REVOKED",
        `The feed was already revoked at ${feed.revokedAt}`,
      );
    const calendarName =
      database.getOwnedCalendar(ownerId, feed.calendarId)?.displayName ??
      "a removed calendar";
    return {
      ok: true,
      summary: `Revoke the read-only feed ${quoted(feed.label)} for the ${quoted(calendarName)} calendar. Every client using its address stops receiving the calendar; the address cannot be restored, only a new feed created by the owner.`,
      affected: [
        { entityKind: "calendar_feed", entityId: feed.id },
        { entityKind: "calendar", entityId: feed.calendarId },
      ],
    };
  }
  const status = google.status(ownerId, now);
  if (!status.configured)
    return failure(
      409,
      "GOOGLE_OAUTH_NOT_CONFIGURED",
      "Google OAuth configuration is not installed; nothing can be retried",
    );
  const connector = database.getGoogleConnector(ownerId);
  if (connector === undefined || status.state === "disconnected")
    return failure(
      409,
      "CONNECTOR_NOT_CONNECTED",
      "Google is not authorized; the owner must connect it in the browser",
    );
  const reset = command.input.full
    ? `, discarding and rebuilding the projection of ${plural(status.calendars.length, "calendar")}`
    : "";
  return {
    ok: true,
    summary: `Fetch Google calendar changes for ${status.accountLabel === null ? "the connected account" : quoted(status.accountLabel)} now${reset}. The stored grant is reused; no new authorization or scope is requested.${status.state === "reconnect_required" ? " The grant was last rejected, so this attempt may fail again." : ""}`,
    affected: [{ entityKind: "connector", entityId: connector.id }],
  };
};

/* Confirmation */

/**
 * The import writes and the Google fetch are network calls, so they run
 * before the receipt commits and return their result directly, like a
 * subscription refresh; each import item mark is durable on its own and a
 * retry resumes from the remaining items. A feed revocation applies inside
 * the confirmation transaction.
 */
export const confirmRecovery = async (
  database: SuiteDatabase,
  baikal: BaikalConnectorService,
  google: GoogleConnectorService,
  ownerId: string,
  command: RecoveryCommand,
  now: () => string,
): Promise<
  | { readonly ok: true; readonly result: Result }
  | { readonly ok: true; readonly apply: () => Result }
  | {
      readonly ok: false;
      readonly status: number;
      readonly message: string;
    }
> => {
  const current = previewRecovery(
    database,
    google,
    ownerId,
    command,
    new Date(now()),
  );
  if (!current.ok)
    return { ok: false, status: current.status, message: current.message };
  if (command.operation === "imports.apply") {
    const job = database.getCalendarImportJob(ownerId, command.input.jobId);
    if (job === undefined)
      return { ok: false, status: 404, message: "Calendar import not found" };
    const replayed = job.state === "applied";
    if (!replayed) {
      const timestamp = now();
      for (const item of job.items) {
        if (item.state === "applied") continue;
        const write = await baikal.putImportedEvent({
          ownerId,
          calendarId: job.calendarId,
          href: item.href,
          rawIcs: item.rawIcs,
        });
        database.markCalendarImportItem(
          ownerId,
          job.id,
          item.externalId,
          write.ok || write.reason === "precondition-failed"
            ? "applied"
            : "reconciliation_required",
          timestamp,
        );
      }
    }
    const completed = database.finishCalendarImport(ownerId, job.id, now());
    if (completed === undefined)
      return { ok: false, status: 404, message: "Calendar import disappeared" };
    return {
      ok: true,
      result: { job: importJobBody(database, completed), replayed },
    };
  }
  if (command.operation === "calendar_feeds.revoke") {
    const feedId = command.input.feedId;
    return {
      ok: true,
      apply: () => {
        if (!database.revokeCalendarFeedCapability(ownerId, feedId, now()))
          throw new Error("Calendar feed changed during confirmation");
        const record = database.getCalendarFeedCapability(feedId);
        if (record === undefined)
          throw new Error("Calendar feed disappeared during confirmation");
        return { feed: feedBody(database, record) };
      },
    };
  }
  const synchronized = await google.synchronize(
    ownerId,
    new Date(now()),
    command.input.full,
  );
  return {
    ok: true,
    result: {
      status: synchronized.status,
      resetCalendars: [...synchronized.resetCalendars],
    },
  };
};
