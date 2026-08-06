# Existing Super Productivity MCP catalog mapping

**Status:** Phase 0 feasibility and boundary analysis. No Suite MCP server,
transport, credential, or production integration is introduced by this document.

## Evidence inspected

This analysis is based on the local source checkout
`/home/onnwee/Projects/tools/super-productivity-mcp` at commit
`82cf129fb48714dc91898aeb1067483d663e7a5e`. The checkout had unrelated local
changes when inspected; none were modified.

The source catalog is `internal/catalog/tools.json`, embedded and schema-checked
by `internal/catalog/catalog.go`. At this snapshot it declares 55 actions,
all exposed as MCP tools, and 11 read-only resources:

| Surface | Catalog groups | Meaning for this analysis |
| --- | --- | --- |
| Task tools | 37 `task.*` actions | Super Productivity task records, scheduling, recurrence, tracked time, bulk actions, and bridge diagnostics |
| Project/tag tools | 3 `project.*`, 3 `tag.*` actions | Super Productivity organizational records |
| Counters/notifications | 6 `counter.*`, 2 `notification.*` actions | Plugin-specific extensions and desktop notifications |
| Bridge tools | 4 `bridge.*` actions | Health, connection, capability, and directory diagnostics for the plugin bridge |
| Resources | `sp://projects`, tags, task filters, schedule views, and counters | Fixed-payload read-only views fulfilled through the same bridge actions |

The source server is an MCP JSON-RPC 2.0 **stdio** adapter. It validates tool
arguments and optional outputs from its catalog, then forwards resolved actions
over local file IPC to a plugin running inside Super Productivity. Optional
localhost REST endpoints with an environment-supplied bearer token fill gaps in
the plugin API for archive/restore and some timer operations. This is an
integration with Super Productivity's runtime and data model, not a generic
task-service implementation.

No live client registration, MCP `initialize`, tool call, resource read, OAuth
flow, Local REST call, or Super Productivity plugin runtime was exercised for
this spike. The conclusions below are source-verified only.

## Suite automation boundary

The Productivity Suite will own task, task-to-calendar mapping, active-session,
provider, confirmation, idempotency, audit, and authorization policy. Baïkal
and other calendar providers remain authoritative for their calendar resources.
The Suite automation context must invoke the same Suite application contracts
as the React client; it must never operate through the existing Super
Productivity plugin, its filesystem IPC directories, or Super Productivity's
private task identifiers.

Accordingly, an eventual MCP adapter is only an authenticated edge adapter:

```text
MCP client
  -> Suite MCP transport and scoped credential
  -> automation authorization, preview/confirmation, idempotency, audit
  -> Suite task / calendar / active-session application contracts
  -> Suite persistence and qualified calendar-provider ports
```

The existing `sp-mcp -> file IPC -> Super Productivity plugin` path is not on
the Suite production path. It remains a separate existing-system integration
and potential import/reference source.

## Mapping decisions

| Existing concept | Decision | Suite direction and rationale |
| --- | --- | --- |
| A single declarative catalog as the source of truth for names, input schemas, output schemas, resources, and adapter mappings | **Reuse the pattern** | Keep one Suite-owned catalog/contract source, generate or check adapter-facing views, and fail CI on catalog/schema drift. This directly supports the Phase 4 API/catalog parity exit evidence. |
| Startup compilation of input and output schemas | **Reuse the pattern** | Validate Suite automation requests before dispatch and validate adapter results before they reach an MCP client. Schemas must be Suite contracts, not copied Super Productivity shapes. |
| Read-only MCP resources distinguished from tools | **Reuse the pattern** | Expose small owner-scoped Suite views such as tasks, schedule, projects/tags, active session, and provider freshness as read-only resources. Resource contents must obey the same authorization and freshness policy as the HTTP API. |
| Typed error shape with code, retryability, and limited details | **Adapt** | Converge on the Suite API error taxonomy being defined in Phase 0C. Preserve stable machine-readable code and retryability, but do not expose task content, connector credentials, or internal transport paths in details. |
| Catalog-driven contract tests and read-only evaluation scenarios | **Reuse the pattern** | Add Suite fixtures that prove catalog/API parity, authorization rejection, no-content error safety, preview/confirm requirements, retry/idempotency behavior, and revision-conflict presentation. |
| Stdio MCP JSON-RPC adapter | **Adapt and defer** | A local stdio adapter is a Phase 4 transport candidate, not Phase 0 product code. It must authenticate to Suite contracts with an explicit local credential strategy; it cannot inherit filesystem trust from the source server. Hosted transport remains a separate authenticated design decision. |
| `task.*`, `project.*`, `tag.*`, `counter.*`, and `notification.*` action names | **Decline as canonical names** | Define Suite vocabulary from Suite bounded contexts and stable IDs. Avoid presenting Super Productivity's task semantics, counters, project/tag schema, or notification behavior as Suite compatibility commitments. An explicit later import adapter may map source concepts with provenance. |
| Direct forwarding of catalog actions to the Super Productivity plugin | **Decline** | This would bypass Suite owner authorization, durable idempotency, revisions, audit, task/calendar mapping, and one-authority-per-calendar policy. |
| File IPC inbox/processing/outbox/deadletter protocol | **Decline for production** | It assumes local co-installation with a desktop plugin and has retry/timeout semantics that cannot establish Suite mutation idempotency. The Suite server's durable operation ledger is the required mutation authority. |
| Optional Local REST URL and bearer token in MCP-client environment | **Decline** | Environment bearer tokens for a loopback desktop REST bridge are not an authorization model for Suite automation. Suite scoped credentials, storage, revocation, and transport are deferred to the Phase 4 security decision. |
| `dryRun:false` plus `confirmApply:true` convention for broad actions | **Adapt** | Preserve the useful preview-before-apply intent, but make confirmation an explicit Suite operation/approval contract tied to a preview result, actor, expiration, scope, revision, and idempotency key. Boolean flags alone are not a sufficient authorization or replay boundary. |
| Source `stop_task` no-op idempotency and retryable IPC errors | **Adapt** | Model idempotency per Suite command with a durable owner-scoped key and stored outcome. Do not infer idempotency from a tool description or blindly retry calendar writes after transport uncertainty. |
| Quick-add using the same bridge as MCP | **Reuse only the architectural principle** | A later Suite quick-add client may call the same Suite API/automation command contracts. The current Super Productivity quick-add binary and plugin bridge are not reused. |
| Plugin health/capabilities diagnostics | **Adapt** | Provide Suite health, readiness, build, connector/provider health, and later automation diagnostics through Suite-owned endpoints. Do not expose client filesystem paths or bridge directory details. |

