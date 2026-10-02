---
status: accepted
---

# Work history: time entries, corrections and worklog reports

Issue #41. Tadooer records focus intervals from the active session (ADR 0010)
but had no daily history, no way to correct tracked time and no reports. Super
Productivity 19.1.0 keeps its work history as daily totals per task and as
daily work start/end records per project and tag. Until now the importer
blocked every export with tracked time. This decision adds time entries,
manual correction, worklog reports and the import of that history. It also
settles the parent time totals that ADR 0018 deferred.

## Source semantics (Super Productivity 19.1.0)

Read from `src/app/features/time-tracking`, `features/tasks/store`,
`features/worklog`, `features/archive` and `core/date/date.service.ts`:

- **Daily totals.** `timeSpentOnDay` maps a date string to milliseconds. Each
  tracking tick adds its duration to the key `todayStr()`: the device's local
  calendar date of `now` minus the start-of-next-day offset. No time zone and
  no time of day are stored, so a key is a floating local date.
  `timeSpent` is recalculated as the sum of the days.
- **Parent aggregation.** A parent's `timeSpentOnDay` is recalculated as the
  sum of its children's, day by day, and its `timeSpent` as their total. When
  a first subtask without time is added, it takes over the parent's days; when
  the last subtask is removed, its days can be copied back to the parent. In a
  consistent export a parent therefore has no time of its own. The worklog
  counts only tasks without subtasks toward day, month and year totals.
- **Work context records.** `timeTracking` maps `project` and `tag` IDs to
  dates. Each day holds `s` (first tracked minute), `e` (last tracked minute),
  `b` (break count) and `bt` (break milliseconds). Every tick updates the
  task's project, its tags and the `TODAY` tag, so the `TODAY` record spans the
  whole working day.
- **Archive flow.** The live state keeps only today's context records; the
  daily finish moves older days to `archiveYoung.timeTracking`, and the
  young-to-old flush moves all of them to `archiveOld.timeTracking`. Readers
  merge the three field by field: live first, then `archiveYoung`, then
  `archiveOld`. Archived tasks keep their own `timeSpentOnDay`.
- **Worklog export.** The source offers CSV with configurable columns,
  grouping and rounding of work, start and end times.

Imported daily totals and Tadooer focus time are different kinds of fact. A
focus interval has exact server instants and belongs to one session. An
imported value is only "this much time on this date"; turning it into an
interval would invent a start and end that were never recorded.

## Decision

### Time entries and their sources

A **time entry** is a task's tracked time on one owner-zone calendar day. It
has one of three sources:

- `focus`: a focus interval of the active session, split at the owner's local
  midnights. Nothing is copied: reports read `active_session_intervals` and
  split them on read. The session stays the only authority for focus time, and
  a focus entry cannot be edited or deleted through time entries.
