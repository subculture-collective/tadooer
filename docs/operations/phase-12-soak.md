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
