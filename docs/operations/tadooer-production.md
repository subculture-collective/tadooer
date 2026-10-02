# Tadooer production deployment

The supported daily-driver placement is one Suite container on `nuc`, behind
Almaz Caddy and the existing Cloudflare wildcard tunnel. The existing NUC
Baïkal service remains authoritative. Super Productivity stays running during
the parallel soak.

## Fixed production boundary

- Public origin: `https://tadooer.subcult.tv`
- NUC listener: `10.0.0.56:18080`
- Trusted proxy: Almaz `10.0.0.200/32`
- Compose networks: existing `productivity` and `monitoring`
- Notification network: existing private `management`
- Suite data: `/srv/apps/productivity/data/tadooer`, owned by UID/GID 1000 and
  mode 0700
- Compose file: `/srv/apps/productivity/tadooer-compose.yaml`
- Image: registry reference with an immutable `sha256` digest

The Caddy route does not use Authelia. Suite authentication is the application
boundary, and the Google callback must reach Suite directly. Caddy replaces the
forwarded client address with its normalized `{client_ip}`; Suite trusts that
header only when the socket peer is Almaz.

## Secrets and first start

Install `/srv/apps/productivity/data/tadooer/google-oauth.json` as UID/GID 1000,
mode 0600, using the normalized Suite schema. The Google Web OAuth client must
contain this exact redirect URI:

`https://tadooer.subcult.tv/api/connectors/google/callback`

Do not copy the local Suite database or credential key. Let the production
container create both, create the owner through the public UI, and connect the
existing Baïkal and Google accounts explicitly.

Install `/srv/apps/productivity/data/tadooer/ntfy-publisher.json` as UID/GID
1000, mode 0600. It contains only `{baseUrl, topic, token}`. Use `http://ntfy`
on the private `management` network and a dedicated non-admin ntfy user with
write-only access to the selected topic. Never use the public anonymous route,
an admin token, or a browser-visible credential.

## Promotion and deployment

1. Run the complete repository and Phase 9 disposable gates.
2. Build and push the image, record its registry digest, and create the release
   manifest before changing production.
3. Set `SUITE_IMAGE` to the digest reference and run `docker compose pull` then
   `docker compose up -d --wait` from the production compose file.
4. Verify `/api/build`, `/api/ready`, `/api/metrics`, public login, connector
   projection, task placement/removal, focus transitions, and restart recovery.
5. Roll back by restoring the prior manifest's image digest. Restore data only
   after a separately selected, checksum-verified backup set is qualified in an
   isolated project.

## Backup and monitoring

Run `deploy/production/backup.sh` before the NUC Restic job and include only the
generated `/srv/apps/productivity/data/tadooer/backups` directory in Restic.
The script makes an online SQLite backup, copies the paired credential key and
optional OAuth and ntfy publisher configurations, creates `SHA256SUMS`, and
writes content-free node-exporter textfile metrics. Backup directories and secrets stay mode
0700/0600. The NUC Prometheus agent scrapes Suite over its private `monitoring` network
and remote-writes to Dozor; Dozor loads the supplied alert rules. A direct
Dozor-to-NUC application-port scrape is neither required nor opened. The secret-bearing coherent set is retained only
inside the encrypted Restic workflow.

An acceptance restore always uses an isolated Compose project, isolated ports,
a copied Baïkal backup, and no route to the production Baïkal service.

## Background calendar bridge worker

The Suite process runs Google/Baïkal bridge passes and Google projection syncs
on a schedule (ADR 0043), so synchronization continues with no browser open.
It does nothing until the owner creates and enables a bridge mapping. The
environment toggles below go in the `suite` service `environment` block; the
defaults apply when a variable is unset.

| Variable                                            | Default | Effect                                                                                        |
| --------------------------------------------------- | ------- | --------------------------------------------------------------------------------------------- |
| `SUITE_CALENDAR_BRIDGE_WORKER`                      | `true`  | `false` stops all background bridge work in this process. Manual runs from the UI still work. |
| `SUITE_CALENDAR_BRIDGE_INTERVAL_SECONDS`            | `300`   | Bridge pass interval per mapping, ±20% jitter. Minimum 60.                                    |
| `SUITE_CALENDAR_BRIDGE_PROJECTION_INTERVAL_SECONDS` | `900`   | Google projection sync interval for owners with an enabled mapping. `0` disables it.          |
| `SUITE_CALENDAR_BRIDGE_MAX_BACKOFF_SECONDS`         | `3600`  | Upper bound of the exponential retry delay after failures.                                    |
| `SUITE_CALENDAR_BRIDGE_CONCURRENCY`                 | `2`     | Jobs running at once in this process (1–16).                                                  |
| `SUITE_CALENDAR_BRIDGE_OWNER_CONCURRENCY`           | `1`     | Jobs running at once for one owner (1–16).                                                    |
| `SUITE_CALENDAR_BRIDGE_SHUTDOWN_GRACE_SECONDS`      | `8`     | How long shutdown waits for an in-flight pass. Keep it below the Docker stop timeout (10 s).  |

