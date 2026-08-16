---
status: accepted
---

# Resolve choice pools with an explainable logical-time authority

Phase 6 adds Choice Pools and Planning Placeholders without turning reusable
candidate items into hidden tasks. A pool, its items, and its append-only
history are first-class owner-scoped records. A placeholder is an ordinary
planned parent task with an unresolved pool reference; only a confirmed
resolution creates ordinary subtasks.

## Eligibility is pure and evaluated at an explicit instant

Every eligibility calculation accepts an ISO timestamp rather than reading the
wall clock internally. A pool configures a pick count and a policy:

- `cooldown`: selection starts the per-item cooldown; an item is eligible at
  the exact `selectedAt + cooldownSeconds` boundary;
- `cycle`: an active item cannot repeat until every currently active item has
  been selected in the cycle; when a cycle is exhausted, the next resolution
  starts a new cycle;
- `one_shot`: an item retires immediately when selected, while its history is
  retained; and
- `none`: every active item is eligible.

Suggestions use deterministic ordering: least recently selected first, then
item position, then item identity. They never mutate state. Every item returns
an eligibility flag, a stable reason code, and an optional next-eligible
boundary. An explicit manual override may select an otherwise unavailable item,
but the committed history records that the policy was bypassed.

Completion is a separate append-only event for reporting. It does not drive
Phase 6 eligibility; selection does. This removes the open ambiguity without
conflating generated-task completion with pool policy.

## Placeholders preserve their parent planning identity

A Planning Placeholder is attached to one active task and one active pool. It
stores the required pick count and revision. The parent task may carry planner
or calendar placement; generated subtasks are not scheduled independently.
Template pool slots are represented as inert blueprint references and become
placeholders when the template is instantiated.

Resolution input contains the placeholder revision and a unique ordered list
of item identities. The server re-evaluates eligibility at the supplied logical
time, validates pick count and ownership, records one selection event per item,
creates ordered subtasks, and marks the placeholder resolved in one SQLite
transaction. The durable idempotency record includes owner, placeholder,
revision, item order, override flag, and logical time. A same-request retry
returns the original history and subtask identities; a changed request or stale
revision conflicts without partial work.

Two clients may preview concurrently, but only the first valid confirmation can
advance the placeholder revision. The other receives the committed result when
retrying that exact request or an explicit stale/conflict response. Silent
double resolution is impossible.

## Sync, automation, and backup expose the same authority

Pool snapshots bundle ordered active and archived items. Placeholder snapshots
bundle the committed resolution when present. Selection and completion history
is append-only and included in pool reads and SQLite backup; sync changes carry
pool and placeholder snapshots, never fabricated task records.

The shared automation catalog adds `pools.list` and confirmed
`placeholders.resolve`. Automation preview captures pool, placeholder, parent
task, and selected-item revisions and returns the same eligibility explanation
as the browser API. Confirmation executes the same persistence operation.
MCP remains local stdio and catalog-derived.

## Required evidence

- logical-clock and property tests cover cooldown boundaries, unique picks,
  cycle exhaustion, item additions/removals, one-shot retirement, and override;
- suggestions have no database side effects and explain every unavailable item;
- retry and restart cannot duplicate history or generated subtasks;
- two registered clients racing one placeholder get one committed resolution;
- pool, item, placeholder, and history data survive sync and backup/restore; and
- browser and MCP paths use preview/confirmation and expose no direct mutation
  bypass.
