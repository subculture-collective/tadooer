---
status: accepted
---

# Read-only iCal subscriptions

Issue #91 (roadmap #15, parity row `calendar-subscriptions`). Reference:
Super Productivity 19.1.0 at `42ded9f31a132bf92633b0c78ad4ebf1d87c0f71`,
`src/app/features/calendar-integration` and
`src/app/features/issue/providers/calendar`. Builds on the calendar
projection of ADR 0009, the Google/Baikal bridge boundary of ADR 0017, the
planned day and start of ADR 0020 and the day start of ADR 0027.

Before this change Tadooer read calendars only through a connector: Baikal
CalDAV or the Google grant. A calendar published as an iCal address (a shared
team calendar, a holiday feed, a private Google or Outlook feed with a token
in the address) had no place, and Super Productivity users with `ICAL`
providers lost them on import.

## Source semantics (Super Productivity 19.1.0)

- An iCal calendar is an issue provider (`issueProviderKey: "ICAL"`,
  `CalendarProviderCfg`): `icalUrl`, `checkUpdatesEvery` (milliseconds,
  default two hours), `isAutoImportForCurrentDay`, `isReferenceCalendar`,
  `color`, `icon`, `filterIncludeRegex`, `filterExcludeRegex`,
  `showBannerBeforeThreshold`, `isDisabledForWebApp`, plus the generic
  provider fields. The browser fetches the address itself.
- Events are read-only. The schedule shows them; a click converts one to a
  task with a deterministic ID (`cal_<provider>_<event>`), so the same event
  never becomes two tasks across devices. Reference calendars show events
  for context only and offer no task actions.
- Auto-import creates tasks for the current day's events. Skipped event IDs
  and the IDs of events already turned into tasks are remembered so a
  deleted or completed calendar task is not re-created.
- Hidden event IDs live in local storage (at most 500). Include and exclude
  filters are regular expressions checked against the title with a
  catastrophic-backtracking guard; an unusable include pattern hides every
  event and an unusable exclude pattern excludes nothing.
- Error logs and messages replace the address with its host, because feed
  addresses often embed a secret.

## Decision

### Subscriptions

A **calendar subscription** is an owner-scoped, revisioned record of one iCal
address with a name, refresh interval (5 to 1,440 minutes, default 120),
optional colour and icon, optional include and exclude title patterns,
`referenceOnly`, `autoImport`, `enabled` and `hidden` flags (migration
`0036_calendar_subscriptions`). At most 25 per owner.

- The address is accepted on create or change, validated (http, https or
  webcal, no embedded credentials, not loopback, link-local, multicast,
  unspecified or metadata addresses; private LAN ranges stay allowed because
  the homelab serves feeds from them) and stored only as AES-256-GCM
  ciphertext under the connector credential key, bound to the owner,
  subscription and key ID. The host is the only address-derived value kept
  in clear. No route, log, assistant preview, resource or export returns the
  address.
- A subscription is not a calendar provider record and has no connector. Its
  events join `listCalendarEvents` as provider kind `ical`, so the planner,
  reminders and the assistant schedule resource see them beside Baikal and
  Google events, and never join the Google/Baikal bridge (ADR 0017). Nothing
  is ever written to the feed.
- Subscriptions and their events are online-only: outside the sync feed and
  the offline cache.

### Fetching

The server fetches feeds; the browser never does. A fetch is due when
`nextFetchAt` has passed; the notification tick fetches due subscriptions
(at most ten per tick), and the owner or assistant can fetch one at once.

- Before each request the host is resolved and every resolved address is
  checked with the same policy as the literal address. At most three
  redirects are followed, each re-checked. Requests time out at 20 seconds,
  send `If-None-Match` and `If-Modified-Since`, and refuse bodies over the
  4 MiB parser limit.
- The feed parser (`parseIcalFeed`) keeps occurrences from 30 days before
  the fetch to 400 days after, at most 2,000 in total and 500 per series. It
  expands DAILY, WEEKLY, MONTHLY and YEARLY rules with INTERVAL, COUNT,
  UNTIL, BYDAY, BYMONTHDAY and BYMONTH, honours EXDATE, RECURRENCE-ID
  overrides and STATUS:CANCELLED, and falls back to the owner's planning
  zone for floating times and unknown TZIDs. A series with another rule
  contributes its first occurrence and is counted as unsupported.
