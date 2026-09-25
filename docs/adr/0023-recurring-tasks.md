---
status: accepted
---

# Recurring tasks

Issue #42. Super Productivity 19.1.0 repeats tasks through `taskRepeatCfg`
records. The September 24 backup holds 49 of them, and about 750 distinct live
and archived tasks are their instances. Until now the importer blocked any export with a repeat
configuration. This decision adds recurring series to Tadooer and defines how
the source configurations and their history import. Habits (ADR 0012) stay a
separate feature and are not used for this.

## Source semantics (Super Productivity 19.1.0)

Read from `src/app/features/task-repeat-cfg`:

- A configuration has a cycle (`DAILY`, `WEEKLY`, `MONTHLY`, `YEARLY`),
  `repeatEvery`, weekday flags, a `startDate`, and for monthly rules either an
  Nth-weekday anchor (`monthlyWeekOfMonth` plus `monthlyWeekday`), a last-day
  flag, or the start date's day of month. Weekly blocks start on the start
  date. Days past a month's end clamp to its last day.
- `getNewestPossibleDueDate` returns the newest occurrence after
  `lastTaskCreationDay` and on or before today. One instance is created per
  configuration per check, never one per missed date. With `skipOverdue` a
  past target only advances `lastTaskCreationDay`.
- Instance IDs are `rpt_<config>_<date>`; the check skips a date that already
  has an instance or is in `deletedInstanceDates`.
- `waitForCompletion` holds the next instance while any live or archived
  instance is open. `repeatFromCompletionDate` moves `startDate` and
  `lastTaskCreationDay` to the completion day of the newest instance.
- `startTime` schedules the instance only together with a `remindAt` option;
  without one the instance gets a due day. `subTaskTemplates` become subtasks
  when `shouldInheritSubtasks` is on.

## Decision

### Series and occurrences

A **recurring series** is an owner-scoped record holding a task template
(title, notes, project, tags, estimate, child templates) and a rule (cycle,
interval, weekdays or monthly anchor, start date, optional end date, optional
start time and start reminder). An **occurrence** is one date the rule
produces. A materialized occurrence is an ordinary task, called an instance,
linked to the series by (series ID, occurrence date).

Rule semantics follow the source: weekly blocks start on the anchor date;
monthly day-of-month dates clamp to the month's end; Nth weekday allows the
first to fourth or last weekday; February 29 falls on February 28 in common
years. An occurrence never precedes the start date or follows the end date.

### Time zone and instance dates

Occurrence arithmetic uses calendar dates only. The owner's IANA planning zone
decides which date is today and turns a start time into an instant, read when
the instance is created. Without a start time, the instance gets the
occurrence date as its planned day. With one, it gets a planned start at that
local time and the series' start reminder (ADR 0020 keeps the two exclusive).
Across daylight-saving changes the wall-clock time stays fixed. A time that a
spring-forward gap skips moves forward by the gap (02:30 becomes 03:30 in
America/Chicago); a time repeated when clocks fall back resolves to the first,
earlier instant. Changing the planning zone affects instances created later,
not existing ones.

### Generation

One generation pass handles every active series of the owner, at most 500
series and at most one instance per series:

1. For a completion-anchored series, if the newest linked instance was
   completed on an owner-local date later than the anchor, the anchor and the
   cursor move to that date. Reopening does not move them back.
2. The target is the newest occurrence after the cursor, on or before today,
   and not before the series' floor date.
3. If the target already has a ledger row (an instance, a skip or a deletion),
   the cursor advances and nothing is created.
4. With wait-for-completion, an open linked instance (active or archived, not
   deleted) stops the pass; the cursor does not advance.
5. A target before today under the `skip` missed-occurrence policy only
   advances the cursor. Otherwise the instance and its child tasks are created
   and the cursor advances.

**Missed occurrences.** However long the server was down, a pass creates at
most one instance per series: the newest missed occurrence (`latest`, the
source default) or none unless today is an occurrence (`skip`, from
`skipOverdue`). Older missed dates are never materialized.

**Floor date.** Creating a series, changing its schedule and resuming it set
the floor to that owner-local day, so none of these writes creates an instance
dated before the day it happened. Import leaves the floor empty, so an imported
series catches up like the source after downtime.

**Trigger.** Generation runs server-side at the start of the reminder tick
(every 60 seconds, and once at startup), before reminders are reconciled, so a
new timed instance is scheduled in the same tick. Series create, edit and
resume run a pass in the same transaction. Completing an instance does not run
a pass; wait-for-completion and completion-anchored series create their next
instance on the next tick.

**Identity and concurrency.** `recurring_occurrences` has the primary key
(series, occurrence date) and states `generated`, `imported`, `linked`,
`skipped` and `deleted`. A pass claims the ledger row before creating the task
and runs in a `BEGIN IMMEDIATE` transaction, so a second connection waits for
the write lock and then sees the claimed row. A pass that fails midway rolls
back its ledger row, tasks and cursor together; the next pass retries. A
restart resumes from the stored cursor. The instance task also uses the
idempotency key `recurrence:<series>:<date>`.

### Templates and child tasks

Child templates create child tasks (ADR 0018) under each new instance, with
their own title, notes and estimate and the series project. They are not
checklist items: source subtask templates carry notes and estimates, which the
checklist cannot hold. Instance edits never flow back into the templates.

