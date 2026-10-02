# Productivity Suite

This workspace is the implementation and integration home for a private,
self-hostable productivity suite. The intended suite includes a Greenfield
React productivity experience, Daymark's calendar work, Baïkal, SuperSync, and
the existing Super Productivity MCP tooling.

Phases 0 through 8 are complete, including live Google federation qualification
for Phase 3. The runnable
self-hosted suite includes secure single-owner
authentication, encrypted Baïkal planning, a durable browser-local task cache,
replay-safe queued task writes, explicit two-client conflicts, daily-use task
organization, and one server-authoritative focus/break session with follower
and takeover behavior, plus separately scoped automation credentials, a stable
preview/confirm API, content-safe audit records, a catalog-driven local MCP
stdio adapter, quick-add through the same confirmed API, and a separate
Template Library with inert templates, ordered Template Sets, explicit-project
instantiation, immutable provenance, sync snapshots, and confirmed MCP
instantiation. Google calendar-list/event read scopes, encrypted refresh grants,
incremental projection, explicit freshness, and calm daily planning are present
and were qualified against a real Google OAuth grant on 2026-08-07. It does not
claim offline calendar/focus mutation,
closed-application background sync, recurrence editing beyond read-only Google
instances, or hosted MCP.

Calendar migration accepts either a generic ICS payload or an explicit Google
Calendar ICS/Takeout export. Preview reports recurrence, attendees, alarms,
vendor/unknown properties, duplicates, and malformed components without
writing to Baïkal. Apply is a one-time, replay-safe copy with stable CalDAV
resource identities. Authenticated exports and opaque capability feeds preserve
the original VEVENT fields; capability URLs support GET/HEAD only and can be
revoked immediately. This is migration and read-only publication, not Google
OAuth, CalDAV write access, or background mirroring.

Phase 8 adds a packaged Linux Electron client that displays the same Suite
origin without Node integration or a second data authority. Release operations
use immutable version/revision/image-digest manifests, explicit promotion and
rollback history, coherent backup/restore, and content-free Prometheus metrics
at `/api/metrics`. Android/iOS, PostgreSQL, and multi-user mode are deliberately
not shipped because their conditional roadmap prerequisites are not met.

## Run the Suite

Requirements: Docker with Compose, or Node.js 24+ and pnpm 11.15.1 for local
development.

```bash
docker compose up --detach --build --wait
./deploy/smoke.sh
```

The React first-run application is available at `http://127.0.0.1:18080`. Baïkal's
installer/admin interface is available at `http://127.0.0.1:18086/admin/` until
the first-run owner flow connects it. Change either loopback port
with `SUITE_PORT` or `BAIKAL_PORT`; public TLS and routing belong at the edge and
are intentionally not embedded in this local Compose file.

On first load, create the single Suite owner, sign in, and enter the credentials
for the Baïkal user you created in Baïkal's admin interface. The Suite connects
only to its server-configured `http://baikal/dav.php/` endpoint, verifies the
credentials through CalDAV, encrypts the password, and displays discovered
calendar collections with separate Events and Todos capabilities. A server
administrator may point `BAIKAL_ENDPOINT` at a different CalDAV deployment;
arbitrary browser-entered connector origins are intentionally unsupported.
Bundled and existing-instance setup, the **Check connection** permissions
probe, setup failure codes and `pnpm verify:baikal-setup` are documented in
[`docs/operations/baikal-setup.md`](docs/operations/baikal-setup.md).

After Baïkal is connected, the owner sees supported non-recurring UTC-timed
events in the current seven-day window. They can capture, rename, annotate,
complete, reopen, soft-delete, and recover Suite-owned tasks, then choose an
event-capable calendar, start, and duration for one task time block. A move uses
the previously observed strong DAV ETag; if the event changed elsewhere, the UI
shows a conflict and does not overwrite it. Removing a time block likewise uses
its stored ETag; a task with an active block must be cleaned up before it can be
soft-deleted.

