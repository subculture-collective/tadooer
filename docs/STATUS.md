# Current development and release checkpoint

Recorded September 20, 2026. This is the single current checkpoint; phase notes
and execution logs retain dated historical evidence. The complete work list is
[roadmap #15](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/15).
The [approved interview](discovery/2026-09-20-parity-assistants-calendar-hub.md)
and [execution plan](superpowers/plans/2026-09-20-parity-and-calendar-hub.md)
define the current scope.

## Source and publication

The reviewed development stack through `cc1babd` passes `pnpm verify`:
234 tests in 72 files, type checking, lint, formatting, and all four builds.
A built stdio adapter against a built disposable server advertises 34 tools;
project/tag lifecycle, assignment and checklist workflows have HTTP and runtime
checks. This is local verification, not hosted CI or live assistant qualification.

- Reliability/core import work: PR #53 was merged into `main` at `d80b9a3`.
- Bounded import capacity, assistant inventory and calendar authority contract:
  original PRs #54/#61/#62 were merged into intermediate branches. Integration
  PR #68 carries their original commits to `main`; their earlier merged status
  alone does not prove they reached `main`.
- Source parity inventory: PR #69.
- Atomic organization authority and assistant operations: PRs #70/#71.
- Atomic checklist authority and assistant operations: PRs #72/#73.

Those stack relationships were read from Gitea during this work. A temporary
HTTP 502 interrupted readback; a later successful API/Git check again found
`main` at `d80b9a3` and default branch `codex/phase-0-foundation` (#23). Inspect
live PR/base state before merging. Retarget a child to `main` only after its
parent commits reach `main`.
No PR was merged or production image changed by this implementation run.

## Production and stable qualification

The last recorded deployment is candidate `0.14.1-calendar`, source `a6983dc`,
19 migrations, image
`sha256:68438591510360e82e84d98e83d2825bce5134004a884a26e55c75403080548f`.
The recorded soak began `2026-09-20T12:55:39.883Z`; seven full days cannot elapse
before `2026-09-27T12:55:39.883Z`. This documentation pass did not re-probe
production, provider freshness, backups or the live soak ledger.

[#21](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/21) owns
natural observation and stable qualification. Explicit workflow evidence,
backup/restore, absence of qualifying failures and sign-off remain required.
Elapsed time alone never qualifies a release. Keep prior failed ledgers.
Development has migration 0020; source checks do not imply production migrated.
Candidate delivery is [#37](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/37)
and needs its own artifact, backup, deployment and authenticated checks.

## Approved implementation sequence

| Workstream                     | Current evidence and next work                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reliability and release        | Session recovery, Planner loading/range and freshness are implemented in the reliability stack. Browser acceptance #14, Sprint 14 qualification #16, soak #21 and candidate delivery #37 remain distinct.                                                                                                                                                              |
| Super Productivity parity      | #17 pins source 18.16.0, 44 feature directories, 19 export sections and 55 source MCP tools. Installed version/hash is recorded without claiming its exact built commit. Full feature parity is approved; see the [matrix](product/super-productivity-parity.md).                                                                                                      |
| Migration                      | #18 raises the bounded limit to 16 MiB with record/diagnostic budgets. Core apply is transactional, but the real history remains unqualified for apply. #38 archive identity, #27 hierarchy, #28 project organization, #29 date-only planning, #30 linked data, #41 time history and #42 recurrence precede isolated full reconciliation #47 and reviewed cutover #49. |
| Assistant parity               | #19 maps browser actions to catalog coverage. #55 and #56 have implementation PRs. #57 reusable-work authoring, #58 existing time blocks, #59 planning/preferences, #60 imports/connectors and confirmation policy #33 continue under #32. Actual Codex/Claude clients remain #39; Claude account access is explicitly deferred.                                       |
| Hosted and embedded assistance | Hosted OAuth #34 precedes transport #43. Embedded subscription-backed runtime #44 is conditional on actual supported account/runtime qualification. No implicit paid API fallback. Plugins, MCP and skills are the usable independent path.                                                                                                                            |
| Google/Baikal hub              | #20 defines accepted authority and conflict behavior in [ADR 0017](adr/0017-opt-in-baikal-calendar-hub.md), including pure policy tests. Bundled/external Baikal #35, new Google write consent #36, mappings/outbox #40, recurrence/fields #45, worker #46, conflict UI #48 and real-provider qualification #50 remain. No background bridge is enabled.               |
| Remaining parity               | #63 boards/views, #64 metrics, #65 focus preferences, #66 plugins and #67 configuration are explicit children of #31. Additional import adapters #51 follow the Super Productivity priority.                                                                                                                                                                           |
| Conditional scope              | Mobile #24, PostgreSQL #25 and multi-user #26 require their own decisions/evidence. Differentiation #52 follows parity. Default branch reconciliation remains #23.                                                                                                                                                                                                     |

## Reconciled historical plans

[The architecture/frontend audit](product/legacy-plan-reconciliation.md)
separates implemented work from residual tasks. Persistence authority cleanup
#74, app controller extraction #75 and semantic component migration #76 replace
blind execution of old unchecked steps. Old line-count targets and proposed
filenames are not release gates.
