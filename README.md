# Productivity Suite

This workspace is the implementation and integration home for a private,
self-hostable productivity suite. The intended suite includes a Greenfield
React productivity experience, Daymark's calendar work, Baïkal, SuperSync, and
the existing Super Productivity MCP tooling.

Phase 0 is complete. The runnable repository foundation now includes secure
single-owner authentication, encrypted Baïkal connection and collection
discovery, stable provider/calendar identities, and the first retry-safe task
capture/list slice. It does not yet claim calendar event reads or writes, task
editing/completion, focus, synchronization, Google, or MCP product functionality.

## Run Phase 0

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
calendar collections with separate Events and Todos capabilities. After Baïkal
is connected, the owner can capture and list Suite-owned tasks. Task creation is
stored in SQLite with a stable UUID, revision 1, and a durable idempotency
result. Event content is not read or changed in Phase 0.

For the public HTTPS deployment, set `SUITE_SECURE_COOKIES=true` so the opaque
session cookie is sent only over TLS. Preserve the original public `Host` header
at the reverse proxy; unsafe API requests compare it with the browser's Origin
in addition to requiring the session CSRF token.

Persistent data lives in three named volumes:

- `suite-data`: Suite SQLite database and backups
- `baikal-specific`: authoritative Baïkal DAV database/resources
- `baikal-config`: Baïkal configuration

Create a consistent online SQLite and connector-key backup pair with
`./deploy/backup.sh`. Restore one with
`./deploy/restore.sh <database-backup-basename>`; restore stops only the Suite
service and retains pre-restore database and key copies. Treat the mode-0600 key
backup as a secret: the encrypted DAV password cannot be recovered without it.
Back up the two Baïkal volumes separately before upgrades; Suite backups never
claim to contain authoritative calendar or address-book resources.

## Develop and verify

```bash
pnpm install --frozen-lockfile
pnpm dev
pnpm verify
./deploy/verify-compose.sh
```

`pnpm verify` is the canonical local code gate. The Compose verification is a
slower disposable deployment check: it builds both services, validates rendered
HTTP/API output, proves installation identity across restart, replaces the
database and credential key, restores the matched backup pair, and removes its
test volumes.

The Phase 0 contract and authority decisions are recorded in
[`docs/adr/0008-phase-0-identities-api-and-authority.md`](docs/adr/0008-phase-0-identities-api-and-authority.md).
The Google connector and MCP work remain deliberately deferred; Phase 0 records
their feasibility boundaries in [`docs/spikes/`](docs/spikes/) without creating
production credentials, using real calendar/task data, or exposing an automation
transport.

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