Each authenticated browser registers a separate owner-scoped client and keeps
its raw client proof, canonical task cache, immutable outbox, cursor, conflicts,
and content-free diagnostic metadata in IndexedDB. Core task create/edit,
complete/reopen, delete/restore, and estimates can be queued temporarily
offline; the foreground app synchronizes on load, explicit activity, and the
browser `online` event. Project, tag, subtask, calendar, connector, and focus
commands remain online-only. A focus session has one controller; another client
observes it read-only and must explicitly take over before controlling it.

### Live sync

While the web app is open and signed in, it keeps one connection to
`GET /api/sync/events` (ADR 0045). The server sends hints on it: the sync feed
moved, or records outside the feed changed (boards, time entries,
preferences and the like). A hint carries no content. The app answers a feed
hint with an ordinary sync round and a records hint by reloading the views
that are open, so a change made on one device shows on another within a
second or two.

- One tab per browser profile holds the connection. Other tabs of that
  profile follow it and reload from the local cache. Closing the leading tab
  hands the connection to another.
- The sidebar and Settings show **Live updates** as `live`, `reconnecting`,
  `offline` or `paused`. `paused` means no connection until the next sign-in,
  or a browser without Web Locks, `BroadcastChannel` or streaming `fetch`.
- Sync does not depend on the connection. The app also syncs on load, on
  **Sync now**, after its own writes, on the browser `online` event, when the
  page becomes visible or focused, and on an interval while the page is
  visible: every minute while the connection is down, every five minutes
  while it is live.
- Rounds started by a hint or by the interval are marked
  (`x-suite-sync-trigger: push`) so the server does not count them as owner
  activity for the session idle timer.
- A closed app receives nothing. Changes made elsewhere arrive the next time
  the app is opened. Records outside the feed are refreshed only while their
  view is open and are not available offline.

For the public HTTPS deployment, set `SUITE_SECURE_COOKIES=true` so the opaque
session cookie is sent only over TLS. Preserve the original public `Host` header
at the reverse proxy; unsafe API requests compare it with the browser's Origin
in addition to requiring the session CSRF token.

Persistent data lives in three named volumes:

- `suite-data`: Suite SQLite database and backups
- `baikal-specific`: authoritative Baïkal DAV database/resources
- `baikal-config`: Baïkal configuration

Owners download their own data as one JSON file from Settings and restore it
after a preview (ADR 0034); the file contains no secrets and is separate from
the operator backups below. Create a Suite-only online SQLite and
connector-key backup pair with `./deploy/backup.sh`. Restore one with
`./deploy/restore.sh <database-backup-basename>`; restore stops only the Suite
service and retains pre-restore database and key copies.

For a coherent Phase 1 recovery point containing all three volumes, use:

```bash
./deploy/backup-stack.sh /absolute/new/backup-directory
./deploy/restore-stack.sh /absolute/backup-directory
```

The full-stack backup stops both SQLite writers briefly, copies Suite data and
Baïkal's authoritative database/configuration, records SHA-256 checksums, then
restarts and waits for both services. `restore-stack.sh` verifies every checksum
before intentionally replacing the selected Compose project's volumes. Select
the project with `COMPOSE_PROJECT_NAME` when it is not the default. Protect the
backup directory as a secret: it contains the mode-0600 Suite credential key,
encrypted connector material, Baïkal users, and calendar resources.

## Develop and verify

```bash
pnpm install --frozen-lockfile
pnpm dev
pnpm verify
./deploy/verify-compose.sh
pnpm verify:phase1
pnpm verify:phase2
pnpm verify:phase4
pnpm verify:phase5
pnpm verify:phase6
pnpm verify:phase7
pnpm verify:phase8
pnpm verify:phase9
pnpm verify:phase10
pnpm verify:phase11
```

`pnpm verify` is the canonical local code gate. The Compose verification is a
slower disposable deployment check: it builds both services, validates rendered
HTTP/API output, proves installation identity across restart, replaces the
database and credential key, restores the matched backup pair, and removes its
test volumes. `pnpm verify:phase1` additionally requires Docker Compose and a
Chromium binary at `/usr/bin/chromium` (override with
`PLAYWRIGHT_CHROMIUM_PATH`). It provisions only synthetic data in a disposable
Baïkal instance, drives the real UI, proves conditional VEVENT CRUD and visible
conflict handling, restarts the Suite, restores all state into fresh volumes,
repeats task placement, and removes the verification volumes.

