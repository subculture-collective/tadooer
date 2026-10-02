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

Decided and implemented in the next commit of this slice; this section is
completed there. Until then time entries stay online HTTP records (ADR
0024).

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

- A reorder and a plan for tomorrow work without a connection and reach
  other devices after one hint and one round.
- Every client replaces its cache once after migration 0050.
- Two devices that reorder the same date get a conflict to review. A device
  that reorders while another changes which tasks are in the day does not.
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
