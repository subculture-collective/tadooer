---
status: accepted
---

# Fix stable identities, mutation conventions, and store authority

Phase 0 closes with persisted UUID identities for Suite-owned owners, tasks,
calendar providers, and discovered calendar collections. The client UUID schema
and table are reserved for Phase 2 registration. Provider-native event identity
is contract-only until Phase 1 projection: opaque strings are always qualified
by the Suite provider and calendar UUIDs. A provider-native href, UID, or Google
event identifier is never treated as globally unique by itself.

## API conventions

- Authenticated operations derive `ownerId` from the server-side session. An
  owner identifier supplied by a browser is never an authorization decision.
- Every mutation requires same-origin validation, an authenticated actor, and
  the actor's CSRF or future scoped-automation credential.
- Every API error contains a bounded uppercase `code`, a safe human `message`,
  and a generated `requestId`. Error responses do not contain task content,
  credentials, stack traces, or provider response bodies.
- Retriable creates require an `Idempotency-Key` of 8–128 URL-safe characters.
  The durable ledger is scoped by owner, operation, and key. A retry with the
  same normalized request hash returns the original resource; a different hash
  returns `IDEMPOTENCY_CONFLICT` and creates nothing.
- Suite-owned mutable resources have positive integer revisions. Successful
  mutations return the current revision in the body and as a quoted `ETag`.
  Phase 1 update/delete operations must require `If-Match`; a stale or missing
  precondition fails visibly and never overwrites newer state.
- Browser sessions are the only implemented actor in Phase 0. The automation
  actor is a separate authorization context for Phase 4, not an implicit reuse
  of browser cookies or connector credentials.

## Authoritative stores

| State | Authority | Phase 0 handling |
| --- | --- | --- |
| Installation, owner, web sessions | Suite SQLite | Authoritative and included in Suite backup |
| Client identity and revocation | Suite SQLite | Schema/contract fixed; registration begins with multi-client work |
| Tasks and task revisions | Suite SQLite | Authoritative; capture is implemented and backed up |
| Idempotency outcomes | Suite SQLite | Authoritative retry ledger, stored beside the created resource |
| Provider and discovered-calendar identity | Suite SQLite | Stable Suite UUIDs map to connector/native hrefs |
| Baïkal credentials | Suite SQLite plus mode-0600 Suite key | Encrypted record and key must be backed up as a pair |
| Baïkal DAV resources, UIDs, hrefs, ETags | Baïkal volumes | Authoritative; Phase 0 only discovers collections |
| Google calendar resources | Google | No live state or credentials in Phase 0; future local state is a projection |
| Imported source records | The source until explicit import apply | Phase 0 fixtures are synthetic contract inputs, not published Suite data |
| Calendar projections and task-event mappings | Suite SQLite | Future derived/mapping state; never a second event authority |
| Automation tokens and audit records | Suite SQLite | Future authority after the Phase 4 security contract is implemented |

SQLite backups do not contain authoritative Baïkal data. Baïkal volumes require
their own consistent backup. A connector, import adapter, or MCP adapter cannot
change which store is authoritative merely by copying data.

## Phase boundary

Phase 0 proves the contracts with synthetic fixtures and a task-capture vertical
slice. Task editing/deletion, event projection and conditional CalDAV writes,
client registration/sync, Google OAuth, and automation transports remain later
phase work and must consume these identities and conventions rather than invent
parallel ones.
