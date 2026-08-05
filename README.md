# Productivity Suite

This workspace is the implementation and integration home for a private,
self-hostable productivity suite. The intended suite includes a Greenfield
React productivity experience, Daymark's calendar work, Baïkal, SuperSync, and
the existing Super Productivity MCP tooling.

Phase 0A provides the runnable repository foundation. It deliberately does not
claim task, calendar, focus, synchronization, authentication, or MCP product
functionality yet.

## Run the foundation

Requirements: Docker with Compose, or Node.js 24+ and pnpm 11.15.1 for local
development.

```bash
docker compose up --detach --build --wait
./deploy/smoke.sh
```

The React readiness screen is available at `http://127.0.0.1:18080`. Baïkal's
installer/admin interface is available at `http://127.0.0.1:18086/admin/` until
the first-run owner flow connects it in Phase 0B. Change either loopback port
with `SUITE_PORT` or `BAIKAL_PORT`; public TLS and routing belong at the edge and
are intentionally not embedded in this local Compose file.

Persistent data lives in three named volumes:

- `suite-data`: Suite SQLite database and backups
- `baikal-specific`: authoritative Baïkal DAV database/resources
- `baikal-config`: Baïkal configuration

Create a consistent online SQLite backup with `./deploy/backup.sh`. Restore one
with `./deploy/restore.sh <backup-basename>`; restore stops only the Suite
service and retains a pre-restore database copy. Back up the two Baïkal volumes
separately before upgrades; Suite backups never claim to contain authoritative
calendar or address-book resources.

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
database, restores an online SQLite backup, and removes its test volumes.

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