- `import`: a Super Productivity daily total with its provenance (source task
  ID, source date, store, and whether it is a task day or a parent's own time).
- `manual`: a daily total the owner adds. It may be negative, as a correction.

Migration `0028_time_history` adds `time_entries` for import and manual
entries: owner-scoped, UUID, date, milliseconds, note (500 characters),
revision and import provenance. A partial unique index on the import identity
prevents a second copy of the same source day. `time_work_context_days` keeps
the imported work start/end records.

Days are calendar dates in the owner's planning time zone (ADR 0020). A focus
interval that crosses midnight contributes to both days; on daylight-saving
days in America/Chicago the day is 23 or 25 hours long. Imported date keys are
taken as owner-zone dates as they are. The source never recorded the zone, so
no conversion is attempted.

### Rules for manual writes

- Only active tasks accept writes. Time on archived history and on deleted
  tasks is read-only; SQLite triggers reject changes to entries of an archived
  task.
- A manual entry is a nonzero whole number of milliseconds within one day. An
  edited import entry stays positive and keeps its provenance.
- After every write, each affected task-day total (focus, import and manual)
  stays between 0 and 24 hours (`TIME_ENTRY_DAY_NEGATIVE`,
  `TIME_ENTRY_DAY_FULL`).
- While a focus interval on the task is running on that day, a write that
  lowers the day is refused (`TIME_ENTRY_FOCUS_RUNNING`). The running amount is
  not final. Adding time is allowed.
- Edits and deletes require `If-Match` with the entry revision; a stale
  revision is `412 TIME_ENTRY_REVISION_CONFLICT`. A create carries a
  client-chosen UUID, so a retry with the same content replays and a different
  entry with that ID is `409 TIME_ENTRY_EXISTS`.

Because daily totals have no time of day, a manual entry cannot be checked for
overlap with a focus interval. Overlap is bounded only by the 24-hour
task-day total. Reports show focus, import and manual time separately.

### Reports

`GET /api/time/report?from=&to=` covers at most 366 owner-zone days:

- **Days** with every entry, per-task totals split by source and, when
  imported, the day's work start, end and breaks. The `TODAY` record is used
  when present; otherwise the earliest start, latest end and largest break
  record of the day's project and tag records.
- **Weeks** starting on Monday, with days worked.
- **Tasks**: own time in the range, children's time in the range and all-time
  own plus children's time. Parent time is derived on read and never stored,
  so no millisecond is counted twice. Own estimate and a rollup of own plus
  children's estimates sit next to the spent time.
- **Projects**: each task's own time under its own project, with the sum of
  those tasks' estimates.

Soft-deleted tasks are left out; archived history is included. The browser
exports a basic CSV with one row per task and day: date, task, parent,
project, `h:mm`, decimal hours, exact milliseconds, estimate and sources.
Text cells that start with `=`, `+`, `-`, `@`, tab or carriage return are
prefixed with an apostrophe. Rounding and grouping options are not ported.

### Sync and offline policy

Time entries and work context records are online HTTP records. They are not in
the sync change feed or the offline cache, and the browser does not queue
them offline. Focus time already reaches every client through the active
session; a second, synced copy would create the duplicate intervals this
decision avoids. The Worklog view and its edits are disabled offline.

> Note, 2026-10-02: superseded for stored entries by
> [ADR 0050](0050-day-orders-and-time-entries-in-the-sync-feed.md). Import
> and manual entries are sync feed records; the snapshot and the offline
> cache hold a rolling 90-day window of them, and the Worklog shows them
> and queues create, patch and delete without a connection. The rules
> above are checked when the server applies a queued write; a refusal is a
> visible conflict with its reason. Focus time stays a projection of the
> session, exactly as decided here, and the report with focus time, work
> context records and older history stay online.

### Super Productivity import

Every tracked millisecond is imported once:

- A task without children imports each positive `timeSpentOnDay` value as a
  `task_day` entry. Zero days carry no time and are skipped.
- A parent imports only the part of each day that its source children do not
  explain, as a `parent_residual` entry, reported as `time_parent_residual`.
  Children include those imported at top level because their parent is in the
  other lifecycle, since the parent's days still contain their time. When the
  children exceed the parent on a day, the parent adds nothing and
  `time_parent_shortfall` is reported.
- When `timeSpent` differs from the sum of the days, the dated values are
  imported: they are the only record with a date. `time_total_mismatch`
  explains which case applies. Undated time is not imported and stays in the
  task's import provenance, which now includes `timeSpent` and
  `timeSpentOnDay` when they hold time. Tasks without tracked time keep the
  provenance hash of earlier imports.
- One `time_reconciliation` finding compares leaf `timeSpent`, dated leaf
  time and the imported totals. Milliseconds are kept exactly; there is no
  rounding.
- A day value over 24 hours blocks (`time_day_exceeds_day`), as do malformed
  `timeTracking` records (`invalid_time_tracking`) and unknown keys.
- `timeTracking` from the live state and both archives merges field by field
  in the source's priority order (`work_context_merged` counts overlaps). The
  `TODAY` tag becomes the day context. Records of projects, tags or board
  markers that are not imported keep their source ID and appear only by day
  (`work_context_historical`).

These findings do not block. `time_history_parity_required` is removed.
Entries are written in the import transaction for newly created tasks only,
before archived tasks are marked archived. A replayed export adds no time. A
changed work context record in a later export aborts the import, as a changed
task does.

### Assistant

`time.report` is a `tasks:read` resource with the report above.
`time_entries.mutate` (`tasks:write`) adds, edits or deletes an import or
manual entry. The preview names the task, date and resulting day total, and
freezes the entry revision, or the task revision and new entry ID for an
addition. Confirmation checks the day total and running focus again.

## Evidence

A read-only run of the importer on the September 24 backup
(`2026-09-24_214032.json`, 4,092,223 bytes):

- Leaf `timeSpent`: 2,018,712,402 ms (560.75 h). Dated leaf time:
  2,050,100,402 ms.
- Imported: 418 task-day entries (2,050,100,402 ms) and one parent-own entry
  (3,001,982 ms, an `archiveOld` parent whose single day exceeds its child's),
  2,053,102,384 ms in all, plus 444 work start/end records.
- Two `time_total_mismatch` findings. An `archiveYoung` child has
  `timeSpent` 0 but two days totalling 31,448,000 ms; its parent's days
  include that time, so the days are imported. An `archiveOld` task has
  `timeSpent` 60,000 ms and no days; that minute is not imported.
- 164 work-day records belong to projects or tags that are not imported. No
  time finding blocks. The export still cannot be applied for the reasons
  listed in the parity inventory (duplicates, recurrence, other sections).

## Consequences

- Parent totals (ADR 0018) are derived in reports. Stored parent time exists
  only where the source recorded time the children do not explain.
- Date keys recorded on a device in another zone are shown as owner-zone
  dates. The source kept no zone to correct them with.
- Work start/end records are imported and read-only; there is no editor.
- According to its source, Super Productivity's archive compression adds each
  removed subtask's days to its parent, whose days already include them. An
  export compressed that way has doubled parent time that the importer cannot
  detect.
- A running focus session can later push a task-day past 24 hours when manual
  time was added during it; the limit is checked at write time.
- Time entries are not in a self-service data export yet (#93).
