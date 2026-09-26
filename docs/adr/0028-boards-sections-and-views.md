---
status: accepted
---

# Boards, sections, saved task views and sidebar folders

Issue #63. Builds on the full-list reorder convention of ADR 0019, the
planned day and planning date of ADR 0020 and ADR 0027, and the archive rules
of ADR 0022. Source reference: Super Productivity 19.1.0 (`boards`,
`section`, `task-view-customizer`, `menu-tree`).

Before this change Tadooer had no board, no section, no saved sort or group
setting and no sidebar folders. The importer reported `boards` as
configuration, blocked on a populated `section` store, flattened `menuTree`
folders away, and blocked every export whose live tasks carried the
`EM_URGENT`, `EM_IMPORTANT` or `KANBAN_IN_PROGRESS` system tag.

## Source semantics (Super Productivity 19.1.0)

- `boards.boardCfgs[]` holds `BoardCfg {id, title, cols, panels[]}`. A
  `BoardPanelCfg` is a filter (`includedTagIds` with `includedTagsMatch`
  all/any, `excludedTagIds` with `excludedTagsMatch` any/all, `projectIds`
  where `[""]` means every project, `taskDoneState`, `scheduledState`,
  `backlogState`, `isParentTasksOnly`, optional `sortBy`/`sortDir`) plus
  `taskIds`, the manual order used when `sortBy` is absent. Legacy
  `projectId` and `sortByDue` are migrated on load. The Eisenhower matrix and
  Kanban defaults are built from the system tags `EM_URGENT`, `EM_IMPORTANT`
  and `KANBAN_IN_PROGRESS`.
- Dropping a task into a panel (`board-panel.component.ts`) rewrites the
  task so that it matches: every included tag is added (for `any`, the first
  one when none is present), every excluded tag is removed (for `all`, only
  the first when the task carries all of them), the done state and the first
  specific project are applied, and a panel that requires a scheduled task
  asks for a date. The task is then placed in the panel's `taskIds`.
- `section` entities are `{id, contextId, contextType PROJECT|TAG, title,
isExpanded, taskIds}`. The source only allows project contexts and the
  singleton `TODAY` tag.
- The task-view customizer stores sort (name, scheduledDate, deadline,
  creationDate, estimatedTime, timeSpent), group (tag, project,
  scheduledDate, deadline), one filter with a preset, and collapsed group IDs
  per context in `localStorage`. It is not exported.
- `menuTree.projectTree` and `menuTree.tagTree` are trees of folder nodes
  (`k: "f"`, `id`, `name`, `isExpanded`, `children`) and project or tag
  nodes. The newest local backup on September 25 (counts only) has 2 boards
  with 7 panels, every panel filter built from system tags, 0 sections, and
  project folders nested two levels deep.

## Decision

All four records are owner-scoped, revisioned, online HTTP resources
(migration `0032_boards_sections_views`). None is in the sync change feed or
the offline cache; offline, the browser shows nothing for them and disables
their controls. A stale revision fails with 412 and the browser reloads the
record. Offline structural edits remain #92.

### Board markers

Super Productivity's system tags are never ordinary tags (ADR 0019). A task
has zero or more stored **board markers** (`urgent`, `important`,
`in_progress`; `task_board_markers`) beside its tags, and a derived `today`
marker: the task's planned day, or the owner-zone date of its planned start,
equals the owner's current planning date (ADR 0027). Markers do not change the
task revision, are not in the task record or the sync feed, and are returned
with a board view. The importer applies `EM_URGENT`, `EM_IMPORTANT` and
`KANBAN_IN_PROGRESS` on a live task as markers and strips them from its tags.

### Boards and panels

A **board** has a title, 1 to 6 columns, a position, a revision and up to 12
ordered **panels**. A panel is a saved filter (the source fields, with tags
and markers side by side and `projectIds` empty for every project) and an
optional manual order (`board_panel_tasks`). Membership is computed on read
from the owner's active tasks (`doesTaskMatchPanel` with markers). A panel
without `sortBy` lists saved ranks first, then the rest in creation order;
with `sortBy` it sorts by due date, creation, title or estimate with missing
values last. Deleted and archived tasks are ignored on read and pruned by the
next order write; hard deletes cascade. Editing a board replaces its whole
configuration with the board revision; panels keep their IDs and manual order
when they are listed again and are deleted when they are not. The Eisenhower
and Kanban templates exist as an explicit create action and are never
created automatically.

**Moving a task into a panel** is one explicit, all-or-nothing operation with
the board revision and the task revision. The server plans the changes with
the source rules: add or remove tags and markers, complete or reopen, assign
the first filter project, plan the task for today (or clear its planned day)
for the `today` marker, and add it to or remove it from the project backlog.
Each change is an ordinary task mutation, so the task revision advances and
the sync feed sees the tag, state, project and date changes. A move the
server cannot make true (a child into a parents-only panel, an unscheduled
task into a scheduled-only panel, a task with a start time out of a today
panel, a task with a calendar block, or a backlog panel without an enabled
project backlog) is refused with `409 BOARD_MOVE_UNSUPPORTED` and changes
nothing; the source's date dialog is not reproduced. The browser asks the
server for a dry run and shows the change list before the move; the
assistant preview names the same list. Manual reorder is a full list of the
panel's current members and fails with 412 when the list or the board
revision is stale.

