import type { FieldDisposition } from "./super-productivity-schema.ts";

/**
 * Super Productivity 19.1.0 iCal calendar providers (issue #91, ADR 0032):
 * `issueProvider` entries with `issueProviderKey: "ICAL"`, typed
 * `IssueProviderCalendar` (`IssueProviderBase` plus `CalendarProviderCfg`).
 *
 * The `issueProvider` section is configuration: the importer reads only a
 * provider's `id` and key for linked issues (ADR 0021) and never reads,
 * stores or logs the rest. `icalUrl` routinely embeds a private token, so
 * subscriptions are not imported; the owner re-creates them under
 * Connections. This table records the reviewed fields and, in
 * `superProductivityCalendarProviderEquivalents`, the Tadooer subscription
 * setting that corresponds to each source field.
 */
export const superProductivityCalendarProviderFields = {
  // IssueProviderBase
  id: "ignored",
  isEnabled: "ignored",
  issueProviderKey: "ignored",
  defaultProjectId: "ignored",
  defaultTagIds: "ignored",
  pinnedSearch: "ignored",
  migratedFromProjectId: "ignored",
  isAutoPoll: "ignored",
  isAutoAddToBacklog: "ignored",
  isIntegratedAddTaskBar: "ignored",
  pollingMode: "ignored",
  // CalendarProviderCfg
  icalUrl: "ignored",
  isAutoImportForCurrentDay: "ignored",
  isReferenceCalendar: "ignored",
  color: "ignored",
  icon: "ignored",
  checkUpdatesEvery: "ignored",
  showBannerBeforeThreshold: "ignored",
  isDisabledForWebApp: "ignored",
  filterIncludeRegex: "ignored",
  filterExcludeRegex: "ignored",
} as const satisfies Record<string, FieldDisposition>;

/** Tadooer subscription setting for each source field, or null when none. */
export const superProductivityCalendarProviderEquivalents: Readonly<
  Record<keyof typeof superProductivityCalendarProviderFields, string | null>
> = {
  id: null,
  isEnabled: "enabled",
  issueProviderKey: null,
  // Converted tasks land in no project; the assistant or owner assigns one.
  defaultProjectId: null,
  defaultTagIds: null,
  pinnedSearch: null,
  migratedFromProjectId: null,
  isAutoPoll: null,
  isAutoAddToBacklog: null,
  isIntegratedAddTaskBar: null,
  pollingMode: null,
  // Entered again by the owner; never copied from an export.
  icalUrl: "url",
  isAutoImportForCurrentDay: "autoImport",
  isReferenceCalendar: "referenceOnly",
  color: "color",
  icon: "icon",
  // Milliseconds in the source; minutes (5 to 1,440) in Tadooer.
  checkUpdatesEvery: "refreshIntervalMinutes",
  // Reminder banners are not a subscription setting in Tadooer.
  showBannerBeforeThreshold: null,
  // Tadooer fetches on the server, so there is no browser-only switch.
  isDisabledForWebApp: null,
  filterIncludeRegex: "includePattern",
  filterExcludeRegex: "excludePattern",
};
