# Assistant capability and permission inventory

Issue #19; follow-on operations #32. Baseline: branch from issue #18 at `4664bb1`.
This inventory describes source support, not successful real Codex/Claude operation.
The installed stdio smoke tests and exact-client qualification (#39) are separate.

## Authority and confirmation

`packages/contracts/src/index.ts` exports the sole automation catalog. Each row
below references those IDs; the catalog supplies exact scopes, schemas, HTTP/MCP
names and whether preview is required. Do not maintain a second hand-written
permission list. Read resources also appear as MCP tools. The confirmation tool
resolves the scope of the stored operation rather than requiring every advertised
write scope. Browser identity, provider secret entry, OAuth consent and issuance
of broader assistant authority remain owner-interactive boundaries.

All current mutation tools use preview/confirmation. A server confirmation call
is not necessarily a second user prompt: #33 will qualify ordinary explicitly
requested edits versus explicit bulk/deletion approval. Existing scope, revision,
staleness and durable replay checks must remain. Skills do not replace these
application controls. No full-capability claim is made while gaps remain.

## Current capability inventory

Covered means a catalog path exists. Partial means some UI actions are missing.
Gap means existing UI/API behavior has no equivalent catalog path. Future means
the underlying feature itself is not implemented. Operator/internal rows have an
explicit authority boundary rather than silently counting as covered.

| Action | Source status | Catalog IDs | Follow-up |
| --- | --- | --- | --- |
| Owner setup, browser sign-in/out and session recovery | owner-only | — | [#39](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/39) |
| Provision Baikal credentials, authorize Google, disconnect grants | owner-only | — | [#60](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/60) |
| Connector health and explicit Google sync/resync | gap | — | [#60](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/60) |
| Day plan and planning preferences | gap | — | [#59](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/59) |
| Notification preferences, health and test delivery | gap | — | [#59](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/59) |
| Active and deleted task inventory | covered | `tasks.list`, `tasks.deleted` | [#39](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/39) |
| Plain or structured task capture | covered | `tasks.create` | [#39](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/39) |
| Title, notes, dates and estimate edits | covered | `tasks.update` | [#39](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/39) |
| Complete and reopen tasks | covered | `tasks.set_completed` | [#39](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/39) |
| Delete and restore tasks | covered | `tasks.delete`, `tasks.restore` | [#33](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/33) |
| Bounded planner and calendar projection | covered | `schedule.get` | [#39](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/39) |
| Create, move and remove a task time block | partial | `schedule.create_time_block` | [#58](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/58) |
| Browser registration, cache snapshots and outbox transport | internal | — | [#19](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/19) |
| Focus/break lifecycle and takeover | covered | `active-session.get`, `focus.start`, `focus.pause`, `focus.resume`, `focus.start_break`, `focus.end_break`, `focus.complete`, `focus.takeover` | [#39](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/39) |
| Project and tag inventory | covered | `projects.list`, `tags.list` | [#39](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/39) |
| Project/tag lifecycle and task assignment | gap | — | [#55](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/55) |
| Checklist child create/edit/reorder/delete | gap | — | [#56](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/56) |
| Template and set libraries | covered | `templates.list`, `template-sets.list` | [#39](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/39) |
| Template authoring, archive, from-task and set creation | gap | — | [#57](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/57) |
| Instantiate a template or set | covered | `templates.instantiate`, `template_sets.instantiate` | [#33](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/33) |
| Choice pool library | covered | `pools.list` | [#39](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/39) |
| Pool authoring, slots, completion history and placeholder creation/suggestion | gap | — | [#57](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/57) |
| Resolve a planning placeholder | covered | `placeholders.resolve` | [#33](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/33) |
| Habit lifecycle, canonical completion and metrics | covered | `habits.list`, `habits.mutate` | [#39](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/39) |
| Calendar import preview/apply | gap | — | [#60](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/60) |
| Read-only calendar feed create/list/revoke | gap | — | [#60](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/60) |
| Super Productivity preview and reviewed apply | gap | — | [#60](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/60) |
| Issue/list/revoke scoped assistant credentials | owner-only | — | [#34](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/34) |
| Execute approved catalog preview | internal | `automation.confirm` | [#33](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/33) |
| Full hierarchy, archived history, recurrence and manual worklogs | future | — | [#32](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/32) |
| Calendar mapping/conflict/background bridge controls | future | — | [#48](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/48) |

| Authenticated calendar ICS export | gap | — | [#60](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/60) |

## Drift checks and coverage boundary

`assistant-capabilities.json` contains the concrete web API function names,
source references and authority notes. `automation-coverage.test.ts` uses the
TypeScript syntax tree to require a disposition for every exported browser API
function, and requires a mapping for every automation catalog entry. It rejects
unknown IDs, duplicate API mappings, missing source paths and untracked gaps.
Adding a callable browser export or a catalog operation requires updating the
inventory. This prevents catalog/API drift; it does not prove behavioral parity.

Local-only navigation, filters, command-bar presentation and recovery diagnostics
are client presentation, not separate persisted assistant actions. Query/read
capabilities should support their user outcome without simulating UI controls.
Any newly added server-backed UI action must use the reviewed API boundary or
add an explicit inventory row. Habits are recorded separately because the UI
uses sync commands instead of exported direct-HTTP habit functions. The calendar
ICS download is also mapped explicitly because it uses an authenticated anchor
in `calendar-migration.tsx`, outside the API helper module.

## Evidence required for each implementation slice

1. Shared input/output/scope contracts, owner isolation and authoritative store.
2. Rejected/stale preview, revoked credentials, race, interrupted confirmation,
   atomic rollback, restart/replay and deletion-after-restore tests as applicable.
3. Installed runtime initialize/catalog/read/preview/confirm checks.
4. Actual Codex and Claude workflow evidence under #39, including skill behavior,
   approval rejection and no secret disclosure. Claude account access is deferred.
5. Update this inventory and linked implementation issue; deployment remains #37.
