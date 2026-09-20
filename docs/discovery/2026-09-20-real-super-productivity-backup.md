# Real Super Productivity backup qualification — September 20

Read-only qualification of a local automatic backup using
`prepareSuperProductivityImport` from commit `463dc45`. No records were applied,
no source files were changed, and production was untouched. This is a backup
snapshot, not proof of the current live task state.

## Provenance

- File: `/home/onnwee/.config/superProductivity/backups/2026-09-20_123244.json`
- Modified: September 20, 2026 at 12:32:44 CDT (17:32:44 UTC).
- Size: 4,191,857 bytes; only 2,447 bytes below the current 4 MiB preview limit.
- SHA-256: `dfdddc25d21317fc9fb6a00ff5bd7f2e4b0962bd2da19d01e238bfbb411215b3`
- Running application path identified the local 18.16 custom installation.
- Root-format export with live tasks and both archive stores.
- Task content, source IDs, credentials, and the original export are excluded
  from this repository report.

## Inventory and apply decision

The parser accepted the file; `canApply` was false, as expected for this full
export. The current core importer must not silently apply a subset.

| Measure | Count |
| --- | ---: |
| Raw live task records | 106 |
| Raw young archive records | 1,211 |
| Raw old archive records | 3,510 |
| Raw total task records | 4,827 |
| Preview task inventory | 4,821 |
| Completed inventory tasks | 4,772 |
| Archived inventory tasks | 4,715 |
| Child tasks | 2,594 |
| Projects | 49 |
| Tags | 21 |
| Repeat configurations | 51 |

Six old archive tasks have blank titles and are excluded from the preview
inventory totals. Raw archived count is 4,721. Leaf-task tracked milliseconds
sum to 2,181,326,651; this is parser inventory, not reconciled work-history proof.

## Findings

| Issue code | Occurrences |
| --- | ---: |
| missing_tag | 2,956 |
| missing_repeat_config | 657 |
| missing_project | 1,095 |
| invalid_task | 6 |
| duplicate_reference | 3 |
| missing_child | 5 |
| time_total_mismatch | 2 |
| hierarchy_parity_required | 1 |
| recurrence_parity_required | 1 |
| time_history_parity_required | 1 |
| unsupported_import_data | 75 |

All missing-reference, invalid-task, duplicate-reference, missing-child, and
mismatched-time findings occur in the old archive. None occur in live tasks or
the young archive. The archives contain tasks and time tracking, without separate
project/tag/repeat stores. Historical references missing from today's entity
stores may reflect deletion over time; this does not establish corruption of the
active application. Do not rewrite the source backup to make it pass.

The 75 unsupported-data findings comprise 64 issue links, six reminders, and
one each for completed projects, archived projects/tags, the virtual Today tag,
day-only scheduling, and archived history. These are occurrence counts, not
necessarily distinct affected tasks.

## Implementation implications

1. Preserve full child-task metadata and hierarchy before importing this export.
2. Add historical task lifecycle and unresolved historical source identity support;
   do not require every old reference to resolve against current entity stores.
3. Qualify repeat configurations and work history without substituting habits or
   flattening time entries. Investigate the two time mismatches explicitly.
4. Preserve linked issues, reminders, date-only scheduling, and project lifecycle;
   retain original source data for unsupported features.
5. Revisit the bounded upload limit before the next qualification: routine backup
   growth can push this export beyond 4 MiB. Never truncate the export.
6. Re-run preview and reconciliation after each relevant parity slice. Successful
   parsing here does not qualify full migration, browser upload, or production use.
