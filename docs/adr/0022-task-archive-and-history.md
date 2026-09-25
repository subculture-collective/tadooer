---
status: accepted
---

# Archived task history

Issue #38. Super Productivity 19.1.0 keeps finished work in two archive
stores, and the September 24 backup holds 4,370 archived task records next to
348 live ones. Many archived records point at projects, tags and repeat
configurations that no longer exist. Until now the importer blocked every
export with an archive. This decision adds archived history to Tadooer and
defines how that history is imported.

## Source semantics (Super Productivity 19.1.0)

Read from `src/app/features/archive`, `features/history` and the task-shared
lifecycle meta-reducer:

- `archiveYoung` and `archiveOld` are each an `ArchiveModel`: a task entity
  store, a `timeTracking` state, and flush timestamps. Tasks move from young to
  old after 21 days. The split is storage tiering; both hold the same kind of
  record.
- Archiving moves a top-level task together with its subtasks. It sets
  `isDone`, keeps or derives `doneOn`, and clears `dueWithTime`, `dueDay` and
  `reminderId`. Older archived records can still carry `plannedAt`,
  `remindAt` or `dueDay`.
- Nothing rewrites archived records when a project, tag or repeat
  configuration is deleted, so archived references go stale.
- `restoreTask` returns a task and its archived subtasks to the active store.
  It reopens the parent (`isDone: false`, `doneOn` cleared), drops stale
  project and tag references, and plans the task for today.
- The History page groups archived work by day and offers restore.

## Decision

### Lifecycle

A task is in exactly one state: **active**, **archived** or **soft-deleted**.
Completion is independent of all three.

- _Archived_ is read-only history. The task keeps its UUID, `createdAt`,
  `completedAt`, revision history, focus intervals and provenance. It leaves
  every active surface: task lists, Today, the Planner, backlogs, reminders and
  the offline cache.
- _Soft-deleted_ keeps its existing recovery meaning (ADR 0009).
- A task cannot be archived and deleted at once; a SQLite trigger rejects it.
  To delete an archived task, restore it first. Permanent purge of history is
  not part of this decision.
- Archiving does not complete an open task, unlike Super Productivity. The
  owner decides separately whether the work was done.
- Restoring does not reopen, re-plan or move the task to Today. It returns to
  active lists with the same completion, dates, project and tags. Unlike Super
  Productivity, this keeps the original completion time. If a restored open
  task has a past planned start, the normal reminder ledger rules apply.

Storage: migration `0026_task_archive_history` adds `tasks.archived_at`. Active
queries require `deleted_at IS NULL AND archived_at IS NULL`. A trigger rejects
any change to an archived row's content, planning, reminder, project or
placement columns, so history stays read-only even if an application check is
missed. Tag assignments are protected by the application: every tag and
project write path reads the task as active first.

### Hierarchy

Archive and restore act on a top-level task and its active children together,
as the source archives a parent with its subtasks. A child alone is never
archived or restored (`TASK_ARCHIVE_CHILD`). Consequently a child always shares
its parent's state:

- Children that were soft-deleted before the archive stay deleted and keep
  their parent reference. Restoring such a child from recovery while its parent
  is archived makes it top-level, following the existing ADR 0018 rule for a
  missing parent.
- An archived task is not a valid parent for an active task.
- A running focus session or a calendar block on the task or an active child
  blocks archiving (`TASK_ARCHIVE_BLOCKED`), as it blocks deletion. Archived
  tasks therefore never hold a live calendar block.

### Revisions, sync and offline policy

Archive and restore are conditional writes: each moved task gains one revision,
and the change feed records one change per task. Archive state is not a sync v2
operation, so the browser archives and restores only while online.

History is outside the offline cache. The sync route sends a task that is
archived _now_ as `kind: "deleted"` with a `null` snapshot, whatever change
kind was recorded; the client drops it. A restore sends an ordinary upsert, and
full snapshots contain active tasks only. This keeps a 4,000-record history
out of IndexedDB and needs no epoch reset. An offline edit, completion, move,
delete or restore queued before the archive arrives as a
`SYNC_RESOURCE_CONFLICT` whose outcome replays idempotently; nothing is
applied to the archived task.

### History browse, search and restore

