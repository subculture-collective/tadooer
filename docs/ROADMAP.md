# Productivity Suite Roadmap

**Status:** Approved 2026-08-05. Phase order is dependency order rather than a
calendar-date commitment; movement between phases follows the feature
prioritization policy and recorded exit evidence.

## Strategy

Deliver contract-first vertical slices that are usable end to end. Every phase
must leave a runnable, testable product state; phases are dependency order, not
calendar-date commitments.

Feature ordering follows
[`product/feature-prioritization.md`](product/feature-prioritization.md).

## Phase 0: Contract lab and repository foundation

### Implementation checkpoint

Phase 0A was completed on 2026-08-05 on `codex/phase-0-foundation`:

- pnpm TypeScript workspace with React/Vite web, Node server, and framework-free
  contract, domain, persistence, CalDAV, and test-support packages
- same-origin `/api/health`, `/api/ready`, and `/api/build` contracts plus a
  readiness UI that does not claim product functionality
- built-in SQLite adapter with checksummed migration ledger, stable installation
  identity, online backup, and restore tooling
- pinned two-container Suite and Baïkal Compose topology with explicit volumes
- disposable deployment drill covering health, restart persistence, database
  replacement, backup restore, and cleanup

Phase 0B was completed on 2026-08-05 on `codex/phase-0-foundation`:

- one-shot, stable owner setup with scrypt password hashing and constant-work
  invalid credential checks
- revocable server-side sessions with idle/absolute expiry, HttpOnly SameSite
  cookies, same-origin enforcement, CSRF rotation, and login rate limiting
- owner-scoped AES-GCM encrypted Baïkal credentials under a mode-0600 key
- bounded, redirect-safe CalDAV discovery of event and todo collections
- first-run, login, connector, discovered-calendar, and logout React states
- paired SQLite/key backup and restore drill with fail-closed key mismatch tests

Phase 0C was completed on 2026-08-05 on `codex/phase-0-foundation`:

- stable persisted UUIDs for tasks, calendar providers, and discovered calendars;
  a reserved client-identity table; and qualified provider-native event contracts
- owner-scoped API authorization plus client-visible error request IDs, durable create
  idempotency, positive revisions, and the conditional-mutation convention
- first task-capture vertical slice: authenticated create/list API, persistent
  task state, retry-safe capture, and rendered React capture/list states
- committed synthetic CalDAV and import fixtures with invalid-contract rejection
- current Google OAuth/Calendar feasibility and source-pinned MCP catalog mapping
- an authoritative-store decision covering Suite, Baïkal, Google, imports, and
  future automation state

Phase 0 is complete. Phases 1 and 2 were subsequently completed as the first
bounded planning and local-first focus slices; Phase 3 is next.

### Outcome

The suite repository builds and tests a React application, application API,
shared contracts, and Compose topology. One owner can securely capture and list
retry-safe tasks after setup; calendar functionality remains collection
discovery only until Phase 1.

### Scope

- Monorepo/package topology and code-quality gates
- Bounded task, calendar projection, active session, auth, and automation
  contexts
- Stable owner, task, calendar-provider, event, and client identities
- SQLite-default persistence decision and migration harness
- CalDAV and import fixture corpus
- API error, idempotency, revision, and authorization conventions
- Two-container Compose skeleton with explicit persistent volumes
- Backup/restore format spike
- Google OAuth/Calendar connector feasibility spike
- Existing MCP catalog mapping analysis

### Exit evidence

- Contracts compile and reject invalid fixtures
- Disposable Compose stack starts and preserves a migration marker across restart
- No production calendar or task data is used
- Architecture decisions identify every authoritative store

## Phase 1: First self-hosted planning slice

### Implementation checkpoint

Phase 1 was completed on 2026-08-06 on `codex/phase-1-planning-slice`:

- bounded, non-recurring UTC VEVENT projection with explicit freshness and
  qualified provider/calendar/event identity
- task rename/notes, complete/reopen, soft-delete/recovery, planned start, and
  positive duration under revision preconditions
