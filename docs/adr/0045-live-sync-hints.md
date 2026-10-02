---
status: accepted
---

# Live sync is a hint stream over the existing sync rounds

Roadmap #112, wave 7A (#113). Builds on ADR 0010 (local-first
task sync, foreground rounds) and ADR 0033 (which records are outside the
feed). Decided 2026-10-02.

## Context

The owner wants Tadooer to behave as one service across the self-hosted
instance, the web app, desktop apps and mobile: a change made on one device
should appear on the others within a second or two.

Today nothing is pushed. A client runs a sync round on load, on the browser
`online` event, on "Sync now" and after its own writes (ADR 0010). A second
device sees a change only when one of those happens. Many owner records are
also outside the sync feed entirely (ADR 0033: notes, boards, day orders,
time entries, preferences and others); other devices see those only after a
reload.

ADR 0010 lists "WebSocket correctness dependencies" as a non-goal. That
constraint stays: a transport that carries data would add a second place where
ordering, loss and replay have to be right.

## Decision

Add a server-to-client **hint stream**. It says that something changed and
never carries the change. Every client keeps converging through protocol 2
sync rounds and ordinary HTTP reads, so a lost, late or duplicated hint can
only cost latency.

### Transport

`GET /api/sync/events` returns `text/event-stream`. Clients read it with
`fetch` and a stream reader, not `EventSource`, because the request needs the
same proof as a sync round: the session cookie plus `x-suite-client-id`,
`x-suite-client-credential` and `x-suite-sync-version: 2`. The same code runs
in the browser, the Electron shell and any later webview shell.

Server-sent events over plain HTTP were chosen over WebSocket: the server is
`node:http` with no upgrade handling, the stream is one-directional, and the
existing proxy chain (Caddy, then a Cloudflare tunnel) passes a chunked
response without new configuration. The response sets `Cache-Control:
no-store` and `X-Accel-Buffering: no`, and a `: hb` comment every 25 seconds
keeps intermediaries from closing an idle connection.

### Events

Defined in `packages/contracts/src/live-sync.ts`:

| Event       | Meaning                                                                                              |
| ----------- | ---------------------------------------------------------------------------------------------------- |
| `hello`     | First event. Carries the feed head (`epoch.sequence`) at connect time and the heartbeat interval.    |
| `changes`   | The sync feed advanced to `head`. The client runs a round if its cursor differs.                     |
| `resources` | Records outside the feed changed. Names the affected families and the client that caused the change. |
| `bye`       | The server is closing the stream: shutdown, session ended, client revoked, replaced or epoch reset.  |

Events carry no titles, notes, identifiers of records or other content. The
only identifier is the registered client ID in `resources`, which lets the
writer skip refetching what it just wrote.

### Server

An in-process hub keeps the open streams per owner.

- **Feed changes.** After any request that is not a `GET` completes, and on a
  two-second tick while at least one stream is open, the hub compares the
  owner's feed head with the last head it announced and emits `changes` when
  it moved. The tick covers writes the request hook cannot see: recurrence
  generation, the calendar bridge worker and a second server process.
- **Records outside the feed.** Every mutating route is classified into one
  or more resource families. A successful mutation emits `resources`. A test
  fails when a mutating route has no classification, in the same way the
  capabilities inventory is drift-tested.
- **Coalescing.** Hints for one owner within 100 ms are merged.
- **Bounds.** One stream per registered client; a second replaces the first
  with `bye: replaced`. At most eight streams per owner; a ninth client is
  refused with `429 LIVE_SYNC_STREAM_LIMIT` before the stream starts. A stream
  that cannot be written to for 30 seconds is dropped.
- **Sessions.** Opening a stream authenticates without refreshing the idle
  timer, and the stream ends with `bye: session-ended` when the session
  expires or is revoked (noticed within about two seconds). A request that a
  client makes because of a hint or a background timer carries
  `x-suite-sync-trigger: push` and does not refresh the idle timer on any
  route. Reads already never refresh it. Live sync therefore does not keep an
  unattended device signed in; the 30-minute idle and 12-hour absolute limits
  of ADR 0007 are unchanged.
- **Shutdown.** Streams get `bye: shutdown` and are closed before the HTTP
  server stops, inside the existing shutdown grace.
- **Metrics.** Open streams, hints sent by event and streams dropped, without
  identifiers. `/api/ready` is unaffected.

### Clients

- One tab per browser profile holds the stream. Tabs elect a leader with the
  Web Locks API and share results over a `BroadcastChannel`; a follower tab
  reloads its view from IndexedDB when the leader reports an applied round.
  Sync rounds from any tab run under one lock, which also closes the existing
  gap where two tabs of one client could send the same outbox entries.
- On `changes` the leader runs rounds until `hasMore` is false. On
  `resources` each tab refetches the online views it has open for those
  families, unless it is the source client. The source is known only for
  requests that carry the client proof (sync rounds and focus commands), so
  two tabs of one profile rely on the focus timer poll for each other's focus
  commands.
- The stream reconnects with jittered exponential backoff from one second to
  one minute. `hello` after a reconnect carries the head, so a client that
  missed feed hints catches up at once; it also refetches every open view,
  because `hello` says nothing about records outside the feed.
- Independent of the stream, a client syncs when the page becomes visible or
  focused and on a fallback interval: one minute while the stream is down,
  five minutes while it is up. Interval rounds carry the push trigger; a
  round on visibility or focus is the owner's own activity. A browser without
  Web Locks or streaming `fetch` falls back to these triggers alone.
- The sync status shows whether the device is live, reconnecting or offline.

### Feed maintenance

Live sync makes rounds frequent, so the feed read is bounded: change pages are
read with a SQL limit instead of loading the whole tail. Changes older than
the retention window (30 days by default, `SUITE_SYNC_RETENTION_DAYS`) are
pruned, and a cursor below the retained floor gets the existing
`SYNC_CURSOR_EXPIRED` response and replaces its cache from a snapshot.

## Consequences

- With the app open on two devices, a change in the feed reaches the other
  device after one hint and one round. The server test asserts under one
  second on loopback; real latency adds the network round trip.
- Records outside the feed become live on other devices only while their view
  is open, by refetch. They are still not available offline. Moving them into
  the feed is wave 7B (#114).

  > Note, 2026-10-02: notes moved first ([ADR 0046](0046-notes-in-the-sync-feed.md)).
  > The `notes` resource family is retired: the server no longer emits it,
  > and the name stays in the contract enum until a later cleanup.

  > Note, 2026-10-02: saved day orders followed
  > ([ADR 0050](0050-day-orders-and-time-entries-in-the-sync-feed.md)) and
  > the `day_orders` family is retired the same way.

- A closed app receives nothing. Background delivery on desktop and mobile
  needs long-lived device sessions (wave 7C, #115) and platform shells (waves 7D
  and 7E); those are separate decisions.
- The stream holds one HTTP connection per client. HTTP/2 through the proxy
  multiplexes it; a direct HTTP/1.1 connection spends one of the browser's
  six per-origin connections, which the single-leader rule keeps to one.

## Alternatives considered

- **WebSocket carrying changes.** Lower latency by one request, but it makes
  the socket a correctness dependency and needs upgrade handling, a second
  authentication path and proxy changes.
- **Short-interval polling.** No new transport, but a five-second poll costs
  a round per device per interval when nothing changes and still feels slow.
- **Web Push for data changes.** Works with the app closed, but needs a
  push service, per-device subscriptions and user permission, and browsers
  throttle silent pushes. It remains an option for notifications in wave 7E (#117).
