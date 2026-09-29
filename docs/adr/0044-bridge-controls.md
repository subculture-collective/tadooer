---
status: accepted
---

# Calendar bridge controls: mapping status, review and assistant access

Issue #48 (roadmap #15). Builds on the mappings, event links, outbox and
owner routes of ADR 0041, the write consent of ADR 0040 and the confirmation
policy of ADR 0035. It adds the owner's controls on the Connections page and
scoped assistant operations. The engine, envelope and scheduling are
unchanged; #45 owns event semantics and #46 the background worker.

## Owner routes (additive)

All keep ADR 0041's owner session, CSRF and online-only rules.

- `GET /api/calendar-bridge/overview`: every live mapping with the calendar
  names, a derived `state`, an `attention` list and counts (links, active,
  pending writes, writes in flight, writes retrying after an error, blocked
  events, deletions awaiting approval, open conflicts, excluded, tombstoned).
- `POST /api/calendar-bridge/mappings/preview` with the create body: what the
  mapping would copy, computed from the events Tadooer last read from each
  calendar. Per allowed direction it reports the existing events, how many
  would be copied (none for `new_only`), how many repeat, up to ten titles, the
  time of the last read, and why creation would be refused (`consent-required`,
  `google-calendar-not-writable`, `calendar-in-use`, `invalid-calendar`). It
  writes nothing and does not contact either provider.
- `GET /api/calendar-bridge/mappings/:id/review`: the mapping summary, blocked
  links with their reason and the side that deleted the event, open conflicts
  with both retained versions, and unfinished writes. Each list returns at
  most 200 entries; the counts give the totals.
- `POST /api/calendar-bridge/mappings/:id/links/:linkId/decline-deletion` with
  the link `If-Match`: the owner keeps the surviving copy. The link becomes
  `excluded` with reason `deletion-declined`, so the deletion is never
  propagated and the bridge stops syncing that event. Nothing is written to
  either calendar.
- `POST .../conflicts/:conflictId/resolve` accepts an optional link
  `If-Match`. Without it the conflict ID already binds the exact versions: a
  later change supersedes the conflict and the ID no longer resolves.

A version is read from the retained normalized snapshot: title, description,
location, start, end, all-day, the names of unsupported fields and the
opaque native revision. It never includes provider credentials or raw
iCalendar.

## State

`state` is the first that applies: `paused` (disabled), `reconnect-required`
(Google disconnected or needing reconnection, write consent missing or lost,
the Google calendar gone or no longer writable for a direction that writes
Google, or the Baikal connector or calendar gone), `failing` (the last pass
recorded an error), `needs-review` (conflicts, deletions awaiting approval,
other blocked events or writes retrying after an error), `not-run` (no pass yet) and `ok`. `stale` is true for an
enabled mapping whose last success is more than 24 hours old, or that has run
without ever succeeding. Until #46 schedules passes,
an enabled mapping becomes stale unless the owner runs it.

## Owner journey

The Connections page gains a Calendar bridge card:

1. Choose one Google and one Baikal calendar, the direction and the initial
   sync. The initial-sync choice has no default. A Google calendar that is not
   writable is labeled with the reason and only offers Google to Baikal.
2. Preview, then create. Changing any field discards the preview.
3. Each mapping shows its state, last pass, last success, pending writes,
   blocked events and conflicts, with Run pass now, Pause or Resume, Review
   and Remove.
4. Review lists conflicts with both versions side by side and "Keep Google
   version" or "Keep Baikal version", deletions awaiting approval with
   "Approve deletion" or "Keep the other copy", and other blocked events with
   their reason. Every choice asks for confirmation that names its effect.
5. Remove is refused while a write's outcome is unconfirmed. With pending
   writes the owner must tick "Discard N pending writes"; removal never
   deletes events.

## Assistant operations

Two scopes, so no existing token gains anything: `calendar_bridge:read` and
`calendar_bridge:review`. `automation.confirm` accepts `calendar_bridge:review`.

- Resource `calendar_bridge.status` (`calendar_bridge:read`), input
  `{ mappingId? }`: the overview; with `mappingId`, also that mapping's review.
- Tool `calendar_bridge.decide_deletion` (`calendar_bridge:review`), input
  `{ mappingId, linkId, expectedRevision, decision: "approve" | "keep" }`.
  Rule `by_action` on `decision`: `approve` is consequential (`deletion`)
  because the next pass deletes the other copy; `keep` is ordinary because it
  writes nothing and changes one revision-bound link.
- Tool `calendar_bridge.resolve_conflict` (`calendar_bridge:review`), input
  `{ mappingId, conflictId, keep, expectedLinkRevision }`. Always
  consequential (`destructive_replacement`): the chosen version overwrites or
  deletes the other copy.

Previews name the event, both versions and the effect, list the mapping, link
and (for resolution) conflict as affected entities (new kinds
`calendar_bridge_mapping`, `calendar_bridge_link`, `calendar_bridge_conflict`)
and write nothing. Confirmation repeats the check against the link revision
inside the store transaction, so a change in between answers
`AUTOMATION_PREVIEW_STALE`. Results are `{ link }` and `{ operation }` as in
the owner routes.

Creating, pausing, removing and running a mapping stay owner-only. They choose
which calendars exchange events, discard pending work or send queued writes to
both providers; the inventory records this.

## Persistence

No migration; 0048 is not used. The store gains `declineDeletion` and an
optional `expectedLinkRevision` on `resolveConflict`. Views are built from the
existing read models (`listMappings`, `listLinks`, `listOpenConflicts`,
`listUnfinishedOperations`) and the calendar projections.

## Limits

The creation preview uses the last read of each calendar, which covers the
projection window, not necessarily every event the first pass will see; the
page says so. A declined deletion cannot be re-linked; the owner can copy the
event by hand. No live-provider qualification (#50). Stale detection has no
schedule to compare against until #46.