- HTTP: `GET /api/tasks/history?query=&cursor=&limit=` returns top-level
  archived tasks with the children archived with them, newest first by
  completion time (archive time when open), then ID. A family matches when the
  parent or any child matches the query in title or notes; matching is
  case-insensitive for ASCII and treats `%` and `_` literally. Cursors are
  opaque keyset positions; an invalid one is a `400`.
- `POST /api/tasks/:id/archive` and `POST /api/tasks/:id/unarchive` require
  `If-Match`.
- Web: a History view lists families with their original dates, provenance,
  review notes and historical references, and restores a family. Tasks shows
  Archive on top-level tasks. Both are disabled offline.
- Assistant: `tasks.history` (resource, `tasks:read`), `tasks.archive` and
  `tasks.unarchive` (tools, `tasks:write`). The preview names the task, counts
  its children and freezes every revision in the family. A changed child makes
  the confirmation stale, and so does a child added or removed after preview.

### Super Productivity import

Both archive stores apply as archived tasks, created, placed in their
hierarchy, then marked archived in the same transaction as the rest of the
import. `archived_at` is the import time; the source records no archive time.
`created` and `doneOn` are preserved exactly.

**Unresolved historical references.** On an archived task, a project, tag or
repeat configuration that is absent from the export is not invented and does
not block. Its source ID is stored in `task_historical_references` with the
reason `missing_from_export`, and the preview reports one aggregated
`historical_reference` finding per kind. Priority and board markers
(`EM_URGENT`, `EM_IMPORTANT`, `KANBAN_IN_PROGRESS`) on archived tasks are kept
the same way with reason `system_tag`. Existing repeat configurations are
recorded as `recurrence_unsupported` until #42. The same missing references on
a live task still block, because a live task needs a real link.

**Review policy for malformed history.** The importer never rewrites the
source backup. For an archived record:

- a blank title imports as "Untitled archived task" with review reason
  `blank_title`;
- notes over 20,000 characters import their first 20,000 characters with
  `notes_unrepresentable`;
- an estimate that is not whole minutes up to 720 is not applied, with
  `estimate_unrepresentable`.

In each case the full source value stays in the import provenance JSON, the
preview reports a non-blocking `history_review` finding for the record, and
History shows "Needs review". A blank title on a live task still blocks.

**Schedule and reminders.** Archived history never schedules or reminds.
`dueWithTime`, `dueDay`, `plannedAt`, `remindAt` and `deadlineRemindAt` on an
archived record are not applied and are kept in provenance; `plannedAt` does
not block on archived records. Deadlines apply as plain values.

**Duplicate live/archive copies.** When one ID appears in more than one store,
the importer compares the copies field by field, ignoring the reviewed
view-state fields (`modified`, `hasPlannedTime`, `_hideSubTasksMode`,
`subTasks`):

- identical copies collapse to the first store's copy (live, then
  `archiveYoung`, then `archiveOld`), reported as non-blocking
  `duplicate_copy_collapsed`;
- divergent copies block with a per-task `duplicate_task` finding that names
  the differing fields.

The importer never chooses between divergent copies.

**Mixed lifecycles.** A child whose parent is in the other lifecycle (a live
child of an archived parent, or the reverse) imports at top level in its own
lifecycle. The source parent ID is kept as a historical reference with reason
`lifecycle_mismatch`, and the preview reports `historical_parent_detached`. An
archived child whose parent is absent from the export imports at top level
with a `missing_from_export` parent reference. A live child with a missing
parent still blocks.

**Still blocking.** Populated `timeTracking` inside either archive store blocks
until work history parity (#41). Unknown archive keys block. Recurrence and
tracked time on any task keep their existing blocking findings.

Each finding in the preview now carries `blocking`; the web preview lists
blocking findings and reported dispositions separately.

## Consequences

- Imports are idempotent as before: the source identity table maps each source
  task once, and provenance rows are written only for newly created tasks.
- Against the September 24 backup, the importer maps 4,275 archived records
  (1,778 young after collapsing duplicates, 2,497 old), keeps 5,369 historical
  references and flags 9 records for review. 32 duplicate copies collapse and
  63 divergent ones block. The export still cannot be applied because of
  duplicate live index entries, linked issues, time history, recurrence and
  other sections outside this decision.
- History is online-only and not searchable offline.
- Work-history totals for archived tasks remain with #41; recurrence with #42.
