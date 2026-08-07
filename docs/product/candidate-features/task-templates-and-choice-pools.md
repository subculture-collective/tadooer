# Candidate Feature: Task Templates and Choice Pools

## Status

The Task Template and Template Set portion was accepted and implemented in
Phase 5 on 2026-08-07. Choice Pools and Planning Placeholders are now governed
by the accepted Phase 6 authority decision in ADR 0013: cooldown begins at
selection, generated work is attached as subtasks to an ordinary parent task,
and the parent's calendar placement remains authoritative.

## Goal

Let a person preserve reusable work without filling ordinary task views with
inactive copies, and let a vaguely planned block be resolved later by choosing
eligible activities from a reusable pool.

The motivating workflows are:

- A sporadic task that should be easy to recreate but should not recur on a
  schedule.
- A reusable set of general tasks that can be instantiated into a project.
- A workout or practice block whose exact exercises are chosen during a later
  planning session.
- A rotation that encourages variety by temporarily excluding recently chosen
  items, exhausting a set before repeating, or permanently retiring one-shot
  items.

## Product language

### Task Template

An inert blueprint from which the user creates an independent real task. It may
contain a title, notes, estimate, tags, task settings, and subtask blueprints,
but it has no active-task status, schedule, reminder, timer, or completion state.

A template appears only in the Template Library, template search, and explicit
creation pickers. It does not appear in Today, projects, the planner, calendar,
overdue views, task counters, reminder evaluation, or time tracking.

### Template Set

An ordered collection of task templates that can be instantiated together. A
set may suggest a destination project, but creating project templates or
silently creating a project is a separate scope decision.

### Choice Pool

A named collection of reusable candidate items, such as leg exercises, songs to
practice, maintenance chores, meals, drills, or review prompts. A pool retains
selection and completion history so it can calculate which items are currently
eligible.

### Pool Item

A selectable blueprint inside a Choice Pool. It can create a subtask, a normal
task, or another deliberately supported result when selected. It is not an
active task merely because it exists in the pool.

### Planning Placeholder

A real planned task or time block whose detailed contents are intentionally
unresolved. During a planning session, the user fills one or more slots by
selecting or accepting suggestions from a Choice Pool. The selections then
become concrete tasks or subtasks and follow ordinary task behavior.

_Avoid_: treating an unresolved pool item as an overdue, incomplete, or hidden
ordinary task.

## In scope

### Task template behavior

- Create a template from scratch or from an existing task.
- Instantiate one independent task from a template.
- Instantiate a Template Set into a selected existing project.
- Copy subtask blueprints into new independent subtasks.
- Allow an optional suggested destination project without requiring it.
- Edit or archive the template without changing tasks already instantiated from
  it.
- Retain provenance on an instantiated task so the UI can say which template
  created it and offer to create another.
- Synchronize templates as first-class template data rather than disguising them
  as unscheduled tasks.

### Choice-pool behavior

- Create and edit a named pool and its candidate items.
- Manually choose from currently eligible items.
- Ask the system to suggest eligible items without silently committing them.
- Choose a configured number of unique items for one planning resolution, such
  as three exercises for a leg-day block.
- Make selected items temporarily ineligible for a duration, such as five days.
- Support a cycle-without-replacement policy: do not repeat an item until every
  active item in the pool has been selected once.
- Support one-shot items that retire after selection or completion.
- Show why an item is unavailable and when it becomes eligible again.
- Keep an append-only selection/completion history sufficient to recalculate and
  explain eligibility.
- Permit an explicit override while recording that the cooldown or cycle was
  bypassed.

### Planning composition

- A Task Template may include one or more unresolved Choice Pool slots.
- A normal task or planned block may be converted into a Planning Placeholder.
- Resolving a placeholder previews the proposed concrete tasks/subtasks before
  committing them.
- Resolution is idempotent: retrying the same committed resolution cannot create
  duplicate tasks.
- Calendar time remains attached to the parent block unless the user explicitly
  schedules generated children separately.

## Example