- The outcome is recorded on the subscription: a fetched feed replaces the
  saved occurrences and stores the validators; `304` keeps them; a failure
  stores a bounded error class (`http_404`, `blocked_address`, `dns_failed`,
  `timeout`, `network_error`, `too_large`, `not_calendar`, `key_unavailable`
  and the redirect classes) and retries within 30 minutes. Freshness is
  derived: `never`, `fresh` (a success within two intervals and no error
  since), `stale` (saved events shown after an overdue or failed fetch) or
  `unavailable` (no success yet). A new address discards the previous feed's
  events and validators.
- Include and exclude patterns are applied when events are read, with the
  source's fail-closed/fail-open semantics and its backtracking guard, so a
  filter change needs no refetch. Patterns that fail the guard are rejected
  on write.

### Conversion, auto-import and tombstones

- **Convert.** An occurrence (subscription, UID, occurrence start) becomes
  one task: the summary as title, the subscription name and the event URL
  in the notes, the event start as the planned start with the duration as
  the estimate, or the event date as the planned day for an all-day event.
  The idempotency key is the occurrence identity, and a conversion record
  keeps the task ID, so converting again returns the same task. Reference
  calendars refuse conversion.
- **Dismiss.** The owner can mark an occurrence as not to be imported. A
  dismissal never replaces a conversion; a conversion replaces a dismissal.
- **Auto-import.** On the tick, for each enabled, visible, non-reference
  subscription with `autoImport`, every visible occurrence in the owner's
  current local day that has neither a conversion nor a dismissal is
  converted. Conversion records are the tombstones: a task deleted, archived
  or completed after import is never re-created, because its record stays.
- Task provenance is the conversion record (`conversionForTask`); the task
  itself carries no calendar field. Deleting a subscription removes its
  events, hidden events and conversion records but never its tasks.

### Hiding

An occurrence can be hidden (at most 1,000 per subscription, oldest dropped)
and a subscription can be hidden as a whole. Hidden items leave the planner
and the assistant schedule but stay in the owner's event list, and unhiding
needs no refetch. Hiding never deletes feed data or tasks.

### API and assistant

Browser routes under `/api/calendar-subscriptions` (owner session, same
origin, CSRF, `If-Match` revisions for edits and removal) list, create (with
an immediate first fetch), edit, remove and refresh subscriptions, list
events for a window of at most 31 days including hidden ones, and hide,
convert or dismiss an occurrence. The web Connections page carries the form
and the next seven days of events.

The assistant catalog gains `calendar_subscriptions.list` (`schedule:read`),
`calendar_subscriptions.refresh` and `calendar_subscriptions.hide_event`
(`schedule:write`) and `calendar_subscriptions.convert_event`
(`tasks:write`). Previews name the subscription and host and say when an
event already has a task. Adding, editing, dismissing and removing
subscriptions stay owner-only because the address may embed a token.

### Import

`ICAL` providers in a Super Productivity export remain configuration: their
fields are reviewed as `calendarProviderFields` in the parity manifest with
the corresponding Tadooer setting, and nothing from them is read or stored.
The owner re-creates each subscription with the address entered once.

## Consequences

- The feed address is a secret handled like a connector credential. Losing
  the credential key makes existing subscriptions unfetchable
  (`key_unavailable`) until the owner re-enters the address.
- Subscription events are conditional on the last fetch. The planner reports
  them as current projections; the subscription's own freshness says how old
  they are. Reminder suppression treats them as busy time like other events.
- The recurrence expander covers the common rule shapes, not RFC 5545 in
  full. Unsupported series show their first occurrence and are counted, so
  the owner can see the gap.
- Colour and icon are stored and returned but not yet rendered in the
  planner. Plugin calendar providers and the source's banner threshold are
  out of scope.

## Verification

- `packages/domain/src/ical-subscription.test.ts`: address policy, filter
  guard, scheduling and freshness.
- `packages/import-export/src/ical-feed.test.ts`: parsing, zones,
  recurrence, overrides and bounds.
- `packages/persistence/src/calendar-subscriptions.test.ts`: store,
  projection, hidden events, conversions, tombstones, restart and backup
  without the address.
- `apps/server/src/calendar-subscriptions.test.ts`: HTTP and assistant flows
  with a fake fetcher and resolver, including blocked addresses, redirects,
  conditional refresh, one-task conversion, auto-import after dismissal and
  deletion, and no address in any response.
- `apps/web/src/components/CalendarSubscriptions.test.tsx`: the view and its
  form validation.
- Real-data qualification against the owner's export remains #47.
