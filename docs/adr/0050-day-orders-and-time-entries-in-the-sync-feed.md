---
status: accepted
---

# Day orders and time entries are sync feed records

Roadmap #112, wave 7B (#114), second slice. Builds on ADR 0010 (local-first
sync), ADR 0024 (time history), ADR 0027 (saved day order), ADR 0033
(record-revision operations), ADR 0045 (live sync hints) and ADR 0046 (notes
in the feed and the checklist for moving a record kind). Decided 2026-10-02.

## Context

After ADR 0046 only notes had moved. Saved day orders and time entries were
still online HTTP records: Today and the Planner showed the derived order and
disabled their move controls without a connection, the Worklog was empty
offline, and another device saw a change only while the matching view was
open and refetched after a `resources` hint.

ADR 0046 also left a gap: a web bundle older than a release could not parse a
feed kind it did not know, so its rounds failed until the page was reloaded.

## Decision

### Unknown entity kinds are skipped, counted and recovered

This comes first because every later kind depends on it.

- The server contract stays strict (`syncRoundResponseSchema`,
  `syncSnapshotResponseSchema`). A client reads rounds and snapshot pages
  with `clientSyncRoundResponseSchema` and `clientSyncSnapshotResponseSchema`.
  These drop each change or snapshot record whose `entityKind` is not in
  `syncKnownEntityKinds` and return the number dropped as
  `skippedUnknownKinds`. A record of a known kind must still be valid; a
  malformed one fails the round as before.
- The round's `nextCursor` is applied unchanged, so the cursor advances past
  the skipped changes and the tab keeps syncing the kinds it knows.
- Snapshot pagination advances its offset by what the server sent (kept plus
  skipped), so a page that holds only unknown kinds does not end or repeat
  the pagination.
- The local store adds the count to `skippedUnknownKinds` in its metadata
  and records `skippedByKinds`, the signature of the kinds the skipping build
  knew (`syncEntityKindsSignature`). The count is in each round's diagnostic
  record and in the support manifest as `skippedUnknownKindCount`.
- A build whose signature differs from `skippedByKinds`, with a count above
  zero, requires a snapshot before its next round. The skipped records are
  therefore fetched once the page loads a bundle that knows them. A snapshot
  resets the count.

This protects an open tab after a deploy. It does not replace the epoch
reset below: records that existed before their kind joined the feed have no
feed change, and bundles older than this release do not skip.

### Record identity

A saved day order has no UUID; it is keyed by owner and calendar date. The
feed's `entityId`, an outcome's `entityId` and `taskId`, and a diagnostic
operation's `entityId` are now `syncEntityKeySchema`: a UUID or a calendar
date. `sync_changes.entity_id` and `sync_operation_outcomes.entity_id` were
already text. In the browser a day order is the `entities` row
`["day_order", date]`.

### Day orders

**Feed record.** `day_order` carries the saved ranks of one date
(`savedDayOrderSchema`: date, revision, task IDs, update time). It is not
the composed list that `GET /api/day-orders/{date}` returns. Membership stays
derived from the tasks (ADR 0027): a client takes the date's members from its
cached tasks and sorts them with `applyDayOrder`, the function the server
uses to compose a read. A date that was never reordered has no record and
shows the derived order. Saved ranks of a task that left the day stay in the
record until the next write of that date and are ignored on read, on the
server and in the cache alike, so a task leaving the day needs no feed change
for the order.

**Write paths.** Every write of a saved order goes through one private
method of `SqliteDayOrderStore`, which appends the feed change in the
caller's transaction:

| Path                                     | Store method      | Feed change                        |
| ---------------------------------------- | ----------------- | ---------------------------------- |
| `PUT /api/day-orders/{date}`             | `reorder`         | `upsert`, new revision             |
| `POST /api/day-orders/{date}/tasks`      | `plan`            | `upsert`, plus one per task        |
| Assistant `day_order.reorder`            | `reorder`         | `upsert`, new revision             |
| Super Productivity import                | `importOrders`    | `upsert`, revision 1 per date      |
| Sync outbox (`day_order.reorder`)        | `reorderFromSync` | `upsert`, base revision plus one   |
| Data restore                             | rows written      | none; the restore resets the epoch |
| A task leaves the day or is hard-deleted | none              | none; ranks are filtered on read   |

A refused write and a resubmission of the saved order over HTTP append
nothing. No server tick writes a day order.

**Offline rule.** One operation joins protocol version 2:
`day_order.reorder` with the date, the complete order as the client shows it
and `baseRevision`, the saved revision the client reordered (0 when the date
has no saved order).

**A saved day order keeps one record revision per date. A reorder whose
`baseRevision` is not the saved revision is a `SYNC_RESOURCE_CONFLICT` with
`entityKind: "day_order"` and reason `revision`. It changes nothing on the
server, and the saved order is re-sent.** Two devices that reorder the same
date therefore conflict visibly; there is no merge of two orders.