```text
Template: Leg Day
Estimate: 60 minutes
Subtasks:
  - Warm up
  - Choice Pool slot: choose 3 from "Leg exercises"
  - Cool down

Choice Pool: Leg exercises
Selection policy:
  - choose 3 unique items per resolution
  - selected items cool down for 5 days

Items:
  - Squat
  - Romanian deadlift
  - Lunge
  - Leg press
  - Leg curl
  - Calf raise

Monday planning:
  1. Instantiate Leg Day into the Fitness project.
  2. Preview three currently eligible exercises.
  3. Replace any suggestion manually if desired.
  4. Confirm.
  5. The three exercises become real subtasks.
  6. Those items display "available again Saturday" in the pool.
```

## Out of scope until separately accepted

- Treating every unscheduled task as a template.
- Retroactively updating instantiated tasks when a template changes.
- Automatically generating a complete project merely because a template has a
  suggested destination.
- General workflow automation or an unrestricted rules engine.
- Health, coaching, load, injury, or medical recommendations for workout pools.
- Algorithmically claiming an activity is optimal.
- Automatically scheduling generated tasks into calendar gaps without preview.
- Competitive streaks, scores, or engagement notifications.
- Requiring choice pools for ordinary recurring tasks.

## Constraints and decisions

- Templates and pool items are not hidden ordinary tasks. They have separate
  identities, storage, query surfaces, and lifecycle rules.
- Instantiation copies a snapshot by default; it does not create a live link
  whose later edits mutate already planned work.
- "Choose three every five days" is decomposed into two independent policies:
  a selection count of three and a per-item cooldown of five days.
- Eligibility is derived from explicit policy plus recorded history and must be
  explainable to the user.
- Selection and completion are distinct events. Phase 6 eligibility and
  cooldown use selection time; completion remains append-only reporting data.
- Removing an item from a pool does not delete historical tasks or selection
  records.
- Sync conflict behavior must preserve committed history and prevent two devices
  from unknowingly selecting the same supposedly unique slot.
- MCP automation may list templates, preview instantiation, and preview pool
  resolution. Mutating operations follow the suite's confirmation and
  idempotency rules.

## Acceptance criteria

- A template can be created and later instantiated without appearing in any
  active-task query before instantiation.
- Instantiation creates a normal independent task with copied content and a new
  task identity.
- A template with subtasks produces the expected independent task tree exactly
  once.
- A pool can explain every eligible and ineligible item at a given logical time.
- A cooldown prevents normal reselection until its boundary and becomes eligible
  deterministically at that boundary.
- A cycle-without-replacement policy selects every active item before repeating
  one, including after synchronization and restart.
- One-shot behavior retires the item at the configured event without deleting
  its history.
- Resolving a placeholder previews and then creates the selected concrete work
  exactly once.
- Two devices resolving the same placeholder receive a deterministic committed
  result or an explicit conflict; they cannot silently produce two sets.
- Template, pool, and history exports preserve enough information for backup and
  restore.

## Verification

- Pure policy tests with an injected logical clock for cooldown boundaries,
  cycles, overrides, retirement, and item additions/removals.
- Property tests for no duplicate selections within one committed resolution and
  no repetition before cycle exhaustion.
- Two-client synchronization tests that race resolution of the same placeholder.
- Browser E2E covering template creation, template instantiation, pool preview,
  manual replacement, confirmation, and resulting task/subtask display.
- Backup/restore round trip including template provenance and pool history.
- MCP contract tests for list, preview, confirm, retry, and conflict behavior.

## Resolved Phase 6 questions

The trailing phrase "Also, maybe we have an option to make a task ..." was an
abandoned start of the Task Template requirement, not an additional feature.

1. Cooldown starts when an item is selected.
2. Pool items produce ordered subtasks on the placeholder's parent task.
3. The placeholder is attached to a normal planning task; calendar time remains
   on that parent and is not copied to generated subtasks.
4. When a project suggested by a template does not exist, should instantiation
   ask for another destination, create it after preview, or instantiate into an
   Inbox?
5. Is a Template Set sufficient for the initial feature, leaving full Project
   Templates for later?
6. Should pool history record selection only, completion only, or both while
   eligibility chooses one as its trigger?

## Recommended route

Lightweight plan after the task model and synchronization contracts are defined.
Implement inert single-task templates first, then template subtasks, then manual
Choice Pools with history, and only then policy-driven suggestions and planning
placeholder composition. Keep Project Templates and automatic calendar packing
outside the first slice.
