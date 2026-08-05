# Feature Prioritization

**Status:** Approved 2026-08-05 for roadmap and backlog decisions.

## Goal

Choose implementation order by the user journey, dependency graph, contract
risk, and observable evidence—not by Super Productivity parity, novelty, or the
ease of producing isolated UI.

## The product loop

Every candidate feature should strengthen at least one part of the primary loop:

```text
Capture → Plan against real time → Focus and track → Adapt and reuse
    ↑                                                  ↓
    └──────────── Calendar and automation context ─────┘
```

The first complete product must let one owner:

1. Deploy and sign in.
2. See existing Baikal events and availability.
3. Capture a task.
4. Place the task into real calendar time.
5. Start, pause, resume, and finish work or a break.
6. Observe and safely take over the active session from another device.
7. Ask the MCP to read or preview the same state through explicit permissions.

Anything that does not help complete or validate this loop is not first-slice
work, even when it is desirable.

## Ordering rules

Apply these gates in order. A feature that fails an earlier gate does not advance
because it scores well on a later one.

### Gate 1: Product fit

- Does it make capture, planning, focus, adaptation, or safe automation better?
- Is it a calm building block rather than a new stream of alerts or maintenance?
- Can it remain optional without fragmenting the basic workflow?
- Does it respect local-first behavior and explicit external-data consent?

Features with no clear job are declined or left in the candidate notebook.

### Gate 2: Dependency and vertical-slice fit

- What domain objects, APIs, synchronization semantics, and UI primitives must
  already exist?
- Can the feature be proven in the current end-to-end slice?
- Does it unlock several later features?

Foundations move earlier only when a vertical slice consumes them. Avoid months
of infrastructure with no usable product path.

### Gate 3: Contract and safety risk

Move costly-to-reverse questions earlier for design and testing:

- Persisted identity and ownership
- Offline writes and multi-device conflicts
- Calendar UID, recurrence, href, and revision semantics
- Active-session ownership, takeover, expiry, and recovery
- Connector credentials and authorization scopes
- Import idempotency and provenance
- MCP mutation, preview, confirmation, and retry behavior

This does not mean implementing every risky feature first. It means proving the
contract with fixtures before dependent UI multiplies the cost of changing it.

### Gate 4: User value and frequency

Among dependency-ready candidates, prefer the feature that:

- Removes the most repeated friction from the product loop
- Benefits the broadest set of intended users
- Makes the product useful on more days, not merely more configurable
- Provides a meaningful advantage over using a task list and calendar separately

### Gate 5: Evidence and effort

Use an ordinal comparison rather than false numerical precision:

| Dimension | Low | Medium | High |
| --- | --- | --- | --- |
| Journey impact | Cosmetic or peripheral | Improves one step | Completes/unlocks the loop |
| Frequency | Rare setup | Weekly/planning | Daily/repeated |
| Unlocks | Isolated | One dependent feature | Several roadmap slices |
| Risk retired | Little new learning | Tests one contract | Resolves a major uncertainty |
| Confidence | Assumption | Comparable evidence | Reproduction/user evidence |
| Effort | Days | Weeks | Multi-month |

Prefer high journey impact, frequency, unlocks, risk retirement, and confidence
at lower effort. Record why an exception is made.

## Priority states

- **Now:** required by the single active vertical slice. Keep this list small.
- **Next:** dependency-ready and likely to enter the following slice.
- **Later:** approved direction with unmet dependencies or lower current value.
- **Candidate:** captured but not yet approved or sequenced.
- **Declined:** intentionally excluded, with the reason retained.

No feature enters **Now** without:

- An observable user outcome
- Explicit non-goals
- Persisted/API contract review when applicable
- Acceptance criteria
- A proportional verification plan
- A rollback or safe failure behavior for external writes

## Current application

| Feature | State | Reason |
| --- | --- | --- |
| First-run owner and two-container deployment | Now | Required to reach any self-hosted workflow |
| Basic task capture/edit/complete | Now | Starts the primary loop |
| Existing Baikal discovery and event projection | Now | Supplies real planning context |
| Plan one task into Baikal calendar time | Now | Proves the task/calendar product thesis |
| Persisted task state and backup | Now | Prevents a disposable demo from masquerading as a product |
| New sync and active-session contracts | Next, contract spike now | Required before multi-device focus can ship safely |
| Two-device timer/focus/break handoff | Next | Completes the cross-device focus loop after sync foundation |
| Google live calendar connector | Next, OAuth spike early | High user value; provider risk should be learned before broad UI |
| Core MCP read and preview operations | Next, contract spike early | Shapes a stable suite API without exposing premature mutations |
| Projects, tags, subtasks, and estimates | Next | Everyday organization once the core loop is coherent |
| Availability-aware quiet reminders | Next | Connects calendar state to calm work behavior |
| Task Templates | Later, first reusable-work slice | Depends on stable task creation/copy semantics |
| Template Sets | Later, after Task Templates | Reuses template instantiation and destination selection |
| Choice Pools and history | Later | Depends on task templates, logical time, persistence, and sync |
| Planning Placeholders | Later | Composes stable templates, pools, task planning, and calendar blocks |
| One-time calendar migration into Baikal | Later | Needs provider identity, recurrence-safe writes, and reconciliation reports |
| Read-only published ICS capability URLs | Later | Valuable interoperability, not required for the primary loop |
| Super Productivity/task-app importers | Candidate/Later | New-user product; build the common import contract before source breadth |
| Project Templates | Candidate | Template Sets may solve the workflow with less permanent scope |
| One-way provider mirrors | Candidate | Only after a demonstrated Baikal-only client need |
| Bidirectional provider mirrors | Declined by default | Creates competing event authorities and conflict loops |
| Full Super Productivity parity | Declined | Contradicts Greenfield new-user scope |

## Review cadence

Re-evaluate **Now** at the end of every vertical slice. Move features only when
new evidence or a resolved dependency changes their position. Do not reorder the
roadmap merely because a feature was recently discussed.