To pause synchronization for one owner, disable the mapping in the UI. To stop
it for the installation, set `SUITE_CALENDAR_BRIDGE_WORKER=false` and recreate
the container. The schedule, leases, outbox and conflicts stay in the
database; re-enabling resumes overdue work on the first tick, about 30 seconds
after start.

`/api/ready` reports `checks.calendarBridge` as `disabled`, `idle`, `ok` or
`degraded`. It never makes the service unready. `/api/metrics` exports
`suite_calendar_bridge_*` aggregates: failing jobs by class (`rate-limited`,
`grant-expired`, `provider-offline`, `ambiguous-write`, `configuration`,
`internal`), age of the stalest last success, outbox backlog by state, stuck
operations, open conflicts and the Google cooldown. They contain no IDs,
calendar names or event content. `grant-expired` needs the owner to reconnect
Google or fix the Baïkal credential. `ambiguous-write` resolves itself on the
next pass, which reads the target before any resend. Open conflicts wait for
owner review.

Two Suite processes on the same database (for example during a restart
overlap) exclude each other through leases in SQLite. A crashed process's lease
expires after 10 minutes.

## Live sync hint stream

Each signed-in client with the app open holds one long-lived request,
`GET /api/sync/events` (ADR 0045). The response is `text/event-stream` and
carries hints only: that the sync feed advanced, or which kinds of online
records changed. It never carries titles, record content or record IDs. A
client that receives no hints still synchronizes on load, on focus and on its
fallback interval, so a proxy that breaks the stream costs latency, not data.

What the stream needs from the proxy chain:

- **No response buffering.** The server sets `Cache-Control: no-store` and
  `X-Accel-Buffering: no`. Caddy's `reverse_proxy` flushes
  `text/event-stream` responses as they arrive, and the Cloudflare tunnel
  passes them through. If hints arrive in bursts after a proxy change, check
  for a buffering or response-rewriting step first, including `encode`.
- **Idle time above 25 seconds.** The server writes a `: hb` comment line
  every 25 seconds. A proxy idle or read timeout below that closes the stream
  between heartbeats; clients then reconnect with backoff and fall back to
  interval sync.
- **The request headers of a sync round.** The session cookie,
  `x-suite-client-id`, `x-suite-client-credential` and
  `x-suite-sync-version` must reach Suite unchanged.
- **One connection per stream.** Over HTTP/2 the stream shares the browser's
  connection. The Suite side of the proxy uses one upstream connection per
  open stream, and the server closes it when the stream ends
  (`Connection: close`).

Limits: one stream per registered client (a second replaces the first), at
most eight streams per owner (a ninth request gets `429
LIVE_SYNC_STREAM_LIMIT`), and a stream whose socket accepts no data for 30
seconds is dropped. The stream does not refresh the session idle timer and
ends when the session expires, the owner signs out or the client is revoked.
On shutdown every stream receives `bye: shutdown` before the listener stops,
so a restart does not wait for open streams.

`/api/metrics` exports, without identifiers:

| Metric                                         | Meaning                                                                                                                                 |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `suite_live_sync_streams_open`                 | Streams open in this process.                                                                                                           |
| `suite_live_sync_hints_total{event}`           | Events written, by name: `hello`, `changes`, `resources`, `bye`.                                                                        |
| `suite_live_sync_streams_dropped_total`        | Streams dropped because the socket could not be written for 30 seconds. A steady rise points at a proxy or client that stopped reading. |
| `suite_live_sync_unclassified_mutations_total` | Successful mutations whose route has no resource family. Each one sent the `all` hint. Expected to stay 0; a nonzero value is a defect. |

`/api/ready` does not depend on the stream.

## Owner data export versus operator backups

Two copies exist, with different jobs (ADR 0034):

|          | Operator backup pair                                                                                                                     | Owner data export                                                                                                                                      |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Made by  | `deploy/backup.sh` or `deploy/production/backup.sh` (container access)                                                                   | The owner in Settings, or `GET /api/data/export` with the browser session                                                                              |
| Contents | The whole SQLite file: every owner, sessions, assistant tokens, encrypted connector credentials, iCal subscription addresses, sync state | The owner's rows of the included tables as one versioned JSON document; no secrets, sessions, connector or subscription credentials, sync state        |
| Needs    | The paired `credential.key` from the same backup set                                                                                     | Nothing; portable between instances and credential keys                                                                                                |
| Restores | The complete instance, by the operator, with the service stopped                                                                         | One owner's content through a preview and an explicit empty-account or replace choice; connectors, subscriptions and assistant tokens are set up again |

Use the operator pair for disaster recovery and acceptance restores. Use the
owner export to move data between instances, to keep a copy the owner
controls, or to reset an account to a known state. Restoring an owner export
starts a new sync epoch, so every signed-in device resynchronizes; unsynced
offline changes on a device are not in the export.
