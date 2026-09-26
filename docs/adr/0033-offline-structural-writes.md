---
status: accepted
---

# Offline structural writes: planning, assignment, projects, tags and checklists

Issue #92 (roadmap #15, parity row `offline-writes`). Builds on the sync v2
protocol of ADR 0010, the deadline field version of migration 0017, offline
moves of ADR 0018, the organization records of ADR 0019, the exclusive
planned day and start of ADR 0020 and the calendar block authority of
ADR 0009.

Before this change the outbox queued only task create, field patch
(title, notes, estimate, deadline), completion, deletion, restore, move and
habit commands. Planned time, project and tag assignment, project and tag
lifecycle and checklist items were cached read-only and every write needed a
connection, although `task_field_versions` already versioned `projectId` and
`tagIds`. Super Productivity is local-first for every entity.

## Decision

### Task fields

`task.patch` accepts three more field groups with the ADR 0010 semantics: a
patch applies atomically when every changed field still has its base version;
disjoint fields merge; any advanced field is a visible `SYNC_FIELD_CONFLICT`.

- **Planning slot.** `plannedStart` (instant or null) and `plannedDay`
  (owner-zone date or null) share one field version named `plannedStart`,
  because the two values are exclusive (ADR 0020). A patch may set either or
  clear both; setting one clears the other on the server exactly as the
  conditional task API does. Every server-side change of either value,
  including calendar block reservation and release, advances the version.
  Migration `0037_sync_v2_planned_start_epoch_reset` rebuilds
  `task_field_versions` with the new field name, seeds it from each task's
  revision and resets the change-stream epoch, so every client replaces its
  cache from a snapshot once. Existing browser outboxes stay valid: no
  IndexedDB store or key changed, the database version stays 2 and queued
  operations keep their shape.
- **Calendar authority.** A task with a Suite calendar block keeps Baikal as
  the owner of its planned start. A queued planning patch for such a task is
  recorded as a `SYNC_RESOURCE_CONFLICT` with conflict field `calendarBlock`
  and changes nothing; the browser shows it as a conflict that cannot be
  retried locally and the owner changes the block through the planner. The
  browser never queues a calendar write.
- **Reminder settings** (`startReminder`, `deadlineReminder`) stay
  online-only. The server ledger is the only delivery authority (ADR 0020),
  so the planning form saves a planned day or time offline and reports that
  reminder changes need a connection.
- **Assignment.** `projectId` (UUID or null) and `tagIds` (at most 25 unique
  UUIDs) use the existing `projectId` and `tagIds` versions. An unknown or
  archived project or tag is a `SYNC_RESOURCE_CONFLICT` with field `project`
  or `tag`; the operation changes nothing. Leaving a project also leaves its
  backlog, as the HTTP route does.

### Projects and tags

`project.create`, `tag.create`, `project.patch` and `tag.patch` are new sync
operations. Creates carry a client-generated UUID and a title; a reused ID is
a resource conflict, like `task.create`. Patches carry `baseRevision` and any
of `title`, `archived`, `color`, `icon`, plus `completed` for projects, and
apply through the same `mutateOrganization` rules as the HTTP routes (archive
and completion cannot change together). Projects and tags keep one record
revision rather than per-field versions, so a stale patch is a
`SYNC_RESOURCE_CONFLICT` on the record. A tag whose case-folded name already
exists is a resource conflict with field `name`. Reorder, backlog membership,
hide-from-menu and notes remain online HTTP writes.

### Checklist items

`subtask.create`, `subtask.patch` and `subtask.delete` queue offline. A
create carries the item UUID, task, title and position; a patch carries
`baseRevision` and any of `title`, `completed`, `position`; a delete carries
`baseRevision`. Items keep one revision, so a stale patch or delete is a
resource conflict. A missing or deleted parent task is a resource conflict
with field `task`. The browser moves an item up or down by queueing two
position patches; the complete-membership reorder route stays online.

### Outcomes and review

Conflict outcomes gain an optional `entityKind` (`task`, `project`, `tag` or
`subtask`, default `task`). The existing `taskId` and `taskRevision` fields
carry the conflicting entity's ID and revision for every kind; the names are
kept so protocol version 2 and stored outcomes stay compatible. The browser
records the kind with each conflict, offers retry only for task field
conflicts as before, and lets the owner dismiss project, tag and checklist
conflicts after the canonical record has been pulled. Every outcome is
idempotent by owner, client and operation ID with the request-hash check of
ADR 0010; replay of an already conflicted operation returns the stored
conflict.

### Browser behaviour

Task organization, planning day or time, project and tag creation and
checklist edits on the Tasks page write to the outbox and sync when a
connection exists. Projects, tags and checklists are read from the local
cache after each sync, so an offline-created project can be assigned before
it has synced. The limited offline workspace shown when no session can be
resumed still offers only capture, completion, deletion and restore.

## Explicit boundaries

Online-only, unchanged by this decision: reminder settings, calendar blocks
and Google planning, project and tag reorder, backlog membership, notes,
menu folders, boards, day orders, archive to history, recurrence series,
time entries, focus control and application preferences. Sync remains
foreground-only (ADR 0010). Two-profile browser evidence and real-data
import qualification (#47) are recorded separately from this implementation.

## Consequences

- Migration 0037 forces one snapshot reset per client; queued operations
  replay over the new snapshot in client sequence order.
- `docs/product/super-productivity-parity.json` rows `core-tasks`,
  `projects`, `tags`, `planning` and `offline-writes` describe the new
  offline policy; `assistant-capabilities.json` no longer lists offline
  structural writes as a remaining parity action.
