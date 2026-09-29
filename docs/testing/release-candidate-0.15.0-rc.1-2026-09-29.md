# Release candidate 0.15.0-rc.1 qualification, 2026-09-29

Issue: [#37](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/37).
This candidate is built and rehearsed. It is **not deployed**. Production and
its soak were read, not changed.

## Identity

| Item               | Value                                                                                                                             |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| Source             | `main` at `65820d8754aa87f129a440101105f9f91aff62a5` (merge of #110)                                                              |
| Version label      | `0.15.0-rc.1`                                                                                                                     |
| Image              | `127.0.0.1:5000/subculture-collective/productivity-suite@sha256:87a00cbefe22e587b0bac0f886b516d5a57b0c4793222f7dde6839f0b017ec3f` |
| Manifest           | `deploy/releases/0.15.0-rc.1-65820d8.json`                                                                                        |
| Migrations         | 41 (production: 19)                                                                                                               |
| Automation catalog | 102 entries                                                                                                                       |

Production on nuc runs `tadooer-suite-1` from
`sha256:68438591510360e82e84d98e83d2825bce5134004a884a26e55c75403080548f`,
labelled revision `a6983dc` and version `0.14.1-calendar`, observed read-only
on 2026-09-29.

An earlier push of the same source as `0.14.0-rc.1`
(`sha256:2d3e7b29…`) is superseded: its version sorts below production's
`0.14.1-calendar`. Do not deploy that tag.

## Checks

| Check                                                                                    | Result                                      |
| ---------------------------------------------------------------------------------------- | ------------------------------------------- |
| Hosted CI `verify` on the merged commits (PRs #108, #109, #110)                          | passed                                      |
| `pnpm verify` on each integration branch in the dev environment                          | passed, 802 tests on the final branch       |
| `pnpm test:phase8`, `pnpm test:phase9`, backup script syntax and ShellCheck              | passed                                      |
| Production Compose rendered with a placeholder digest                                    | passed                                      |
| `deploy/verify-phase8-compose.sh` (build, readiness, metrics, restart, restore, promote) | passed in 49 s                              |
| Push to the nuc registry through an SSH tunnel, then pull by digest                      | passed; registry digest matches local build |

## Backup, upgrade and rollback rehearsal

Run with `deploy/rehearse-upgrade.sh <production-image> <candidate-image>` on
a disposable volume on Kvant: loopback only, no Baïkal and no production data.
Script output, counts only:

| Step | Binary     | Action                                              | Result                                     |
| ---- | ---------- | --------------------------------------------------- | ------------------------------------------ |
| 1    | production | empty volume, owner setup, one task                 | ready, 19 migrations, task present         |
| 2    | production | online SQLite backup plus the paired credential key | backup set written                         |
| 3    | candidate  | start on the same volume, then restart              | ready, 41 migrations, login and task kept  |
| 4    | production | start on the migrated database without restoring    | running but `not_ready`; it does not serve |
| 5    | production | restore the backup set from step 2, start           | ready, 19 migrations, login and task kept  |

Step 4 shows that rolling back the image alone is unsafe after this upgrade:
rollback must restore the backup set taken before the candidate started.

## Not done

These need the owner:

- **Soak disposition.** The pinned soak's outcome must be recorded before
  production changes.
- **Production backup and deploy.** Take `deploy/production/backup.sh` on nuc,
  set `SUITE_IMAGE` to the digest above, `docker compose pull`, then
  `docker compose up -d --wait`, and verify `/api/build`, `/api/ready`
  (41 migrations), `/api/metrics`, login and task, connector, focus and restart
  workflows on the live instance.
- **New soak.** Start candidate evidence once deployed.

Not covered by this rehearsal:

- Real production data. The migrations from 19 to 41 were exercised on a
  one-task database and in the test suite, not on the owner's history.
- Installed Codex and Claude runs against the new catalog entries (#33, #57,
  #58, #60, #48). The September 25 client qualification covers the earlier
  catalog.
- Any live Google account (#50). The calendar bridge ships opt-in with no
  mapping, and its worker runs only for enabled mappings.
