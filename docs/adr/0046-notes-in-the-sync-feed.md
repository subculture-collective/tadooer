---
status: accepted
---

# Notes are sync feed records with offline writes

Roadmap #112, wave 7B (#114), first slice. Builds on ADR 0010 (local-first
sync, record revisions, epoch and snapshot), ADR 0019 (notes), ADR 0033
(record-revision operations without a protocol bump) and ADR 0045 (live sync
hints). Decided 2026-10-02.

## Context

Notes were online HTTP records (ADR 0019): outside the sync feed, absent from
the IndexedDB cache, and written only with a connection. After ADR 0045 a
note changed on one device reached another only while the notes panel was
open there, through the `notes` resource family and a refetch. Notes are
edited daily on more than one device, so they are the first record kind to
move into the feed. Later kinds (day orders, time entries, boards,
preferences) follow the shape set here.

## Decision

### Feed

`note` is a sync entity kind. Its snapshot is the whole note as the HTTP
routes return it (`noteSchema`). `SqliteNoteStore` takes a change appender
and every method that writes a note appends the feed change inside its own
savepoint: `insert`, `create`, `update`, `delete` and `reorder`. No caller
appends a note change itself, so no path can skip it:

| Path                                   | Store method                       | Feed change                        |
| -------------------------------------- | ---------------------------------- | ---------------------------------- |
| `POST /api/notes`                      | `create`                           | `upsert`, revision 1               |
| `PATCH /api/notes/{id}` (edit, pin)    | `update`                           | `upsert`, new revision             |
| `DELETE /api/notes/{id}`               | `delete`                           | `deleted`, revision + 1            |
| `PUT /api/notes/order`                 | `reorder`                          | one `upsert` per moved note        |
| Assistant `notes.mutate` (all actions) | the same four methods              | the same                           |
| Super Productivity import              | `insert` in the import transaction | `upsert`, revision 1               |
| Sync outbox (`note.*`)                 | `create`, `update`, `delete`       | the same                           |
| Data restore                           | rows written directly              | none; the restore resets the epoch |

A refused write (stale revision, invalid content, unknown project or tag)
appends nothing. A restore already replaces the owner's epoch (ADR 0034), so
clients take a snapshot, and the snapshot carries the restored notes.

`GET /api/sync/snapshot` lists notes in the owner's order. A `deleted` change
has no snapshot; the client removes the note from its cache.

### Epoch reset

Migration `0049_sync_notes_epoch_reset` deletes the feed, gives every owner a
new epoch and sets the retained floor back to 0, as migration 0037 did
(ADR 0033). It is required: notes written before this release have no feed
change, so a client with a valid cursor would never receive them. After the
migration each client gets `SYNC_CURSOR_EXPIRED` once, replaces its cache
from a snapshot and replays its queued operations over it. Operation
outcomes are kept, so a replayed operation stays idempotent.

The IndexedDB database stays at version 2. Notes are rows of the existing
`entities` store keyed by `["note", id]`, and note operations are rows of
the existing outbox, so there is no upgrade and existing outboxes stay valid.

### Offline writes

Three operations join protocol version 2:

- `note.create` carries a client-generated UUID, `content`, `projectId`,
  `tagId` and `pinnedToToday`. Every field is explicit so the request hash
  never depends on a default. The server assigns the position.
- `note.patch` carries `baseRevision` and any of `content`, `projectId`,
  `tagId`, `pinnedToToday` and `position`.
- `note.delete` carries `baseRevision`. Deletion is permanent.

Reorder fits the record-revision rule as two `note.patch` operations: the
browser moves a note by exchanging the positions of two notes, each guarded
by its own revision, as it does for checklist items (ADR 0033). The
complete-membership reorder (`PUT /api/notes/order`, assistant `reorder`)
stays an online write and appends one change per moved note.

### Conflict rule