## Catalog surface disposition

The source catalog is useful as an evidence-backed inventory, but only a small
semantic subset overlaps the Suite roadmap:

| Source capability family | Potential Suite counterpart | Phase 0 disposition |
| --- | --- | --- |
| Create/list/get/update/complete/reopen/delete task | Owner-scoped Suite task commands and recovery model | Define the identity, revision, error, authorization, and idempotency contract in Phase 0C. Implement only the selected task-capture slice; do not promise source parity. |
| Project/tag/subtask/estimate and bulk task changes | Later core-task and planning contracts | Deferred. These depend on the basic Suite task entity, recovery semantics, multi-client conflicts, and Phase 1 product scope. |
| Planned time, schedule hygiene, auto-scheduling | Task-to-event calendar planning and availability policy | Deferred. Calendar writes require qualified provider identity, ETags/revisions, conditional operations, preview/confirmation, and real Baïkal qualification. |
| Timer/current task/worklog | Active-session bounded context | Deferred to Phase 2, where owner/follower/takeover/expiry/recovery semantics are explicitly scoped. |
| Recurrence | Task recurrence and/or calendar recurrence | Deferred. No source recurrence schema is adopted; Suite must distinguish task recurrence from calendar RFC 5545 behavior. |
| Archive/restore | Suite task deletion/recovery model | Deferred. The source Local REST fallback that marks a task done is specifically not acceptable as a Suite archive semantic. |
| Projects, tags, counters, notifications | Future Suite domain decisions | Deferred or declined pending a Suite-owned product decision. Counters are not currently on the roadmap. |
| Existing `sp://` resources | Eventual Suite read-only resource catalog | Do not retain `sp://` URIs. Choose Suite-owned URIs only after the authorization, tenant/owner scoping, versioning, freshness, and cache semantics are set. |

## Authentication, authorization, and transport findings

The source adapter trusts the local MCP client process and its shared data
directory; it has no Suite-style user/session or token authorization layer.
Its optional Local REST bearer token is configured in the MCP client
environment. That configuration is valid only for the source application's
localhost bridge and cannot demonstrate OAuth, token storage, revocation,
scoping, or Suite automation authorization.

For the Suite, retain these non-negotiable boundaries:

- Interactive browser sessions remain separate from automation credentials.
- Every automation request is authorized against the stable Suite owner and
  scopes before reading or mutating data.
- Mutations carry a durable idempotency key and return a stable outcome; a
  transport retry must not duplicate a task or calendar event.
- Broad or destructive actions require an explicit preview/confirmation
  contract. Authorization, confirmation, and idempotency are separate checks.
- Audit records hold actor, declared operation, outcome, and safe metadata;
  they do not log task/note content or connector credentials.
- Hosted MCP, if selected later, needs a supported authentication and
  revocation design. OAuth is not assumed merely because a client can launch a
  local stdio process.

## Phase 0 conclusion and follow-up

This spike closes only the **existing MCP catalog mapping analysis** item from
the Phase 0 roadmap. It does not close Phase 4 automation implementation, and
it does not consume the Google OAuth/Calendar feasibility spike.

Before this analysis can inform implementation, Phase 0C must establish the
Suite's stable owner/task/provider/event/client identities and API
error/idempotency/revision conventions. The first Suite task-capture vertical
slice should use those contracts directly. A later automation slice can then
create a Suite-owned catalog with a deliberately small read-only surface first,
followed by preview/confirm mutations and catalog/API parity tests.

## Verification

- Source inspected read-only at the commit recorded above; existing uncommitted
  source changes were not touched.
- Catalog count and declared actions/resources were read from
  `internal/catalog/tools.json`.
- Source structure checked against its catalog loader, stdio adapter, IPC
  client, Local REST documentation, and MCP adapter tests.
- No source tests, client reloads, live MCP initialization, plugin IPC calls,
  Local REST calls, OAuth flows, or Suite automation code were run. Those are
  intentionally unverified because this is a source-analysis spike only.