`pnpm verify:phase2` uses two disposable persistent Chromium profiles. It proves
offline task create/edit across profile close/reopen, reconnect without a
duplicate task, visible same-field conflict handling, follower takeover, and
the same authoritative focus session after a Suite restart. Lease expiry and
the no-duplicate-interval transition matrix use an injected clock in server
tests; no test clock endpoint exists in the Compose runtime.

`pnpm verify:phase5` qualifies only reusable Task Templates and Template Sets:
inert template records, explicit existing-project instantiation, independent
subtask snapshots with provenance, exact-once retry across a restart, a real
local stdio MCP preview/confirmation, and paired Suite backup/restore. Choice
Pools and Planning Placeholders are Phase 6 work and are not asserted by this
gate.

`pnpm verify:phase6` qualifies dedicated Choice Pools and ordered candidates,
logical-time cooldown/cycle/one-shot eligibility explanations, editable history-
preserving pools, template pool slots, two-client placeholder resolution,
catalog-derived local MCP preview/confirmation, restart replay, and SQLite
backup/restore. Suggestions are read-only; only confirmation creates ordinary
subtasks and append-only selection history.

`pnpm verify:phase7` provisions a synthetic owner and real disposable Baïkal
calendar, previews and applies a recurring Google-export fixture, proves a
retry and Suite restart leave exactly one remote resource, performs a coherent
full-stack backup/restore, checks preserved ICS export, and finally revokes the
GET-only capability feed.

`pnpm verify:phase8` runs the canonical gate, release-channel and metrics tests,
creates an actual Linux x64 Electron directory bundle, starts its executable in
non-graphical smoke mode, and qualifies a versioned production Compose image
through readiness, metrics, restart, backup/restore, and candidate promotion.
Production rollout and rollback procedures are in
[`docs/operations/release-and-rollback.md`](docs/operations/release-and-rollback.md).

`pnpm verify:phase11` qualifies the durable occurrence/kind notification ledger,
calm-day suppression, explicit transient retry, ambiguous-response fail-closed
behavior, redacted owner health APIs, Settings controls, scheduler restart
replay, and the disposable recovery image. Live ntfy acceptance uses a dedicated
write-only publisher on NUC's private `management` network as documented in
[`docs/operations/tadooer-production.md`](docs/operations/tadooer-production.md).

Build the Linux desktop bundle, its `tar.gz` and a SHA-256 file with
`pnpm package:desktop`; `pnpm desktop:artifact` prints the name and checksum
for the release manifest. On first start the app asks for the server address
and checks `/api/build` there before storing it; `SUITE_SERVER_URL` overrides
the stored address. It accepts HTTPS, loopback HTTP, and plaintext HTTP to a
private IP address only after an explicit confirmation. It rejects URL
credentials, paths, queries, fragments, cross-origin navigation, embedded
webviews, and renderer Node access.

The shell adds a tray with sync status, "Quick capture" and "Sync now", a
single-instance lock, opt-in start at login and close-to-tray, and
`tadooer://open/<path>` links. The page reaches it through three validated
preload calls and nothing else. It stores one settings file and no owner data.
Installation, checks and what remains for macOS and Windows are in
[`docs/operations/desktop.md`](docs/operations/desktop.md); the boundary is
[ADR 0047](docs/adr/0047-desktop-shell-capabilities.md).

`apps/mobile` holds the Android app: a Capacitor 8 WebView around the same
origin, with the desktop's setup page and address rules, `tadooer://` links, a
share target that fills quick capture, and Back handling. The Suite page gets
no Capacitor plugin; the shell stores the server address and nothing else.
`pnpm android:debug` builds a debug APK on a machine with the Android SDK and
JDK 21, and stops with the reason on a machine without them. No APK has been
built or run on a device yet. Reminders still reach the phone through the ntfy
app. Build, signing and distribution are in
[`docs/operations/mobile.md`](docs/operations/mobile.md); the decision and
what remains unverified are in [ADR 0049](docs/adr/0049-mobile-shell.md).