### Sections

A **section** belongs to one project or one tag context and has a title,
`expanded`, a position among its context's sections, a revision and an
ordered task list. Members must be active tasks of the context; a task sits
in at most one section per context, so placing it removes it from a sibling
and bumps that sibling's revision. A task that leaves the context, is
completed and archived, or is deleted is ignored on read and pruned by the
next write. Reorder is the full list of the context's sections with their
revisions. Sections of the source's Today view have no Tadooer context and
are reported, not imported. The Tasks page shows sections when a project or
tag filter is active; tasks outside every section stay in the regular list.

### Saved task views

A **task view** stores sort (`name`, `scheduledDate`, `deadline`,
`creationDate`, `estimatedTime`, `timeSpent`), direction, group (`tag`,
`project`, `scheduledDate`, `deadline`), one filter (a tag, a project, a
scheduled-date or deadline preset, or an estimate or time-spent minimum) and
collapsed group keys per context: `all`, `today`, or one project or tag. The
revision is 0 until the first save. Unlike the source, the view is
server-side and shared by every browser. The Tasks page applies the view to
the filtered list; `timeSpent` uses the last 366 days of the worklog.

### Sidebar folders

A **menu folder** groups projects or tags (`kind`), has a title, `expanded`,
an optional parent folder of the same kind (at most eight levels, no cycles),
a position among its siblings and an ordered item list. An item is in at
most one folder; placing it elsewhere removes it from the previous folder and
bumps that folder's revision. Deleting a folder deletes its subfolders and
returns their items to the top level. Project and tag order (ADR 0019) stays
the global order; folders only group. The Tasks page shows folders as option
groups in the project and tag filters and offers a manager for them.

### API, assistant and scopes

- `GET/POST /api/boards`, `PUT /api/boards/order`, `GET/PUT/DELETE
/api/boards/{id}`, `PUT .../panels/{p}/order`, `POST .../panels/{p}/tasks`
  (with `dryRun`).
- `GET/POST /api/sections`, `PUT /api/sections/order`, `PUT/DELETE
/api/sections/{id}`; `GET/PUT /api/task-views`; `GET/POST
/api/menu-folders`, `PUT /api/menu-folders/order`, `PUT/DELETE
/api/menu-folders/{id}`. Deletes use `If-Match`; other writes carry
  `expectedRevision`.
- Assistant resources `boards.list` (configuration plus computed membership
  and markers), `sections.list`, `task_views.list`, `menu_folders.list`
  under `tasks:read`; tools `boards.mutate` (create, update, delete,
  reorder_panel, move_task), `sections.mutate`, `task_views.set` and
  `menu_folders.mutate` under `tasks:write`. No new scope is introduced:
  boards, sections, views and folders arrange tasks and never grant more than
  task authority. Previews freeze board, section, folder and moved-task
  revisions; a task view has no entity ID, so confirmation repeats its
  revision check.

### Super Productivity import

`boards`, `section` and `menuTree` are applied sections; their fields are
classified in `super-productivity-boards.ts` and listed in the parity
manifest. Each board, section and folder is recorded once by source ID in
`task_import_sources`; a repeated import of the same bytes changes nothing
and a changed source fails the whole import. Panel manual orders, section
members and folder items resolve through the batch's task, project and tag
IDs; references to records absent from the export are reported as
non-blocking `board_notice` findings and dropped, as are archived tasks
(history is read-only). Unknown tags or projects in a filter, unknown state
codes (the panel shows all tasks for that field) and unknown sort fields (the
panel keeps its manual order) are reported and dropped, as the source itself
tolerates them. Unreviewed fields, a missing title, a contextType other than
`PROJECT` or `TAG`, and a filter that includes and excludes the same tag or
marker block apply. Items already placed in a folder by an earlier import
keep that folder. Markers apply to newly imported tasks only.

## Consequences

- Exports with boards, sections, folders and priority or in-progress tags no
  longer block. The September 25 backup's boards would import with all seven
  panel filters expressed as markers; a real qualification import remains
  #47.
- Tests cover matching and move planning in the domain package, revisions,
  owner isolation, pruning, import idempotency, restart and backup in
  persistence, and HTTP, assistant preview/confirm and the import endpoint in
  the server.
- Boards, sections, views and folders need a connection until offline
  structural writes are designed (#92). The browser uses buttons and a
  confirmation dialog rather than drag-and-drop; the source's date dialog for
  scheduled-only panels is not reproduced.
- Sections of the Today view and a `timeSpent` sort beyond 366 days remain
  open.
