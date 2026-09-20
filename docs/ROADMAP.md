# Productivity Suite Roadmap

**Status:** Approved 2026-08-05. Phase order is dependency order rather than a
calendar-date commitment; movement between phases follows the feature
prioritization policy and recorded exit evidence.

## Current release checkpoint — September 20, 2026

Production runs candidate `0.14.1-calendar`, application revision `a6983dc`,
with 19 migrations. Deadline/offline sync, habits, structured capture, and
calendar session recovery/full resync are deployed and verified. Google resync
has been verified in the owner account; all 16 calendars are fresh. Monitoring
now flows from the NUC agent to Dozor, with seven evaluated Tadooer alerts.

The new seven-day soak is active from `2026-09-20T12:55:39.883Z`, pinned to
`sha256:68438591510360e82e84d98e83d2825bce5134004a884a26e55c75403080548f`.
No stable qualification is claimed. Older checkpoints below are historical.
[Sprint 14](superpowers/plans/2026-09-20-sprint-14-daily-use-reliability.md)
tracks the next development work separately from the frozen production candidate.

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
bounded planning and local-first focus slices. Phase 4's provider-independent
automation boundary was completed afterward; Phase 3 Google federation was then
live-qualified against a real owner grant on 2026-08-07.

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

### Implementation checkpoint

The credential-independent implementation landed on 2026-08-07 on
`codex/phase-3-google-federation`:

- narrow-scope web-server OAuth with digest-only, expiring, single-use state;
  encrypted refresh grants; explicit reconnect-required state; revocation; and
  a mode-0600, no-symlink operator configuration boundary
- paginated calendar discovery plus event incremental sync, deletion tombstones,
  recurring-instance/all-day projections, `410` cursor reset, per-calendar
  freshness, and provider-qualified identities
- unified Baïkal/Google planner projection, scheduled-task-first ordering,
  UTC working hours and quiet breaks, calm day states, and deterministic reminder
  suppression when availability cannot be trusted
- browser controls and a constrained packaged-desktop handoff to Google's exact
  system-browser authorization surface
- deterministic protocol, persistence, HTTP, rendered UI, and desktop policy
  tests, plus an explicitly named credential-independent verification gate

Phase 3 was completed on 2026-08-07 after the credential-independent checkpoint
was qualified against a real Google OAuth client and owner grant. The live run:

- discovered 15 calendars and projected a current seven-day window without
  duplicate provider identities
- showed one Baïkal event beside Google events, then removed the temporary
  Baïkal block cleanly
- projected one disposable Google event through create, update, and delete;
  the update retained its provider-identity digest and the active window moved
  from 25 to 26 and back to 25 unique identities
- converted remote grant revocation into reconnect-required state while keeping
  the last safe projection visibly stale and preserving Baïkal plus local tasks
- reconnected to current projection, then disconnected through the Suite and
  removed Google connector/projection state without disturbing Baïkal or local
  tasks

The content-safe evidence record and operator procedure are in
[`operations/google-calendar.md`](operations/google-calendar.md).

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

### Implementation checkpoint

Completed on 2026-08-06 on `codex/phase-4-automation-mcp`:

- Suite-owned catalog and versioned Zod contracts for five owner-scoped read
  resources, confirmed task/calendar/focus operations, and one generic confirm
  tool shared by HTTP and MCP
- separately issued, digest-only, expiring, scoped, revocable automation
  credentials that do not reuse browser cookies or browser client proofs
- durable previews, consumed confirmations, restart-safe outcomes, namespaced
  task/calendar/session idempotency, and append-only content-safe audit metadata
- task creation, Baïkal time-block scheduling, and focus-session commands behind
  preview and explicit confirmation, including calendar reconciliation against
  the reserved provider href and UID
- local TypeScript MCP stdio adapter with catalog-derived tools/resources and a
  mode-0600 token-file contract; hosted MCP explicitly disabled pending a
  separate public OAuth/PKCE design
- quick-add CLI using the same preview/confirm API and caller-stable retry key
- contract, persistence, HTTP restart/replay/revocation, focus, MCP protocol,
  quick-add, and full repository verification gates

Phase 4 is complete for the providers actually present in the repository.
Phase 3's Google federation and unified cross-provider availability were
subsequently live-qualified and completed on 2026-08-07.

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

### Implementation checkpoint

Completed on 2026-08-07 on `codex/phase-5-reusable-work`:

- dedicated inert Task Template, ordered subtask-blueprint, Template Set,
  ordered membership, durable instantiation, and task-provenance storage under
  checksummed migration 0009
- a separate searchable Template Library with create-from-scratch,
  create-from-task, edit, archive, explicit existing-project selection,
  ordered Set creation, and persisted provenance display
- one-transaction template or set instantiation that copies independent normal
  tasks, tags, estimates, and ordered subtasks; same-request retries return the
  original task-tree identities across restart
- first-class sync snapshots that bundle ordered blueprints with templates and
  ordered members with sets without casting either into active tasks
- scoped catalog-derived MCP resources and preview/confirm tools for template
  and set instantiation, including stale-source revisions, durable replay,
  audit, and revocation behavior inherited from the Phase 4 authority
