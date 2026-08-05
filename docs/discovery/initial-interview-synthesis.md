# Initial Greenfield Suite Interview Synthesis

## Goal

Build a new-user React productivity product that presents tasks, calendar,
focus, planning, synchronization, and automation as one coherent experience,
while retaining explicit bounded contexts and open integration contracts.

## In scope

- One unified React application experience
- A one-owner, minimally configured self-hosted default
- No more than two required application containers
- Baikal as the bundled, replaceable CalDAV/CardDAV authority
- Live federated calendars with one authoritative provider per calendar
- Explicit, verified calendar migration into Baikal
- A smaller task, planning, timer, focus, and break product designed for the new
  workflow rather than Super Productivity parity
- A new synchronization model suitable for web and multiple devices
- First-class automation backed by the existing MCP catalog and safety lessons
- An extensible, provenance-aware import framework

## Out of scope

- Full Super Productivity feature parity
- Angular, NgRx, storage, plugin, or SuperSync wire compatibility as a permanent
  constraint
- Concurrent old-SP and new-suite writers against one canonical task store
- A native CalDAV/CardDAV server replacement for Baikal
- Default bidirectional Google/Baikal mirroring
- Multi-user sharing and administration in v1
- Universal interception of events created by Gmail, text messages, assistants,
  or operating-system integrations

## Constraints and decisions

- Internal modularity must not become a microservice deployment burden.
- The default installation has one suite container and one Baikal container,
  persistent volumes, generated secrets, and one normal suite login.
- Every persisted record and token is scoped to a stable owner identity even
  though v1 supports one owner.
- The browser never needs a normal Baikal administrator login.
- Every connected calendar has one authority; migration transfers ownership,
  while publication and mirroring remain explicitly read-only.
- Imports are non-destructive, idempotent where source identity permits, and
  report transformed, skipped, and unsupported records.

## Acceptance criteria

The first implementation plan is acceptable only when it defines:

- One end-to-end v1 workflow that includes task planning against real calendar
  availability
- Exact ownership for task, calendar, active session, and automation state
- Offline behavior and multi-device conflict semantics
- A two-container Compose installation with first-run owner setup
- Existing Baikal calendar discovery and event CRUD qualification
- One Google Calendar connection or a deliberately deferred, fixture-backed
  connector boundary
- A safe MCP mutation model with preview/confirmation for destructive actions
- Backup, restore, upgrade, and rollback evidence
- Explicit unsupported behavior rather than silent data loss or false sync

## Verification

- Contract fixtures for CalDAV, Google calendar identity/revisions, imports, and
  MCP schemas
- Real Baikal qualification with disposable calendars and events
- Two-client synchronization and active-session recovery tests
- Import reconciliation reports against representative source fixtures
- Browser-rendered React workflow tests
- Packaged self-hosted deployment tests against persistent volumes
- Backup/restore and upgrade/rollback drills
- Platform-specific qualification before promising system-default calendar
  behavior

## Open questions

The next architecture phase must resolve the ten questions listed in the active
requirements interview, beginning with the smallest complete v1 workflow.

## Captured candidate features

- [Task Templates and Choice Pools](../product/candidate-features/task-templates-and-choice-pools.md)
  captures inert task blueprints, reusable task sets, eligibility-aware activity
  pools, and planning placeholders. It is preserved for product planning but is
  not yet a v1 commitment.

## Recommended route

Full plan, delivered as contract-first vertical slices. Start with owner setup,
Baikal connection, unified calendar projection, one task planned into an
available interval, and safe synchronization of that task and active session.
