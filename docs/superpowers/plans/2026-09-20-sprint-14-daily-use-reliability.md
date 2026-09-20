# Sprint 14: Daily-use reliability

**Status:** Started September 20, 2026. Planning window September 20–27.
**Development branch:** `sprint/14-daily-use-reliability`.
**Production baseline:** `0.14.1-calendar`, application revision
`a6983dc218b546a39bec0773011545e78e4b4bef`, immutable image
`sha256:68438591510360e82e84d98e83d2825bce5134004a884a26e55c75403080548f`.

## Goal and release boundary

Make the Capture → Plan → Focus workflow reliable across expired sessions,
calendar refreshes, and multiple devices. Run the seven-day production soak in
parallel. Sprint work stays on its branch and in disposable environments until
review; it does not silently replace the candidate under observation. A P0/P1
production repair requires a new immutable candidate and a fresh soak ledger.

## Closed release work

- [x] Deadline/offline sync, habit sync/UI/automation, and structured capture shipped.
- [x] Calendar session recovery and full resync shipped; owner resync verified all
  16 Google calendars fresh and current production Planner projection.
- [x] Restore the NUC Prometheus-agent scrape and Dozor alert-file registration;
  verify up=1, migrations=19, backup success, and seven healthy/inactive rules.
- [x] Start a fresh exact-image soak; preserve August and failed collector ledgers.
- [x] Schedule current-window health/backup observation every fifteen minutes,
  with no automatic credit for user journeys or historical evidence.

## Ordered development backlog

### 1. Consistent session recovery across online actions — shared recovery implemented

September 20 implementation: shared API failure notifications now surface inline
session recovery for authenticated actions, preserving mounted drafts and IndexedDB.
Recovery updates the session without replaying the failed action. Calendar actions
use the same recovery UI. Full verification passed: 192 tests and four builds.
Two disposable Chrome profiles verified expired-session login and stale-CSRF refresh,
retained capture drafts, no mutation before explicit retry, and one create per retry.
Remaining audit: successful writes followed by failed ancillary reads and offline
outbox recovery across expiry. Browser snapshots are in local `.playwright-cli/`.

Calendar actions now recover explicitly, but the other task/calendar/focus,
settings, and automation UI paths need the same audit. Inspect `apps/web/src/api.ts`,
`app.tsx`, sync transport and session-resume behavior before choosing a shared
boundary. Keep offline task outboxes and conflict state intact. Do not replay
potentially committed mutations automatically, extend session expiry, or turn
an invalid Google grant into a Tadooer-login error.

Acceptance: an expired session or stale CSRF token in two real browser profiles
produces an actionable state; successful writes remain visible when a later
read fails; queued offline work survives sign-in. Focused failure tests plus
server-backed browser checks and `pnpm verify` pass.

### 2. Planner range and loading consistency — implemented and verified

September 20 implementation: server filters tasks by planned start in [from, to);
latest navigation request wins, mismatched periods stay hidden, and load failures
provide an explicit retry. Navigation uses local calendar days across DST.
Full verification passed (195 tests, four builds); disposable browser verification
delayed an older response behind a newer one, injected a 503, and recovered using
Retry without displaying prior-period tasks. Source checks cover period endpoints,
unscheduled/old tasks, and spring/fall DST.

Production inspection showed an old planned task outside the selected week in
Planned tasks. Audit `PlannerPage.tsx`, calendar-range helpers, `loadPlanner`,
and the planner response contract. Calendar events after resync are in range;
the task list must be qualified separately. Prevent an older in-flight response
from replacing a newer selected period. Keep Today queue membership unchanged.

Acceptance: day/three-day/week views contain only the intended events and tasks,
DST boundaries work, rapid navigation cannot display another period's results,
and loading/failure states identify saved data. No scheduling or task dates
change as a side effect of navigation.

### 3. Calendar freshness and recovery feedback — queued

Audit the meaning of “current” against `lastSuccessfulSyncAt`, stored incremental
cursors, disconnected/revoked state, and transient provider failures. Show when
calendars were last updated and distinguish stale data from failed sign-in.
Choose and document any automatic-refresh policy before implementing it.

Acceptance: old projections are never labeled newly refreshed, a failed full
resync retains last good events, and the owner can recover without disconnecting
unless Google actually requires a new grant. Provider failures are bounded and
visible; no broadened OAuth scopes or writes to Google.

### 4. Qualification and documentation reconciliation — ongoing

Reconcile older architecture/frontend-plan checkboxes against actual code rather
than treating them as missing features. Maintain one current release checkpoint
and keep historical evidence labeled. Record production acceptance only when
executed after the active soak start.

## Active soak

NUC ledger: `/srv/apps/productivity/soak/20260920-calendar-a6983dc-r2.json`.
Started: `2026-09-20T12:55:39.883Z` (07:55:39 America/Chicago).
Earliest possible qualification: September 27 at 07:55:39 America/Chicago.
Time alone does not qualify the release.

Collector: `tadooer-soak-observer.timer` every fifteen minutes, checking the
pinned public build and image, readiness, migration count, runtime health,
current-window paired backup checksums/integrity, and successful encrypted
Restic backup/check report. It waits for in-progress backups and preserves
failed observations. It runs as root to read private backup manifests; backup
and credential permissions remain unchanged. Both the old August ledger and
the first September collector-permission failure remain intact.

Initial health/backup, authenticated Google projection, auth-boundary checks,
and parallel Super Productivity availability are recorded after start. The
out-of-range Planned tasks display is recorded as a P2 defect, with no observed
data mutation or loss; it is not hidden by passing health checks.

Required explicit scenarios tracked by the ledger: two browser profiles,
Baikal and Google projections, focus/break lifecycle, lead and at-start ntfy,
restart recovery, isolated restore, candidate upgrade, immutable rollback,
forward recovery, auth boundaries, calendar/notification non-duplication, and
parallel Super Productivity availability. Do not substitute unit tests or
pre-start deployment evidence for these observations. Natural reminder delivery
and human sign-off remain required before stable 1.0.0.

## Verification and sprint exit

Use focused tests first, `python3 -m unittest discover -s deploy/production -p test_observe_soak.py`,
`pnpm exec vitest run deploy/phase12-soak.test.mjs deploy/release-channel.test.mjs`,
and `pnpm verify` for source changes. Include real browser journeys for UI changes.

Sprint exit requires accepted items verified and committed, an honest disposition
of remaining backlog, and either a fully qualified soak or explicit missing
observations. Stable promotion requires the existing qualifier and human sign-off;
Super Productivity remains available throughout.
