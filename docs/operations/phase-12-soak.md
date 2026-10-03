# Phase 12 seven-day soak

Phase 12 begins only after the production owner, Baïkal, Google, and ntfy owner
preferences are configured. Start a new ledger with the exact deployed digest:

```bash
node deploy/phase12-soak.mjs start /protected/phase12-soak.json \
  0.11.0-phase11 efe73ee sha256:... 2026-08-08T00:00:00.000Z
```

The ledger is operator evidence, not telemetry inference. Record only checks
that actually passed. Every 24-hour soak window needs both `daily_health` and
`daily_backup`. The whole soak needs two-browser task capture/planning, both
calendar projections, a complete focus/break lifecycle, lead and at-start ntfy
delivery, restart recovery, isolated restore, candidate upgrade, immutable
rollback, forward recovery, auth-boundary checks, calendar/notification
non-duplication, and confirmation that Super Productivity remained available.

Any failed ordinary observation or P0/P1 defect blocks qualification. A serious
defect starts a fresh seven-day ledger after repair. The qualifier refuses to
emit `1.0.0` until seven full 24-hour windows and all required evidence exist:

```bash
node deploy/phase12-soak.mjs qualify /protected/phase12-soak.json \
  /protected/productivity-suite-1.0.0.json 2026-08-15T00:00:00.000Z "OWNER"
```

Review the signed manifest and cutover recommendation before promoting it with
the release-channel tool. Promotion does not stop, remove, or migrate Super
Productivity.

## Current run and scheduled collection

**Ended early, 2026-10-03.** The owner asked, "I would like to get tadooer
updated", and `0.15.0-rc.2` was deployed. The run below did not qualify. Its
ledger is unchanged; the decision is in
`20260920-calendar-a6983dc-r2-ended-20261003.json` beside it. The observer
timer is stopped and disabled until the owner starts a new ledger for the new
digest. See
[release-0.15.0-rc.2-2026-10-03.md](../testing/release-0.15.0-rc.2-2026-10-03.md).

The active NUC ledger is `/srv/apps/productivity/soak/20260920-calendar-a6983dc-r2.json`,
also referenced by `soak/active.json`. It started September 20, 2026 at
12:55:39.883 UTC with candidate `0.14.1-calendar` / `a6983dc` and digest
`sha256:68438591510360e82e84d98e83d2825bce5134004a884a26e55c75403080548f`.
Earliest qualification is September 27 at the same UTC time, subject to every gate.

`tadooer-soak-observer.timer` runs the supplied `observe-soak.py` every fifteen
minutes. The root service reads private backup manifests without weakening their
permissions. Evidence files and ledgers stay private. The collector checks current
public/runtime identity, health and backups; it does not infer browser, calendar,
focus or notification journeys. It waits for an in-progress Restic job and credits
only backups created in the current 24-hour window with a successful later Restic
backup/check report. Use the shared `<resolved-ledger>.lock` when manually recording
observations. Each evidence file is separate; failure observations remain in place.

The August ledger and September run ending in a collector-permission failure are
retained. The corrected collector was verified before starting the active run.
`start` now refuses to overwrite an existing ledger. Production is pinned during
the soak; sprint work stays on `sprint/14-daily-use-reliability`.

The encrypted Restic file list now includes `/srv/apps/productivity/soak` and
`/srv/apps/productivity/operations` so ledgers and observer code travel with
future backups. The existing backup script and monitoring configs have dated
pre-change copies on their owning hosts.
