# Super Productivity functional parity matrix

Issue #17. This is a versioned inventory and work map, not a migration-success or
replacement-readiness claim. Full real-data reconciliation remains #47 and reviewed
cutover remains #49. The source application and its backup files were read only.

## Reference identity

Re-pinned September 24, 2026, when the installed application had moved to the
upstream release. `deploy/verify-parity-reference.py` passed against these pins.

- Source: Super Productivity **19.1.0**, tag `v19.1.0`, commit
  `42ded9f31a132bf92633b0c78ad4ebf1d87c0f71`; model-config cross-model version **4.5**.
- Installed app: `~/.local/opt/super-productivity-19.1.0` on Kvant, used by the
  launcher and the running process. `app.asar` SHA-256
  `2133ce92480137f6637d8a23937770a1ec56dcc58dff769e42199f29bdbee0e4`. An exact
  build-to-commit correspondence has **not** been established.
- Previous pin (September 20): 18.16.0 custom fork `a4d74ea32`, recorded under
  `source.previous`. Between the two, `tracking-presence` was added and
  `user-profile` removed from the source feature directories.
- Source MCP: commit `6dde7f75f1f79a064b7d59346259d55076a35eb4`, with 55 catalog
  tool entries. Catalog hash, protocol version and per-tool workflow disposition
  are recorded in the JSON manifest. Source catalog presence does not prove a
  live installed plugin method is available.
- Representative backups: September 20 `dfdddc25…` (18.16) and September 24
  `2026-09-24_164532.json`, SHA-256 `418c0931…` (19.1.0). Both are root-object
  exports with 19 sections and no root schema-version field.
- Source worktrees were preserved, including unrelated untracked files. No source
  configuration, provider secret, task text or task identity is included here.

`super-productivity-parity.json` records all 44 source feature directories, every task, project and tag field, all
19 actual export sections, hashes of five relevant source files, each source MCP
tool's workflow group, data mapping, current status, offline/sync policy, issue
and acceptance scenario. Feature-directory membership is an inventory boundary,
not a claim to have tested every branch of every source feature.

## Workflow matrix

Partial means relevant Tadooer behavior exists but parity/import is incomplete.
Missing means the workflow has no qualified equivalent. Decision-gated rows
remain explicit platform/product decisions; they are never counted as delivered.
Excluded rows record an owner decision not to pursue that source capability.

