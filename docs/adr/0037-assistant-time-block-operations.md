---
status: accepted
---

# Assistant operations: move and remove task time blocks

Issue #58 (parent #32, inventory #19, roadmap #15; parity row `time-blocks`).
Builds on the CalDAV write contract of ADR 0002 and ADR 0009, the automation
preview/confirmation protocol of ADR 0011 and the existing
`schedule.create_time_block` operation.

Before this change the assistant could create a task time block but could not
change its interval or remove it. The browser has both controls:
`putTaskTimeBlock` re-posts the block with a new start and duration, and
`removeTaskTimeBlock` deletes it. Both carry the task revision in `If-Match`
and the remote event ETag in the CalDAV request.

## Decision

Two new catalog operations, both `schedule:write`, both preview/confirm:

- `schedule.move_time_block` — input `taskId`, `expectedRevision`, `startsAt`,
  `durationMinutes`, optional `calendarId`. The task must already have a
  block. When `calendarId` is given it must be the block's calendar; a
  different calendar is rejected with `TIME_BLOCK_CALENDAR_FIXED`, exactly as
  the browser route rejects it. Changing calendars is therefore remove then
  create, two approvals, because one durable calendar write record binds one
  event href. The result is the same `TaskTimeBlockMutationResponse` as
  create.
- `schedule.remove_time_block` — input `taskId`, `expectedRevision`. The
  result is `{ task, replayed }` with the task's planned start and estimate
  cleared. Removal is a deletion under the #33 categories, so it always needs
  its own confirmation; nothing else is removed with it.

`expectedRevision` is the task revision the assistant read. The preview
rejects a mismatch with `TASK_REVISION_CONFLICT` (412) before anything is
frozen, then binds the task revision as the base revision. Every local
mutation of a block (create, move, remove, reconciliation) advances the task
revision, so a stale task revision also detects a changed block. The preview
also checks that the block exists (`TIME_BLOCK_NOT_FOUND`) and that the
calendar still supports events (`CALENDAR_NOT_FOUND`).

Preview text names the task, the calendar and the interval: the current
interval and the new one for a move, the current interval for a remove. The
current interval comes from the task's `plannedStart` and `estimateMinutes`,
which the calendar write keeps in step with the block.

## Confirmation semantics

Move reuses the create path: `reserveCalendarWrite` records the intended
write under the confirmation's internal idempotency key with the block's
existing href and UID, the connector issues a conditional PUT with the block's
stored ETag, and `completeCalendarWrite` stores the new ETag and interval. The
three outcomes match the browser route:

- `412` from the provider (the event changed remotely) →
  `CALENDAR_EVENT_CONFLICT` (409) with `action: "refresh_and_replan"` and the
  block's mapping ID; the write record is marked conflicted.
- Any other failure or lost response → `CALENDAR_WRITE_RECONCILIATION_REQUIRED`
  (409). Re-confirming with the same key after a restart replays the write
  record and reconciles by reading the calendar: when the intended event is
  found it completes, otherwise it stays conflicted. No second event is
  created because the href is fixed.
- Success → the mapping and task with `replayed: false`.

The create operation now shares this code, so a create that replaces an
existing block reports a remote change as `CALENDAR_EVENT_CONFLICT` instead
of the generic reconciliation error. Everything else about create is unchanged.

Remove issues a conditional DELETE with the stored ETag before the receipt,
because it is a network call. A `412` marks the block `conflict` and returns
`CALENDAR_EVENT_CONFLICT`; a lost or ambiguous response marks it
`needs_reconciliation` and returns `CALENDAR_DELETE_UNCERTAIN` (502). Both
leave the preview unconsumed, so the assistant can re-confirm; a provider
`404` on retry counts as removed. The local release (delete the block and
projection, clear the task's planned start and estimate, bump the revision,
append the sync change) runs inside the confirmation transaction, so the
block, task, sync change, consumed preview, audit entry and replay receipt
commit or roll back together. `releaseTaskCalendarBlock` therefore uses a
savepoint instead of opening its own transaction; the browser DELETE route
calls it outside any transaction, where a savepoint behaves the same.

Failed provider calls append an `execute`/`failed` audit entry with the error
code, in addition to the preview entry and the receipt's `execute`/`succeeded`
entry. Replays return the stored receipt with `replayed: true` and never call
the provider again.

## Not covered

- Changing a block's calendar in one operation.
- Refreshing a conflicted block's ETag from the provider; that remains the
  existing reconciliation path for the browser and assistant alike.
- Installed Codex/Claude client evidence stays in #39.

No persistence migration; the schema already stores every field used.