- one explicit Suite-created time block per task using durable idempotency,
  `If-None-Match: *` creation, strong-ETag moves, and visible conflicts
- a unified current-week React planner and PWA app shell
- test-only Baïkal installer/user provisioning plus real conditional VEVENT
  create, query, read, update-conflict, and delete qualification
- checksummed quiescent backup and fresh-volume restore of Suite data/key and
  Baïkal's authoritative database/configuration
- a disposable system gate that drives the complete browser outcome, proves no
  duplicate event across restart, preserves an external edit, repeats placement
  after restore, and removes all synthetic volumes

This evidence is local disposable-Compose qualification. It does not claim a
production deployment or compatibility beyond the pinned Baïkal release and
the Phase 1 CalDAV subset.

### User outcome

One owner deploys the suite and Baikal, signs in, sees an existing Baikal
calendar, creates a task, and places it into a calendar interval.

### Scope

- First-run owner setup and session security
- bundled Baikal by default, with a server-admin endpoint override for an
  external CalDAV deployment
- Calendar discovery and bounded event projection
- Basic tasks: create, rename, notes, complete, reopen, delete with recovery
- Planned start and estimate/duration
- Unified day/week planning surface
- Explicit task-to-event time block with conditional CalDAV write
- SQLite persistence, backup, restore, health, and readiness
- PWA-capable React delivery

### Non-goals

- Offline multi-writer sync
- Google Calendar production support
- Recurring task parity
- Templates, pools, imports, native apps, or broad MCP mutations

### Exit evidence

- Browser E2E completes the entire user outcome
- Real disposable Baikal VEVENT CRUD and cleanup pass
- Restart preserves task and mapping without duplicating the event
- Stale ETag produces a visible conflict rather than overwrite
- Backup restores into a fresh stack and repeats the smoke flow

## Phase 2: Local-first tasks and cross-device focus

### Implementation checkpoint

Phase 2 was completed on 2026-08-06 on `codex/phase-2-local-first-focus`:

- durable IndexedDB task snapshots, immutable task outbox, opaque cursors,
  bounded reset snapshots, visible field conflicts, and redacted diagnostics
- owner-scoped registered browser clients with one-time raw credentials,
  server-side credential digests, inventory, proof, and revocation
- ordered SQLite change streams, replay-safe operation outcomes, per-field task
  versions, and structural delete/restore conflicts
- server-authoritative focus/break sessions with controller/follower behavior,
  heartbeats, pause/resume, break transitions, explicit takeover, exact lease
  expiry, retained interval history, and restart-safe idempotency
- projects, case-folded tags, one-level revisioned subtasks, task assignment,
  and task estimates on the daily-use surface
- persistent-profile browser qualification proving offline create/edit across
  close/reopen, reconnect without duplication, a visible same-field conflict,
  two-client takeover, and authoritative session recovery after server restart

This evidence is local disposable-Compose qualification. Clock-controlled
expiry and duplicate-interval matrices run through the injected server clock;
the production Compose stack has no test-time clock backdoor. Foreground sync
does not claim closed-application background execution or offline calendar and
focus mutation.

### User outcome

The owner uses two clients, works offline temporarily, and safely observes or
takes over one active timer/focus/break session.

### Scope

- Client-local task cache and queued writes
- New synchronization operations, revisions, cursors, and recovery
- Two-client conflict semantics for core task fields
- Explicit active-session owner/follower model
- Start, pause, resume, complete, break, takeover, expiry, and recovery
- Projects, tags, subtasks, and estimates required by daily use
- Sync diagnostics and exportable recovery bundle without task-content logs

### Exit evidence

- Failing two-client reproductions precede conflict fixes
- Offline create/edit reconnect tests pass
- Owner/follower/takeover/expiry matrix passes under clock control
- Browser reload and server restart recover the same authoritative session
- No duplicate tracked-time intervals arise from concurrent clients

## Phase 3: Calendar federation and calm daily planning

### User outcome

The owner plans against Baikal and Google calendars in one view, receives quiet
availability-aware reminders, and always sees the next scheduled task first.

### Scope

