# Current development and release checkpoint

Recorded November 3, 2026, from `main` at `026bc6f`, the Gitea issue list and a
read of the production `/api/build` and `/api/ready` endpoints; the production
section was updated after the `0.15.0-rc.6` deployment on November 4. This is
the single current checkpoint; phase notes, release records under
`docs/testing/` and execution plans keep the dated history. The repository is
[subculture-collective/tadooer](https://github.com/subculture-collective/tadooer)
and its default branch is `main`.

Issues moved from Gitea to GitHub on November 10, 2026 and were renumbered.
Issue numbers in this repository's documents are the Gitea numbers. A linked
number opens the matching GitHub issue, whose first line names its Gitea
number.

## Production

A `v*` tag deploys to production on NUC and publishes the desktop packages on
a Gitea release; see [releases.md](operations/releases.md). The
[releases page](https://git.subcult.tv/subculture-collective/tadooer/releases)
lists what has shipped, and `https://tadooer.subcult.tv/api/build` reports the
live version. Each deployment's backup, rehearsal, verification and rollback
set is in `/srv/apps/productivity/releases/` on NUC.

On 2026-11-04, `0.15.0-rc.8` (`22c1657`, 53 migrations) was the first release
with every job passing: deploy, the Linux tar.gz and the macOS universal zip
and disk image. Before it, `0.15.0-rc.6` was deployed by hand
([release record](testing/release-0.15.0-rc.6-2026-11-04.md)) and
`0.15.0-rc.7` deployed through the workflow without desktop packages.

## Stable release

[#21](https://github.com/subculture-collective/tadooer/issues/23) still
describes the September 20 soak of `0.14.1-calendar` (`a6983dc`, 19
migrations). Production has since moved through `0.15.0-rc.1` to `rc.8`, so
that soak does not cover the running build. Its disposition is an owner
decision recorded on
[#37](https://github.com/subculture-collective/tadooer/issues/39). Elapsed
time alone never qualifies `1.0.0`; workflow evidence, backup and restore, the
absence of qualifying failures and sign-off remain required.

## Open work

| Workstream                       | Open issues and next step                                                                                                                                                                                                                                                                                     |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Release and cutover              | #21 soak and stable release, #37 next candidate, #49 reviewed migration cutover from Super Productivity.                                                                                                                                                                                                      |
| Super Productivity parity        | The parity matrix (#17) and its child slices are closed. #31 and #32 remain open as epics; #47 qualifies a full import of the real history and reconciles real workflows. Additional import adapters (#51) follow. #217 tracks the remaining v20 gaps ([plan](product/super-productivity-parity-roadmap.md)). |
| Calendar hub                     | Bridge implementation (#35, #36, #40, #45, #46, #48) is closed and tested against fake providers and disposable Baikal. #50 qualifies Google and both Baikal modes with real accounts. Busy-only feeds (#189) are deployed.                                                                                   |
| Assistant access                 | Hosted OAuth (#34), confirmation policy (#33) and installed Codex/Claude clients (#39) are closed. #43 delivers the hosted MCP transport; #193 is a smaller capture-only hosted endpoint. Embedded subscription runtimes (#44) stay conditional.                                                              |
| Workspace UI                     | Both shell slices (#194, #196) are deployed. #176 tracks the landing page.                                                                                                                                                                                                                                    |
| Multi-device sync (#112)         | Waves 7A and 7B are closed. Open: device sessions #115, desktop apps #116, mobile #117 (Capacitor Android shell in `apps/mobile`, [ADR 0049](adr/0049-mobile-shell.md)) and live-sync qualification #118.                                                                                                     |
| Installation and releases (#136) | Eighteen issues, #137 to #154, in milestones: automated server setup, desktop releases and device hosting, hosted sync without a home server, Google-backed app data, Android, iOS, and a final installation and platform matrix.                                                                             |
| Decisions                        | #26 multi-user scope, #52 improvements after parity, #102 extension runtime.                                                                                                                                                                                                                                  |

## Earlier plans

[The architecture/frontend audit](product/legacy-plan-reconciliation.md)
separates implemented work from residual tasks; its follow-ups #74, #75 and
#76 are closed. Old line-count targets and proposed filenames are not release
gates.
