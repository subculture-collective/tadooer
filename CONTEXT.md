# CONTEXT.md — Domain Glossary

> Generated 2026-08-10 from `docs/adr/0001`–`0016`, `docs/product/feature-prioritization.md`, and
> `docs/discovery/initial-interview-synthesis.md`.

---

## 1. Domain Terms

| Term | Definition |
|---|---|
| **Owner** | The single human account that deploys and uses the suite. All records scoped to a stable owner UUID. |
| **Session (Auth)** | Server-side owner authentication session backed by an opaque cookie, stored as SHA-256 digest with independent CSRF token, idle/absolute expiry, and explicit revocation. Distinct from Active Session. |
| **Task** | Suite-owned mutable resource with UUID identity, positive integer revision, per-field versions, soft-delete/recover lifecycle. |
| **Project** | Owner-scoped UUID record with title, revision, optional archive. A task belongs to zero or one project. |
| **Tag** | Owner-scoped UUID record with display name, case-folded uniqueness key, revision, optional archive. Max 25 per task. |
| **Subtask** | One-level checklist record. Not recursive; cannot own projects, calendar blocks, or focus sessions. |
| **Choice Pool** | Owner-scoped record containing Pool Items with append-only selection/completion history and one of four policies (cooldown, cycle, one_shot, none). |
| **Pool Item** | Candidate inside a Choice Pool. Eligibility evaluated at an explicit logical timestamp. |
| **Planning Placeholder** | Attached to one task and one pool, storing pick count and revision. Resolution creates ordered subtasks. |
| **Task Template** | Inert first-class record (title, notes, estimate, tags, suggested project, subtask blueprints). Never appears in active-task queries. |
| **Template Set** | Ordered collection of active Task Templates. Not a Project Template. |
| **Template Instantiation** | Atomic SQLite transaction creating independent tasks from a template or set, with source identity and immutable snapshot provenance. |
| **Calendar Provider** | A system that stores and serves a calendar. Unmapped calendars remain provider-owned; an explicitly mapped bridge uses Baïkal for accepted canonical state. |
| **Connector** | Integration component that communicates with a Calendar Provider via CalDAV or Google API. Encrypted credentials stored alongside a mode-0600 AES-256-GCM key file; Baïkal automatic, Google OAuth. |
| **Calendar Projection** | Bounded, cached read of calendar events in Suite SQLite. Never duplicates authoritative calendar resources. |
| **Calendar Mapping** | An explicit pairing of one Google calendar with one Baïkal calendar; it never distributes events to unrelated calendars. |
| **Accepted Calendar State** | The last reconciled event state accepted in Baïkal. An unacknowledged external edit remains pending rather than replacing this state silently. |
| **Bridge Conflict** | Incompatible changes since the last accepted state, retained on both sides until explicitly resolved. |
| **Calendar Tombstone** | Evidence that a previously mapped event was deleted, retained to prevent replay from resurrecting it. |
| **Time Block** | Suite-created VEVENT linking a task to a calendar interval. At most one active block per task. |
| **Active Session** | Server-authoritative focus/break session. At most one nonterminal per owner. 90-second lease, 30-second heartbeat, 24-hour hard expiry. |
| **Controller / Follower** | One registered client controls the active session; others are read-only with explicit takeover. |
| **Client** | Durable browser installation with owner-scoped UUID and one-time 256-bit credential (stored in IndexedDB, server stores SHA-256 digest). |
| **Automation Credential** | Opaque bearer token `suite_at_<UUID>.<secret>`. Owner-bound, scoped, expiring, revocable. |
| **Preview / Confirmation** | Two-phase mutation model: preview has no side effects and stores input hash; confirmation executes only if preview is unexpired and revisions match. |
| **Idempotency Key** | 8–128 URL-safe characters for retriable creates. Same key + same request hash replays original outcome; different hash returns IDEMPOTENCY_CONFLICT. |
| **Revision / ETag** | Positive integer revision. All mutations return current revision and quoted ETag. Update/delete require If-Match. |
| **Field Version** | Per-field integer version (title, notes, status, estimateMinutes, projectId, tagIds) enabling disjoint merge during sync. Distinct from whole-resource revision. |
| **Operation (Sync)** | Immutable, client-sequenced sync message identified by UUID. Deduplicated by (owner, client, operation UUID) with a normalized request hash. |
| **Outbox** | Client-side IndexedDB queue of immutable operations identified by UUID, awaiting sync-round transmission. |
| **Sync Round** | Ordered change stream with persistent epoch + positive sequence. Client sends queued operations; server returns remote changes. Field-level merge with per-field versions. |
| **Epoch (Sync)** | Persistent identifier coupled with sequence numbers in the change stream. Mismatch or cursor outside retained range triggers full-snapshot reset. |
| **Local Store** | IndexedDB cache (suite-local-v1) storing canonical task/project/tag/subtask/template/pool/active-session snapshots, opaque cursor, immutable queued operations, outcomes, and conflicts. |
| **Sync Engine** | Foreground sync coordinator: registers client, loads outbox, sends round, applies response, handles cursor reset recovery. |
| **Automation Catalog** | Declarative catalog in @suite/contracts defining all operation/resource identifiers, scopes, confirmation rules, HTTP mappings, MCP names/URIs, and Zod schemas. Single source of truth. |
| **Audit Record** | Append-only row recording authenticated reads, previews, successful/denied executions, and confirmation replays. Contains owner, token, operation, phase, outcome, error code, and request hash; never task content or secrets. |
| **ntfy** | Write-only delivery adapter for notifications. Suite owns reminder intent and delivery history. ntfy is private-network, ACL-limited. |
| **Capability URL** | Opaque 256-bit secret for read-only iCalendar publication. Secret returned once, stored as SHA-256 digest. GET/HEAD only. Revocable. |
| **DAV Resource** | Calendar event stored authoritatively in Baïkal. Qualified by Suite provider UUID + calendar UUID + provider-native identifier. |
| **Calm Day** | Deterministic evaluation of working state (working/break/unavailable/finished) based on owner's working hours, configured breaks, calendar busy intervals, and calendar freshness. Produced by buildCalmDay(). |
| **Recovery Manifest** | Client-exportable JSON diagnostics manifest with schema version, installation/client IDs, cursor, pending/conflict counts, operation IDs/kind/states/hashes/revisions, and safe error codes. Never contains task content, credentials, or browser paths. |
| **Release Manifest** | Immutable version/revision/image-digest record promoted through explicit `candidate` and `stable` channels. Prior manifests retained in append-only history. Rollback selects a previously qualified manifest. |
| **Migration** | Versioned SQL schema change in packages/persistence. Currently 14 migrations (0001–0014) applied atomically. |
| **Vertical Slice** | A runnable, testable product increment that delivers one bounded user outcome across all layers (persistence, domain, API, UI). Every phase must produce a vertical slice. |

