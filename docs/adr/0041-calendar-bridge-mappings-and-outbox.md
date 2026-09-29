---
status: accepted
---

# Calendar bridge mappings, event links and outbox

Issue #40 (roadmap #15). Implements the durable part of ADR 0017: mappings,
event links with accepted state and tombstones, a per-mapping outbox and one
explicit synchronization pass. Scheduling (#46), recurrence and invitation
semantics (#45), Google write consent (#36) and the mapping/conflict UI (#48)
build on these boundaries and are not implemented here.

## Data model (migration `0045_calendar_bridge`)

- `calendar_bridge_mappings`: owner, revision, one Google calendar collection
  and one Baikal calendar collection, `direction` (`two_way`,
  `google_to_baikal`, `baikal_to_google`), `initial_sync` (`copy_existing` or
  `new_only`), `enabled`, the Google sync cursor, the first-pass marker,
  last-run outcome and `removed_at`. Partial unique indexes allow each
  calendar in at most one live mapping. Removal is a soft delete so links and
  tombstones remain as provenance. Collection IDs have no foreign key because
  disconnecting Google deletes its collection rows. The mapping keeps the
  Google calendar ID and Baikal collection href from creation, and a pass
  reports `calendar-unavailable` when the collection is gone.
- `calendar_bridge_links` (**event link**): one row per bridged event. Holds
  the origin side, Google event ID and iCalUID, Baikal href and UID, and for
  each side the last observed kind, native revision (ETag), semantic digest
  and normalized snapshot. `accepted_kind`/`accepted_digest`/
  `accepted_snapshot` is the **Accepted Calendar State**; `accepted_kind =
'deleted'` is the **Calendar Tombstone**. `status` is `pending`, `active`,
  `conflict`, `blocked`, `excluded` or `tombstoned`, with a reason code.
  Deletion approval binds to one side and one observed deletion proof.
- `calendar_bridge_outbox`: stable operation ID, mapping sequence, mapping
  revision, target side, action (`create`, `update`, `delete`), target native
  identity (reserved before any create), expected destination revision,
  source side and revision, normalized payload and its digest, state,
  attempt count and last error. At most one unfinished operation per link.
- `calendar_bridge_conflicts` (**Bridge Conflict**): reason, baseline digest
  and both observed sides (kind, revision, digest, snapshot). At most one open
  conflict per link. Resolution is a new reviewed operation.

Provider IDs, UIDs, hrefs and ETags are stored separately and never compared
across providers. ETags are opaque.

## Normalized envelope

`apps/server/src/calendar-bridge/envelope.ts` normalizes a Google event JSON
object or a Baikal iCalendar resource into envelope version 1: summary,
description and location (null means absent), and either UTC start/end
instants or all-day start/end dates. Any other meaningful content is listed as
an unsupported field and kept in the digest, so a change to it is visible and
never silently dropped. Examples: recurrence, attendees/organizer
(invitation effect), alarms or non-default reminders, conference data,
attachments, `TZID` times, and extra components. The digest is SHA-256 over
the canonical envelope and does not include ETags, fetch time or serialization
order. Only the envelope is written to a destination. Time-zone labels on
Google timed events are not preserved; #45 owns that round trip.

## One pass (`runBridgeOnce`)

`CalendarBridgeService.runOnce(ownerId, mappingId, now)` in
`apps/server/src/calendar-bridge/service.ts` resolves credentials and builds
two provider sides. `runBridgeOnce` in `engine.ts` performs one pass against
the `BridgeSide` port (`ports.ts`). Passes for the same mapping are serialized
in-process; a concurrent call returns `busy`.

1. A disabled or removed mapping does nothing and keeps its state.
2. **Reconcile uncertain work.** Operations left `dispatched` (process stopped
   after marking) or `uncertain` (transport failure, 5xx or failed readback)
   are resolved by reading the target's reserved identity. If the target
   matches the payload digest, or is gone for a delete, the receipt is
   recorded. If it still carries the expected revision, or a reserved create
   is still absent, the operation returns to `pending`. Otherwise it fails
   and the new observation goes through the policy. Nothing is re-sent blind.
3. **Read both sides completely.** Google reads use the stored sync token and
   process every page. HTTP 410 starts a full read. The Baikal side lists a
   bounded window and reads each linked event outside it by href. A read
   failure ends the pass before any decision and the cursor is not advanced.
   An event missing from a full read is confirmed by a direct read. Absence
   alone is never deletion.
4. **Linked events.** Each side's observation is the change reported this pass
   or the last observed state. `decideCalendarBridgeChange` (ADR 0017) makes
   the decision. Equal digests settle without writing, so the bridge's own
   write read back from the other side is an echo, not a foreign change.
   `propagate` enqueues a conditional operation. `conflict` opens a conflict
   and writes nothing. `blocked` records the reason. Links with unfinished
   work are skipped so per-event work stays ordered.
5. **New events.** `decideCalendarBridgeNewEvent` (pure, in
   `packages/domain/src/calendar-bridge.ts`) decides for an event with no
   link. On the first pass of a `new_only` mapping, existing events become
   `excluded` links and are never copied. A source side the direction does not
   allow is excluded. An event with unsupported fields or an invitation effect
   is blocked. Two cases are blocked as `identity-collision` rather than
   adopted: an unlinked event with the same UID on the other side, or a native
   identity already present in another mapping's links. Otherwise the pass
   creates a link, reserves the destination identity and enqueues a create.
   The reserved Baikal href is `<link id>.ics` with the source UID. The
   reserved Google event ID is the link ID in base32hex.
6. **Dispatch.** Each pending operation is marked `dispatched` in its own
   transaction before any network I/O. Writes are conditional: `If-None-Match:
*` for Baikal creates and a client-chosen ID for Google inserts, and
   `If-Match` with the expected ETag for updates and deletes. A successful
   response is followed by a readback. The receipt, the new revisions and the
   accepted state are committed in one transaction. A precondition failure
   fails the operation for re-reading. An existing reserved create target is
   verified by readback. Authorization failures leave the operation pending
   with the error recorded.
7. The Google cursor and first-pass marker are saved after decisions are
   durable. A process stop before that step replays the same changes, and the
   replay settles against accepted state.

Deletions follow ADR 0017: a one-sided deletion is blocked with
`deletion-approval` until the owner approves that link's observed deletion.
Deletion against an edit is a conflict. Both sides deleted keeps the
tombstone. A tombstoned event that reappears on either side opens a
`resurrection` conflict.

Conflict resolution (`keep: google | baikal`) enqueues a conditional write of
the chosen side's retained snapshot, or a delete, against the other side's
revision as recorded in the conflict. If either side has changed since, the
precondition fails and the next pass opens a new conflict.

## Owner routes

Owner session plus CSRF, online-only, not in the sync feed or the automation
catalog. Assistant coverage is #48.

- `GET  /api/calendar-bridge/mappings`
- `POST /api/calendar-bridge/mappings` `{ googleCalendarId, baikalCalendarId,
direction, initialSync }`. Requires the Google `calendar.events` scope on
  the stored grant (#36 adds consent); otherwise 409
  `BRIDGE_WRITE_CONSENT_REQUIRED`.
- `PATCH /api/calendar-bridge/mappings/:id` `{ enabled }` with `If-Match`
- `DELETE /api/calendar-bridge/mappings/:id?pendingWork=cancel` with
  `If-Match`. Refused while work is in flight. Refused without
  `pendingWork=cancel` while work is pending. Never deletes events.
- `POST /api/calendar-bridge/mappings/:id/run`: one pass, returns counts
- `GET  /api/calendar-bridge/mappings/:id/links`: links, open conflicts and
  unfinished outbox operations
- `POST /api/calendar-bridge/mappings/:id/links/:linkId/approve-deletion`
  with the link `If-Match`
- `POST /api/calendar-bridge/mappings/:id/conflicts/:conflictId/resolve`
  `{ keep }`

## Entry points for dependent issues

- #46 worker: `CalendarBridgeService.runOnce` (or `runBridgeOnce` with custom
  sides), `SqliteCalendarBridgeStore.listRunnableMappings`, and outbox
  `attempts`/`lastError` for retry policy. No timer is installed here.
- #45: `envelope.ts` (`normalizeGoogleEvent`, `normalizeCalDavEvent`,
  `googleEventBody`, `calDavEventIcs`) and the unsupported-field list.
- #48: the store read models (`listMappings`, `listLinks`, `listOpenConflicts`,
  `listUnfinishedOperations`) and the routes above.

## Limits

No live-provider qualification (#50) and no background scheduling. Alarms and
vendor fields are blocked and visible. [ADR 0042](0042-bridge-event-semantics.md)
(#45) adds recurring series, time zones and read-only invitation mirrors. Baikal changes are read by windowed listing plus per-link reads, not
WebDAV sync-collection. Restoring a Suite backup restores mappings, links,
tombstones and the outbox. The first pass after a restore reconciles
uncertain work before sending anything. It cannot undo Google writes made
after the backup.
