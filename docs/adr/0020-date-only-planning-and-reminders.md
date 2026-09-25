---
status: accepted
---

# Date-only planning and per-task reminders

Issue #29. Reference: Super Productivity 19.1.0 (`task.model.ts`,
`work-context.selectors.ts`, `remind-option-to-milliseconds.ts`, planner store).

## Source behavior

Super Productivity stores a timed plan as `dueWithTime` and a date-only plan
as `dueDay`. The two are meant to be exclusive; when legacy data has both,
`dueWithTime` wins. Today is a virtual view: a task belongs to it when
`dueWithTime` falls today or, without a time, when `dueDay` is today.
`TODAY_TAG.taskIds` stores only the manual order. `planner.days` stores the
order of future days.

Reminders are absolute timestamps. `remindAt` is derived from `dueWithTime`
and one of six options: at start, or 5, 10, 15, 30 or 60 minutes before. A
timed task without `remindAt` has no reminder. `deadlineRemindAt` uses the
same options and exists only for a deadline with a time.

Priority is expressed with ordinary tags (`EM_URGENT`, `EM_IMPORTANT`) used by
the Eisenhower board. The 19.1.0 task model has no dependency field; every task
field is classified in `super-productivity-schema.ts`.

## Decision

### Planned day

A task may have a **planned day**: a calendar date read in the owner's IANA
planning time zone. It never implies a time. It is exclusive with the planned
start:

- Setting a planned day clears the planned start; setting a planned start
  clears the planned day. A request that sets both is invalid.
- A Suite time block is calendar-authoritative (ADR 0009). Creating a block
  clears the planned day. Setting a planned day while a block exists returns
  `409 TIME_BLOCK_REMOVE_REQUIRED`; the owner removes the block first.
- When both values are present anyway (legacy import data), the planned start
  wins everywhere.

Today shows a date-only task in "Planned for today" while the owner-local date
equals its day. After local midnight it moves to Overdue. The day window is
computed in the owner zone, so it is 23 or 25 hours on daylight-saving change
days. The Planner lists a date-only task on every owner-zone day that overlaps
the requested window and shows it in the all-day lane. It is never positioned
on the time grid, so it cannot overlap an event.

Storage: migration `0023_date_only_planning` adds `planned_day`, reminder
columns, and triggers that reject a stored planned day together with a planned
start.

### Reminders

Each task has a **start reminder** setting:

- `default` keeps the ADR 0016 behavior: a 15-minute lead reminder and an
  at-start reminder, each controlled by the owner's notification preferences.
- `none` disables start reminders for the task.
- `before_start` with 0, 5, 10, 15, 30 or 60 minutes sends exactly one
  reminder at that offset. It replaces the owner's lead and at-start toggles
  for the task. Offset 0 uses the `at_start` ledger kind; other offsets use
  `lead`.

A **deadline reminder** uses the same offsets before a timed deadline. Clearing
the deadline or making it date-only removes the reminder. A deadline reminder
without a timed deadline is rejected. Date-only plans and deadlines have no
reminder time.

The owner's master notification switch applies to every setting.

Reminders stay in the ADR 0016 ledger. Its identity is owner, task, occurrence
and kind; the migration rebuilds the table to add the `deadline` kind and
copies existing rows. A deadline row's occurrence is the deadline instant.
Reconciliation rules:

- An offset change moves a pending row that has not been attempted.
- A row cancelled as obsolete was never published, so it may return to
  pending when the reminder is wanted again.
- Delivered, suppressed, failed and in-flight rows are final. Changing an
  offset after delivery does not send a second reminder for the same
  occurrence and kind.

Start reminders keep the existing calendar freshness, working-hours, break,
busy and focus suppression. A deadline reminder is suppressed only when the
task is completed and cancelled when it is deleted; a deadline passes
regardless of calendar state or working hours. Suppression and failures remain visible through the existing
notification status.

### Sync and offline policy

Planned day and reminder settings follow the planned-start policy: they are in
task snapshots and sync change notifications but are not sync v2 operation
fields. Adding them would require new field versions and another epoch reset.
The browser edits them only online through the conditional task API and
disables the form offline. The server ledger is the only delivery authority,
so no offline client can create or repeat a delivery. Offline planning edits
remain part of #92.

### Assistant operations

`tasks.create` and `tasks.update` accept `plannedDay`, `startReminder` and
`deadlineReminder` through the existing preview and confirmation flow. Preview
rejects a planned day for a task with a calendar block and a deadline reminder
without a timed deadline.

### Super Productivity import

- `dueDay` becomes the planned day when `dueWithTime` is absent. It is never
  converted to a time. A superseded `dueDay` is not applied or stored in
  provenance, which keeps the source hash of earlier imports unchanged.
- `remindAt` becomes a `before_start` offset only when `dueWithTime - remindAt`
  is exactly one of the six offsets. A timed task without `remindAt` imports
  with `none`. Any other `remindAt` blocks apply with an explanation; nothing
  is rounded.
- `deadlineRemindAt` follows the same rule against `deadlineWithTime`.
- The legacy `reminders` section and `reminderId` stay blocked.

## Deferred

- **Persisted Today and planner-day order** (`TODAY_TAG.taskIds`,
  `planner.days`). This needs an ordering record, reorder API, drag UI and a
  sync decision. Follow-up: #TBD (assigned by the coordinator). Today orders
  date-only tasks by ID and overdue work by when it became due.
- **Backlog planning, plan-for-tomorrow and finish-day rituals.** Project
  backlog data stays blocked under #28; ritual flows stay in the planning
  parity row.
- **Start-of-next-day offset.** Super Productivity can move the day boundary;
  Tadooer uses local midnight.
- **Priorities** import as ordinary tags; board configuration stays #63.