**Propagation.** A template edit to title, notes, estimate, project or tags
updates open, active (not archived) instances whose current value still equals
the previous template value. An instance the owner has already customized keeps
its value, and completed and archived instances never change. Each updated
field goes through the normal conditional task write, so it bumps the
instance revision and reaches the sync feed. Schedule edits (rule, dates,
anchor, start time) never move existing instances; they apply to later
occurrences from the new floor date. Child templates apply to new instances
only.

### Occurrence operations

- **Skip** records a `skipped` exception for an occurrence after the cursor.
  **Unskip** removes it. A processed date (on or before the cursor) returns
  `409 RECURRENCE_OCCURRENCE_PROCESSED`.
- **Delete instance** soft-deletes the active instance of a date, with its
  children, and marks the ledger row `deleted`, so the date is never
  recreated. A running focus session or calendar block blocks it
  (`RECURRENCE_INSTANCE_BLOCKED`). Deleting an instance through the ordinary
  task delete also keeps its ledger row, so that date is not recreated either.
- **Complete** is the ordinary task completion. Completing twice, or reopening,
  never creates another instance for the same date.
- **Pause** stops generation; **resume** sets the floor to today, so dates
  inside the pause are not backfilled. **End** is permanent: an ended series
  accepts no edits or skips and generates nothing; its instances stay.

A series is never hard-deleted. An existing top-level task can start a series
(`sourceTaskId`): it becomes the instance for the first occurrence on or after
today, and its fields are unchanged.

### Interfaces and sync policy

- HTTP (owner session, CSRF, online-only): `GET /api/recurring-series`,
  `POST /api/recurring-series` (Idempotency-Key),
  `PATCH /api/recurring-series/:id`, `POST /api/recurring-series/:id/state` and
  `POST /api/recurring-series/:id/occurrences/:date`, each write with
  `If-Match` on the series revision. A series response carries its next five
  occurrence dates with skip flags, its exceptions and its instance count.
- Sync: series are not in the sync feed or the offline cache. Instances are
  ordinary tasks: creation, propagation and deletion append task changes, and
  a task payload carries `recurrence: { seriesId, occurrenceDate }`. Linking an
  existing task re-sends it without a revision bump.
- Web: the Tasks page has a series manager (state, upcoming dates with skip and
  restore, edit) and, on each task, either the instance's occurrence with
  "Delete this occurrence" or a "Repeat this task" form. Both are disabled
  offline.
- Assistant: `recurrence.list` (resource, `tasks:read`) and
  `recurrence.create`, `recurrence.update`, `recurrence.set_state` and
  `recurrence.occurrence` (tools, `tasks:write`). A preview freezes the series
  revision; deleting an instance also freezes that task's revision. A browser
  edit after the preview makes confirmation stale.

Storage: migration `0027_recurring_tasks` adds `recurring_series`,
`recurring_occurrences` and `recurring_task_links`.

### Super Productivity import

- Configurations map field by field (`superProductivityRepeatCfgFields`). The
  Nth-weekday anchor wins over `monthlyLastDay`; an incomplete anchor falls back
  to the start date's day. `remindAt` maps to a start reminder offset
  (`DoNotRemind` to none). `startTime` without `remindAt` imports as a
  date-only series, as the source behaves, with a non-blocking
  `recurrence_notice`. Templates apply only with `shouldInheritSubtasks`.
  `deletedInstanceDates` become deleted exceptions. `isPaused` imports as
  paused. `repeatFromCompletionDate` sets the completion anchor, starting from
  `lastTaskCreationDay`.
- `lastTaskCreationDay`, or the legacy `lastTaskCreation` in the owner's zone,
  seeds the cursor. Every linked instance date also raises the cursor, so
  imported history is never regenerated.
- Live and archived tasks with the `repeatCfgId` of an exported configuration
  link to the series. The occurrence date is the date in a `rpt_<config>_<date>`
  ID, otherwise `created` in the owner's zone. The first task for a date owns
  the ledger row; another task for the same date is linked as history and
  reported as `recurrence_duplicate_occurrence`. A child task with a
  `repeatCfgId` blocks.
- An archived task whose configuration is absent keeps a `missing_from_export`
  historical reference (ADR 0022); a live one still blocks. `repeatCfgId` is
  kept in task provenance only when it links, so the provenance hash of history
  imported before this decision is unchanged. The `recurrence_unsupported`
  reason remains only on records imported earlier.
- Options that cannot be represented block with one `recurrence_unmappable`
  finding each: a missing start date, an interval outside 1 to 366, a weekly
  rule with no weekday, an unknown reminder option, an estimate that is not
  whole minutes up to 720, priority or board tags, missing projects or tags,
  malformed templates or dates, and unreviewed fields. `order` and
  `disableAutoUpdateSubtasks` are retained in provenance; `quickSetting` is
  ignored.
- Series identity uses `task_import_sources` with entity kind `repeat_config`;
  a repeated import creates nothing, and a changed configuration fails with
  `IMPORT_SOURCE_CHANGED`.

## Consequences

- The September 24 backup's 49 configurations map without a blocking finding
  in a read-only mapping run. The export as a whole remains blocked by time
  history, counters and the other sections in the parity inventory.
- An instance is at most 60 seconds late after its day starts, after a
  completion that releases wait-for-completion, or after a completion that
  moves a completion anchor.
- Future occurrences are not projected into Today or the Planner; the series
  manager lists the next five dates. Moving a single occurrence to another date
  is done by editing the instance task, which keeps its occurrence identity.
- Series writes need a connection. Instances follow the existing task sync and
  offline rules.
- Imported series with `skipOverdue` (47 of 49 in the backup) create no
  catch-up instance after downtime; the other two create the newest missed one.
