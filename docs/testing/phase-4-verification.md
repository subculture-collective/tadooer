# Phase 4 verification plan: first-class automation and MCP

**Status:** implemented and qualified on 2026-08-06. This document records the
delivered verification layers; it does not claim Phase 3 calendar federation
or a hosted MCP transport.

## Current baseline and scope boundary

The checked repository contains the Phase 2 runtime plus the Phase 4
provider-independent automation boundary: scoped credentials, audit and
outcome ledgers, a Suite-owned catalog, confirmed task/calendar/focus commands,
a local stdio MCP adapter, and quick-add. Phase 3 Google Calendar federation is
still absent.

Consequently, Phase 4 verification identifies the actual calendar provider
surface in this checkout. It does not assume
Google OAuth, unified availability, provider revocation, recurrence support,
or hosted MCP from a roadmap entry alone. The test fixture may exercise
Baikal-backed scheduling only while that is the qualified provider surface; its
claims must say so. If Phase 3 introduces a unified provider port, the same
tests must run against each supported provider with provider-specific fixture
setup.

The existing Super Productivity MCP repository is reference material only. The
Suite must not use its file IPC bridge, private task identifiers, `sp://`
resource URIs, or environment bearer-token convention as a production path.

## Delivered Phase 4 surfaces

The implementation and its verifier provide:

1. A Suite-owned declarative automation catalog defining tool/resource names,
   input and output schemas, required scopes, mutation/preview/confirmation
   classification, and API mapping.
2. Application services shared by interactive and automation entry points for
   task, calendar-block, and active-session operations. The MCP adapter may
   not call React/browser internals or database methods directly.
3. Separate scoped automation credentials with server-side digests, issuance,
   expiry, revocation, and owner binding. Browser cookies and Phase 2 sync
   client credentials are not automation credentials.
4. Durable, owner-scoped operation outcomes and safe audit records, including
   an operation/request hash and replay/conflict state.
5. Explicit preview and confirmation records, bound to actor, owner, action,
   target scope, current relevant revisions/provider state, expiry, and the
   final idempotency key.
6. A local stdio JSON-RPC MCP adapter using the Suite automation API.
7. An explicit ADR for hosted MCP: either a supported authenticated/revocable
   transport with a verification target, or an intentional deferral. A local
   stdio adapter alone is not hosted MCP.
8. A quick-add client using the same Suite automation command contract.

## Verification layers

| Layer | Command/test home | Purpose |
| --- | --- | --- |
| Contracts | `packages/contracts/src/*.test.ts` | Validate catalog schemas, public errors, scopes, preview and confirmation payload limits. |
| Persistence | `packages/persistence/src/*.test.ts` | Prove atomic durable outcome, confirmation consumption, audit redaction, and calendar-write recovery. |
| Server integration | `apps/server/src/phase4.test.ts` | Prove authorization, preview/confirm, retry/restart, scope, and revocation behavior through HTTP. |
| MCP protocol | `apps/mcp-stdio/src/*.test.ts` and `deploy/phase4-runtime.mjs` | Validate protocol behavior and spawn the built stdio adapter against the deployed Suite. |
| Quick-add | quick-add package test plus verifier helper | Prove it uses the same API/credential/confirmation path with no bypass. |
| Disposable runtime | `deploy/verify-phase4-compose.sh` | Prove packaged Compose behavior with a synthetic owner, quick-add retry, real stdio child process, revocation, browser continuity, and cleanup. |

`pnpm verify` remains the code-quality gate. `pnpm verify:phase4` runs it, the
focused automation suites, and the disposable Compose runtime verifier.

## Catalog/API parity checks

The Suite catalog is the source of truth. The parity suite must:

1. Enumerate every catalog tool and resource and verify its input/output schema
   compiles at startup.
2. Assert every catalog entry has one registered application/API handler and
   its declared scope, preview requirement, confirmation requirement, and
   idempotency policy.
3. Assert every public automation handler is catalogued; unlisted public
   automation actions fail the test.
4. Run representative valid and invalid input/output fixtures for every entry,
   including zero-result read resources.
5. Validate the stdio adapter's `tools/list` and resource discovery output
   against the same catalog, not a separately hand-maintained list.

At minimum, the read-only resource checks cover owner-scoped tasks, schedule,
projects, tags, and active session. Calendar/schedule responses must include
the documented freshness/provider state rather than presenting stale
projections as current fact.

## Authorization, preview, and confirmation matrix

For every catalogued action, the HTTP integration suite should construct an
owner, at least two automation credentials, and a live interactive browser
session. It must prove the following outcomes:

| Case | Expected result |
| --- | --- |
| Valid owner credential with required scope | Authorized request succeeds and produces safe audit metadata. |
| Same owner credential lacking scope | Stable authorization error; no read or mutation result. |
| Credential from another owner | No cross-owner data disclosure; stable authorization error. |
| Unknown, malformed, expired, or revoked credential | Fail closed before preview/read/mutation; no side effect. |
| Direct broad/destructive mutation without confirmation | Explicit confirmation-required error; no side effect. |
| Valid preview followed by valid confirmation | One mutation and one durable outcome. |
| Confirmation used by different actor, owner, operation, target set, or idempotency key | Rejected; no side effect. |
| Confirmation after expiry or relevant task/calendar revision change | Rejected as stale/expired; caller must preview again. |
| Exact confirmation retry | Stored outcome is replayed; no second mutation. |

The preview result must not itself apply a mutation. A Boolean such as
`confirm: true` is insufficient unless it refers to a durable server-issued
confirmation record meeting the bindings above.