The Phase 0 contract and authority decisions are recorded in
[`docs/adr/0008-phase-0-identities-api-and-authority.md`](docs/adr/0008-phase-0-identities-api-and-authority.md).
The bounded Phase 1 projection, write, and recovery rules are recorded in
[`docs/adr/0009-phase-1-planning-and-caldav.md`](docs/adr/0009-phase-1-planning-and-caldav.md).
The Phase 2 task-sync and active-session authority rules are recorded in
[`docs/adr/0010-phase-2-local-sync-and-active-session.md`](docs/adr/0010-phase-2-local-sync-and-active-session.md).
The Phase 4 automation authority and local-only transport decision are recorded
in [`docs/adr/0011-phase-4-automation-authority.md`](docs/adr/0011-phase-4-automation-authority.md).
The Phase 5 reusable-work identities, snapshot, and exact-once decisions are
recorded in
[`docs/adr/0012-phase-5-reusable-work.md`](docs/adr/0012-phase-5-reusable-work.md).
The Phase 6 logical-time policy, placeholder, conflict, and history authority is
recorded in
[`docs/adr/0013-phase-6-choice-pool-authority.md`](docs/adr/0013-phase-6-choice-pool-authority.md).
The Phase 7 preserved-import, stable-identity, and read-only publication rules
are recorded in
[`docs/adr/0014-phase-7-import-publication.md`](docs/adr/0014-phase-7-import-publication.md).
The Phase 8 desktop authority, release channel, observability, and conditional
platform decisions are recorded in
[`docs/adr/0015-phase-8-packaged-operations.md`](docs/adr/0015-phase-8-packaged-operations.md).

An owner issues, inventories, and revokes automation credentials through
`/api/automation/tokens`; the raw `suite_at_...` credential is returned only at
creation. Store it in a regular file owned by the current user with mode `0600`.
The local clients are:

```bash
node apps/mcp-stdio/dist/main.mjs \
  --url http://127.0.0.1:18080 --token-file /absolute/path/suite.token

node apps/quick-add/dist/main.mjs \
  --url http://127.0.0.1:18080 --token-file /absolute/path/suite.token \
  --idempotency-key quick-add-20260806-001 "Capture this task"
```

Both clients reject non-loopback plaintext HTTP, reject token files that are
not owner-only, and use only the cataloged automation API. The MCP adapter is
newline-delimited JSON-RPC over stdio; no hosted MCP route, Super Productivity
plugin IPC, or environment bearer-token shortcut is shipped. Google Calendar
operator setup and the completed live qualification record are documented in
[`docs/operations/google-calendar.md`](docs/operations/google-calendar.md).
Run `pnpm verify:phase3:foundation` without credentials for deterministic
protocol coverage; the dated runbook record separately captures the real grant
and provider evidence. The disposable phase gates are local verification, not a
production deployment or a universal provider compatibility claim.

## Existing systems under consideration

- Super Productivity fork: `/home/onnwee/Projects/forks/super-productivity`
- Daymark calendar: `/home/onnwee/Projects/tools/calendar-app`
- Super Productivity MCP suite: `/home/onnwee/Projects/tools/super-productivity-mcp`
- Baikal: deployed service; source repository or deployment definition still to
  be identified during discovery
- SuperSync: currently developed and shipped from the Super Productivity
  repository

## Discovery

The active requirements interview is recorded in
[`docs/discovery/requirements-interview.md`](docs/discovery/requirements-interview.md).

Candidate product requirements and their implementation boundaries live under
`docs/product/candidate-features/`. The
[Task Templates and Choice Pools](docs/product/candidate-features/task-templates-and-choice-pools.md)
record now distinguishes the completed Phase 5 template slice from the
remaining Phase 6 Choice Pool work.

Implementation order is governed by the
[Feature Prioritization](docs/product/feature-prioritization.md) rules and the
[Roadmap](docs/ROADMAP.md), not by feature parity with Super Productivity.

https://www2.onnwee.me