---

## 2. Bounded Contexts

| Context | Owns | Files |
|---|---|---|
| Owner & Auth | Owner identity, auth sessions, password hashing (scrypt), CSRF, connector credential encryption | packages/persistence, apps/server/auth.ts |
| Task | Task CRUD, projects, tags, subtasks, status lifecycle, soft-delete/recover | packages/domain, packages/persistence, apps/server, apps/web |
| Calendar | Provider connections, connector logic, event projections, time blocks, planner | packages/caldav, packages/google-calendar, apps/server/connector.ts |
| Planning | Calm day evaluation, working hours, breaks, reminder suppression | packages/domain/day-planning.ts |
| Active Session | Focus/break state machine, controller/follower, lease expiry, takeover, heartbeat | packages/domain/active-session.ts |
| Sync | Client registration, change stream, per-field versions, outbox, conflicts, cursor reset | apps/web/local-store.ts, apps/web/sync-engine.ts |
| Templates | Template CRUD, template sets, instantiation with provenance | packages/persistence |
| Choice Pools | Pool/item CRUD, eligibility evaluation, suggestions, placeholder resolution | packages/domain/choice-pool.ts, packages/persistence |
| Automation | Tokens, preview/confirm, idempotency, audit, MCP/CLI/HTTP surfaces | packages/contracts, apps/server, apps/mcp-stdio, apps/quick-add |
| Notifications | ntfy delivery, reminder ledger, occurrence evaluation, publisher configuration | apps/server/notifications.ts, packages/domain/notifications.ts |
| Import/Export | ICS import parsing with preserved intermediate representation, iCalendar publication feeds | packages/import-export |
| Desktop Packaging | Electron shell around deployed Suite origin; no private database, credential, or alternate API | apps/desktop |
| Test Support | Shared contract fixtures, synthetic test data, manual clock injection, Compose-qualified test harness | packages/test-support |

---

## 3. Architectural Principles