| Workflow               | Current status | Source-data and behavior mapping                                                                                                                                      | Issue                                                                     |
| ---------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| core-tasks             | partial        | Core titles/notes/timestamps/dates/estimates map transactionally; unsupported metadata blocks apply. Source IDs remain provenance, not destination IDs.               | [#47](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/47) |
| hierarchy              | partial        | Children import as full two-level child tasks in source order; deeper chains block apply. Parent time totals wait for #41.                                            | [#27](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/27) |
| projects               | partial        | Colour, icon, order, hide-from-menu, completion, restore and backlog are stored, edited and imported (ADR 0019); menu folders (#63) and in-project task order remain. | [#28](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/28) |
| tags                   | partial        | Colour, icon, order and archive/restore are stored and imported; Today and board system tags are never ordinary tags (#29, #63).                                      | [#28](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/28) |
| planning               | partial        | Today queue, timed blocks and date-only planned days exist (ADR 0020); persisted Today order, daily rituals, schedule hygiene and auto-planning remain.               | [#29](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/29) |
| history                | partial        | Both archive stores apply as read-only history with historical references, review flags and a collapse-or-block duplicate policy (ADR 0022).                          | [#38](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/38) |
| time                   | partial        | Active interval tracking exists; source daily history, correction and reporting remain unqualified.                                                                   | [#41](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/41) |
| recurrence             | missing        | Source has daily/weekly/monthly/yearly, completion-based generation, inherited child templates and deleted instances; habits do not substitute.                       | [#42](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/42) |
| notes                  | partial        | Project, tag and standalone Markdown notes with pin and order are stored and imported; image notes, legacy notes text and checklist/space workflows remain.           | [#28](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/28) |
| linked-issues          | missing        | Issue identity/provider fields and attachments currently block full import; provider credentials are excluded.                                                        | [#30](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/30) |
| reminders              | partial        | Per-task and timed-deadline reminder offsets use the ntfy ledger (ADR 0020); exact source offsets import. Legacy reminders section stays blocked.                     | [#29](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/29) |
| boards                 | missing        | Source board/section/task-view state has no qualified Tadooer mapping.                                                                                                | [#63](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/63) |
| counters               | missing        | Source counters and metric history are not equivalent to habit streaks.                                                                                               | [#64](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/64) |
| focus                  | partial        | Tadooer has server-authoritative focus/break/takeover; source preferences and idle disposition require parity.                                                        | [#65](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/65) |
| plugins                | missing        | Preserve opaque plugin data; do not run imported code or credentials. Source API and plugin implementations are separately inventoried.                               | [#66](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/66) |
| preferences            | partial        | Planning/preferences exist; safe application config and shortcuts need mapping. Secret/provider configuration is intentionally excluded.                              | [#67](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/67) |
| calendar               | partial        | Google/Baikal federation exists; plugin calendars and opt-in canonical bridge need qualification.                                                                     | [#50](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/50) |
| platforms              | decision-gated | PWA and Linux packaging exist; platform-specific native delivery requires explicit platform design.                                                                   | [#24](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/24) |
| presentation           | decision-gated | Store-rating prompts and engagement presentation are not migrated data; decide relevant product outcomes under post-parity discovery.                                 | [#52](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/52) |
| capture                | partial        | Structured capture resolves existing names only; estimate syntax, tag creation, URLs and markdown/email paste have no equivalent.                                     | [#90](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/90) |
| calendar-subscriptions | missing        | iCal URL subscriptions, event-to-task conversion, auto-import tombstones and hidden events.                                                                           | [#91](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/91) |
| offline-writes         | partial        | Only task core fields and habits queue offline; planned time/day, reminders, assignment, project/tag and checklist writes are online-only.                            | [#92](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/92) |
| data-export            | missing        | Source has self-service JSON export/restore and local backups; Tadooer has only operator SQLite backups.                                                              | [#93](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/93) |
| sync-providers         | excluded       | Owner decision September 24: third-party storage sync and client-side end-to-end encryption are not parity requirements.                                              | [#94](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/94) |

## Import dispositions

`packages/import-export/src/super-productivity-schema.ts` classifies every export
section and every task, project, tag and note field. Each field belongs to
exactly one workflow row in the JSON manifest. The preview and apply paths use the tables, so
no section is dropped without a report:

- **applied**: mapped into Tadooer records.
- **parity**: inventoried; apply is blocked with a parity finding (recurrence,
  time history). Archived tasks apply since #38; see "Archived history" below.
  Hierarchy fields apply since #27, and a chain deeper
  than two levels blocks with `hierarchy_depth_unsupported`. Day-only plans
  (`dueDay`) and exact reminder offsets apply since #29; a reminder that is not
  an exact offset blocks.
- **retained**: not applied, but kept in the import provenance JSON (themes,
  task order inside projects and tags, note lock and background colour).
- **blocked**: a populated value blocks apply (`unsupported_section` or
  `unsupported_import_data`, one finding per record).
- **configuration**: `globalConfig`, `boards`, `planner`, `issueProvider`,
  `pluginMetadata` and counter definitions. Reported as
  `configuration_not_imported`; never applied and does not block.
- **ignored**: derived or view-only task state (`modified`, `hasPlannedTime`,
  `_hideSubTasksMode`, the leaked `subTasks` copy) and legacy project issue
  configuration, which can hold credentials.

Since #28 (ADR 0019), `note` and `menuTree` apply. `menuTree` supplies project
and tag order; folders are reported with `configuration_not_imported` and not
imported. The `TODAY`, `EM_URGENT`, `EM_IMPORTANT` and `KANBAN_IN_PROGRESS`
system tags never become ordinary tags: unused ones are reported and skipped,
while Today task order or a marker used by tasks blocks apply. Backlog or
`noteIds` entries that point at records missing from the export are reported
and skipped; entries that contradict the task's project block.

Unknown sections (`unknown_section`), task fields (`unknown_task_field`) and
project/tag/note fields block apply until they are reviewed.

Every finding carries `blocking`. Reported dispositions that do not block are
`configuration_not_imported`, `duplicate_copy_collapsed`,
`historical_reference`, `historical_parent_detached` and `history_review`; any
other code blocks.

### Archived history (#38)

`archiveYoung` and `archiveOld` apply as archived tasks (ADR 0022). Their
`task` stores keep original `created` and `doneOn` times and their hierarchy.
On archived records only:

- projects, tags, repeat configurations and parents absent from the export,
  and priority markers, are kept as historical references instead of blocking;
- a blank title imports as "Untitled archived task", notes over 20,000
  characters import truncated, and an unrepresentable estimate is left empty;
  each is flagged for review and the source value stays in provenance;
- schedule and reminder fields, including legacy `plannedAt`, are kept in
  provenance and never applied.

Identical copies of one task in two stores collapse to the first store's copy
(live, then young, then old). Divergent copies block and name the differing
fields. A child whose parent is in the other lifecycle imports at top level
with the parent kept as a historical reference. Populated archive
`timeTracking` still blocks (#41), as do unknown archive keys.

A read-only rerun on the September 24 backup maps 4,275 archived records
(1,778 young after 95 duplicates, 2,497 old). It keeps 5,369 historical
references: 1,100 projects and 2,930 tags missing from the export, 28 priority
markers, and 1,311 repeat configuration IDs (657 missing, 654 existing). Six
blank titles, one oversized note and two estimates are flagged for review.
32 duplicate copies collapse; 63 differ in `isDone`/`doneOn` and block.

### September 24 backup (19.1.0)

A read-only run of the updated importer found no unknown sections or fields. The
export still cannot be applied:

- `metric`, recorded `simpleCounter` values, `timeTracking` and `pluginUserData`
  block as unsupported sections; six configuration sections are reported.
- 73 unsupported-data findings, one per source: 49 live tasks with blocked fields
  (34 with linked issues and 19 with reminders; 4 have both), 22 tasks with
  day-only plans, the TODAY tag, and one finding for the archives.
- Integrity: 95 tasks exist both live and in `archiveYoung`, and the live index
  repeats 28 IDs (every retained backup from 14:25 to 16:45 CDT). The September 20
  backup had neither. #47 tracks resolving this in Super Productivity before a
  qualification import; the importer refuses to choose between copies.

## UI, synchronization and assistant acceptance

Every workflow issue must deliver user-visible behavior, appropriate persistence
and sync semantics, and equivalent scoped assistant actions. The separate
[assistant inventory](assistant-capabilities.md) maps existing UI/API functions to
Tadooer's actual catalog. The source MCP mapping in this manifest identifies
required outcomes; it does not equate similarly named source/Tadooer tools or
promise exact source tool names. Source bulk mutations need #33 approval rules
and #32 implementation rather than repeated unreviewed single-item writes.

For each row, record at least one imported-data workflow through the UI and
assistant, exact source/destination counts, relevant conflict/restart/offline
behavior, and original time/history totals. Do not mark a row qualified merely
because an import creates records. Migration of preferences must distinguish
safe user preferences, source-only transient selection state, and credentials
that require fresh authorization. Original exports remain the recovery source
until every section has an explicit supported mapping or reviewed disposition.

## Priority and discovered work

1. #18 increases bounded preview capacity; #27 hierarchy and #38 historical
   identity unblock much of the actual archive. #28 organization and #29 planning
   can progress alongside those domain contracts.
2. #41 work history and #42 recurrence require full source-child semantics;
   preserve old missing references and explicitly reconcile mismatched totals.
3. #30 linked issues/attachments and #63–#67 boards, counters, focus preferences,
   plugins and configuration close the remaining inventoried areas. These child
   issues are linked under #31 rather than hidden in an omnibus parity promise.
4. #47 exercises a complete isolated import and reconciles all matrix rows before
   #49 replacement/cutover. Native platform scope #24 and post-parity product
   choices #52 retain explicit decisions and evidence boundaries.

## Rechecking this inventory

Run the portable read-only reference checker against the pinned source checkouts:

```sh
python3 deploy/verify-parity-reference.py --source /path/to/super-productivity --mcp /path/to/super-productivity-mcp
```

Optionally supply `--installed-asar /path/to/resources/app.asar` to verify the
independent installed-artifact fingerprint. A mismatch requires a new reviewed
manifest; do not update recorded hashes simply to make the check green.
Repository tests require every captured feature directory/export section/tool to
have a workflow disposition and every row to have acceptance, sync and assistant
tracking. They do not require private backups or another repository on CI.