## Retry and non-duplication scenarios

### Task creation

1. Submit a confirmed task-create request with an idempotency key.
2. Let the service persist the result, but simulate response loss at the caller
   boundary.
3. Restart the Suite process against the same database.
4. Submit the byte-equivalent request with the same credential and key.
5. Assert the returned operation is replayed, one task exists, task identity
   and timestamps/outcome are unchanged, and audit has one applied outcome
   plus an optional safe replay record according to the documented policy.
6. Reuse the same key with a changed request hash and assert
   `IDEMPOTENCY_CONFLICT`, one task, and no calendar side effect.

### Calendar creation, move, and removal

Each write requires a corresponding test because provider writes can succeed
before the Suite returns a response:

1. Use a disposable qualified calendar provider and obtain a valid preview and
   confirmation for create/move/remove.
2. Inject response loss after the provider-side write has succeeded and the
   Suite has persisted enough recovery identity to reconcile it.
3. Restart the Suite, resend the same key/request, and wait for recovery.
4. Assert one Suite task block and exactly the expected provider resource:
   one UID/href after create or move, and no resource after remove.
5. Assert no duplicate event, block, or calendar-write operation appears.
6. Reuse the key with altered task/calendar/timing input and assert rejection.

The implementation must not rely on a generic HTTP retry around an uncertain
provider mutation. Durable provider operation identity, request hash, and
recovery state are required.

## Revocation without interactive disruption

This is a required two-principal runtime test:

1. Sign into the web UI and retain its browser session/cookie.
2. Issue an automation credential; read a resource and complete at least one
   permitted preview/confirmation flow.
3. Revoke only that automation credential through the authorized management
   route/application service.
4. With the unchanged web browser session, list tasks and create or update an
   interactive task successfully.
5. Attempt resource read, preview, confirmation, and an exact retry through
   the revoked automation credential. Each must fail closed with the stable
   automation authorization error and produce no mutation.
6. Assert the interactive session remains authenticated and is not rotated,
   logged out, or downgraded as an incidental effect of MCP credential
   revocation.
7. Inspect audit/log fixtures to prove raw credentials and task note/title
   content are absent.

## Local stdio MCP verification

The test must launch the shipped adapter as a separate child process and send
newline-delimited JSON-RPC 2.0 messages. It must cover:

1. `initialize` and capability negotiation.
2. Tool/resource discovery matching the Suite catalog exactly.
3. Read-only resources for tasks, schedule, projects, tags, and active
   session, including no-result and stale-provider cases.
4. A valid preview, valid confirmation, exact retry, and changed-key conflict.
5. Missing scope, malformed request, missing confirmation, stale confirmation,
   and revoked credential errors.
6. Clean stdout: stdout contains JSON-RPC protocol messages only; diagnostics
   go to stderr and contain no raw credential, task content, connector secret,
   file-system bridge path, or stack trace with secrets.
7. Process termination and retry behavior: the adapter can reconnect to the
   same durable Suite outcome after adapter or Suite restart.

The adapter may authenticate through an explicit local credential strategy, but
must not inherit ambient filesystem trust merely because it was launched on the
same machine.

## Hosted transport decision gate

Before release qualification, add an ADR with exactly one status:

- **Hosted selected:** identify the supported authentication mechanism,
  credential storage, consent/redirect boundary if applicable, scope mapping,
  TLS/proxy requirements, revocation propagation, and a test environment that
  proves issuance, access, scope denial, and revocation.
- **Hosted deferred:** say that only the local stdio adapter is shipped in this
  phase and explicitly do not document or market hosted MCP as available.

The Phase 4 verifier must check the selected status. It cannot treat an MCP
client capable of launching stdio as evidence of a hosted authenticated
transport.

## Quick-add verification

The shipped quick-add client must use the same Suite command/credential path as
the adapter. Its test must:

1. Provide synthetic input and create one task through the automation API.
2. Simulate response loss, retry with the same durable key, and show exactly
   one task from both the API and browser surfaces.
3. Prove rejected missing/invalid confirmation behavior for any mutation that
   requires confirmation.
4. Prove insufficient-scope and revoked-credential failures have no side
   effect.
5. Assert it does not access Super Productivity IPC directories or private
   application data. The executable's stdout/stderr must not leak credentials.

## Disposable Compose verifier

`deploy/verify-phase4-compose.sh` creates a unique Compose project, builds and
starts the packaged Suite/Baïkal topology, bootstraps a synthetic owner, issues
a short-lived credential into a mode-0600 temporary file, and runs the built
quick-add executable twice with the same input/key. It then spawns the built
stdio MCP process, performs `initialize`, catalog discovery, and a real task
resource read, revokes the credential, proves automation fails closed, and
proves the browser session can still read tasks. Its exit trap removes volumes;
the runtime helper removes the temporary credential file even on failure.

Calendar response-loss/restart qualification is intentionally exercised in
`apps/server/src/phase4.test.ts`, where the synthetic DAV provider commits the
PUT and drops its response, the Suite restarts, the same confirmation
reconciles by reserved href/UID, and the test asserts one remote resource. The
Compose gate qualifies the packaged local clients and authorization boundary;
it does not claim a production Google provider, universal CalDAV behavior, or
hosted MCP.

## Completion criteria

Phase 4 is ready to close only after the code gate and the disposable runtime
gate pass from a clean checkout, the hosted transport ADR has a deliberate
status, and the release documentation matches the actually qualified provider
and transport scope. A passing catalog/unit suite is not enough without the
response-loss restart, stdio child-process, calendar identity, and interactive
non-disruption evidence described above.