- SQLite backup/restore coverage plus a disposable Compose gate using the built
  Suite, Baïkal, and real local stdio adapter; restored confirmations replay the
  same provenance-bearing tree

Phase 5 is complete. Choice Pools, planning placeholders, cooldown/cycle
policy, and two-device placeholder resolution remain Phase 6 work.

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

Phase 6 is complete. The Suite now provides dedicated inert Choice Pools,
ordered editable candidate records, append-only selection/completion history,
logical-time cooldown/cycle/one-shot explanations, explicit override audit,
Planning Placeholders on ordinary parent tasks, and ordered pool slots inside
Task Templates. Suggestions are pure; browser and scoped automation
confirmation share one exact-once transaction that creates ordered subtasks,
records history, advances the placeholder revision, rejects a competing client,
and replays identical identities across restart and backup/restore. The
catalog-derived local MCP surface lists pools and previews resolution without a
direct mutation bypass.

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

Phase 7 was completed on 2026-08-07 on
`codex/phase-7-migration-publication`. The Suite now has a bounded common
calendar-import IR with generic ICS and Google Calendar ICS/Takeout adapters,
an inert reconciliation preview, stable per-item CalDAV identities, durable
apply/replay state, authenticated ICS export, and digest-only revocable
read-only feed capabilities. Raw VEVENT data preserves recurrence, attendees,
alarms, and vendor fields while the report makes those compatibility boundaries
visible. The disposable gate proves one resource in real Baïkal across retry,
Suite restart, and full-stack backup/restore, then proves feed revocation fails
closed. Live Google OAuth/federation was separately qualified to close Phase 3;
no background mirror is enabled.

## Phase 8: Packaged clients and broader operations

### Scope

- Electron desktop packaging after the PWA/API contracts stabilize
- Android/iOS delivery only after platform-specific offline and credential design
- Optional PostgreSQL adapter if measured deployment needs justify it
- Upgrade channels, rollback, observability, and production qualification
- Multi-user discovery only after owner-scoped authorization has been audited

Phase 8 was completed on 2026-08-07 on
`codex/phase-8-packaged-operations` for the deployment needs supported by
evidence. The Suite now builds an actual Linux x64 Electron bundle whose only
authority is the configured HTTPS (or loopback-development HTTP) Suite origin;
Node integration, webviews, cross-origin navigation, and alternate local data
authority are disabled. Immutable release manifests, candidate/stable
promotion, append-only channel history, explicit rollback selection, a
release/restore runbook, content-free Prometheus metrics, versioned image
metadata, and a disposable production qualification gate are present.

Android/iOS delivery is explicitly not enabled because platform-specific
offline/background and credential storage have not been designed. PostgreSQL
is not enabled because no measured SQLite limitation justifies its operational
cost. Multi-user mode is not enabled because the required owner-scoped
authorization audit has not occurred. These are satisfied roadmap decisions
under the phase's conditional scope, not claims that unsupported clients or
database adapters were shipped.

## Phase 9: Production landing and recovery

Phase 9 is operationally deployed as a digest-pinned candidate at
`https://tadooer.subcult.tv`. NUC owns the Suite container and persistent data;
Almaz owns the Cloudflare/Caddy edge. The public host/origin boundary, Almaz-only
forwarded-address trust, Secure cookies, HSTS, private Prometheus scrape,
content-free alerts, coherent SQLite/key backup, encrypted Restic inclusion,
isolated restore, immutable rollback, and forward recovery have passed. A clean
production database was used and Super Productivity remains available.

Interactive owner creation plus explicit Baïkal and Google authorization remain
acceptance evidence before this phase is marked complete. The production Google
client must use exactly
`https://tadooer.subcult.tv/api/connectors/google/callback`.

## Phase 10: Calm daily workspace

Phase 10 is complete in source and disposable deployment qualification. The PWA
now has route-backed Today, Tasks, Reuse, Connections, and Settings views;
Today and Tasks preserve the IndexedDB task path while online-only calendar and
focus controls are visibly unavailable offline. Task search and organization
filters, keyboard-visible focus, responsive navigation, and PWA `/today` launch
are covered by web tests.

Planning preferences now accept supported IANA time zones, default new owners to
`America/Chicago`, preserve preexisting `UTC` rows through migration 0013, and
derive civil-day boundaries and calm-state decisions across 23-hour and 25-hour
DST days. Planner events retain provider/calendar/event identity while adding
provider kind, provider label, and calendar name. Source badges and calendar
filters keep Google and Baïkal events visibly distinct.

## Phase 11: Durable ntfy reminders

Phase 11 is complete in source and disposable deployment qualification. Suite
publishes through a mode-0600, ACL-limited ntfy credential on the private
management network; the browser receives only owner preferences and redacted
delivery health. The occurrence/kind ledger claims work durably, cancels
obsolete reminders, survives restart, retries only explicit transient HTTP
failures with bounded backoff, and refuses to replay an ambiguous response.

