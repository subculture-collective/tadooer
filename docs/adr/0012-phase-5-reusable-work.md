---
status: accepted
---

# Keep reusable work inert and instantiate immutable snapshots

Phase 5 adds Task Templates and Template Sets as Suite-owned reusable work.
They are separate first-class records rather than incomplete, unscheduled, or
hidden tasks. Ordinary task, planner, reminder, focus, and time-tracking
queries therefore cannot see a template before it is explicitly instantiated.
Choice Pools and Planning Placeholders remain Phase 6 work.

## Templates and sets have a deliberately small model

A Task Template stores a title, notes, optional estimate, tag references,
optional suggested project, and an ordered list of one-level subtask
blueprints. It has its own identity, revision, archive lifecycle, query
surface, sync snapshot, and backup representation. Creating a template from an
existing task copies only those reusable fields. It never copies task status,
completion, deletion, planning, calendar mappings, reminders, or focus state.

A Template Set is an ordered collection of existing, active Task Templates.
It is not a Project Template and never creates a project. A suggested project
is advisory UI state only. Instantiating either a template or a set requires
the caller to select an existing, active project owned by the same owner.

## Instantiation is one atomic copy operation

Instantiation reads the selected template revisions and copies their current
contents into independent ordinary tasks, task-tag relationships, and ordered
subtasks. It records the source template identity, revision, immutable source
snapshot, and resulting task identities as provenance. Later edits or archive
actions on a template or set cannot mutate already-instantiated work.

The entire tree or set is committed in one SQLite transaction. Its durable
idempotency boundary includes owner, source kind and identity, destination,
and request hash. A retry with the same key and request returns the original
task and subtask identities, including after restart. Reusing the key for
another request conflicts without creating partial or duplicate work.

## Sync, backup, and automation preserve the boundary

Template and Template Set mutations append first-class sync changes. Sync
snapshots and client caches retain their distinct entity kinds; they are never
cast to tasks. Instantiation remains an online server-authoritative operation
in this phase, while the generated ordinary work converges through the normal
task and subtask change stream. This avoids introducing a second offline tree
creation authority before it has a separate conflict design.

The existing SQLite backup is the canonical backup artifact. Phase 5 evidence
must restore template content, ordered membership, provenance, immutable
instantiation snapshots, and idempotent outcomes from that artifact.

The shared Suite automation catalog adds scoped template and set resources and
preview-confirm instantiation tools. Preview captures the source and project
revisions but performs no mutation. Confirmation uses the same persistence
operation and idempotency contract as the browser. MCP remains the local stdio
transport accepted in Phase 4; Phase 5 does not broaden hosted exposure.

## Required evidence

- templates remain absent from every active-task and planning query;
- one template with ordered subtask blueprints instantiates exactly once
  across retry and restart;
- one ordered set instantiates into an explicitly selected existing project;
- editing or archiving a source does not change prior instantiated work;
- another sync client receives distinct template and set snapshots/changes;
- backup and restore retain library data, provenance, and retry outcomes; and
- MCP list, preview, confirmation, replay, stale-preview, and revocation paths
  remain catalog-derived and scope checked.
