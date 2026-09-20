# Feature Prioritization

**Status:** Framework approved 2026-08-05. Current application refreshed
2026-08-14 after the Phase 12 implementation checkpoint.

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

The implementation roadmap has advanced through the Phase 12 qualification
tooling. The active **Now** slice is operational qualification for `1.0.0`, not
another unreviewed feature expansion. The selected post-1.0 **Next** wave is the
Actionable Today Queue: a bounded daily workflow that composes existing task,
calendar, focus, and offline contracts without adding a persisted priority or
ranking model. This selection does not waive the active production acceptance
and stable-promotion gates.

| Feature or outcome                                                                                                                                                      | State               | Evidence or entry condition                                                                                                                 |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Core self-hosted loop: owner setup, task capture, Baïkal projection, calendar placement, persistence, and recovery                                                      | Delivered           | Completed through Phases 0–1                                                                                                                |
| Local-first task sync, projects, tags, subtasks, estimates, and cross-device focus/break handoff                                                                        | Delivered           | Completed in Phase 2                                                                                                                        |
| Google federation, calm daily planning, freshness, and reminder suppression rules                                                                                       | Delivered           | Completed and live-qualified in Phase 3                                                                                                     |
| Scoped MCP/HTTP automation with preview, confirmation, audit, and retry safety                                                                                          | Delivered           | Completed in Phase 4                                                                                                                        |
| Task Templates, Template Sets, independent instantiation, and provenance                                                                                                | Delivered           | Completed in Phase 5                                                                                                                        |
| Choice Pools, policy history, suggestions, and Planning Placeholder resolution                                                                                          | Delivered           | Completed in Phase 6                                                                                                                        |
| Provenance-aware calendar import, one-time migration, ICS export, and revocable read-only publication                                                                   | Delivered           | Completed in Phase 7                                                                                                                        |
| Constrained Linux Electron packaging, immutable release channels, rollback, metrics, and production qualification tooling                                               | Delivered           | Completed in Phase 8                                                                                                                        |
| Route-backed calm daily workspace, search, organization filters, time-zone correctness, and provider-aware calendar filtering                                           | Delivered           | Completed in Phase 10                                                                                                                       |
| Durable ntfy reminder claims, retries, suppression, redaction, and browser settings                                                                                     | Delivered           | Source and disposable deployment qualification completed in Phase 11                                                                        |
| Production owner creation plus explicit Baïkal and Google authorization                                                                                                 | Now                 | Required to close Phase 9 and start the production soak                                                                                     |
| Live authenticated ntfy delivery acceptance                                                                                                                             | Now                 | Required to close the Phase 11 production acceptance gate                                                                                   |
| Seven-day production soak and stable `1.0.0` promotion                                                                                                                  | Now                 | Starts only after production owner, calendars, and ntfy are configured; any failed required observation or P0/P1 restarts qualification     |
| Actionable Today Queue: automatic overdue/today queue, separate unscheduled planning, inline capture/calendar/focus/completion actions, and explicit offline boundaries | Deployed candidate | Immutable Phase 13 candidate deployed 2026-08-21 after focused/full gates and local authenticated-browser qualification; public production checks passed, authenticated production interaction and the Phase 12 soak remain separate |
| Super Productivity, Apple Reminders, Google Tasks, and other task-app source adapters                                                                                   | Candidate           | The common import contract exists, but source breadth needs a selected user outcome and representative fixtures                             |
| Project Templates                                                                                                                                                       | Candidate           | Enter only if Template Sets plus explicit destination selection demonstrably fail the workflow                                              |
| One-way provider mirrors                                                                                                                                                | Candidate           | Enter only after a demonstrated client limitation and a separate authority/reconciliation review                                            |
| Hosted MCP transport                                                                                                                                                    | Candidate           | Requires a separate authentication, token-delivery, revocation, rate-limit, and deployment decision                                         |
| User-configurable external CalDAV origins                                                                                                                               | Candidate           | Requires dedicated SSRF, DNS-rebinding, TLS, redirect, credential-isolation, and revocation contracts                                       |
| Android/iOS delivery                                                                                                                                                    | Candidate           | Requires platform-specific offline/background behavior and credential-storage design                                                        |
| PostgreSQL adapter                                                                                                                                                      | Candidate           | Enter only after measured SQLite concurrency, availability, or deployment limits                                                            |
| Multi-user mode                                                                                                                                                         | Candidate           | Requires an owner-scoped authorization audit and explicit sharing/administration contracts                                                  |
| Bidirectional provider mirrors                                                                                                                                          | Declined by default | Creates competing event authorities and conflict loops                                                                                      |
| Full Super Productivity parity                                                                                                                                          | Declined            | Contradicts the Greenfield new-user scope                                                                                                   |

## Review cadence

Re-evaluate **Now** at the end of every vertical slice. Move features only when
new evidence or a resolved dependency changes their position. Do not reorder the
roadmap merely because a feature was recently discussed.
