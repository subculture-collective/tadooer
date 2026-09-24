# Super Productivity parity matrix

Issue [#17](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/17);
roadmap [#15](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/15).
Observed September 24, 2026. This inventory compares source capabilities. It
does not show that any imported workflow works, and it is not a replacement
readiness decision; those remain [#47](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/47)
and [#49](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/49).

`super-productivity-parity.json` holds the complete rows: Super Productivity
source path, Tadooer evidence and tests, data mapping, sync, UI and MCP notes,
and the covered export sections and fields.

## Pinned references

| Reference             | Pin                                                                                        |
| --------------------- | ------------------------------------------------------------------------------------------ |
| Upstream source       | `super-productivity/super-productivity` tag `v19.1.0`, commit `42ded9f31a13`               |
| Installed application | `~/.local/opt/super-productivity-19.1.0` on Kvant; the launcher and running process use it |
| Earlier custom fork   | `PatrickFanella/super-productivity` `a4d74ea32` (18.16.0); no longer running               |
| Export schema         | `crossModelVersion` 4.5, 19 sections, defined in `src/app/op-log/model/model-config.ts`    |
| Sample backup         | `2026-09-24_143032.json`, SHA-256 `088ea71fd1f8…`; bare data without the export envelope   |
| superproductivity-mcp | `PatrickFanella/super-productivity-mcp` `6dde7f75f1f7`; 55 catalog tools                   |

The September 20 backup qualification used the 18.16 custom build. The
application has since moved to upstream 19.1.0, so this matrix uses 19.1.0.

## Import dispositions

`packages/import-export/src/super-productivity-schema.ts` classifies every
19.1.0 export section and every task, project and tag field. The preview and
apply paths use those tables, so no export section is dropped without a report:

- **applied**: mapped into Tadooer records.
- **parity**: inventoried; apply is blocked with a parity finding (hierarchy,
  recurrence, time history, day-only plans, archives).
- **retained**: not applied, but kept in the import provenance JSON (icons,
  colours, themes, ordering, backlog flag).
- **blocked**: a populated value blocks apply (`unsupported_section` or
  `unsupported_import_data`).
- **configuration**: preferences and view setup (`globalConfig`, `menuTree`,
  `boards`, `planner`, `issueProvider`, `pluginMetadata`, counter definitions).
  Reported as `configuration_not_imported`; never applied and does not block.
- **ignored**: derived or view-only task state (`modified`, `hasPlannedTime`,
  `_hideSubTasksMode`, the leaked `subTasks` copy) and legacy project issue
  configuration, which can hold credentials.

Unknown sections (`unknown_section`), task fields (`unknown_task_field`) and
project/tag fields block apply until they are reviewed.

### September 24 backup

The read-only run of the updated importer against the sample backup produced
no unknown sections or fields. The export still cannot be applied:

- `metric`, `simpleCounter` recorded values, `timeTracking` and
  `pluginUserData` block as unsupported sections.
- Six configuration sections are reported.
- 73 unsupported-data findings, one per source: 49 live tasks with blocked
  fields (34 with linked issues and 19 with reminders; 4 have both), 22 tasks
  with day-only plans, the TODAY tag, and one finding for the archives.
- Integrity: 95 tasks appear both in the live store and in `archiveYoung`, and
  the live index repeats 28 IDs. The September 20 backup had neither. Resolve
  these in Super Productivity before a qualification import; the importer
  refuses to guess which copy is authoritative.

## Capability rows

Status counts: 2 supported, 18 partial, 20 gap, 1 owner decision, 1 excluded.

| Area          | Capability                                                                                                                                    | Status    | Tracking                                                                  |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ------------------------------------------------------------------------- |
| Tasks         | Create, edit, complete/reopen tasks with notes, estimate and deadline                                                                         | partial   | [#27](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/27) |
| Tasks         | Full child tasks: add, convert, move between parents, hide done/all children                                                                  | gap       | [#27](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/27) |
| Tasks         | Manual ordering, drag and drop, duplicate, multi-select bulk actions                                                                          | gap       | [#63](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/63) |
| Tasks         | Delete with confirmation and undo/restore                                                                                                     | supported | —                                                                         |
| Tasks         | Short syntax (+project, #tag, @date, !deadline, estimates, URLs), markdown and email paste                                                    | partial   | [#90](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/90) |
| Tasks         | File, link, image, command and note attachments                                                                                               | gap       | [#30](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/30) |
| Organization  | Project lifecycle: create, rename, icon, theme, hide, archive/unarchive, complete/reopen, delete                                              | partial   | [#28](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/28) |
| Organization  | Per-project backlog with move to/from regular list                                                                                            | gap       | [#28](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/28) |
| Organization  | Tags with colour, icon, theme, ordering; Urgent/Important system tags                                                                         | partial   | [#28](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/28) |
| Organization  | Standalone project notes: markdown, pin to Today, reorder, move                                                                               | gap       | [#28](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/28) |
| Organization  | Sidebar folders and ordering for projects and tags                                                                                            | gap       | [#67](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/67) |
| Planning      | Today list from day-only plans, plan tasks and deadline tasks for today, remove from Today                                                    | partial   | [#29](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/29) |
| Planning      | Schedule with date/time, per-task and deadline reminders, snooze, reminder dialog actions                                                     | partial   | [#29](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/29) |
| Planning      | Multi-day planner: drag between days, inline add, overdue column, repeat projections                                                          | partial   | [#29](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/29) |
| Planning      | Timeline with work hours, lunch break, calendar events, split tasks, drag to reschedule                                                       | partial   | [#58](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/58) |
| Recurrence    | Repeat configurations: daily/weekly/monthly/yearly, Nth weekday, pause, wait for completion, skip overdue, delete instance, subtask templates | gap       | [#42](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/42) |
| History       | Archive done tasks, view and restore archived tasks, young/old archive tiers                                                                  | gap       | [#38](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/38) |
| History       | Finish day summary, end-of-day notes, plan tomorrow, finish-day prompt                                                                        | gap       | [#41](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/41) |
| Time          | Track time per task and day, estimate overrun, round time, add time for another day, context work start/end/breaks                            | gap       | [#41](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/41) |
| Time          | Worklog/history by year, month, week; inline correction; CSV export                                                                           | gap       | [#41](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/41) |
| Focus         | Pomodoro, Flowtime and Countdown sessions with breaks, sounds and session logging                                                             | partial   | [#65](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/65) |
| Focus         | Idle detection with time assignment, take-a-break reminders, tracking reminder                                                                | gap       | [#65](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/65) |
| Views         | Boards with filtered panels, Eisenhower and Kanban defaults, drag between panels                                                              | gap       | [#63](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/63) |
| Views         | Named sections inside project and tag lists                                                                                                   | gap       | [#63](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/63) |
| Views         | Sort, group and filter task lists per context                                                                                                 | partial   | [#63](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/63) |
| Metrics       | Daily evaluation, focus session log, productivity and sustainability scores, charts                                                           | gap       | [#64](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/64) |
| Metrics       | Click counters, stopwatches, countdown reminders, habit streaks and weekly grid                                                               | partial   | [#64](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/64) |
| Integrations  | Issue providers (Jira, GitLab, GitHub, Gitea, Linear and others): search, backlog import, polling, two-way sync, Jira worklogs                | gap       | [#30](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/30) |
| Integrations  | Calendar subscriptions, events in planner/schedule, event-to-task, auto-import, hidden events, time blocks                                    | partial   | [#91](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/91) |
| Extensibility | In-app plugin runtime: install, enable, configuration, hooks, synced plugin data, UI injection                                                | gap       | [#66](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/66) |
| Settings      | Feature toggles, task, time-tracking, reminder, schedule, sound and misc preferences                                                          | partial   | [#67](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/67) |
| Settings      | About 60 configurable shortcuts plus desktop global shortcuts                                                                                 | partial   | [#67](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/67) |
| Settings      | Dark/light/system theme, custom themes, backgrounds, language, first day of week, locale                                                      | gap       | [#67](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/67) |
| Settings      | Onboarding presets and guided tour                                                                                                            | gap       | [#67](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/67) |
| Settings      | Tray, floating task widget, minimize to tray, custom title bar                                                                                | partial   | [#67](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/67) |
| Sync          | See and stop another device's active tracking                                                                                                 | supported | —                                                                         |
| Sync          | Multi-device sync through Dropbox, OneDrive, WebDAV, local file, Nextcloud or SuperSync, with optional end-to-end encryption                  | excluded  | [#94](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/94) |
| Sync          | Offline edits for every entity                                                                                                                | partial   | [#92](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/92) |
| Data          | Full JSON export/import, automatic local backups, restore, privacy export                                                                     | partial   | [#47](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/47) |
| Data          | User-facing export and restore of Tadooer data                                                                                                | gap       | [#93](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/93) |
| Assistants    | Local REST API, URL-scheme actions and the super-productivity-mcp tool catalog                                                                | partial   | [#32](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/32) |
| Mobile        | Android widget, foreground tracking notification, native reminders, quick actions                                                             | decision  | [#24](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/24) |

Follow-ups #90–#94 were created from this matrix on September 24.

## Drift check

`super-productivity-parity.test.ts` requires every reviewed section and field
to belong to exactly one row, the section count to match the pinned schema,
Tadooer evidence paths to exist, and every unsupported row to have a tracking
issue. A new Super Productivity field must be classified in the schema module
and assigned to a row before an import containing it can be applied.

## Exclusions

- Owner decision, September 24 ([#94](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/94)):
  client-side end-to-end encryption and sync through third-party storage
  (Dropbox, OneDrive, WebDAV, local file, Nextcloud, SuperSync) are not parity
  requirements. Tadooer keeps its self-hosted server sync.

## Remaining acceptance for #17

- Reconcile the matrix against real imported workflows under #47. Source parity
  evidence does not establish replacement readiness.
