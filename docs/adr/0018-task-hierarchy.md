---
status: accepted
---

# Two-level task hierarchy with full child tasks

Issue #27. Super Productivity 19.1.0 lets a task own subtasks that are
complete tasks with their own notes, dates, estimates, tags, completion and
tracked time. Tadooer's existing `subtasks` are one-level checklist items, so
they cannot hold imported children without losing data. This decision adds
child tasks and keeps the checklist.

## Source semantics (Super Productivity 19.1.0)

Read from `src/app/features/tasks` and the task-shared meta-reducers:

- A task has `parentId` and an ordered `subTaskIds`. `canApplyConvertToSubTask`
  rejects a target that is itself a subtask, a task that already has subtasks,
  and self-nesting, so the tree is exactly two levels.
- A parent's `timeEstimate` is recalculated as the sum of its open children's
  remaining estimates. Its `timeSpent` and `timeSpentOnDay` are the sums of its
  children's.
- Completing the last open child marks the parent done only when
  `isAutoMarkParentAsDone` is on; it defaults to off.
- Deleting a parent deletes its subtasks. Moving a subtask to another parent
  inserts it after an anchor and gives it the new parent's project.
- Converting a subtask to a main task, or a main task to a subtask, keeps the
  task's own tags.

## Decision

**Depth.** Tadooer allows two levels: a top-level task, or a child of one
top-level task. This matches the source, so every valid export maps without
flattening, and it rules out cycles by construction. An import whose chain is
deeper blocks with `hierarchy_depth_unsupported` rather than guessing.

**Identity and storage.** A child task is an ordinary task row with its own
UUID, revision, field versions, project, tags, dates, calendar block, focus
sessions and recovery lifecycle. Migration `0021_task_hierarchy` adds three
columns to `tasks`: nullable `parent_id`, nullable `child_position` and
`hierarchy_version`. SQLite triggers reject any row whose parent is itself,
belongs to another owner, is missing, is not top-level, or whose own children
would become grandchildren. Application code checks the same rules first to
return specific errors (`TASK_PARENT_NOT_FOUND`, `TASK_PARENT_DELETED`,
`TASK_HIERARCHY_CYCLE`, `TASK_HIERARCHY_DEPTH`, `TASK_HAS_CHILDREN`).

**Ordering.** Children sort by a sparse integer `child_position`, then ID.
A move places the child at a sibling index using a midpoint key, so it usually
writes one row. When no integer gap remains the server renumbers the siblings
at 1024 intervals. Top-level ordering is unchanged.

**Revisions.** Every placement change (reparent, convert, reorder,
renumbering) bumps that task's revision and sets `hierarchy_version` to the new
revision. `hierarchy_version` is published as `fieldVersions.parent` in sync
snapshots and is the base for offline moves. A move does not change the
parent's revision.

**Project and tags.** A child keeps its own project and tags when it moves.
Unlike the source, a move does not copy the parent's project; this avoids an
implicit write to a field with its own version. The importer keeps the source
project exactly as exported.

**Completion.** No propagation. Completing every child does not complete the
parent, and completing a parent does not complete its children, which matches
the source default. The Tasks page shows "n of m done" for each parent.

**Estimates and time.** Rollups are derived on read and never overwrite
stored fields. The parent summary shows the sum of open children's estimates;
the parent's own `estimateMinutes` stays independent. Because a source parent's
`timeEstimate` is derived, the importer stores it only in provenance and leaves
the parent estimate empty. Parent time totals depend on imported work history
and remain with #41.

**Soft delete and restore.** Deleting a parent soft-deletes its active
children in the same transaction with the same `deleted_at`. The delete is
refused if any of those children has an active focus session or a calendar
block. Restoring the parent restores exactly the children deleted with it; a
child deleted earlier stays deleted. Restoring a child whose parent is still
deleted makes the child top-level, so the restored task is never orphaned.
A task with only deleted children may become a child; its deleted children are
detached so they cannot form a third level.

## Checklist coexistence

Checklist `subtasks` stay as a separate, lightweight concept: a titled
checkbox with a position inside one task. They are not migrated, deleted or
converted. Use a child task when the work needs its own dates, estimate,
project, focus time or recovery; use a checklist item for a step inside one
task. Template subtask blueprints still create checklist items.

## Interfaces

- HTTP: `GET /api/tasks/:id/children`, `POST /api/tasks/:id/children`
  (Idempotency-Key), `PUT /api/tasks/:id/children` (full order with every child
  revision) and `POST /api/tasks/:id/move` (If-Match; `parentId: null` converts
  to top-level). Task payloads carry `parentId` and `childPosition`.
- Sync v2: `task.move` carries `parentId`, `index` and `baseParentVersion`.
  The server replays it idempotently by operation ID. A stale base version, a
  deleted or missing parent, or a target that would add a level is a
  `SYNC_RESOURCE_CONFLICT` that changes nothing, so replay cannot orphan or
  cycle the graph. The server re-sends the unchanged task in the change stream
  so the client drops its optimistic placement. Offline child creation is `task.create` followed by
  `task.move`; if the move conflicts, the task stays visible at top level.
  Soft delete and restore cascades happen on the server and arrive as ordinary
  task changes.
- Assistant: `tasks.hierarchy` with `create_child`, `move` and `reorder`
  actions. The preview freezes the task, the target parent and every reordered
  child revision; confirmation fails if any changed.
- Import: `parentId` and `subTaskIds` are applied. Children are created as
  full tasks and placed in `subTaskIds` order after all records exist, in the
  same transaction.

## Consequences

Existing tasks become top-level tasks with `hierarchy_version` equal to their
revision. Older clients ignore the new optional fields. Children appear in
`tasks.list` and every existing task surface; views that need a tree group by
`parentId`. Moving a child to another parent can change its position among
siblings but never its project, tags, dates or completion.
