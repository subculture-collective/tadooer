# Greenfield React Productivity Suite Requirements Interview

## Status

Initial interview complete and approved. Architecture planning and feature
sequencing continue in the roadmap; unresolved contract questions are handled in
bounded follow-up interviews rather than reopening settled product direction.

## Goal

Define a Greenfield React productivity product for new users and an umbrella
suite that integrates Daymark, Baikal, synchronization, and the existing Super
Productivity MCP tooling without prematurely coupling their data stores or
duplicating their authoritative state. The existing Super Productivity product
is a source of tested ideas and an optional future import source, not a parity or
wire-compatibility target.

## In scope

- Product boundary and naming decisions for the suite and its applications
- Greenfield React client scope
- An extensible import framework, with Super Productivity as a future source
- Calendar and availability integration with Daymark and Baikal
- Cross-device synchronization and active timer/focus handoff through SuperSync
- MCP tool, resource, bridge, and automation integration
- Web, PWA, Electron, mobile, self-hosting, and deployment targets
- Data ownership, privacy, authentication, offline behavior, and recovery
- Acceptance criteria, verification strategy, and staged delivery plan
- Repository and package topology after boundaries are agreed

## Out of scope until explicitly accepted

- Moving or vendoring any existing repository
- Rewriting production code before the first vertical slice is defined
- Replacing Baikal as the calendar source of truth
- Full feature parity with Super Productivity
- Permanent storage or wire compatibility with Angular Super Productivity
- A mandatory migration path for existing Super Productivity users in v1
- Deploying or changing production services
- Retiring the existing Angular application

## Known constraints and evidence

- The current Super Productivity frontend is Angular and already targets web,
  Electron, and Capacitor.
- Its current renderer is large: approximately 268 components, 277 injectable
  services, 50 NgRx effect files, and 217 Playwright E2E specifications.
- The fork contains custom cross-device timer/focus session work and custom
  CalDAV behavior that must be treated as candidate compatibility requirements.
- Daymark is a React/Vite calendar application under active development. It is
  intended to own calendar and availability behavior while preserving raw ICS.
- Baikal is intended to remain the CalDAV/CardDAV source of truth unless this
  interview deliberately changes that decision.
- SuperSync currently lives within the Super Productivity repository.
- The existing MCP repository is a Go MCP server plus quick-add client, plugin
  bridge, tool catalog, and skill bundle. Its catalog and safety behavior are
  existing contracts, not disposable prototypes.
- Existing repositories have uncommitted work and must remain untouched during
  discovery.
- The Greenfield product is intended primarily for new users. Existing Baikal
  calendars and at least one mainstream hosted calendar source are higher
  priority than importing the full Super Productivity data model.

## Acceptance criteria

To be completed after the interview. At minimum, the outcome must define:

- One explicit product goal and primary user workflow
- Clear authority for tasks, calendars, availability, sessions, and automation
- Compatibility and migration policy for existing user data
- Supported clients and self-hosting topology
- MCP trust and mutation model
- A testable first vertical slice
- Explicit non-goals for the initial release

## Verification

The resulting architecture must be checked against the live repository
contracts, existing persisted data shapes, two-client synchronization behavior,
CalDAV interoperability requirements, MCP catalog behavior, and packaged web and
desktop clients before any replacement claim is made.

## Decisions

### 1. Modular architecture, unified product experience

**Decision:** Build internally as a suite of bounded contexts and replaceable
services, while converging on a single React user experience for tasks,
calendar, focus, sync, and automation.

The existing Angular application remains usable during migration. Compatibility
and import paths are deliberate, but the Greenfield design is not required to
copy every historical implementation detail. Daymark, Baikal, SuperSync, and
the MCP retain explicit authority and protocol boundaries even when the user
interacts with them through one application shell.

**Deployment direction:** A self-hosted default should require no more than one
or two containers, minimal configuration, generated secrets, documented
persistent volumes, and one public application origin. Additional services may
be supported for advanced deployments but cannot be prerequisites for the
single-user default.

**Status:** Agreed in principle. Exact calendar authority, process composition,
database topology, and MCP placement remain open.

### 2. Baikal is the bundled, replaceable calendar authority

**Decision:** The default self-hosted distribution includes Baikal as its second
container and authoritative CalDAV/CardDAV store. The suite integrates through
standards-based DAV contracts so an advanced deployment can substitute another
qualified CalDAV server.