Lead and at-start reminders follow calendar freshness, working hours, breaks,
busy intervals, task completion, and active-focus suppression. Detailed content
is limited to task title, localized planned time, and a Suite deep link. Notes,
event titles, provider/account data, connector secrets, and automation tokens
are excluded. Live authenticated ntfy delivery remains production acceptance
evidence before the phase is operationally complete.

## Phase 12: Seven-day soak and stable release

The fail-closed soak ledger and `1.0.0` qualification gate are implemented.
They require seven full 24-hour windows of health and backup evidence plus two
browser profiles, both calendar providers, focus/break and notification
delivery, restart recovery, isolated restore, immutable rollback/forward
recovery, authentication and non-duplication checks, and confirmation that
Super Productivity stayed available. P0/P1 or any failed required observation
blocks qualification.

The current production soak started September 20, 2026 after owner/provider
setup and deployment verification. The August ledger and a failed September
collector run are preserved separately. Current-window health and backup
evidence is collected automatically; explicit workflow observations and human
sign-off remain required. Super Productivity is not changed automatically.

## Phase 13: Actionable Today Queue

**Status:** Implementation and local qualification completed on 2026-08-21.
Focused automated coverage, the repository gate, and authenticated local-browser
validation are green. Production now runs candidate `0.13.0-phase13`, source
revision `c262a46015bcb80226249315419ec354d353015c`, at immutable registry digest
`sha256:e628a354f6a9dfda93d1b323b8a127ad23d683acb78f8ffbaa19b65137f62b2c`.
Post-deploy public build/readiness, migration, security-boundary, login-render,
and connector-projection checks passed. The production browser was not signed
in, so the authenticated Today workflow remains qualified by the local
server-backed browser pass rather than a post-deploy production interaction.
This deployment does not start or complete the Phase 12 seven-day soak and does
not promote stable `1.0.0`.

### Owner outcome

Today becomes the primary daily workflow rather than a calm-state summary. At
the owner's configured IANA time zone and an explicit logical timestamp, it
shows overdue open tasks and the remaining scheduled work for that civil day.
Open unscheduled tasks appear in a separate Planning section. Future scheduled
tasks stay hidden from the queue, with only a count and route to Tasks.

From Today, the owner can capture a task, schedule/move/remove its single Time
Block, start or control its Active Session, and complete or reopen it. Task
capture and status changes retain the existing IndexedDB outbox path. Calendar
and focus mutations remain server-authoritative and fail visibly offline rather
than being queued or simulated.

### Contract boundaries

- Queue membership is derived from existing Task status and `plannedStart`; it
  does not create persisted Today membership, rank, priority, or due-date fields.
- Owner-timezone classification is a pure domain rule. Planning preferences are
  cached as local read input for a cold offline start, but they are not a new
  sync entity or competing authority.
- Existing `DayPlanResponse`, reminder behavior, task field versions,
  Automation Catalog, Time Block conditional writes, and Active Session
  revisions/leases remain unchanged.
- Completing an Active Session and completing its Task stay separate commands.
- The week calendar remains secondary context; Today does not duplicate the
  full Tasks editor, projects/tags, checklists, templates, or recovery tools.

### Explicit non-goals

- Manual ranking, priority, dependencies, recurring tasks, or persisted Today
  selection
- Automatic scheduling, collision avoidance, or drag-and-drop
- Offline calendar writes or offline focus timers
- Automation/MCP surface expansion
- Calendar-provider authority or reconciliation changes

### Acceptance evidence

- Domain tests cover exact overdue/current/day-end boundaries, deterministic
  ordering, completion exclusion, and 23/25-hour DST days.
- Web tests prove queue hierarchy, future-task hiding, task-specific accessible
  actions, empty states, and authenticated/cold-offline composition.
- Authenticated local-browser validation proved capture, schedule/move/remove,
  row-scoped focus, complete/reopen, visible offline boundaries, a cold offline
  reload, and responsive behavior at desktop, tablet, mobile, and 200% zoom.
  Direct tab inspection also confirmed the semantic reading/focusable order;
  the browser automation transport timed out during scripted keyboard stepping
  and screenshot capture. The browser console had no warning or error entries.
- Existing task sync, planner/reminder, Time Block, Active Session, and full
  repository verification gates remain green.
- Before production deployment, the NUC created and checksum-verified a coherent
  Suite backup. Post-deploy checks confirmed the exact Phase 13 image revision,
  healthy migration 14, preserved owner and Baïkal/Google provider records,
  10,540 Google event projections, expected `421` unknown-Host and `403`
  hostile-Origin responses, a public sign-in surface, and a clean browser
  console. Authenticated production Today actions were not exercised.

Implementation details and task order are recorded in
`docs/superpowers/plans/2026-08-14-actionable-today-queue.md`.

## Explicit non-roadmap commitments

The following do not enter a phase without a new decision and evidence:

- Full Super Productivity parity
- Native CalDAV/CardDAV server replacement for Baikal
- Default bidirectional calendar mirroring
- Team management, reporting, streaks, or engagement loops
- Project Templates if Template Sets plus explicit destination solve the need
