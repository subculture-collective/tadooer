# Feature Prioritization

**Status:** Framework approved August 5; current application reconciled September 20.
See [the current checkpoint](../STATUS.md) and [roadmap #15](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/15).

## Goal

Choose implementation order by the user journey, dependency graph, contract
risk, and observable evidence within the approved Super Productivity parity,
assistant-access and opt-in calendar-hub direction. Parity is a committed product
outcome; the feature matrix defines its scope and the dependency graph defines
implementation order.

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

This describes the original first-slice baseline. The September interview expands
the approved scope to source feature parity; it does not remove authority,
verification, or migration requirements.

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

| Dimension      | Low                    | Medium                | High                         |
| -------------- | ---------------------- | --------------------- | ---------------------------- |
| Journey impact | Cosmetic or peripheral | Improves one step     | Completes/unlocks the loop   |
| Frequency      | Rare setup             | Weekly/planning       | Daily/repeated               |
| Unlocks        | Isolated               | One dependent feature | Several roadmap slices       |
| Risk retired   | Little new learning    | Tests one contract    | Resolves a major uncertainty |
| Confidence     | Assumption             | Comparable evidence   | Reproduction/user evidence   |
| Effort         | Days                   | Weeks                 | Multi-month                  |

Prefer high journey impact, frequency, unlocks, risk retirement, and confidence
at lower effort. Record why an exception is made.

## Priority states

- **Now:** required by the single active vertical slice. Keep this list small.
- **Next:** dependency-ready and likely to enter the following slice.
- **Later:** approved direction with unmet dependencies or lower current value.
- **Candidate:** captured but not yet approved or sequenced.
- **Delivered:** implemented with the roadmap's recorded source and disposable
  qualification evidence. Any remaining production acceptance is listed
  separately as **Now**.
- **Declined:** intentionally excluded, with the reason retained.

No feature enters **Now** without:

- An observable user outcome
- Explicit non-goals
- Persisted/API contract review when applicable
- Acceptance criteria
- A proportional verification plan
- A rollback or safe failure behavior for external writes

## Current application

Development proceeds alongside the pinned production soak. A development PR,
local test, published image, deployment and stable qualification are separate
states. The [current checkpoint](../STATUS.md) records those evidence boundaries;
this table orders work without repeating deployment claims.

| Feature or outcome                                            | State                              | Evidence or entry condition                                                                                                                             |
| ------------------------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Core capture/planner/offline/focus/reusable-work product loop | Implemented baseline               | Historical phase evidence is retained in the roadmap; current candidate acceptance is separate.                                                         |
| Reliability and owner browser acceptance                      | Now                                | #14/#16 verify authenticated journeys and the reliability stack.                                                                                        |
| Pinned production soak                                        | Now, independent operational track | #21 requires natural health/backup/workflow observations; no routine feature deployment into the pinned run.                                            |
| Full Super Productivity parity                                | Approved; implementing             | #17 reference matrix and #31 children define source coverage. Prioritize archive/hierarchy/history/recurrence and daily-use gaps by their dependencies. |
| Super Productivity migration                                  | Now                                | #18 capacity, #38 archive mapping and capability gaps precede #47 full isolated reconciliation and #49 reviewed cutover. Preserve the source export.    |
| Assistant plugin/MCP parity                                   | Now                                | #19 inventory, #32 missing operations and #33 consequential-action policy; actual clients #39 remain separately qualified.                              |
| Opt-in Google/Baikal bidirectional hub                        | Approved; contract first           | #20/ADR 0017 precede #35/#36/#40/#45/#46/#48 and real provider qualification #50. Google is the first provider.                                         |
| Hosted MCP                                                    | Next, dependency-bound             | Scoped OAuth #34 before transport #43; no shared owner credential at a public endpoint.                                                                 |
| Embedded subscription-backed assistance                       | Conditional                        | #44 requires actual runtime/account support; otherwise retain plugin/MCP access. No implicit paid API fallback.                                         |
| Other import adapters                                         | Later                              | #51 follows Super Productivity; each needs a representative source and reconciliation proof.                                                            |
| Bundled or operator-configured external Baikal                | Approved                           | #35 preserves credential isolation and safe endpoint configuration; an arbitrary browser-supplied URL is not implied.                                   |
| Mobile / PostgreSQL / multi-user                              | Decision-gated                     | #24/#25/#26 retain platform, measured-capacity and authorization/sharing prerequisites.                                                                 |
| Architecture and visual cleanup                               | Bounded follow-on                  | #74–#76 replace stale unchecked implementation plans; preserve transaction and browser behavior.                                                        |
| Post-parity differentiation                                   | Later                              | #52 follows the parity baseline and evidence of unmet workflow needs.                                                                                   |

## Review cadence

Re-evaluate **Now** at the end of every vertical slice. Move features only when
new evidence or a resolved dependency changes their position. Record explicit user priority changes in the interview/issue roadmap, then
reconcile dependencies and acceptance criteria before implementation.