**A note keeps one record revision. A patch or delete whose `baseRevision`
is not the note's current revision is a `SYNC_RESOURCE_CONFLICT` with
`entityKind: "note"`. It changes nothing on the server.** There is no
last-write-wins and no automatic text merge (ADR 0010).

Per-field versions were not chosen. A note is one free-text field plus three
small ones (association, pin, position). Field versions would need a new
table and a second snapshot shape, and would still leave the case that
matters, two edits of the text, as a conflict. The cost of the simpler rule
is that a text edit on one device conflicts with a pin or move of the same
note on another; the review below resolves that in one step.

Other conflicts, all resource conflicts that change nothing:

- `note.create` with an ID that already exists;
- an operation naming a project or tag the owner does not have (an archived
  one is valid, as over HTTP);
- a patch or delete of a note that does not exist. A deleted note cannot be
  told from one that never existed.

On a conflict the server appends an `upsert` for the canonical note, so the
client's optimistic value is replaced in the same round. Every outcome is
stored by owner, client and operation ID with the request hash; a replay
returns the stored outcome, and a reused ID with another payload is an
`IDEMPOTENCY_CONFLICT`.

### Conflict review

The browser keeps both versions until the owner chooses: the server's note
is in the cache and the local attempt is in the immutable outbox operation.
The existing conflict review shows them side by side and offers:

- **Keep current note**: dismiss; the local attempt stays in the outbox as a
  resolved record.
- **Save mine as a new note**: queue a `note.create` with the local text and
  a new ID. Offered when the local operation carried text, including when
  the note was deleted on the server.
- **Replace with mine** (or **Delete the current note**): queue the same
  fields, or the delete, against the revision that was reviewed. Only the
  attempted fields are sent, so an edit of the text keeps a pin or position
  set elsewhere. Not offered while a newer local change to the same note is
  still syncing, or when the note is gone.

A review of an older revision is refused; the owner reviews the current one.

### Browser cache

- `loadCachedNotes` reads notes in the owner's order. The organization panel
  and a new "Pinned notes" card on Today render from it, with or without a
  connection. The limited offline workspace shown when no session can be
  resumed shows the pinned notes too; it still has no organization panel.
- `apps/web/src/local-notes.ts` holds one pure function,
  `applyNoteOperation`, that says what a queued operation does to a cached
  note. It is used for the optimistic write, for the replay of the outbox
  over a snapshot, and for a rebase after each round: pending operations are
  re-applied on any note the round delivered.
- A patched note takes the revision the server will give it (base plus one),
  so two offline edits in a row do not conflict with each other.
- A note whose `note.create` was refused is removed from the cache; its text
  remains in the conflict review.

### Live sync

Note routes are classified `feed` and `notes.mutate` is feed-only, so a note
change is announced with `changes` and applied by a round. The `notes`
resource family is retired: the server no longer emits it and the web
registry maps it to no view. The name stays in `liveSyncResourceFamilies`
until a later contract cleanup, so a client of this version still parses the
stream of an older server.

The HTTP note routes are unchanged and remain for conditional online writes
and the assistant. The web app no longer calls them, so `apps/web/src/api.ts`
has no note functions.

## How to move the next record kind

Derived from what this slice touched. Do them in this order; each step has a
test at its layer. The sentences that cite ADR 0050 were added when day
orders and time entries moved.

1. **Choose the offline rule first.** Record revision with a visible
   conflict is the default. If no rule is clear, the kind is read-only
   offline: do steps 2 to 4 and 6 to 9 without operations. A rule the client
   cannot evaluate from its cache is checked when the server applies the
   operation and returned as a conflict reason (ADR 0050).
2. **Contracts** (`packages/contracts/src/index.ts`): add the kind to
   `syncEntitySnapshotSchema` and to the `entityKind` enum of
   `syncChangeSchema`. For offline writes also add it to
   `syncEntityKindSchema`, add `<kind>.create|patch|delete` to
   `syncOperationSchema` with explicit fields and `baseRevision`, extend
   `syncOperationEntity` and the kind list of
   `syncDiagnosticOperationSchema`. A kind without a UUID needs its key
   accepted by `syncEntityKeySchema` (ADR 0050). When the HTTP response of
   the kind is a projection, the feed carries the stored record and the
   client derives the rest from what it caches.
