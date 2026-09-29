---
status: accepted
---

# Owner data export and restore

Issue #93 (roadmap #15, parity row `data-export`). Reference: Super
Productivity 19.1.0 at `42ded9f31a132bf92633b0c78ad4ebf1d87c0f71`,
`src/app/imex` (JSON export, JSON import, automatic local backups and the
restore list). Builds on the server-side owner sessions and encrypted
connectors of ADR 0007, the import-once provenance of ADR 0014 and the operator
backup pair described in the README. Owner decision #94 excludes client-side
end-to-end encryption and third-party storage sync; this ADR does not add
either.

Before this change the only copy of an owner's Tadooer data was the operator
SQLite backup (`apps/server/src/cli.ts backup`, `deploy/backup.sh`). That
file is paired with the credential key, contains session and token digests
and encrypted connector secrets, and can only be restored by an operator with
container access. Replacing Super Productivity would have removed the owner's
self-service export.

## Source semantics (Super Productivity 19.1.0)

- **Export** writes the complete application state (`AppDataComplete`,
  including archives) as one JSON file. An anonymized variant replaces titles
  and notes with placeholders.
- **Import** reads a JSON file or a URL, validates it against the current
  model version, migrates older files, and replaces the local data after a
  confirmation dialog. There is no merge.
- **Automatic local backups** are written by the desktop shell; the restore
  list offers them for the same replace-style import.

## Decision

### Format

A **data export** is one JSON document with `format: "tadooer.data-export"`
and `version: 1`:

```json
{
  "format": "tadooer.data-export",
  "version": 1,
  "exportedAt": "2026-09-25T18:00:00.000Z",
  "source": {
    "instanceId": "…",
    "migrationCount": 36,
    "appVersion": "0.0.0",
    "appRevision": "…"
  },
  "owner": { "id": "…", "username": "…", "displayName": "…", "createdAt": "…" },
  "tables": { "projects": [{ "id": "…", "owner_id": "…", "…": "…" }], "…": [] },
  "excludedTables": ["web_sessions", "…"]
}
```

`tables` holds the owner's rows of every included SQLite table, one object per
row with the column names of the current schema and the stored values (text,
integer, real or null). Rows are ordered by primary key so two exports of the
same data are byte-identical apart from `exportedAt`. The export is a copy of
the server authority, not of the browser cache; local outbox entries that
have not synced are not in it.

The table inventory lives in `packages/persistence/src/data-export-store.ts`
and is tested against `sqlite_master`: every table is either included or
listed as excluded, so a new migration cannot add a table without a
disposition. This satisfies the #93 dependency that entities from #27, #38,
#41 and #42 are exported as they land.

**Included** (owner data): `owner_planning_preferences`,
`owner_notification_preferences`, `owner_preference_revisions`,
`owner_focus_preferences`, `owner_focus_reminder_state`,
`owner_application_preferences`, `owner_capture_preferences`, `projects`,
`tags`, `tasks`, `task_tags`, `task_field_versions`, `subtasks`,
`project_backlog_tasks`, `notes`, `task_templates`, `task_template_tags`,
`template_subtask_blueprints`, `template_sets`, `template_set_members`,
`template_instantiations`, `task_template_provenance`, `choice_pools`,
`choice_pool_items`, `template_pool_slots`, `planning_placeholders`,
`choice_pool_history`, `planning_placeholder_resolutions`, `habits`,
`habit_occurrences`, `task_import_sources`, `task_issue_links`,
`task_attachments`, `task_archive_provenance`, `task_historical_references`,
`recurring_series`, `recurring_occurrences`, `recurring_task_links`,
`time_entries`, `time_work_context_days`, `counters`, `counter_day_values`,
`daily_evaluations`, `plugin_data_entries`, `plugin_metadata_records`,
`day_orders`, `day_order_entries`, `boards`, `board_panels`,
`board_panel_tasks`, `task_board_markers`, `sections`, `section_tasks`,
`task_views`, `menu_folders`, `menu_folder_items`, `notification_deliveries`.

**Excluded**, with the reason:

| Tables                                                                                                                                                                                                         | Reason                                                                                                                                                                       |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `owner_accounts`                                                                                                                                                                                               | Only `id`, `username`, `display_name` and `created_at` appear under `owner`; `password_hash` and `disabled_at` never leave the database.                                     |
| `web_sessions`, `client_identities`                                                                                                                                                                            | Session and sync-client digests.                                                                                                                                             |
| `automation_tokens`, `automation_previews`, `automation_operation_outcomes`, `automation_audit_log`                                                                                                            | Token secret hashes and the records that reference tokens with `RESTRICT`. Assistant access is re-granted on the target.                                                     |
| `baikal_connectors`, `google_connectors`, `google_oauth_states`, `google_calendar_sync`, `google_calendar_capabilities`                                                                                        | Connector credentials encrypted with the instance credential key and provider cursors.                                                                                       |
| `calendar_providers`, `calendar_collections`, `calendar_event_projections`, `calendar_feed_capabilities`, `calendar_import_jobs`, `calendar_import_items`, `calendar_write_operations`, `task_calendar_blocks` | Projections of connector calendars and feed capability secrets; they are rebuilt by reconnecting. Tasks keep their `planned_start`.                                          |
| `calendar_subscriptions`, `calendar_subscription_events`, `calendar_subscription_hidden_events`, `calendar_subscription_conversions`                                                                           | The subscription address is encrypted with the credential key; a record without it cannot fetch. Subscriptions are re-created by hand, as after a Super Productivity import. |
| `calendar_bridge_mappings`, `calendar_bridge_links`, `calendar_bridge_outbox`, `calendar_bridge_conflicts`                                                                                                     | Bridge state (ADR 0041) refers to connector grants, provider event IDs and ETags that a restored installation does not share; the owner re-creates mappings after restore.   |
| `calendar_bridge_jobs`, `calendar_bridge_leases`                                                                                                                                                               | Bridge worker schedule and leases (ADR 0043); operational state rebuilt from the mappings.                                                                                   |
| `active_sessions`, `active_session_intervals`, `active_session_events`, `active_session_operation_outcomes`, `active_session_focus_plans`, `active_session_idle_dispositions`                                  | Live focus session state bound to a client identity. Finished work is in `time_entries`.                                                                                     |
| `sync_owner_state`, `sync_changes`, `sync_operation_outcomes`, `idempotency_records`, `habit_operation_outcomes`                                                                                               | Sync feed and idempotency caches. Restore starts a new sync epoch so every client resynchronizes.                                                                            |
| `install_metadata`, `schema_migrations`                                                                                                                                                                        | Instance identity and schema bookkeeping; the export records `source.instanceId` and `source.migrationCount` instead.                                                        |

### HTTP and web

- `GET /api/data/export` (owner session cookie only; automation bearer tokens
  are never consulted on this route) returns the document as a download.
- `POST /api/data/restore/preview` validates a document and returns counts
  per table, the target owner's current counts, whether the target is empty,
  whether the export owner and instance match, blocking issues and an
  `inputHash`. Nothing changes.
- `POST /api/data/restore/apply` needs the same session, same origin, the
  CSRF token, `X-Restore-Hash` equal to the previewed `inputHash` and
  `X-Restore-Mode`: `empty-only` refuses a target owner that already has
  content (409 `RESTORE_TARGET_NOT_EMPTY`); `replace` first deletes the
  owner's rows in every included table and the owner's live sessions, sync
  feed and idempotency caches. There is no merge mode: merging identities
  from two instances cannot be made duplicate-free without owner review of
  every conflict. Preference singletons are replaced in both modes. Bodies
  are limited to 64 MiB.
- Restore runs in one `BEGIN IMMEDIATE` transaction with deferred foreign
  keys. Rows are inserted in dependency order; `tasks` are inserted parents
  first, and `tasks.archived_at` and `counters.deleted_at` are written after
  all rows exist because the archive and counter triggers reject dependants of
  archived tasks and deleted counters. `owner_id` columns are rewritten to
  the target owner. Identifiers inside stored JSON (template instantiation
  snapshots) keep the exporting owner's id; the preview reports whether the
  ids differ.
- The document must have `version: 1` and `source.migrationCount` no greater
  than the target's applied migrations; a newer export is refused. Unknown
  tables or columns block the restore. An export from an older schema is
  accepted: missing columns take the defaults of later migrations, and when a
  later column has no default the restore fails and rolls back. Older-schema
  restores are not covered by tests yet.

### Relationship to operator backups

The operator backup pair (`deploy/backup.sh`: SQLite file plus credential
key) remains the disaster-recovery copy. It restores the whole instance,
including sessions, tokens, connectors and subscriptions, and requires the
matching credential key. The owner export is portable between instances and
credential keys, contains no secrets, and restores only the owner's content.
Both are documented in `docs/operations/tadooer-production.md`.

## Consequences

- Owners can move their Tadooer data to another instance or keep an
  independent copy without operator access.
- After a restore, connectors, iCal subscriptions, assistant tokens and sync
  clients are re-established on the target. The browser cache resynchronizes
  because the sync epoch changed.
- A future migration that adds a table fails the inventory test until the
  table is classified as included or excluded.
- The format is versioned; a breaking change bumps `version` and keeps a
  reader for version 1.

## Verification

- `packages/persistence/src/data-export.test.ts`: inventory covers
  `sqlite_master`, secrets never appear, round trip (export, fresh
  database, restore, export equality apart from documented fields), replace
  and empty-only semantics, sync epoch reset, deferred archived and deleted
  columns.
- `apps/server/src/data-export.test.ts`: owner-only access, download
  headers, preview and apply flow, hash and mode checks, size limit.
- `apps/web/src/components/settings/DataExportRestore.test.tsx`: rendering
  and the confirmation gate.
