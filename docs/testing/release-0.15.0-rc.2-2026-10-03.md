# Release 0.15.0-rc.2 deployment, 2026-10-03

Production on nuc now runs `0.15.0-rc.2` from `main` at
`420f73d278b2bad19c8207a84a3e38c2d3fd7a06`. It replaces `0.14.1-calendar`
(`a6983dc`) and applies migrations 20 to 45 to the owner's database.

## Owner instruction and soak

On 2026-10-03 the owner said: "I would like to get tadooer updated". That ends
the Phase 12 soak for `0.14.1-calendar` early. The soak procedure does not
cover an early end, so the decision is recorded here and in a separate note
beside the ledger:

- Ledger `/srv/apps/productivity/soak/20260920-calendar-a6983dc-r2.json` is
  unchanged (SHA-256 `9ce49a97363d75c0d25d96e7d4dea25c54e073f199a664690fb5cdf7a8946907`).
  It was not qualifiable: two `daily_health` failures, one P2 defect, and most
  one-time evidence kinds never recorded.
- Note: `/srv/apps/productivity/soak/20260920-calendar-a6983dc-r2-ended-20261003.json`.
- `tadooer-soak-observer.timer` was stopped and disabled with `systemctl stop`
  and `systemctl disable`; the unit files are unchanged. Its ledger pins the
  old digest, so it would otherwise record a failure every window.
- Starting a new ledger for the new digest is an owner step:
  `node /srv/apps/productivity/operations/phase12-soak.mjs start <new-ledger> 0.15.0-rc.2 420f73d sha256:b1d60697… <at>`,
  repoint `soak/active.json`, then `sudo systemctl enable --now tadooer-soak-observer.timer`.

## Identity

| Item             | Value                                                                                                                                       |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Version          | `0.15.0-rc.2` (`0.15.0-rc.1` belongs to `65820d8`)                                                                                          |
| Image            | `127.0.0.1:5000/subculture-collective/productivity-suite@sha256:b1d60697c23f8b026d03d429bf929101a90421c2a1aaeef6eb831a0c7a116d34`           |
| Desktop artifact | `tadooer-desktop-0.1.0-linux-x64.tar.gz@sha256:30b0bc6e7c337ced7aed8539fb8ee6a10ea5fbdf3e181933de78b61b37182011` (built, not distributed)   |
| Manifest         | `deploy/releases/0.15.0-rc.2-420f73d.json`; nuc release directory `/srv/apps/productivity/releases/20261003-0.15.0-rc.2-420f73d`            |
| Channel          | `/srv/apps/productivity/releases/channels/stable.json`; previous manifest in `history/2026-09-20T12-38-01.166044Z-0.14.1-calendar.json`     |
| Previous image   | `…@sha256:68438591510360e82e84d98e83d2825bce5134004a884a26e55c75403080548f` (`0.14.1-calendar`, `a6983dc`), kept on nuc and in the registry |
| Migrations       | 19 before, 45 after                                                                                                                         |

## CI evidence

Hosted run 12349 on `420f73d` failed with 30 tests, every one
`Test timed out` and none an assertion. It ran on the new `kuznya` runner
(2 CPU, 4 GiB per job), which replaced the `kvant` runner the same day; single
server tests took 20–95 s there. A rerun was queued behind about 130 jobs and
was not awaited.

The accepted hosted evidence is run 12282, green on
`5322cb3a6102b7bffaaae644698c6a7279086d23`. `5322cb3..420f73d` changes only
`README.md`, `DEVELOPMENT.md`, `docs/assets/readme/banner.png` and
`docs/assets/readme/provenance.json`. The image inputs (`apps`, `packages`,
`Dockerfile`, `package.json`, `pnpm-lock.yaml`) have the same tree listing at
both commits (listing SHA-256 `b9a580197522aaa4bfb7b7d7744a37f49667ac87006198b4ab9a80dbd3c20ce2`).

## Local qualification on `420f73d`

Node 24.18.0 and pnpm 11.15.1, as pinned by the hosted workflow.

| Gate                                           | Result                                                                  |
| ---------------------------------------------- | ----------------------------------------------------------------------- |
| `pnpm verify:phase8`                           | passed: 1,199 tests, phase 8 tests, Linux bundle, Compose qualification |
| Desktop window self-check                      | skipped by the script: `xvfb-run` is not installed                      |
| `pnpm verify:phase9`                           | passed                                                                  |
| `pnpm verify:phase3:foundation`, phases 4 to 7 | passed                                                                  |
| `pnpm verify:phase10`, `pnpm verify:phase11`   | passed                                                                  |

Known-stale gates, not named by the release documents:

