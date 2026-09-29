---
status: accepted
---

# Assistant authoring operations for templates, sets, pools and placeholders

Issue #57 (parent #32, inventory #19, roadmap #15). Builds on the reusable
work library of ADR 0012, the choice pools and planning placeholders of ADR
0013, the preview/confirm protocol of ADR 0011 and the confirmation
categories of #33. `templates.instantiate`, `template_sets.instantiate` and
`placeholders.resolve` are unchanged.

Before this change the assistant could read the template, set and pool
libraries and instantiate or resolve from them, but every authoring step
(`createTemplate`, `createTemplateFromTask`, `patchTemplate`,
`archiveTemplate`, `createTemplateSet`, `createChoicePool`,
`patchChoicePool`, `createTemplatePoolSlot`, `recordChoicePoolCompletion`,
`createPlanningPlaceholder`, `suggestPlanningPlaceholder` in
`apps/web/src/api.ts`) was browser-only. The capability inventory listed both
rows as gaps.

## Current browser behaviour (inventory)

- `POST /api/templates` creates a template with title, notes, estimate,
  suggested project, tags and subtask blueprints; the project and tags must
  be active owner records (400 `INVALID_TEMPLATE_REFERENCES`).
- `POST /api/templates/from-task/:id` copies the task's title, notes,
  estimate, active project, active tags and subtasks into a new template.
- `PATCH /api/templates/:id` with `If-Match` replaces the given fields; a
  subtask list replaces every blueprint (412 on revision drift).
- `POST /api/templates/:id/archive` with `If-Match` archives (412 on drift).
- `POST /api/templates/:id/pool-slots` adds a slot naming a pool, pick count
  and position; the pool must have at least `pickCount` active items (409).
- `POST /api/template-sets` creates a set from one to one hundred distinct
  active templates (400 on an archived or foreign member).
- `POST /api/pools` creates a pool with policy, pick count, optional cooldown
  and one to 250 items; `PATCH /api/pools/:id` with `If-Match` replaces the
  pool fields and item list (items keep their identity by ID or by title;
  missing items are archived).
- `POST /api/pools/:id/items/:itemId/completions` records a completion event
  with an optional placeholder reference and an explicit `occurredAt`.
- `POST /api/placeholders` attaches a placeholder to a task and pool; the
  pick count defaults to the pool's and must not exceed the active items.
- `GET /api/placeholders/:id/suggestion?at=` evaluates the pool policy at a
  logical time and returns the selection, cycle and per-item eligibility.

## Decision

### Catalog

Five entries join the catalog; the existing scopes are enough.

| Entry                     | Kind     | Scope             | Input                                                                         |
| ------------------------- | -------- | ----------------- | ----------------------------------------------------------------------------- |
| `templates.mutate`        | tool     | `templates:write` | `action` = `create`, `create_from_task`, `update`, `archive`, `add_pool_slot` |
| `template_sets.create`    | tool     | `templates:write` | `title`, `templateIds`                                                        |
| `pools.mutate`            | tool     | `pools:write`     | `action` = `create`, `update`, `record_completion`                            |
| `placeholders.create`     | tool     | `pools:write`     | `taskId`, `poolId`, optional `pickCount`                                      |
| `placeholders.suggestion` | resource | `pools:read`      | `placeholderId`, optional `at`                                                |

The inputs reuse the browser request schemas field for field, with the
entity ID and `expectedRevision` (or `expectedTaskRevision` for
`create_from_task`) added where the browser sends `If-Match`. The pool-slot
action lives under `templates.mutate` because a slot changes what
instantiating the template produces; it reads the pool but does not need
`pools:write`. The resource is a tool with a `suite://v1/placeholder-suggestion`
URI like the other parameterised resources.

Results are strict objects: `{ template, blueprints, poolSlots }`,
`{ set, members }`, `{ pool, items, history }` and `{ placeholder }`.

### Previews and revision binding

Each preview repeats the browser validation, names every reference it
checked and freezes the revisions the confirmation depends on:

- `create` freezes the suggested project and each tag; `create_from_task`
  freezes the source task so an edit to the task between preview and
  confirmation is stale; `update`, `archive` and `add_pool_slot` freeze the
  template (a slot also freezes the pool); a set freezes each member
  template; a pool `update` freezes the pool and every item it keeps by ID;
  `record_completion` freezes the pool, the item and, when given, the
  placeholder; `placeholders.create` freezes the task and the pool.
- An `expectedRevision` that does not match the current record is rejected at
  preview (412 `REVISION_CONFLICT`); an archived or foreign reference is 404
  or 409 with the browser's code. New records have no revision to freeze;
  their IDs are minted at confirmation.
- The confirmation runs the same checks again inside the receipt transaction.
  The generic stale check already knows templates, sets, pools, items,
  placeholders, tasks, projects and tags.

Archiving is the only destructive action here and needs the same explicit
confirmation as every other tool; no action deletes, so the bulk category of
#33 does not apply. Summaries name the record and, for an update, the fields
that change.

### Atomic commit

`completeAutomationConfirmation` consumes the preview, writes the outcome and
the audit row and runs the mutation in one `BEGIN IMMEDIATE` transaction.
The template, set, pool and placeholder store methods opened their own
transaction, which SQLite rejects inside another. They now go through a
`#beginWrite` helper that starts a transaction when none is open and a
savepoint otherwise, so the same method serves the browser routes and the
assistant. `appendSyncChange` gets the same treatment because the slot and
completion methods call it.

### Replay

A confirmation replay with the same idempotency key returns the stored
result with `replayed: true` and creates nothing; a different preview under
the same key is `IDEMPOTENCY_CONFLICT`. IDs minted at confirmation are
therefore stable per receipt.

## Consequences

- No migration. The persistence migration count stays 36 on this branch.
- Set archive and pool archive have no browser API and stay out of the
  catalog; item-level edits go through the pool `update` action as in the
  browser.
- A `templates:write` credential can reference any active owner pool in a
  slot; that mirrors the browser, where the same session authors both.

## Verification

- `packages/contracts/src/index.test.ts`: catalog size, scopes and input
  parsing for the new entries; `automation-coverage.test.ts` keeps the
  inventory rows aligned with the catalog and `api.ts`.
- `apps/server/src/automation-authoring.test.ts`: scope denial, each action
  through preview and confirmation, stale library revisions at preview and
  after a browser edit, a source-task edit before confirmation, unavailable
  project, tag, template, pool and item references, slot pick counts,
  completion history, placeholder creation and suggestion, audit rows and an
  identical replay.
- Client evidence with an installed Codex or Claude runtime remains #39.
