---
status: accepted
---

# Make automation a separately authorized, preview-confirmed Suite actor

Phase 4 introduces first-class automation without granting an MCP client, a
quick-add client, or a local process implicit access to Suite state. Suite
SQLite remains authoritative for automation credentials, previews, durable
outcomes, and audit metadata. Suite task, planning, calendar-projection, and
active-session application contracts remain the only mutation authorities.
Baïkal and other providers remain authoritative for their calendar resources.

## One Suite catalog and a deliberately small surface

`@suite/contracts` owns one declarative automation catalog. It defines the
stable operation/resource identifier, required scopes, confirmation rule, HTTP
mapping, MCP name/URI, and input/output Zod schemas. HTTP handlers and the MCP
adapter import that catalog; they do not maintain copies. A parity test fails if
an adapter-visible catalog entry lacks a handler/schema or a handler exposes an
adapter-visible operation outside the catalog.

The first surface is intentionally narrow:

- read-only owner-scoped tasks, schedule, projects, tags, and active-session
  resources;
- preview then confirmed creation of one task;
- preview then confirmed creation of one task calendar block; and
- preview then confirmed focus-session start, pause, resume, break,
  completion, or takeover commands.

It does not inherit Super Productivity action names, `sp://` URIs, private
identifiers, file IPC, counters, notifications, bulk operations, generic task
patch/delete, or a rules engine. A later feature adds an operation only by
adding it to the Suite catalog and proving the same authority boundaries.

## Authentication and scope are independent of interactive sessions

An automation credential is an opaque bearer token in the form
`suite_at_<token UUID>.<256-bit secret>`. The raw secret is returned only by
the authenticated, same-origin token-creation response. SQLite stores the
token UUID, SHA-256 secret digest, stable owner UUID, bounded label, unique
scope list, expiry, last-use timestamp, and revocation timestamp; it never
stores the raw secret. A token is owner-bound. Caller-supplied owner IDs,
browser cookies, CSRF tokens, connector credentials, and Phase 2 browser-client
credentials are not automation authorization.

Automation endpoints require a syntactically valid `Authorization: Bearer`
credential and do not refresh or consult browser session state. They reject an
`Origin` header and send no CORS permission, preventing a browser context from
turning a bearer endpoint into a cookie-backed API. Authentication checks the
current SQLite record, expiry, and revocation before any resource read,
preview, outcome replay, or mutation. Scope checks happen before all operation
evaluation. Revoking a token therefore fails closed immediately without
revoking or otherwise disrupting the owner's interactive browser sessions.

Token management is browser-only and requires the normal same-origin, session,
and CSRF checks. Scope elevation is revoke-and-reissue, never an in-place token
edit. Tokens have a bounded expiry policy. Token inventory responses never
include a secret and every token response is `Cache-Control: no-store`.

## Preview, confirmation, and idempotency are separate checks

Every initial mutation is submitted to the preview endpoint with one catalog
operation and its exact input. A preview has no Suite or remote side effect. It
stores the owner, token actor, normalized input hash and private input,
operation, scope/policy snapshot, affected entity IDs, base revisions,
expiration, and lifecycle state. The response exposes only a bounded human
summary, affected IDs, revisions, expiry, and `requiresConfirmation: true`.
It never returns an executable raw request body in an audit or diagnostic
artifact.

Confirmation supplies a separate idempotency key. Execution is allowed only
when the confirming token and owner match the preview, the preview is unexpired
and unconsumed, the exact normalized input hash matches, the policy snapshot
still permits the operation, and the recorded resource revisions remain valid.
It then invokes the same Suite application contract as the browser. A Boolean
such as `dryRun: false` or `confirmApply: true` is not a confirmation boundary.
An expired or revision-stale preview fails visibly and requires a new preview.

The durable automation outcome key is `(owner, token, operation,
idempotency key)` plus a canonical request hash. The same key and hash replay
the stored response; the same key with another request conflicts and performs
nothing. The outcome lookup occurs after token authentication but before
confirmation expiry/consumption, making transport retries safe even after a
success. Automation derives a deterministic internal key when it invokes the
existing task or calendar idempotency ledgers, so an automation retry cannot
collide with a browser mutation or another agent's key.

Each local command first enters its existing durable, namespaced idempotency
ledger. Preview consumption, the automation response, and the execution audit
then finalize atomically. A crash between those boundaries replays the same
underlying command rather than applying it twice. Calendar writes remain a
distributed operation and use the existing reservation and reconciliation
protocol with that deterministic key. Automation does not report a successful
outcome until the durable calendar mapping is complete; uncertain remote writes
remain reconcilable and retry the same reservation rather than creating another
event.

Automation credentials remain a distinct authorization boundary. Phase 2's
interval tables require a controller foreign key, so issuance atomically adds
an internal compatibility controller row with an unrecoverable random proof;
it is hidden from browser sync-client inventory and cannot authenticate.
Revocation atomically revokes both records and expires any nonterminal session
controlled by that token, closing its open interval with an automation-revoked
event so an uncommandable controller cannot remain live.

## Audit data is intentionally safe and append-only

Authenticated reads, previews, successful executions, confirmation replays,
and scope/stale/expired denials get append-only audit rows with owner ID, token
ID, catalog operation, phase, outcome, bounded error code, request hash,
preview/outcome IDs, affected IDs, and timestamp. Malformed or unknown
credentials fail before an actor can safely be attributed. Audit records do not
contain bearer secrets, task titles or notes, preview input, connector
credentials, provider response bodies, stack traces, or filesystem paths.
Revocation retains audit history; it does not delete the token record.

## MCP, quick-add, and hosted transport decision

Phase 4 supplies a thin local stdio MCP JSON-RPC adapter. It validates catalog
input and output, derives `tools/list`, `tools/call`, `resources/list`, and
`resources/read` from the Suite catalog, and calls the Suite automation API.
It never talks to Super Productivity's plugin, file IPC directories, or REST
fallback. Its credential is an explicitly configured, owner-readable token
file/profile with restrictive permissions, not trust inferred from a local
process or shared filesystem.

The Phase 4 hosted-MCP decision is **not enabled**. There is no public MCP
transport, OAuth claim, CORS exception, or ambient loopback bearer bridge in
this phase. A hosted transport requires a separate supported authentication,
token delivery, revocation, rate-limit, and deployment decision. Quick-add is
another client of the same preview/confirmation API and has no bypass.

## Required evidence

- catalog/API/adapter parity checks;
- token scope, expiry, and revocation tests, including browser-session
  continuity after revocation;
- no-side-effect preview, required/stale/expired confirmation, and safe audit
  tests;
- same-key replay and changed-request conflict tests across a server restart;
- task and calendar response-loss retry tests proving one task and one mapped
  remote event; and
- a Compose-qualified local stdio MCP run using synthetic task/calendar data.