- Production Google Calendar connector with OAuth and revocation
- One-authority-per-calendar provider model
- Unified availability projection with explicit freshness
- Scheduled task ordering and day planning
- Working hours, scheduled breaks, unavailable, and finished-for-today states
- Reminder suppression that fails open when calendar state is stale
- Recurrence only to the depth required by accepted workflows and fixtures

### Exit evidence

- Google and Baikal event identities never collide or silently duplicate
- Provider revocation removes access without deleting local task state
- Calendar outage/staleness behavior is visible and deterministic
- Rendered tests prove scheduled-time ordering and reminder boundaries

## Phase 4: First-class automation and MCP

### User outcome

An authorized agent can inspect plans, preview changes, and execute confirmed,
idempotent task and scheduling actions through stable suite contracts.

### Scope

- Suite automation API independent of UI internals
- Adapt or reuse the existing MCP catalog and Go adapter
- Read-only resources for tasks, schedule, projects, tags, and active session
- Preview/confirm operations for task creation, scheduling, and session control
- Scoped tokens, audit metadata, retry/idempotency, and revocation
- Local stdio adapter plus authenticated hosted transport decision
- Quick-add integration against the same API

### Exit evidence

- Catalog/API parity checks prevent drift
- Retry cannot duplicate a task or calendar event
- Destructive or broad mutations require the defined confirmation contract
- Revoked MCP credentials fail closed without disrupting interactive use

## Phase 5: Reusable work

### User outcome

The owner creates inert Task Templates and instantiates one task or a reusable
set into an existing project without polluting active task views.

### Scope

- Template Library and search
- Create template from scratch or existing task
- Independent instantiation with provenance
- Subtask blueprints
- Template Sets and explicit destination selection
- Template backup, sync, and MCP read/preview support

### Exit evidence

- Templates never enter active-task/reminder/time-tracking queries
- Retried instantiation cannot duplicate a task tree
- Editing a template does not mutate existing instantiated work

## Phase 6: Choice Pools and planning placeholders

### User outcome

The owner reserves a vague block, then resolves it during planning into eligible
activities with explainable cooldown, cycle, or one-shot behavior.

### Scope

- Choice Pools, Pool Items, and append-only selection/completion history
- Manual eligible selection and previewable suggestions
- Pick-count, cooldown, cycle-without-replacement, and one-shot policies
- Planning Placeholders and pool slots inside templates
- Two-device resolution conflict semantics
- MCP list and preview before mutation support

### Exit evidence

- Logical-clock and property tests prove policy behavior
- Two clients cannot silently commit different resolutions to one placeholder
- Every unavailable item has a visible reason and eligibility boundary

## Phase 7: Migration, publication, and connector breadth

### User outcome

The owner can move selected calendar data into Baikal, publish an explicitly
read-only calendar feed, and use provenance-aware import adapters.

### Scope

- Common import intermediate representation and reconciliation report
- Google-to-Baikal one-time migration
- ICS file import/export
- Revocable read-only iCalendar capability feed
- Source adapter framework for later Super Productivity, Apple Reminders, Google
  Tasks, and other products
- One-way mirror only after a demonstrated client limitation and separate review

### Exit evidence

- Import dry-run and apply are non-destructive and idempotent
- Recurrence, attendees, alarms, unknown fields, and unsupported data are reported
- Capability URLs are revocable and never presented as writable sync

## Phase 8: Packaged clients and broader operations

### Scope

- Electron desktop packaging after the PWA/API contracts stabilize
- Android/iOS delivery only after platform-specific offline and credential design
- Optional PostgreSQL adapter if measured deployment needs justify it
- Upgrade channels, rollback, observability, and production qualification
- Multi-user discovery only after owner-scoped authorization has been audited

## Explicit non-roadmap commitments

The following do not enter a phase without a new decision and evidence:

- Full Super Productivity parity
- Native CalDAV/CardDAV server replacement for Baikal
- Default bidirectional calendar mirroring
- Team management, reporting, streaks, or engagement loops
- Project Templates if Template Sets plus explicit destination solve the need
