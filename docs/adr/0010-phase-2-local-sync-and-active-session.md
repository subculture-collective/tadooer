---
status: accepted
---

# Keep task sync local-first and focus sessions server-authoritative

Phase 2 gives one owner two durable browser clients. Each client can read a
local task cache, queue bounded task work while offline, reconcile it when the
foreground application reconnects, and observe one authoritative focus or
break session. Suite SQLite remains authoritative for Suite entities, ordered
changes, operation outcomes, conflicts, active-session leases, and tracked
intervals. Baikal remains authoritative for calendar resources.

## Client identity and local state

An authenticated owner session authorizes access but does not identify a
durable browser installation. A browser registers an owner-scoped client UUID
and receives a one-time 256-bit credential. The browser stores the UUID and raw
credential only in IndexedDB; the server stores only its SHA-256 digest. Sync
and active-session requests require the owner session and the registered client
proof. Revoking a client fails closed without deleting its local cache.

The versioned IndexedDB database contains canonical task, project, tag, and
subtask snapshots, an opaque server cursor, immutable queued operations,
operation outcomes, conflicts, and bounded diagnostic metadata. Task data and
client credentials never enter localStorage, Cache Storage, query strings,
process arguments, or logs. The service worker continues to cache only the app
shell and never `/api` responses.

Phase 2 promises foreground synchronization triggered by application load, an
explicit sync action, and the browser `online` event. It promises queue/cache
durability across reload and closing/reopening the same browser profile. It
does not promise background synchronization after all windows close, mobile OS
process survival, or power-loss recovery during an IndexedDB transaction.

## Ordered task synchronization

Each client queues immutable, client-sequenced operations identified by a UUID.
The server deduplicates by owner, client, and operation UUID and compares a
normalized request hash before replaying an outcome. A reused UUID with another
payload is an idempotency conflict. Client timestamps are diagnostic metadata;
only the persistent server sequence orders authoritative changes.

An owner-scoped change stream has a persistent epoch and positive sequence. An
opaque cursor carries the epoch and last applied sequence. A mismatched epoch
or cursor outside the retained range produces an explicit reset requirement;
the client obtains a bounded full snapshot, atomically replaces its canonical
cache, then reevaluates its immutable outbox. Phase 2 retains its entire local
change stream, so retention expiry is a tested contract but not an automated
pruning policy yet.

Queueable Phase 2 operations are deliberately narrow:

- create a Suite task with a client-generated UUID;
- patch `title`, `notes`, or `estimateMinutes` using per-field base versions;
- complete or reopen using the logical status field version;
- soft-delete or restore using the whole task revision.

Calendar placement/removal, connector/security changes, client revocation,
project/tag/subtask administration, and active-session control remain online.
`plannedStart` is never changed by offline task sync because it is coupled to a
conditional Baikal write.

Every authoritative task has field versions for `title`, `notes`, `status`,
`estimateMinutes`, `projectId`, and `tagIds`, in addition to its positive
resource revision. A synchronized patch applies atomically when each field it
changes still has the supplied base version. Disjoint field changes therefore
merge. If any changed field advanced, the entire operation becomes a visible
`SYNC_FIELD_CONFLICT`; neither value is silently discarded. Resolution creates
a new operation against the newly pulled version. Delete and restore are
structural and conflict on any intervening task revision.

An operation outcome contains IDs, revisions, field names, sequence numbers,
and safe error codes. Task content arrives only through the authenticated
snapshot/change response, never through logs or diagnostic records.

## Daily-use organization boundary

Projects are owner-scoped UUID records with a title, positive revision, and
optional archive timestamp. A task belongs to zero or one project. Tags are
owner-scoped UUID records with a display name, case-folded uniqueness key,
positive revision, and optional archive timestamp. A task has at most 25 tags.
Archiving prevents new assignment but does not erase existing task history.

Subtasks are dedicated one-level checklist records with their own UUID,
revision, title, completion state, and stable integer position. They are not
recursive tasks and cannot independently own projects, calendar blocks, or
focus sessions. Phase 2 reuses `estimateMinutes` as expected effort; it does not
add a second estimate concept.

Project/tag/subtask changes are online-only in the first Phase 2 protocol but
are returned in full snapshots and reflected in the local cache. This meets the
daily-use organization outcome without introducing unreviewed generic outbox
payloads for every new entity.

## Active-session authority

There is at most one nonterminal focus/break session per owner. It is a
server-authoritative lease, not two client timers that later reconcile. One
registered client controls it; all other clients are followers with a
read-only mirror and an explicit takeover action. No active-session command is
queued offline.

The server clock supplies all interval boundaries. Production uses the system
clock; domain/service tests inject a manual clock. A running controller renews
a 90-second lease with a heartbeat every 30 seconds. Every session has a
24-hour hard expiry. Paused sessions have no short running lease but retain the
hard expiry and controller identity.

The commands and effects are:

- `start`: create a running focus session and one open focus interval;
- `pause`: close the open interval once and retain the phase;
- `resume`: create the next interval ordinal in the current phase;
- `start_break`: close focus and, if running, open a break interval at the same
  server instant;
- `end_break`: close break and, if running, open focus at the same instant;
- `complete`: close any open interval and terminate the session without
  implicitly completing the task;
- `takeover`: explicitly transfer control; while running it closes the old
  interval and opens the next contiguous interval atomically;
- `heartbeat`: renew the controller lease without adding an interval or task
  time;
- `expire`: on read or command, close a running interval at the recorded lease
  boundary, or expire a paused session at its hard boundary;
- `recover`: never resurrect an expired interval; the owner explicitly starts a
  new session.

Focus intervals count as tracked task work. Break intervals preserve chronology
but do not count toward task focus totals. A task referenced by a nonterminal
focus session cannot be soft-deleted. Every transition requires the current
session revision and an idempotency key except an initial start, which requires
only an idempotency key. The transition, interval closure/opening, audit event,
change record, and stored operation outcome commit in one SQLite transaction.

Two simultaneous starts, commands, or takeovers serialize under SQLite. Only
one expected revision can win. A delayed retry returns its stored outcome and
cannot create or close another interval. An old controller heartbeat after
takeover fails ownership validation. Server restart does not change ownership;
the next read either returns the same valid lease or expires it exactly at the
persisted boundary.

## Diagnostics and recovery support

The client can export a JSON recovery-support manifest containing schema
version, installation/client IDs, cursor, timestamps, pending/conflict counts,
operation IDs, entity IDs, operation kinds, states, hashes, revisions, and safe
error codes. It never contains task/project/tag/subtask text, raw operation
payloads, calendar content, cookies, CSRF values, client credentials, connector
material, browser paths, or host details.

A redacted manifest cannot restore unsynchronized task content. A true content
recovery export would require a separately approved encrypted, passphrase-bound
format and is not implied by Phase 2.

## Explicit non-goals

Phase 2 does not add offline calendar writes, offline focus control,
last-write-wins text, background sync with no open application, recursive
subtasks, project portfolios, tag colors, generic entity outboxes, WebSocket
correctness dependencies, automation actors, multi-user state, or SuperSync
protocol compatibility.
