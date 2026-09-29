---
status: accepted
---

# Calendar bridge background worker

Issue #46 (roadmap #15). Builds on ADR 0017 (authority and retry
boundaries) and ADR 0041 (mappings, outbox, `runOnce`). Adds a server-owned
scheduler that runs bridge passes and Google projection syncs without an open
browser. It does not change the pass itself, event semantics (#45) or the
mapping/conflict UI (#48). Live-provider qualification remains #50.

## Opt-in

The worker is controlled by one process switch, `SUITE_CALENDAR_BRIDGE_WORKER`
(default `true` when configuration comes from the environment; a
`ServerConfig` without worker settings runs no worker). With the switch on,
nothing runs for an owner until that owner has an enabled, live mapping.
Disabling or removing the last mapping removes the owner's jobs on the next
tick. The Google projection sync job exists only for an owner with an enabled
mapping and a stored Google connector; owners without a mapping keep the
existing browser- or route-triggered sync.

## Polling policy

Polling, not push. Google push notifications need a public HTTPS callback
with a verified domain and channel renewal. The production deployment has no
such receiver, and CalDAV has no standard push. Every pass already reads
Google incrementally with a sync token, so a quiet calendar costs one list
request per pass plus the token refresh.

Estimated cost per mapping at the defaults (not measured against a live
account): one OAuth refresh, one incremental events list and one bounded
Baikal `REPORT` every 5 minutes, which is about 36 Google requests per hour
plus writes and readbacks. The projection sync adds, every 15 minutes, a
refresh, a calendar list and one events list per visible Google calendar.
Both stay far below Google Calendar's documented per-user request quota. Baikal
listings are windowed (ADR 0041), not `sync-collection`, so their cost grows
with events in the window, not with changes.

## Jobs and durable schedule (migration `0047_calendar_bridge_worker`)

- `calendar_bridge_jobs`: one row per job, keyed `bridge:<mapping id>` or
  `google-projection:<owner id>`. Holds `next_due_at`, consecutive failures,
  last start/success/failure times, the last failure class and a bounded
  error code. Rows are created when a mapping becomes runnable and deleted
  when it stops being runnable. Downtime is recovered on the first tick
  after start: every overdue job becomes due and runs subject to the
  concurrency bounds.
- `calendar_bridge_leases`: `key`, `holder`, `expires_at`. Acquisition is one
  `INSERT ... ON CONFLICT DO UPDATE ... WHERE expires_at <= now` statement, so
  two processes sharing the SQLite file cannot both hold a key. The holder
  renews every third of the lease (default lease 10 minutes) and deletes the
  row when the pass ends. A crashed holder's lease expires.

`CalendarBridgeService.runOnce` takes the `bridge:<mapping id>` lease when the
service is constructed with a lease manager, so the owner's manual run route
and the worker in any process exclude each other. A held lease returns the
existing `busy` outcome. Within one process the service keeps its in-memory
guard. The projection job takes `google-projection:<owner id>`; the owner's
manual Google sync route does not take the lease. Two concurrent projection
syncs are idempotent upserts, not provider writes.

Both tables are operational state and are excluded from the owner data
export (ADR 0034).

## Scheduling, bounds and backoff

A tick every 30 seconds selects due jobs in `next_due_at` order. Limits:
one pass per mapping (lease), `SUITE_CALENDAR_BRIDGE_OWNER_CONCURRENCY` jobs
per owner (default 1) and `SUITE_CALENDAR_BRIDGE_CONCURRENCY` jobs per process
(default 2). A job over a limit waits for a later tick. An installation has
one active owner today, so the owner bound mainly keeps that owner's bridge
passes and projection sync from overlapping; disabled owners get no jobs.

After success the next run is the interval (default 300 s for bridge
passes, 900 s for projection syncs) with ±20% jitter. After a failure the
delay is `min(max backoff, 60 s × 2^(n-1))`, randomized over its upper half,
where `n` is the larger of the job's consecutive failures and the highest
`attempts` count among the mapping's unfinished outbox operations that carry
an error. A `Retry-After` value, when present, is a lower bound.
Maximum backoff defaults to 3600 s.

Google throttling is observed on the Google fetch that the connector uses:
HTTP 429, and 403 with `rateLimitExceeded` or `userRateLimitExceeded`. The
process then holds a Google cooldown until `Retry-After` (seconds or HTTP
date; 60 s when absent). No Google job starts during the cooldown. A job
deferred by the cooldown is not a failure. Manual routes still run; their
429s extend the cooldown.

Clock changes: a stored `next_due_at` more than twice the longest interval
plus the maximum backoff ahead of the clock is treated as due, so a clock that moved
back cannot stall a job indefinitely. A clock that moves forward makes jobs due
early and can expire leases early. The durable `dispatched` mark of ADR 0041
still sends each outbox operation at most once, and the next pass reconciles.

## Failure classes

| Class              | Source                                                                                               |
| ------------------ | ---------------------------------------------------------------------------------------------------- |
| `rate-limited`     | Google 429 or rate-limit 403 observed during the job                                                 |
| `grant-expired`    | Google reconnect or consent required, not connected; Baikal credential unavailable; provider 401/403 |
| `provider-offline` | Transport failure, 5xx, token refresh unavailable, list failure                                      |
| `ambiguous-write`  | The pass left an operation `uncertain`; the next pass reads before any resend                        |
| `configuration`    | Calendar collection gone                                                                             |
| `internal`         | Unexpected exception in the job                                                                      |

Conflicts are not failures. They are exported as a count. A job that throws
is isolated: it is recorded as `internal`, backed off independently, and
other mappings continue. Outbox operations with 5 or more attempts are
counted as stuck.

## Shutdown and restart

`close()` stops ticking, stops starting jobs and waits for in-flight passes up
to `SUITE_CALENDAR_BRIDGE_SHUTDOWN_GRACE_SECONDS` (default 8, within Docker's
10 s stop timeout). Each finished job releases its own lease. A pass that
outlives the grace period is abandoned at its last durable checkpoint: ADR 0041 commits each
decision and each `dispatched` mark before network I/O, and the next pass
reconciles `dispatched` and `uncertain` operations by reading the target.
Its lease is not released early; it expires on its own.

## Health and metrics

`/api/ready` adds `checks.calendarBridge`: `disabled`, `idle` (no jobs), `ok`,
or `degraded` (a job's last outcome was a failure, or an operation is
stuck). It never changes readiness status; a provider outage must not
restart the container.

`/api/metrics` adds content-free aggregates with no IDs, calendar names or
event data:

- `suite_calendar_bridge_worker_enabled`
- `suite_calendar_bridge_mappings_enabled`
- `suite_calendar_bridge_jobs{kind}`
- `suite_calendar_bridge_jobs_failing{kind,class}`
- `suite_calendar_bridge_last_success_age_seconds{kind}` (stalest job; absent
  when no job has succeeded yet)
- `suite_calendar_bridge_never_succeeded_jobs{kind}`
- `suite_calendar_bridge_backlog_operations{state}` (`pending`,
  `dispatched`, `uncertain`)
- `suite_calendar_bridge_stuck_operations`
- `suite_calendar_bridge_open_conflicts`
- `suite_calendar_bridge_in_flight`
- `suite_calendar_bridge_google_cooldown_seconds`
- `suite_calendar_bridge_runs_total{kind,result}` (process counter)

## Limits

No push channels. The Baikal side has no `Retry-After` handling; its failures
use exponential backoff. The owner's manual Google sync route is not leased.
Two processes only exclude each other when they share one SQLite file. The
defaults are estimates to be checked in #50 against a real account.
