# Super Productivity functional parity matrix

Issue #17. This is a versioned inventory and work map, not a migration-success or
replacement-readiness claim. Full real-data reconciliation remains #47 and reviewed
cutover remains #49. The source application and its backup files were read only.

## Reference identity

Re-pinned September 24, 2026, when the installed application had moved to the
upstream release. `deploy/verify-parity-reference.py` passed against these pins.

- Source: Super Productivity **19.1.0**, tag `v19.1.0`, commit
  `42ded9f31a132bf92633b0c78ad4ebf1d87c0f71`; model-config cross-model version **4.5**.
- Installed app (re-pinned September 25): the local plugin-actions build of
  upstream v19.1.0 at `~/.local/opt/super-productivity-19.1.0-plugin-actions`
  on Kvant, used by the launcher. It adds plugin allowlist changes for
  recurrence and issue providers and does not auto-update. `app.asar` SHA-256
  `edecae404cc8bb5eee67421bab258c1e294ba13e5e1dc003dfb85733f8f9b2ba`; the
  stock 19.1.0 artifact (`2133ce92…`) is the previous installed pin. An exact
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

| Workflow               | Current status | Source-data and behavior mapping                                                                                                                                                                                                                                                                                                                                                                    | Issue                                                                     |
| ---------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| core-tasks             | partial        | Core titles/notes/timestamps/dates/estimates map transactionally; unsupported metadata blocks apply. Source IDs remain provenance, not destination IDs.                                                                                                                                                                                                                                             | [#47](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/47) |
| hierarchy              | partial        | Children import as full two-level child tasks in source order; deeper chains block apply. Parent time totals are derived in the worklog (ADR 0024).                                                                                                                                                                                                                                                 | [#27](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/27) |
| projects               | partial        | Colour, icon, order, hide-from-menu, completion, restore and backlog are stored, edited and imported (ADR 0019); menu folders (#63) and in-project task order remain.                                                                                                                                                                                                                               | [#28](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/28) |
| tags                   | partial        | Colour, icon, order and archive/restore are stored and imported; Today and board system tags are never ordinary tags: TODAY is the day order (ADR 0027) and the others are board markers (ADR 0028).                                                                                                                                                                                                | [#28](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/28) |
| planning               | partial        | Today queue, timed blocks and date-only planned days exist (ADR 0020); saved Today and planner-day order, a day start and plan-tomorrow exist (ADR 0027); finish-day rituals, schedule hygiene and auto-planning remain.                                                                                                                                                                            | [#98](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/98) |
| history                | partial        | Both archive stores apply as read-only history with historical references, review flags and a collapse-or-block duplicate policy (ADR 0022).                                                                                                                                                                                                                                                        | [#38](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/38) |
| time                   | partial        | Focus intervals, imported daily totals and manual corrections form one worklog by day, week, task and project with CSV export (ADR 0024). Export rounding options, work start/end editing and idle handling remain.                                                                                                                                                                                 | [#41](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/41) |
| recurrence             | partial        | Repeat configurations import as recurring series with their rule, start time, reminder, completion anchor, wait-for-completion, skip-overdue, pause, child templates and deleted dates (ADR 0023). Instances link by occurrence date and are not regenerated. Habits are not used.                                                                                                                  | [#42](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/42) |
| notes                  | partial        | Project, tag and standalone Markdown notes with pin and order are stored and imported; image notes, legacy notes text and checklist/space workflows remain.                                                                                                                                                                                                                                         | [#28](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/28) |
| linked-issues          | partial        | One issue link per task (provider key, provider instance ID, issue ID, last-synced provenance; Gitea address rebuilt) and attachments import and are edited online (ADR 0021). Local files and commands stay inert; credentials are never read; live provider access needs fresh authorization.                                                                                                     | [#30](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/30) |
| reminders              | partial        | Per-task and timed-deadline reminder offsets use the ntfy ledger (ADR 0020); exact source offsets import. Legacy reminders section stays blocked.                                                                                                                                                                                                                                                   | [#29](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/29) |
| boards                 | partial        | Boards with filtered panels and manual order, sections in a project or tag, saved sort/group/filter views and nested sidebar folders are stored, edited and imported (ADR 0028). Drag-and-drop and Today-view sections remain gaps; the qualification import waits on #47.                                                                                                                          | [#63](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/63) |
| counters               | partial        | Counters and their day values import with provenance (counts, or stopwatch milliseconds); metric days import as daily evaluations, and their focus sessions stay evaluation history rather than time entries (ADR 0025). Streaks are derived, never imported. Not habits.                                                                                                                           | [#64](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/64) |
| focus                  | partial        | Focus preferences, Pomodoro/Flowtime/countdown presets with cycles, browser idle detection with an assign/break/discard correction, and countdown, break-end, take-a-break and tracking reminders through the notification ledger (ADR 0029). Focus globalConfig sections import once.                                                                                                              | [#65](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/65) |
| plugins                | partial        | Plugin data entries (plugin ID, key, opaque value, size) and enabled flags import as inert records that the owner lists, downloads and deletes (ADR 0026). No plugin code is imported or run; a plugin runtime needs an owner decision.                                                                                                                                                             | [#66](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/66) |
| preferences            | partial        | One revisioned application preferences record (theme, locale, start page, capture and completion defaults, reminder defaults, daily note, shortcut bindings) with an assistant read/update tool (ADR 0030). globalConfig is classified per field; safe settings import once, credentials and provider configuration never. Keyboard, onboarding and responsive qualification of every view remains. | [#67](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/67) |
| calendar               | partial        | Google/Baikal federation exists; plugin calendars and opt-in canonical bridge need qualification.                                                                                                                                                                                                                                                                                                   | [#50](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/50) |
| platforms              | decision-gated | PWA and Linux packaging exist; platform-specific native delivery requires explicit platform design.                                                                                                                                                                                                                                                                                                 | [#24](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/24) |
| presentation           | decision-gated | Store-rating prompts and engagement presentation are not migrated data; decide relevant product outcomes under post-parity discovery.                                                                                                                                                                                                                                                               | [#52](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/52) |
| capture                | partial        | Estimates, @date planned days, @every series, links per urlBehavior, consented tag creation and Markdown/email paste batches exist (ADR 0031); time-spent syntax, per-marker switches and .eml file drop are not mapped.                                                                                                                                                                            | [#90](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/90) |
| calendar-subscriptions | partial        | Read-only iCal subscriptions with scheduled refresh, planner projection, filters, one-task conversion, auto-import tombstones and hidden events (ADR 0032); exported ICAL providers are re-created by hand.                                                                                                                                                                                         | [#91](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/91) |
| offline-writes         | partial        | Only task core fields and habits queue offline; planned time/day, reminders, assignment, project/tag and checklist writes are online-only.                                                                                                                                                                                                                                                          | [#92](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/92) |
| data-export            | partial        | Owner export of every included table as one versioned JSON file, and a previewed restore with an explicit empty-account or replace choice (ADR 0034). Secrets, connectors and iCal subscriptions are excluded and re-created; operator SQLite backups remain the disaster-recovery copy. Anonymized export and automatic local backups are not ported.                                              | [#93](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/93) |
| sync-providers         | excluded       | Owner decision September 24: third-party storage sync and client-side end-to-end encryption are not parity requirements.                                                                                                                                                                                                                                                                            | [#94](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/94) |

## Import dispositions

`packages/import-export/src/super-productivity-schema.ts` classifies every export
section and every task, project, tag and note field. Each field belongs to
exactly one workflow row in the JSON manifest. The preview and apply paths use the tables, so
no section is dropped without a report:

- **applied**: mapped into Tadooer records.
- **parity**: inventoried; apply is blocked with a parity finding. Archived
  tasks apply since #38; see "Archived history" below. Repeat configurations
  apply since #42; see "Repeat configurations" below. Work history applies
  since #41; see "Work history" below. Counters and metric days apply since
  #64; see "Counters and daily evaluations" below.
  Hierarchy fields apply since #27, and a chain deeper
  than two levels blocks with `hierarchy_depth_unsupported`. Day-only plans
  (`dueDay`) and exact reminder offsets apply since #29; a reminder that is not
  an exact offset blocks.
- **retained**: not applied, but kept in the import provenance JSON (themes,
  task order inside projects and tags, note lock and background colour).
- **blocked**: a populated value blocks apply (`unsupported_section` or
  `unsupported_import_data`, one finding per record).
- **configuration**: `issueProvider`. Reported as
  `configuration_not_imported`; never applied and does not block. `globalConfig`
  applies per field since #65 and #67; see "Focus, idle and break settings" and
  "Application preferences" below.
- **ignored**: derived or view-only task state (`modified`, `hasPlannedTime`,
  `_hideSubTasksMode`, the leaked `subTasks` copy) and legacy project issue
  configuration, which can hold credentials.

Since #28 (ADR 0019), `note` and `menuTree` apply. `menuTree` supplies project
and tag order; since #63 (ADR 0028) its folders apply as sidebar folders, and
`boards` and `section` apply as boards and sections; see "Boards, sections,
views and folders" below. The `TODAY`, `EM_URGENT`, `EM_IMPORTANT` and
`KANBAN_IN_PROGRESS` system tags never become ordinary tags: TODAY is the
day order and the other three become board markers on the tasks that carry
them. Since #98 (ADR 0027), Today's task order and `planner.days` apply as
saved day orders; see "Today and planner-day order" below. Backlog or
`noteIds` entries that point at records missing from the export are reported
and skipped; entries that contradict the task's project block.

Since #30 (ADR 0021), `attachments`, `issueId`, `issueProviderId`,
`issueType` and `issueLastUpdated` apply; the other last-synced issue fields are
retained and copied into the link's opaque metadata. From `issueProvider` the
importer reads only provider `id` and key, plus a Gitea host and repository to
rebuild issue addresses; nothing from that section is stored. A link to a
provider absent from the export is kept and reported as
`issue_provider_missing` without blocking. Attachment fields are reviewed
separately (`attachmentFields` in the manifest); addresses with embedded
credentials block apply.

Since #91 (ADR 0032), the fields of `ICAL` issue providers are reviewed as
`calendarProviderFields`; they stay configuration and are not imported. See
"Calendar subscriptions" below.

Since #66 (ADR 0026), `pluginUserData` and `pluginMetadata` apply as inert
records: each value is kept as opaque text of at most 1 MiB, never decoded or
run, and each enabled flag is kept without enabling anything. Their fields are
listed as `pluginUserDataFields` and `pluginMetadataFields` in the manifest. A
malformed section or entry blocks with `plugin_data_invalid`; findings name
the plugin ID, never the value or key.

Unknown sections (`unknown_section`), task fields (`unknown_task_field`) and
project/tag/note fields block apply until they are reviewed.

Every finding carries `blocking`. Reported dispositions that do not block are
`configuration_not_imported`, `issue_provider_missing`,
`issue_metadata_orphaned`, `duplicate_child_reference`,
`duplicate_copy_collapsed`, `historical_reference`,
`historical_parent_detached`, `history_review`, the recurrence findings
`recurrence_notice` and `recurrence_duplicate_occurrence`, and the work history
findings `time_total_mismatch`, `time_parent_residual`, `time_parent_shortfall`,
`time_reconciliation`, `work_context_merged` and `work_context_historical`, and
the counter findings `counter_notice`, `counter_reconciliation` and
`metric_field_retained`, the plugin summary `plugin_data_preserved`, and the
focus setting report `focus_preference_notice`; any other code blocks.

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
with the parent kept as a historical reference. Archive `timeTracking` applies
since #41; unknown archive keys still block.

A read-only rerun on the September 24 backup maps 4,275 archived records
(1,778 young after 95 duplicates, 2,497 old). It keeps 5,369 historical
references: 1,100 projects and 2,930 tags missing from the export, 28 priority
markers, and 1,311 repeat configuration IDs (657 missing, 654 existing). Six
blank titles, one oversized note and two estimates are flagged for review.
32 duplicate copies collapse; 63 differ in `isDone`/`doneOn` and block. These
counts predate #42: the 654 references to existing repeat configurations now
link to recurring series instead of staying historical references.

### Repeat configurations (#42)

`taskRepeatCfg` applies as recurring series (ADR 0023). Every
`TaskRepeatCfgCopy` field is classified in `super-productivity-recurrence.ts`
(`repeatCfgFields` in the manifest):

- The rule, start date, pause, `repeatFromCompletionDate`,
  `waitForCompletion`, `skipOverdue`, notes, project, tags and default estimate
  apply. The Nth-weekday anchor wins over `monthlyLastDay`, and an incomplete
  anchor falls back to the start date's day, as in the source.
- `startTime` applies together with `remindAt`; without a reminder option the
  source creates date-only instances, so Tadooer does the same and reports
  `recurrence_notice`.
- `subTaskTemplates` become child task templates when `shouldInheritSubtasks`
  is on; otherwise they are reported and kept in provenance.
- `deletedInstanceDates` become deleted exceptions. `lastTaskCreationDay`, or
  the legacy `lastTaskCreation` read in the owner's zone, seeds the cursor.
- `order` and `disableAutoUpdateSubtasks` are retained; `quickSetting` is
  ignored.

Live and archived tasks whose `repeatCfgId` names an exported configuration link
to its series. The occurrence date comes from the deterministic
`rpt_<config>_<date>` ID, or from `created` in the owner's zone. Linked tasks
are never recreated. A second task for the same date is linked and reported
with `recurrence_duplicate_occurrence`. Any other unrepresentable option, such
as a missing start date, a weekly rule with no weekday, an unknown reminder
option or a priority tag, blocks with `recurrence_unmappable` for that
configuration. A missing configuration on an archived task stays a historical
reference; on a live task it still blocks.

A read-only mapping run on the September 24 backup maps all 49 configurations
without a blocking finding: 32 weekly, 7 daily, 8 monthly (3 on the start
date's day of month, 4 on an Nth weekday, 1 on the last day) and 2 yearly. 47 skip overdue dates, 2 wait for completion, 15
inherit child templates, and 6 have templates that are not inherited. 779
instance records across the live and archive stores reference existing
configurations; each has an occurrence date. This mapping run did not apply
the export, which stays blocked by the sections listed below.

### Work history (#41)

`timeSpentOnDay` values import as daily time entries in the owner's planning
zone; no interval is invented for them (ADR 0024). A task without children
imports each positive day. A parent imports only the part of a day its source
children do not explain, so no millisecond is counted twice. When `timeSpent`
disagrees with the days, the dated values are imported and the finding says
which case applies; undated time stays in import provenance. `timeTracking`
from the live state and both archives merges field by field (live, then
young, then old) and imports as read-only work start/end records. A day over
24 hours and malformed `timeTracking` block.

A read-only run on `2026-09-24_214032.json` imports 418 task-day entries
(2,050,100,402 ms) and one parent-own entry (3,001,982 ms) against a leaf
`timeSpent` total of 2,018,712,402 ms, plus 444 work-day records. The two
mismatches: an `archiveYoung` child with `timeSpent` 0 but 31,448,000 ms of
dated days, which its parent's days include; and an `archiveOld` task with
60,000 ms and no day, which is not imported. 164 work-day records belong to
projects or tags that are not imported and keep their source IDs. No time
finding blocks.

### Counters and daily evaluations (#64)

`simpleCounter` and `metric` apply (ADR 0025). Their fields are classified in
`super-productivity-counters.ts` (`simpleCounterFields` and `metricFields` in
the manifest):

- Counter definitions keep their kind, enabled and hidden state, icon, streak
  settings and countdown length. Positive `countOnDay` values import as day
  values in the owner's zone, with the source value kept for replay checks.
  Stopwatch values are milliseconds and may not exceed the day's length. `isOn`
  is running state and is only reported.
- Metric days import as daily evaluations: notes, the single reflection,
  impact, energy and remind-tomorrow. `focusSessions` stay on the evaluation
  as history; the same work is in `timeSpentOnDay`, so they never become time
  entries. `totalWorkMinutes`, `completedTasks` and `plannedTasks` are kept in
  provenance.
- A missing title, an unusable icon, a streak without a minimum, a repeated
  countdown (its timer is not ported) and a running counter are reported with
  `counter_notice`. Out-of-range or malformed values, more than one reflection
  and unreviewed fields block.

A replay adds nothing and keeps Tadooer edits; a later export may add days. A
changed source record, or a source day that meets a value recorded in Tadooer,
aborts the import. A read-only run on `2026-09-24_231032.json` maps 12 counters
(10 click, 1 stopwatch, 1 repeated countdown), 140 day values counting 209, and
80 metric days with 283 focus sessions (983,691,885 ms) that stay out of the
worklog. The only counter finding is one `counter_notice`.

### Today and planner-day order (#98)

`TODAY_TAG.taskIds` imports as the saved order of the owner's planning date
when the preview or apply runs, and `planner.days` as the order of each date
(ADR 0027). Only entries that name an imported, open, date-only task planned
for that date apply. Entries for missing tasks, and for timed, completed,
archived or differently dated tasks, are non-blocking `day_order_notice`
findings. An order is saved only for a date that has none, so a repeat import
keeps the owner's edits. A malformed planner or an unreviewed planner key
blocks. `startOfNextDayTime` is reported; since #67 it also imports as the
planning day start while planning preferences were never saved, otherwise set
the Tadooer day start first so Today's order lands on the same date.

The newest local backup (`2026-09-24_230532.json`, counts only) has 27 Today
entries: 20 completed and 7 open timed tasks, so none applies. Its six planner
dates are empty and its day starts at 03:00.

### Boards, sections, views and folders (#63)

`boards.boardCfgs` import as boards with ordered panels (ADR 0028). A panel
filter keeps its included and excluded tag lists with their all/any match
modes, project list (`[""]` means every project), done, scheduled and backlog
state, parents-only flag and sort; `EM_URGENT`, `EM_IMPORTANT` and
`KANBAN_IN_PROGRESS` in a filter become the `urgent`, `important` and
`in_progress` markers, and live tasks carrying those tags get the marker.
Legacy `projectId` and `sortByDue` are migrated as the source does on load.
A panel's `taskIds` become its manual order. `section` entities become
sections of a project or tag with their title, expanded flag and member
order; sections of the Today view have no Tadooer context and are reported.
`menuTree` folders become sidebar folders with their nesting.

Each board, section and folder is recorded once by source ID, so a repeat
import of the same bytes changes nothing and a changed source fails the whole
import. Panel orders, section members and folder items resolve through the
batch's task, project and tag IDs; references to records missing from the
export, archived tasks, unknown tags or projects in a filter, unknown state
codes and unknown sort fields are non-blocking `board_notice` findings and
are dropped, as the source itself tolerates them. An unreviewed field, a
missing title, a `contextType` other than `PROJECT` or `TAG`, or a filter that
both includes and excludes the same tag or marker blocks apply. The source's
task-view customizer keeps its sort, group and filter settings in browser
localStorage only, so they are not in the export and are not imported.

The newest local backup (September 25, counts only) has 2 boards with 7
panels, every panel filter built from system tags, 0 sections and project
folders nested two levels deep. A read-only importer run on that backup has
not been recorded; the qualification import remains #47.

### Focus, idle and break settings (#65)

The focus sections of `globalConfig` (`pomodoro`, `flowtime`, `focusMode`,
`idle`, `takeABreak`, the tracking-reminder keys of `timeTracking` and
`sound`) are classified in `super-productivity-focus.ts` (`focusConfigFields`
in the manifest). Applied keys overlay the Tadooer defaults as the owner's
focus preferences the first time an export is imported while the record has
never been saved; the record keeps the export hash, the import instant and
the applied key names, and a later import never overwrites an edit. Source
milliseconds become whole minutes within the preference limits. Retained keys
(preparation screen, sounds, keep-tracking-during-break, Pomodoro overtime,
lock screen, full-screen blocker, motivational images, per-channel reminder
switches) are reported by name with `focus_preference_notice` and stay in the
export. The other `globalConfig` sections are the application preferences
mapper's (#67), which neither reads nor reports the focus sections.

### Application preferences (#67)

`globalConfig` is classified per section and field in
`super-productivity-config.ts` (ADR 0030): applied, transform (units, IDs and
option names converted), excluded (credentials, sync providers, desktop
window and tray state, device paths, wallpaper, deprecated copies,
transient bookkeeping), delegated to the focus mapper (#65: `pomodoro`,
`flowtime`, `focusMode`, `idle`, `takeABreak`, `sound` and the tracking
reminder keys of `timeTracking`) or deferred with an owner (capture syntax
and notes template #90; feature toggles; keyboard keys without a Tadooer
action). Mapped settings become the
application preferences record, and `schedule` and `startOfNextDayTime`
become planning preferences, each applied once while the owner has never
saved those preferences; a repeat import changes nothing. Findings carry
section names and counts, never values: `config_applied` summarises what
applies, `config_field_excluded` counts fields whose values are never read,
and `config_field_retained` counts deferred, unreviewed and unusable fields.
Configuration never blocks. Nine of the 60 source `keyboard` keys map to
Tadooer actions; a binding that collides with another is reported and kept
in the export. Dark or light mode is device-local in the source and absent
from exports, so the theme is never imported.

### Calendar subscriptions (#91)

Super Productivity keeps iCal calendars as `issueProvider` entries with
`issueProviderKey: "ICAL"`. That section is configuration: the importer reads
only a provider's `id` and key for linked issues, and `icalUrl` routinely
embeds a private token, so subscriptions are not imported. Their fields are
reviewed as `calendarProviderFields` in the manifest
(`super-productivity-calendar.ts`), each with the Tadooer subscription setting
it corresponds to: `checkUpdatesEvery` (milliseconds) to
`refreshIntervalMinutes`, `isAutoImportForCurrentDay` to `autoImport`,
`isReferenceCalendar` to `referenceOnly`, `filterIncludeRegex` and
`filterExcludeRegex` to the include and exclude patterns, `color` and `icon`
to the same names. `showBannerBeforeThreshold`, `isDisabledForWebApp` and the
generic issue-provider fields have no equivalent. The owner re-creates each
subscription under Connections with the address entered once (ADR 0032).

### September 24 backup (19.1.0)

A read-only run of the updated importer found no unknown sections or fields. The
export still cannot be applied:

- No section blocks as unsupported any more: `timeTracking` applies since #41,
  `metric` and `simpleCounter` since #64 (read-only run on
  `2026-09-24_231032.json`) and plugin data since #66 (read-only run on
  `2026-09-24_224532.json`: one 61-byte `brain-dump` entry and six enabled
  flags, no blocking finding). `globalConfig` applies per field since #67;
  `boards` and `issueProvider` are still reported as configuration.
- 73 unsupported-data findings, one per source: 49 live tasks with blocked fields
  (34 with linked issues and 19 with reminders; 4 have both), 22 tasks with
  day-only plans, the TODAY tag, and one finding for the archives. Since #98
  the TODAY tag's order is reported as notices instead.
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
2. #41 work history requires full source-child semantics; preserve old missing
   references and explicitly reconcile mismatched totals. #42 recurrence maps
   repeat configurations and links their history (ADR 0023).
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
