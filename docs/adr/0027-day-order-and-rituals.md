---
status: accepted
---

# Saved day order, day start and plan-tomorrow

Issue #98, split from #29 (ADR 0020). Builds on the full-list reorder
convention of ADR 0019 and the planned day of ADR 0020.

Before this change, Today was derived from dates only: date-only tasks were
sorted by ID and nothing could change that order. Super Productivity 19.1.0
keeps a manual order for Today and for each planner day, can start a new day
after local midnight, and offers plan-for-tomorrow and finish-day flows. The
importer blocked every export whose Today tag had a task order.

## Source semantics (Super Productivity 19.1.0)

- `TODAY_TAG.taskIds` stores only the order of the Today view. Membership is
  derived from `dueDay` and `dueWithTime` (ADR 0020). The export records no
  date for this order: it is the order of whatever day was "today" in the app
  when the export was written.
- `planner.days` maps a date to the ordered task IDs of that day. A cleanup
  action deletes today's and earlier dates, so the map holds future days.
  `addPlannedTasksDialogLastShown` is dialog bookkeeping.
- `globalConfig.misc.startOfNextDayTime` ("HH:MM") moves the day boundary:
  `isTodayWithOffset` subtracts that many milliseconds from an instant before
  taking its local date.
- Add-tasks-for-tomorrow pulls tomorrow's planned tasks into today. The daily
  summary (finish day) reviews tracked time, archives done tasks and offers to
  plan the next day.

## Decision

### Day order

A **day order** is an owner-scoped record per calendar date: a revision and a
list of task IDs (`day_orders`, `day_order_entries`, migration
`0031_day_order`).

- **Members** of a date are the open, active (not deleted or archived) tasks
  with no planned start and a planned day equal to that date. Membership is
  always derived from task dates; the order only sorts.
- **Reading** returns every current member: saved IDs that are still members
  in their saved order, then the other members in the derived order (task ID).
  Saved IDs that stopped being members are ignored. The revision is 0 until
  the first save.
- **Reordering** is a full-list write, as in ADR 0019: the request carries the
  expected revision and every current member exactly once. A stale revision,
  a missing or extra ID, or a duplicate returns
  `412 DAY_ORDER_CONFLICT` and changes nothing. A successful write stores
  exactly the current members and increases the revision by one. Resubmitting
  the saved order with the current revision is a no-op and keeps the
  revision; replaying an earlier request after it succeeded is stale.
- **Tasks leaving the day** (completed, rescheduled, given a start time,
  deleted or archived) never cause an error. They are ignored when read and
  removed by the next write of that date. Hard-deleted tasks cascade away. A
  task that returns before that write regains its saved rank; after it, it
  joins at the end in the derived order.

Today's order is the day order of the owner's current planning date. Today
keeps its sections: overdue, scheduled today and unscheduled work keep their
time or ID order, and the saved order applies to "Planned for today". The
Planner sorts each day's all-day lane by the same order.

### Day start

The planning preferences gain an optional `dayStartsAt` ("HH:MM", default
"00:00"), the Tadooer form of `startOfNextDayTime`. Before that local time the
previous date is still today. It is wall-clock based: at 02:00 local with
`dayStartsAt` 04:00 the planning date is yesterday, on daylight-saving change
days as on any other. A day start that does not exist on a spring-forward day
begins at the first instant after the gap. The window of scheduled-today work
runs from the day start to the next day start, so it is 23 or 25 hours long
across a change.

The day start changes what "today" and "tomorrow" mean for the Today queue,
plan-tomorrow, the default date of `day_order.get` and the Today order date
of an import. Planner columns, planned days, reminders, the calm day plan and
work history keep calendar dates and local midnight. A client that omits
`dayStartsAt` keeps the saved value, so older clients cannot reset it.

### Plan tomorrow and finish day

`POST /api/day-orders/{date}/tasks` plans up to 50 tasks for a date in one
transaction. Each task carries its revision. Each task's planned day becomes
the date (which clears a planned start, ADR 0020), and the tasks are placed
after the date's other members in request order. A stale day-order or task
revision returns 412, a task with a calendar block returns
`409 TIME_BLOCK_REMOVE_REQUIRED`, and a completed or inactive task returns
`409 DAY_PLAN_TASK_INVALID`; any failure rolls back every task. Today shows a
"Plan tomorrow" panel: tomorrow's current order with move controls and a list
of open, untimed tasks to add in the order they are picked.