The unified React application owns calendar presentation, task/calendar
workflows, availability rules, integration mappings, and explicitly stale cached
projections. It does not make its projection database authoritative for calendar
resources. External DAV clients remain supported, and replacing Baikal must not
require migrating task, timer, focus, or MCP state.

**Status:** Agreed.

### 3. Single-owner first with multi-user-ready boundaries

**Decision:** The initial self-hosted product supports one owner account and one
normal suite login. Persisted task, calendar-projection, session, integration,
token, and automation records nevertheless carry a stable owner identity, and
authorization is enforced at context boundaries rather than relying on the fact
that only one user exists.

The suite backend owns its connector relationship with the bundled Baikal
service, and the browser does not require a second Baikal login. Direct external
CalDAV/CardDAV access is opt-in and uses separately revocable DAV credentials.
Full household/team account management, sharing, and delegated administration
are deferred, but the v1 storage and API shapes must not make them impossible.

**Status:** Agreed.

### 4. New-user product, selective imports, no parity mandate

**Decision:** The React product is Greenfield and primarily serves new users. It
does not retain the Angular application's storage model, SuperSync operation
format, NgRx-shaped actions, plugin surface, or full feature set merely for
compatibility. Super Productivity remains a design reference and a potential
future import source.

Existing Baikal calendar data must be usable early. Google Calendar is a likely
early external source. The import/connector architecture should later admit
Super Productivity, Apple Reminders, Google Tasks, and other productivity tools,
but v1 does not promise all of those sources or full-fidelity migration from any
task application.

Imports are non-destructive, provenance-aware, repeatable against disposable
targets, and produce explicit imported/skipped/unsupported results. Source IDs
must be retained where needed for idempotency and later reconciliation.

**Status:** Agreed.

### 5. Federated live calendars plus explicit migration into Baikal

**Decision:** Each connected calendar has exactly one authoritative provider.
Baikal and Google calendars can remain live sources in the unified interface.
Users may also run a one-time, verified migration that copies selected calendars
or events into Baikal and then treats the Baikal copies as authoritative.

The suite may publish a revocable, read-only iCalendar capability URL for a
Baikal calendar so external products can subscribe where they support URL-based
calendar subscriptions. Publication is never described as writable sync, may
have provider-controlled refresh latency, and requires an explicit privacy
warning because the subscribing provider receives the calendar data.

One-way mirrors are not a default. If added later, a mirror uses a dedicated
read-only destination calendar, retains source provenance and revisions, and
makes the external provider visibly authoritative. Users edit the source or
perform an explicit ownership migration; the suite never accepts edits on both
sides of a one-way mirror.

Platform behavior is surfaced honestly:

- Apple platforms can connect a Baikal CalDAV account and select a Baikal
  calendar as the system default for newly created events.
- Android requires a CalDAV account adapter such as DAVx5 before compatible
  calendar applications can create events in Baikal.
- Google Calendar URL subscriptions are read-only and cannot make Baikal the
  writable target for Gmail-generated events.
- A future share extension, browser extension, mail integration, or automation
  tool may provide an explicit "Save to suite" action, but cannot be represented
  as a universal operating-system default until qualified per platform.

**Status:** Agreed.

## Approval

The user approved the five recorded product decisions and the captured Task
Templates and Choice Pools direction on 2026-08-05. Approval confirms the
direction and semantics; it does not place every candidate feature in v1.

The user subsequently approved the feature-prioritization framework and complete
Phase 0-8 roadmap on 2026-08-05. Phase 0 may proceed from this discovery
baseline; later phases still require their own contracts and exit evidence.

## Open questions

The initial five-question interview is complete. The architecture phase must
resolve, in dependency order:

1. The smallest complete v1 workflow and explicit feature non-goals.
2. Local-first and offline behavior for the React client.
3. The new synchronization state model, session ownership, and recovery rules.
4. The suite API and process boundary inside the primary container.
5. MCP placement, trust scopes, confirmation rules, and local versus hosted
   transport.
6. OAuth and connector credential storage, rotation, and backup policy.
7. Web/PWA, Electron, Android, and iOS delivery order.
8. SQLite-default persistence, backup/restore, and optional PostgreSQL policy.
9. Import intermediate representation and the first supported source matrix.
10. Packaging, upgrades, observability, and production qualification.

## Recommended route

Full plan. The data and integration contracts are costly to reverse, so
implementation should begin with a bounded vertical slice and contract fixtures,
not a screen-by-screen React port.