- `pnpm verify:phase1` and `pnpm verify:phase2` wait for a "Connect Baïkal"
  heading removed in the August 10 redesign (`ec7656c`). They also use
  controls that no longer exist, such as "Place in calendar" and
  "Task sync: online".
- `deploy/verify-compose.sh` requires exactly 12 migrations. With only that
  check relaxed to `-ge 12`, the rest of the script passed.

## Rehearsal on real data

The new image ran on copies of production backups in containers with no
network and no Google or ntfy configuration: first the 2026-10-03 07:29 daily
backup, then the release backup set. Both reached readiness with 45
migrations, integrity `ok` and no foreign-key violations.

## Backup and verification

- `deploy/production/backup.sh` (installed byte-identical as
  `/usr/local/sbin/tadooer-backup.sh`) wrote
  `/srv/apps/productivity/data/tadooer/backups/20261003T212128Z`; its
  checksums verified.
- The release set `before/` holds that backup as `suite.tar.gz`, a Baïkal copy
  made with `VACUUM INTO` (integrity `ok`, 237 calendar objects) plus its
  configuration, the previous compose, env and release files, per-table
  fingerprints and `SHA256SUMS`.
- `deploy/backup-stack.sh` was not used: it needs one Compose project with
  `suite` and `baikal` services, and `baikal-setup.md` scopes it to
  development.
- Restore check: the set was extracted and its database fingerprint matched.
  The previous image reached readiness on it with 19 migrations and left every
  table unchanged.
- At deploy time the app was stopped and a final snapshot,
  `suite-stopped.tar.gz`, was taken. Between the online backup and the stop,
  only one `calendar_collections.last_discovered_at` value changed. The
  previous image also restored this snapshot, with identical fingerprints.

## Deployment

`docker compose pull` and `up -d --wait` with the digest in
`/srv/apps/productivity/tadooer.env` (previous file kept as
`tadooer.env.before-0.15.0-rc.2.20261003T212213Z`). The container started at
21:22:16 UTC and became healthy. Its only log line is
`Tadooer listening on http://127.0.0.1:8080`.

## Verification after deployment

- `/api/build`: `0.15.0-rc.2`, `420f73d…`. `/api/ready`: 200, 45 migrations,
  `calendarBridge` `idle`. Metrics: `suite_database_migrations 45`, expected 45.
- Table comparison, stopped snapshot against live, over the columns that
  existed before: 42 of 54 tables are unchanged, and no row count dropped.
  Expected differences:
  - `schema_migrations` 19 to 45.
  - `task_field_versions` 7 to 8: migration 0037 adds a `plannedStart`
    version for each task.
  - New table `owner_preference_revisions` with 2 rows, backfilled by
    migration 0021.
  - `sync_owner_state`: new epoch from 0037, 0049 and 0050, and
    `retained_floor` added by 0048. Each signed-in device replaces its
    offline cache from a snapshot once and then replays queued changes.
  - New columns only, same content: `tasks`, `projects`, `tags`,
    `web_sessions`, `google_connectors`, `google_oauth_states`,
    `owner_planning_preferences`, `automation_tokens`.
  - `calendar_collections`: one `last_discovered_at` update at runtime.
- Counts: tasks 1, projects 1, subtasks 2, tags 1, calendar event projections
  10,690, calendar collections 17, Google calendar sync rows 16, notification
  deliveries 7, task templates 4, owner accounts 1, Baïkal and Google
  connectors 1 each.
- Web app: public and private index return 200. Headless Chromium renders the
  "Sign in" screen; its one console error is the expected 401 from the
  signed-out session check. The served bundle contains "Here is the day." and
  "Today is clear.". The signed-in Today view was not checked; that needs the
  owner's session.
- Sync: no bridge mapping exists, so the background calendar worker has no
  jobs. All `suite_calendar_bridge_*` failure, backlog and conflict gauges are 0. Google projection refresh runs when the owner opens the planner.
- No test notification was sent.

## Rollback

Restore the previous image and the pre-upgrade backup set together. The
previous image does not serve on a 45-migration database. The exact commands
are in `/srv/apps/productivity/releases/20261003-0.15.0-rc.2-420f73d/ROLLBACK.md`:

1. Verify `before/SHA256SUMS` and stop `suite`.
2. Move the migrated database aside.
3. Extract `before/suite-stopped.tar.gz`.
4. Restore `tadooer.env.before-0.15.0-rc.2.20261003T212213Z` and the previous
   `tadooer-release.json`.
5. Run `release-channel.mjs rollback` with the archived `0.14.1-calendar`
   manifest.
6. Run `up -d --wait` and check for `0.14.1-calendar` with 19 migrations.

A rollback discards changes made after 21:22 UTC, so take an owner export first.
