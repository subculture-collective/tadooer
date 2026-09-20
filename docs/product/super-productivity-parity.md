# Super Productivity functional parity matrix

Issue #17. This is a versioned inventory and work map, not a migration-success or
replacement-readiness claim. Full real-data reconciliation remains #47 and reviewed
cutover remains #49. The source application and its backup files were read only.

## Reference identity

- Source: Super Productivity **18.16.0**, commit
  `a4d74ea3215be7d07b41ff38eebc3ebffca9ebc8`; model-config cross-model version **4.5**.
- Installed app package inside `app.asar`: **18.16.0**; artifact SHA-256
  `200cd4e96904061f37c6f0f31a227b37d05175295e28b65b27159eeebcaba1d6`.
  This independently identifies the installation; an exact source/build commit
  correspondence has **not** been established. Do not infer it from version equality.
- Source MCP: commit `6dde7f75f1f79a064b7d59346259d55076a35eb4`, with 55 catalog
  tool entries. Catalog hash, protocol version and per-tool workflow disposition
  are recorded in the JSON manifest. Source catalog presence does not prove a
  live installed plugin method is available.
- Representative full backup: SHA-256
  `dfdddc25d21317fc9fb6a00ff5bd7f2e4b0962bd2da19d01e238bfbb411215b3`, root-object
  export with 19 sections. The backup has no independent root schema-version
  declaration; model version 4.5 identifies the pinned source, not a fabricated
  version field in the backup.
- Source worktrees were preserved, including unrelated untracked files. No source
  configuration, provider secret, task text or task identity is included here.

`super-productivity-parity.json` records all 44 source feature directories, all
19 actual export sections, hashes of five relevant source files, each source MCP
tool's workflow group, data mapping, current status, offline/sync policy, issue
and acceptance scenario. Feature-directory membership is an inventory boundary,
not a claim to have tested every branch of every source feature.

## Workflow matrix

Partial means relevant Tadooer behavior exists but parity/import is incomplete.
Missing means the workflow has no qualified equivalent. Decision-gated rows
remain explicit platform/product decisions; they are never counted as delivered.

| Workflow | Current status | Source-data and behavior mapping | Issue |
| --- | --- | --- | --- |
| core-tasks | partial | Core titles/notes/timestamps/dates/estimates map transactionally; unsupported metadata blocks apply. Source IDs remain provenance, not destination IDs. | [#47](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/47) |
| hierarchy | missing | Source children are full tasks, not checklist-only records. | [#27](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/27) |
| projects | partial | Basic project identity/title exists; completion, backlog, notes, folders/order need parity. | [#28](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/28) |
| tags | partial | Basic tags/assignment exist; virtual Today and source context/config are not ordinary imported tags. | [#28](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/28) |
| planning | partial | Today queue and timed blocks exist; date-only planning, source ordering, daily rituals, schedule hygiene and automatic planning need explicit parity. | [#29](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/29) |
| history | missing | Both stores inventoried; archived task apply blocked. Preserve unknown historical project/tag/repeat identity and blank-title dispositions. | [#38](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/38) |
| time | partial | Active interval tracking exists; source daily history, correction and reporting remain unqualified. | [#41](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/41) |
| recurrence | missing | Source has daily/weekly/monthly/yearly, completion-based generation, inherited child templates and deleted instances; habits do not substitute. | [#42](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/42) |
| notes | partial | Task notes exist; standalone/project notes and markdown/checklist/space workflows require mapping. | [#28](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/28) |
| linked-issues | missing | Issue identity/provider fields and attachments currently block full import; provider credentials are excluded. | [#30](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/30) |
| reminders | partial | ntfy scheduled reminders exist; source task/deadline reminder timing needs parity. | [#29](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/29) |
| boards | missing | Source board/section/task-view state has no qualified Tadooer mapping. | [#63](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/63) |
| counters | missing | Source counters and metric history are not equivalent to habit streaks. | [#64](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/64) |
| focus | partial | Tadooer has server-authoritative focus/break/takeover; source preferences and idle disposition require parity. | [#65](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/65) |
| plugins | missing | Preserve opaque plugin data; do not run imported code or credentials. Source API and plugin implementations are separately inventoried. | [#66](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/66) |
| preferences | partial | Planning/preferences exist; safe application config and shortcuts need mapping. Secret/provider configuration is intentionally excluded. | [#67](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/67) |
| calendar | partial | Google/Baikal federation exists; plugin calendars and opt-in canonical bridge need qualification. | [#50](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/50) |
| platforms | decision-gated | PWA and Linux packaging exist; platform-specific native delivery requires explicit platform design. | [#24](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/24) |
| presentation | decision-gated | Store-rating prompts and engagement presentation are not migrated data; decide relevant product outcomes under post-parity discovery. | [#52](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/52) |

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