**Membership never conflicts.** The HTTP route and the assistant require the
exact current members, because they act on what the caller just read. An
offline client cannot meet that: a task may have been completed, moved or
planned for the date on another device since it went offline. Membership is
derived, so the server reconciles it when it applies the operation:

- a named task that is not a member at apply time (completed, deleted,
  archived, given a start time, planned for another date, unknown, or
  another owner's) is dropped;
- a member the client did not name follows the named ones, in its current
  order;
- a duplicate name counts once.

The reconciled list is saved and the revision is the base plus one, even
when the list equals the saved one, so the revision the client assumed is
the revision the server holds. The canonical list reaches the client as the
feed change of its own operation, in the same round. In the browser the same
rule holds before any sync: a queued reorder that names a task which then
leaves the day simply stops showing that task, because the view filters the
ranks by the cached members.

**Plan tomorrow offline.** The browser no longer calls the plan route. It
queues one `task.patch` with the planned day per task (ADR 0033) and then one
`day_order.reorder` that places those tasks after the date's other members.
Operations apply in client sequence, so the tasks are members when the
reorder is applied. A task patch that conflicts leaves that task out of the
day and the reorder drops it. The route stays for the assistant-independent
all-or-nothing plan over HTTP.

**Conflict review.** The saved order is in the cache and the refused order
is in the immutable outbox operation. The review offers **Keep current
order** (dismiss) and **Use my order**, which queues the same list against
the saved revision that was reviewed. The second is not offered while a
newer local reorder of that date is still syncing. A refused reorder is
removed from the cache when its outcome arrives; the saved order, when one
exists, is among the changes of that round.

**Browser.** `loadCachedDayOrders` reads the saved orders. Today, the plan
tomorrow panel and the Planner's day-order card render from them and from the
cached tasks, with or without a connection, and every member can be moved.
`apps/web/src/local-day-orders.ts` holds `applyDayOrderOperation`, used for
the optimistic write, the replay over a snapshot and the rebase after a
round. The web app has no day-order API function left.

**Live sync.** `PUT /api/day-orders/{date}` is classified `feed` and
`day_order.reorder` is feed-only. The plan route keeps `task_planning`,
because the planned days it sets shape the day plan. The `day_orders`
resource family is retired like `notes`: never emitted, mapped to no view,
and kept in `liveSyncResourceFamilies`. `task_planning` no longer refetches a
day-order view; there is none.

**Not bounded.** A saved order is one small record per date the owner
reordered. All of them are in the snapshot.

### Time entries

**Feed record.** `time_entry` carries one stored entry, as the HTTP routes
return it (`timeEntrySchema`): an imported daily total or a manual entry,
with its revision. Focus time is not a record of this kind. ADR 0024 keeps
it as a projection of the active session's intervals, split at owner-zone
midnights when a report is read; it has no row and no revision, and copying
it would create the duplicate intervals ADR 0024 avoids. The active session
was already a feed entity.

**Write paths.** `SqliteTimeEntryStore` takes a change appender and every
method that writes `time_entries` appends inside its savepoint:

| Path                                | Store method     | Feed change                        |
| ----------------------------------- | ---------------- | ---------------------------------- |
| `POST /api/time/entries`            | `create`         | `upsert`, revision 1               |
| `PATCH /api/time/entries/{id}`      | `update`         | `upsert`, new revision             |
| `DELETE /api/time/entries/{id}`     | `delete`         | `deleted`, revision + 1            |
| Assistant `time_entries.mutate`     | the same three   | the same                           |
| Super Productivity import           | `insertImported` | `upsert`, revision 1 per entry     |
| Sync outbox (`time_entry.*`)        | the same three   | the same                           |
| Focus commands and the session tick | none             | none; they write session intervals |
| Data restore                        | rows written     | none; the restore resets the epoch |

A refused write and the replay of an identical `POST` append nothing.
Imported work start and end records (`time_work_context_days`) are not feed
records; they stay part of the online report.

**Offline rule.** Manual entries are writable offline, and imported entries
can be corrected or deleted offline, under the rules of ADR 0024. Three
operations join protocol version 2:

- `time_entry.create` carries a client-generated UUID, the task, the work
  date, the duration and the note, all explicit;
- `time_entry.patch` carries `baseRevision` and any of work date, duration
  and note;
- `time_entry.delete` carries `baseRevision`.

**A time entry keeps one record revision. A patch or delete whose
`baseRevision` is not the entry's revision is a `SYNC_RESOURCE_CONFLICT`
with `entityKind: "time_entry"` and reason `revision`; the entry is
re-sent.** A create whose ID exists, and a patch or delete of an entry that
does not, are conflicts with reason `record`.

**The day rules are checked on the server when the operation is applied.**
A task-day total includes focus time, which the client does not hold, and a
running focus interval is known only to the server. An operation that breaks
a rule is a resource conflict that changes nothing, with the rule as its
reason: `task_unavailable`, `entry_read_only`, `duration_invalid`,
`day_total_negative`, `day_total_exceeds_day` or `focus_running`. An offline
time entry is therefore provisional until it has synced. The browser checks
what it can before queueing (a nonzero duration within a day, a task that is
cached and neither deleted nor archived) and shows the entry at once.

Conflict outcomes for kinds other than tasks now carry `reasons`, the list
the server already stored with the outcome. The review names the rule and
offers **Dismiss**; the owner makes the change again in the Worklog if it
still applies. No merge and no automatic retry.

**Online writes stay conditional HTTP writes.** With a connection the
Worklog calls the time entry routes as before, so a broken rule is reported
on the form at once instead of as a conflict a moment later. The store
appends the feed change, and the round that follows brings the entry into
the cache. Without a connection the same form queues the operation.

**Bound.** Time entries are numerous (the September 24 import evidence in
ADR 0024 has 419). The snapshot and the cache hold a rolling window:

- `syncTimeEntryWindowDays` is 90. The snapshot carries the entries whose
  work date is on or after the owner-zone date 89 days before the snapshot
  is taken, including entries dated in the future.
- A feed change is delivered for an entry of any date; a change is small.
  The browser keeps an entry only when its work date is within the window
  measured from its own UTC date, with one extra day of tolerance for the
  difference between UTC and the owner's zone (91 days back). A change for
  an older date, including an entry moved to an older date, removes the
  entry from the cache.
- Reads of the cache apply the same bound, and entries that have aged out
  are deleted when a snapshot replaces the cache or a round delivers a time
  entry change.
- Older history is read online: `GET /api/time/report` is unchanged and
  covers any range up to 366 days.

**Reports.** Day totals and worklog reports that include focus time are
online-only: they need the session intervals and the imported work context,
which are not in the cache. Offline, the Worklog shows a report computed
from the cache alone: the manual and imported entries of the window, per
day, task and project, with a notice that focus time and history older than
the window need a connection. All-time totals are not shown offline.

**Browser.** `loadCachedTimeEntries` reads the window.
`apps/web/src/local-time-entries.ts` holds `applyTimeEntryOperation` and the
cached report. With a connection the Worklog shows the server report and
reloads it when the cached time entries change, which is how a change made
on another device, by the assistant or by an import arrives.

**Live sync.** The time entry routes are classified `feed` and
`time_entries.mutate` is feed-only. The `time_entries` family is not
retired: focus commands still emit it, because the focus time they add to
the Worklog and to time-spent totals is not in the feed.

### Epoch reset

Migration `0050_sync_day_orders_time_entries_epoch_reset` deletes the feed,
gives every owner a new epoch and sets the retained floor to 0, as 0049 did.
Saved orders and time entries written before this release have no feed
change, so a client with a valid cursor would never receive them. One reset
covers both kinds. The IndexedDB database stays at version 2: both kinds are
rows of the existing `entities` store and their operations are rows of the
existing outbox, so queued operations stay valid and replay over the
snapshot.

## Additions to the ADR 0046 checklist

Found while moving these two kinds; ADR 0046's list now names them.

- A kind without a UUID needs its key accepted by `syncEntityKeySchema`.
- When the HTTP response of a kind is a projection (a day order composed
  with its members), the feed carries the stored record and the client
  derives the rest from what it caches.
- A kind that can be numerous needs a documented bound on the snapshot and
  on the cache, enforced on read and tested at the boundary.
- A rule the client cannot evaluate (a total that needs data outside the
  cache) is checked on apply and returned as a conflict reason.
- A view that still reads a server projection reloads when the cached kind
  changes, since its family is no longer emitted.

## Consequences

- A reorder, a plan for tomorrow and a manual time entry work without a
  connection and reach other devices after one hint and one round.
- Every client replaces its cache once after migration 0050.
- Two devices that reorder the same date get a conflict to review. A device
  that reorders while another changes which tasks are in the day does not.
- An offline time entry can be refused later by a day rule; it then
  disappears from the Worklog and appears in the conflict review with the
  reason.
- A tab running this bundle keeps syncing after a later release adds a
  kind, and takes one snapshot when it loads the newer bundle.
- The HTTP day-order and time entry routes are unchanged.

## Not in this slice

Focus preferences (ADR 0029) and application, planning, notification and
capture preferences (ADR 0030 and related) as read-only offline singletons;
boards, sections, saved views and folders; counters and evaluations; task
links and attachments; archive history and recurrence series. Imported work
context days and focus intervals of ended sessions stay online. Two-profile
browser evidence is recorded separately, as for ADR 0033 and ADR 0046.
