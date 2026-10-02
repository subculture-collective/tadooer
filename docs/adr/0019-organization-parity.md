# ADR 0019: Organization parity for projects, tags, backlogs and notes

Status: accepted, 2026-09-24. Issue: #28. Source reference: Super Productivity
19.1.0 (`project`, `tag`, `note`, `menu-tree`, `work-view/backlog`).

## Context

Projects and tags had a title, a revision and an archive flag. Super Productivity
also stores project colour and icon, menu order and folders, hide-from-menu,
completion, a per-project backlog, and notes attached to projects. Its Today,
urgent, important and in-progress tags are system tags. Imports blocked on most
of these fields.

## Decisions

1. **Appearance.** Projects and tags store a six-digit hex colour (lowercase)
   and an icon. An icon is a Material Symbols ligature name (`work`) or one
   emoji sequence. Icons render as text. Theme blobs are not stored; an import
   takes a project colour from a valid `theme.primary` and keeps the rest of the
   theme in import provenance.
2. **Order.** Projects and tags have an integer `position`. Reorder is a
   complete-membership operation: every record with its current revision. Stale
   or partial lists fail with 412. Only moved records gain a revision and a sync
   change. Migration 0022 backfills positions in the previous title order.
3. **Lifecycle.** Completing a project sets `completedAt` and archives it.
   Reopening clears both. Restoring an archived project also clears completion,
   as Super Productivity's unarchive does. Archive and completion cannot change
   in one request. Tags archive and restore only. Task assignments survive every
   lifecycle change.
4. **Hide from menu.** `hiddenFromMenu` removes a project from the task project
   filter. Hidden projects remain assignable and appear in the manager.
5. **Backlog.** A project with `backlogEnabled` owns an ordered list of its
   active tasks (`backlogTaskIds`). Membership changes the project revision, not
   the task. Moving a task to another project removes it from the old backlog.
   Deleted tasks leave the list and return when restored. Disabling the backlog
   returns its tasks to the regular list, as in Super Productivity.
6. **Folders deferred.** Menu folders are not modelled. An import flattens
   `menuTree` depth-first into project and tag order and reports that folders
   were not imported. Folder grouping belongs with board and view structure
   (#63), which needs its own structural sync rules.
7. **Notes.** A note is owner-scoped Markdown text (up to 20,000 characters)
   attached to one project, one tag or neither, with `pinnedToToday`, a global
   `position` and a revision. Setting one association clears the other. Deletion
   is permanent. The web client renders a safe subset: headings, paragraphs,
   bullet, numbered and checkbox lists, quotes, fenced and inline code, bold,
   italic, `[text](url)` and bare URLs. Links accept only `http`, `https` and
   `mailto`; HTML is displayed as text.
8. **System tags.** Today, urgent, important and in-progress stay derived views
   or board markers. The importer never creates ordinary tags for `TODAY`,
   `EM_URGENT`, `EM_IMPORTANT` or `KANBAN_IN_PROGRESS`. A Today view with task
   order, or a marker that tasks use, blocks apply until #29 or #63.
9. **Sync.** New project and tag fields travel in the existing project and tag
   snapshots of the sync change feed and are cached read-only. Snapshot schema
   defaults keep pre-0022 caches readable. Notes are not in the change feed or
   the offline cache: they are read and written over HTTP only. All organization
   and note writes are online HTTP requests with revisions until offline writes
   are designed (#92).
10. **Assistant operations.** The catalog adds `projects.reorder`,
    `projects.set_backlog`, `tags.reorder`, `notes.list` and `notes.mutate`, and
    extends `projects.mutate`/`tags.mutate` with `configure`, plus `complete` and
    `reopen` for projects. Notes use new `notes:read` and `notes:write` scopes;
    existing tokens do not gain them. All writes use preview and confirmation
    with frozen revisions.

## Import mapping

Applied project fields: `created`, `icon`, `isArchived`, `isDone` with
`doneOn`, `isHiddenFromMenu`, `isEnableBacklog`, `backlogTaskIds` and
`noteIds` (note order). Applied tag fields: `created`, `color`, `icon`,
`isArchived`. Applied note fields: `id`, `projectId`, `content`,
`isPinnedToToday`, `created`. Super Productivity records no archive time, so an
archived project or tag uses the import time; a completed project uses `doneOn`.
Backlog entries for tasks missing from the export are reported and skipped.
Image notes (`imgUrl`) and legacy free-text `notes` on projects and tags still
block. Project `taskIds` (task order inside a project) and `note.todayOrder`
remain provenance only.

## Consequences

- Real exports with an empty Today tag and unused system tags no longer block.
- Task order inside a project, menu folders, and offline organization writes
  remain open (#63, #92).
- Notes need a connection. A later offline design must add note operations to
  the outbox with revision conflicts rather than overwrite silently.

> Note, 2026-10-02: [ADR 0046](0046-notes-in-the-sync-feed.md) is that
> design. Notes are sync feed records, cached offline and written through the
> outbox with one record revision. Decision 9 and the last consequence above
> describe the state before it.