1. **One authority per resource.** Every calendar has exactly one authoritative provider. Suite SQLite owns Suite entities. Baïkal owns DAV resources. Google owns Google resources.
2. **Single-owner first, multi-user-ready.** All records carry owner identity. Authorization enforced at context boundaries.
3. **Preview before mutation.** Every automation mutation goes through no-side-effect preview; confirmation is a separate idempotent step.
4. **Idempotency everywhere.** Retriable creates require Idempotency-Key. Same key + hash replays original outcome.
5. **Conditional writes.** All DAV mutations use If-None-Match: \* or If-Match. 412 → visible conflict, never silent overwrite. Suite mutations use If-Match with revision ETags.
6. **Server-authoritative time.** Server clock supplies all interval boundaries for active sessions. Sync sequence is server-assigned.
7. **Fail closed.** Revoked sessions, expired tokens, lost keys, precondition failures all fail visibly and safely.
8. **Content-safe diagnostics.** Error responses, audit records, recovery manifests never contain task content, credentials, or stack traces.
9. **Contract-first vertical slices.** Every phase leaves a runnable, testable product state. Contracts defined before implementation.
10. **Modularity without microservice burden.** Internal bounded contexts with stable contracts, default deployment ≤2 containers.
11. **Connector credentials encrypted at rest.** DAV passwords use AES-256-GCM with a mode-0600 key file outside SQLite. Backup requires matching key sidecar.
12. **Inert templates, immutable provenance.** Templates never appear in active-task queries. Instantiation copies current state into independent tasks with source snapshot; later template edits cannot mutate prior instances.
13. **Explainable eligibility.** Choice pool eligibility evaluated at explicit logical timestamp, not wall clock. Every item returns eligibility flag, reason code, and next-eligible boundary.

---

## 4. ADR Index

| # | Title | Decision |
|---|---|---|
| 0001 | Modular suite, unified experience | Build greenfield suite with explicit bounded contexts (task, calendar, session, sync, automation) behind a single React product experience; default deployment ≤2 containers. |
| 0002 | Bundle Baïkal behind CalDAV contract | Ship Baïkal as default second container and authoritative calendar store, but integrate through qualified CalDAV/CardDAV contracts so advanced deployments can substitute a compatible server. |
| 0003 | Single-owner first, multi-user-ready | v1 supports one owner but all records, tokens, and credentials remain scoped to a stable owner identity; multi-user deferred, not simulated. |
| 0004 | Greenfield for new users | React product is for new users, not Super Productivity parity. May reuse domain ideas but does not inherit Angular/NgRx storage, plugins, or full feature set. |
| 0005 | Federate or migrate, never implicit mirror | Every calendar has exactly one authoritative provider. Offer explicit one-time migration and read-only iCal publication; no default bidirectional mirroring. |
| 0006 | TypeScript modular monolith and SQLite | pnpm TS workspace with React/Vite + one Node.js server; independently testable packages bundled into one deployable artifact; SQLite storage; one Suite container + one Baïkal container. |
| 0007 | Server-side sessions and encrypted connectors | Opaque session cookies, SHA-256 session digests, memory-hard scrypt passwords, independent CSRF tokens, AES-256-GCM connector credentials with mode-0600 key file outside SQLite. |
| 0008 | Stable identities, mutation conventions, store authority | Persist UUID identities for owners/tasks/providers/calendars; idempotency keys, positive revision ETags, If-Match preconditions; authoritative store table defines single source of truth per resource type. |
| 0009 | Phase 1 planning with one conditional Baïkal time block | One time block per task with bounded CalDAV event projection; If-Match/If-None-Match writes; DAV 412 → visible conflict; soft-delete/recover lifecycle; no auto-scheduling. |
| 0010 | Local-first task sync, server-authoritative focus sessions | Two durable browser clients with IndexedDB local cache, offline outbox, per-field version merge; active session state machine with controller/follower, 90-second lease, 30-second heartbeat, explicit takeover. |
| 0011 | Automation as separately authorized, preview-confirmed actor | Bearer tokens (`suite_at_<UUID>.<secret>`), two-phase preview/confirmation model, @suite/contracts declarative catalog, MCP stdio adapter, append-only audit trail; no hosted MCP transport in Phase 4. |
| 0012 | Reusable work: inert templates with immutable snapshots | Task Templates and Template Sets as separate first-class records; atomic SQLite instantiation copies current contents into independent tasks with provenance; never appear in active-task queries. |
| 0013 | Choice pools with explainable logical-time authority | Four policies (cooldown, cycle, one_shot, none); eligibility evaluated at explicit ISO timestamp; Planning Placeholders resolved into ordered subtasks in one atomic transaction with deterministic idempotency. |
| 0014 | Import once, preserve source evidence, publish read-only | ICS import preserves raw VEVENT and reconciliation analysis; capability URLs for read-only iCal publication (256-bit secret, GET/HEAD only, revocable); no Phase 7 mirror. |
| 0015 | Package the stable web authority; do not fork it | Linux Electron desktop as constrained shell around deployed Suite origin; immutable release manifests promoted through candidate/stable channels; no Android/iOS/PostgreSQL without measured need. |
| 0016 | Durable notification authority | Suite owns reminder intent and delivery history; ntfy is write-only private-network adapter; atomic claim before publish; calendar-suppression logic; detailed notifications limited to task title, time, and deep link. |
