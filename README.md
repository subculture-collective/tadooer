# Productivity Suite

This workspace is the implementation and integration home for a private,
self-hostable productivity suite. The intended suite includes a Greenfield
React productivity experience, Daymark's calendar work, Baïkal, SuperSync, and
the existing Super Productivity MCP tooling.

Phase 1 is complete. The runnable self-hosted planning slice now includes secure
single-owner authentication, encrypted Baïkal connection, a bounded week event
projection, the basic task lifecycle, and one explicit conditional calendar
time block per task. It does not claim recurrence editing, offline multi-writer
sync, focus sessions, Google Calendar, or MCP product functionality.

## Run Phase 1

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

After Baïkal is connected, the owner sees supported non-recurring UTC-timed
events in the current seven-day window. They can capture, rename, annotate,
complete, reopen, soft-delete, and recover Suite-owned tasks, then choose an
event-capable calendar, start, and duration for one task time block. A move uses
the previously observed strong DAV ETag; if the event changed elsewhere, the UI
shows a conflict and does not overwrite it. Removing a time block likewise uses
its stored ETag; a task with an active block must be cleaned up before it can be
soft-deleted.

For the public HTTPS deployment, set `SUITE_SECURE_COOKIES=true` so the opaque
session cookie is sent only over TLS. Preserve the original public `Host` header
at the reverse proxy; unsafe API requests compare it with the browser's Origin
in addition to requiring the session CSRF token.

Persistent data lives in three named volumes:

- `suite-data`: Suite SQLite database and backups
- `baikal-specific`: authoritative Baïkal DAV database/resources
- `baikal-config`: Baïkal configuration

Create a Suite-only online SQLite and connector-key backup pair with
`./deploy/backup.sh`. Restore one with
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

The Phase 0 contract and authority decisions are recorded in
[`docs/adr/0008-phase-0-identities-api-and-authority.md`](docs/adr/0008-phase-0-identities-api-and-authority.md).
The bounded Phase 1 projection, write, and recovery rules are recorded in
[`docs/adr/0009-phase-1-planning-and-caldav.md`](docs/adr/0009-phase-1-planning-and-caldav.md).
The Google connector and MCP work remain deliberately deferred; Phase 0 records
their feasibility boundaries in [`docs/spikes/`](docs/spikes/) without creating
production credentials, using real calendar/task data, or exposing an automation
transport. The disposable Phase 1 gate is local verification, not a production
deployment or a universal CalDAV compatibility claim.

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

Candidate product requirements that have been captured but not assigned to a
release live under `docs/product/candidate-features/`, including
[Task Templates and Choice Pools](docs/product/candidate-features/task-templates-and-choice-pools.md).

Implementation order is governed by the
[Feature Prioritization](docs/product/feature-prioritization.md) rules and the
[Roadmap](docs/ROADMAP.md), not by feature parity with Super Productivity.
