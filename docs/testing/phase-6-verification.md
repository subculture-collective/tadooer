# Phase 6 verification

Phase 6 is qualified only when Choice Pools remain inert, eligibility is
explainable at an injected logical time, and one Planning Placeholder can be
resolved exactly once through browser and local MCP authority.

## Pure policy gate

- At least `pickCount` unique active items are required for a normal suggestion.
- Cooldown rejects an item immediately before its boundary and accepts it at
  the boundary.
- Cycle mode does not repeat an active item before cycle exhaustion and handles
  active item additions and archives deterministically.
- One-shot selection retires an item without removing its history.
- Override admits an unavailable item and marks its selection event overridden.
- Every inactive or policy-blocked item has a stable reason and optional
  `eligibleAt` value.

## Persistence and HTTP gate

- Migration 0010 creates dedicated pool, item, history, placeholder, resolution,
  and template-slot tables.
- Listing tasks and planner results before resolution returns no pool item.
- Suggestion is read-only.
- Resolution atomically creates the required ordered subtasks, selection
  history, and a durable resolved placeholder.
- Same-key retry after server restart returns byte-equivalent identities.
- Same key with changed selections conflicts; stale placeholder revision fails.
- Two clients resolving one revision cannot both commit different selections.
- Pool and placeholder sync snapshots preserve item order, history, resolution,
  and revision without disguising reusable records as tasks.

## UI and automation gate

- The authenticated workspace can create a pool, edit its ordered candidates,
  create a placeholder on an existing task, inspect eligibility reasons,
  replace suggestions manually, confirm, and see generated subtasks.
- A narrowly scoped automation token can list pools but not tasks unless it has
  both scopes.
- MCP exposes catalog-derived pool reads and placeholder preview/confirm tools.
- Preview has no side effect; stale confirmation fails; retry returns the same
  result; revocation remains fail closed.

## Disposable runtime gate

The Phase 6 verifier starts a fresh Compose project, creates a pool and
placeholder, resolves it through the built stdio MCP adapter, retries after a
Suite restart, backs up the database, restores it, and proves one resolution,
one ordered subtask set, retained history, and identical replay identities.