3. **Store**: give the store a change appender (see `NoteChangeAppender`)
   and append inside every writing method, in its savepoint. Do not append
   from callers. Grep for direct `INSERT`, `UPDATE` and `DELETE` on the table
   to find writers that bypass the store (importer, server tick, cascades).
4. **Snapshot**: add the records to `fullSyncSnapshot` and to the snapshot
   list and the change-to-snapshot mapping in
   `apps/server/src/routes/sync.ts`. A kind that can be numerous needs a
   documented bound on the snapshot and on the cache, enforced on read and
   tested at the boundary (ADR 0050).
5. **Operations**: add `apply<Kind>Sync` on `SuiteDatabase` through the
   shared `#applySyncOperation` envelope (add the kind to its union and its
   `load`), and dispatch to it in `routes/sync.ts`.
6. **Epoch**: if records of the kind can exist before the release, add one
   migration that resets the epoch (copy 0049). Kinds released together
   share one reset. Update the migration count in the tests that assert it
   (`migrationCount`, `appliedMigrationCount`, `suite_database_migrations`).
   A new table must be classified in `data-export-store.ts`.
7. **Live sync**: change the route rules in
   `apps/server/src/live-sync/resource-families.ts` to `feed` and the
   automation operations to `feedOnly`; map the family to `[]` in
   `apps/web/src/live-sync/views.ts` and remove the view if nothing else
   loads it. Leave the family name in the contract enum. A view that still
   reads a server projection of the kind must reload when the cached kind
   changes, because its family is no longer emitted (ADR 0050).
8. **Browser**: add the kind to `CachedEntityKind`; add a `loadCached<Kind>`
   loader; write the pure `apply<Kind>Operation` reducer and use it for the
   queue methods, the snapshot replay (`#replayStructuralOperation`) and the
   round rebase; add the kind to the conflict review. Read the cache in the
   app shell (`refreshCachedOrganization`), pass it to the views, and remove
   the HTTP client functions the views no longer call (then update `webApi`
   in `assistant-capabilities.json`, which is drift-tested).
9. **Documents**: an ADR with the conflict rule, a dated note in ADR 0033's
   boundary list, the `offlineSync` text of the parity row and its `.md`
   twin, the capabilities row, and the glossary in `CONTEXT.md`.

## Consequences

- A note written on one device, by the assistant or by an import reaches the
  others after one hint and one round, and is readable and writable offline.
- Every client replaces its cache once after migration 0049.
- A web bundle older than this release cannot parse a `note` snapshot or
  change. Its rounds fail without applying anything and its outbox is kept
  until the app shell reloads the current bundle. The server serves the
  bundle, so this lasts until the next page load. Before many more kinds
  move, the client should skip entity kinds it does not know; that is not
  part of this slice.

  > Note, 2026-10-02: done in
  > [ADR 0050](0050-day-orders-and-time-entries-in-the-sync-feed.md). A
  > client skips and counts changes and snapshot records of a kind it does
  > not know, keeps its cursor advancing, and takes a snapshot once it runs
  > a bundle that knows them. Bundles older than that release still fail
  > their rounds until the page reloads.

- An applied deletion now reports `applied` with the recorded revision. The
  sync route previously reported an applied `subtask.delete` as rejected
  because no record was left to read; the same fix covers checklist items.
- Two devices that move the same note, or one that moves and one that edits
  it, get a conflict to review instead of a merged order.

## Not in this slice

Day orders (the other half of step 1 in #114), time entries, boards,
preferences and the other kinds listed in the issue. Image notes and legacy
project and tag note text (ADR 0019) are unchanged. Two-profile browser
evidence is recorded separately, as for ADR 0033.