Finish-day rituals (daily summary, archive-done, tracked-time review) are
deferred to #52. Work history (#41, ADR 0024) already supplies the reports
such a ritual would use.

### API, UI and sync policy

- `GET /api/day-orders?from=&to=` (at most 62 days) returns dates with members
  or a saved order. `GET` and `PUT /api/day-orders/{date}` read and reorder
  one date. Writes need the session CSRF token.
- Day orders are online-only. They are not in the sync change feed or the
  offline cache. Offline, Today and the Planner show the derived order and the
  move and plan controls are disabled. The browser reads the orders again when
  a shown date's local members change. A 412 reloads the orders and asks the
  owner to try the move again. Queued offline planning remains #92.

  > Note, 2026-10-02: superseded by
  > [ADR 0050](0050-day-orders-and-time-entries-in-the-sync-feed.md). Saved
  > day orders are sync feed records in the offline cache. Today, plan
  > tomorrow and the Planner read them from the cache and reorder through
  > the outbox with `day_order.reorder`, with or without a connection. A
  > reorder of a stale revision is a visible conflict; a queued reorder that
  > names a task which left the day, or misses one that joined it, is
  > reconciled when the server applies it. The HTTP routes below keep the
  > full-list rule and the 412 for conditional online writes.

- Controls are Up and Down buttons with task-specific labels, on Today's
  planned rows, in the plan-tomorrow list and in a "Day order" card under the
  Planner grid for each day with two or more date-only tasks. A task the
  server has not listed yet (for example an unsynced edit) is shown but not
  movable.

### Assistant operations

`day_order.get` (`tasks:read`) reads one date, or the owner's current
planning date by default. `day_order.reorder` (`tasks:write`) takes the date,
the expected revision and every member. A day order has no entity ID, so the
preview freezes no base revision. Confirmation repeats the revision and
membership checks inside its transaction, so a browser reorder or a task
joining or leaving the day after the preview makes it stale
(`412 AUTOMATION_PREVIEW_STALE`). The assistant plans tomorrow with
`tasks.update` and then reorders; there is no separate plan tool.

### Super Productivity import

- `TODAY_TAG.taskIds` becomes the order of the owner's planning date when the
  preview or apply runs (owner zone and day start). Only entries that are
  imported, open, date-only tasks planned for that date are applied.
- `planner.days[date]` becomes the order of that date under the same rule. When
  the Today order already covers the date, the planner entry is reported and
  skipped.
- Entries for tasks absent from the export, and entries for timed, completed,
  archived or differently dated tasks, are reported as non-blocking
  `day_order_notice` findings. They keep their own date or time order.
- An order is saved only for a date without a saved order, so a repeated
  import never overwrites the owner's edits.
- A malformed `planner` (not an object, `days` not a map of dates to ID lists,
  or an unreviewed key) and a non-list Today `taskIds` block apply.
- `startOfNextDayTime` is not imported, since planning preferences are not
  imported. A non-midnight value is reported and names the setting to change
  before importing, so the Today order lands on the same date.

The `planner` section is now `applied`; its keys are classified in
`super-productivity-day-order.ts`.

## Evidence

The newest local backup on September 24 (`2026-09-24_230532.json`, counts
only) has 27 Today entries: 20 completed tasks and 7 open timed tasks, none
missing and none date-only. Its six `planner.days` dates are empty, and
`startOfNextDayTime` is 03:00. Imported today, it would save no day order and
report the Today entries as notices. A real import qualification remains #47.

## Consequences

- Exports with a Today order or planner days no longer block.
- Tests cover America/Chicago midnight and daylight-saving boundaries, the day
  start, stale and partial reorders, replay, tasks leaving the day, plan
  rollback, import with missing references and restart.
- Day orders need a connection until offline planning (#92) queues them.
- Finish-day rituals, schedule hygiene and automatic planning remain open.
