# Phase 5 verification plan: reusable work

**Status:** implementation verification plan. This document qualifies the
inert Task Template and Template Set slice defined in the Phase 5 roadmap. It
does not claim Choice Pools, Planning Placeholders, policy-based suggestions,
or pool-resolution conflict semantics; those are Phase 6 work.

## Qualified contract

A Task Template is a separate, inert blueprint. It may carry task content,
settings, and ordered subtask blueprints, but it is never an ordinary task and
has no open/completed status, reminder, active session, calendar block, or
time-tracking lifecycle. A Template Set is an ordered collection of templates.
Instantiation creates independent normal work in one explicitly selected,
existing project. The result records template provenance as historical context,
not a live link.

The product contract is consequently:

1. The Template Library/search and explicit template pickers are the only
   template discovery surfaces.
2. Creating, editing, archiving, or synchronizing a template cannot make it
   appear in tasks, Today, planner, calendar, overdue, focus, reminder, or
   time-tracking results.
3. Instantiation copies a snapshot into a new task plus new ordered subtasks;
   editing the source afterwards never changes those instances.
4. A Template Set may suggest a destination, but confirmation requires an
   explicitly selected existing active project. It must not silently create a
   project or route work to Inbox.
5. The instantiation transaction and its stored outcome bind the owner,
   request hash, and idempotency key. Exact retry yields the original complete
   task tree; different input with the same key fails without a partial tree.
6. Templates and sets are first-class sync and backup data. They are not
   serialized as unscheduled task records.
7. Automation may list templates and preview instantiation, but mutation uses
   the same scoped preview/confirm/idempotency rules as every Phase 4 command.

## Verification layers

| Layer | Command/test home | Required evidence |
| --- | --- | --- |
| Contracts | `packages/contracts/src/*.test.ts` | Separate template/set/provenance/tree-result schemas, scoped catalog entries, and strict invalid-input rejection. |
| Persistence | `packages/persistence/src/*.test.ts` | New migration, atomic tree creation, durable replay after reopen, ordered blueprints, snapshot independence, and separate active-task queries. |
| Server + sync | `apps/server/src/phase5.test.ts` | Interactive creation/from-task/edit/search/set selection, inertness on every active API query, two-client synchronization, confirmation stale/retry/restart behavior. |
| MCP | `apps/mcp-stdio/src/*.test.ts` | Shared-catalog list/template resource/instantiate preview discovery and schema mapping, without a parallel adapter declaration. |
| Disposable runtime | `deploy/verify-phase5-compose.sh`, `deploy/phase5-runtime.mjs` | Built Compose services, real stdio child, preview/confirm/retry, backed-up and restored template data/provenance, and cleanup. |

`pnpm verify` remains the general code-quality gate. `pnpm verify:phase5`
runs that gate, focused Phase 5 tests, and the disposable Compose journey.

## Required HTTP and synchronization scenarios

The server integration suite uses an authenticated owner session, an active
and an archived project, two registered clients, and a narrowly scoped
automation credential.

| Scenario | Required assertion |
| --- | --- |
| Create scratch template | Template is visible in the Template Library/list response and absent from task, recovery, planner/schedule, focus, and automation task-resource responses. |
| Create from task | Copy the supported task content and ordered existing subtasks into a new template without altering the original task. |
| Edit/archive template | The library reflects the edit/archive lifecycle; a previously instantiated task and children retain their original snapshot. |
| Instantiate one template | Result has a new task identity, selected project, source template ID/revision, copied fields, and a complete ordered independent subtask list. |
| Instantiate a set | All set members create into the explicitly selected project in declared order. Missing, archived, or omitted destination is rejected and creates no work. |
| Retry/restart | Confirm the same preview/key, restart the server, confirm again, and get the same root/child IDs with `replayed: true`. A changed request using the key receives an idempotency conflict. |
| Stale preview | Change the template or set after preview; confirmation is rejected as stale and creates no task. |
| Sync | Templates and sets converge through their dedicated snapshot/change types across two clients and a restart. No sync operation creates an ordinary task merely by syncing template data. |
| Automation | Template-list resource succeeds only with template read scope. Instantiate preview makes no mutation; confirmation creates the single expected tree; retry replays it; revoked credential fails closed while browser session continues. |

For all exact-once tests, assert the complete ordered tree—not merely the
parent task count—and repeat the list after process restart. A parent-only
assertion could miss duplicate children after a partial failure.

## Backup/restore and deployed MCP gate

The Phase 5 Compose verifier creates synthetic owner data only. It must:

1. Start a unique Compose project and create a mode-0600 temporary automation
   credential file.
2. Create an existing project, a template with multiple subtasks, and a
   Template Set through the shipped Suite API.
3. Launch the built stdio MCP adapter as a child process, verify template
   resource discovery/listing, request an instantiation preview, confirm it,
   and repeat confirmation with the same key.
4. Take a matched Suite database/credential backup, restore it using the
   documented scripts, and wait for readiness.
5. Verify template and set records, provenance, and the original instantiated
   task tree remain present after restoration; retry continues to replay rather
   than creating a duplicate tree.
6. Revoke the credential, prove the adapter/API fail closed, and prove the
   retained browser cookie can still read ordinary tasks.
7. Remove temporary credential material and Compose volumes on both success
   and failure.

The SQLite backup pair carries the new data because templates are persisted in
the Suite database. That implementation fact is not sufficient release
evidence: a fresh-volume restore must demonstrate migration, records,
provenance, and idempotency outcomes together.

## Completion boundary

Phase 5 is ready to close only when the focused integration tests and
`pnpm verify:phase5` pass from a clean checkout. Passing unit tests alone do
not qualify this phase: the deployed gate must use the built MCP process and
demonstrate a restored exact-once tree. Choice Pool history, eligibility,
resolution, and cross-device placeholder conflict remain Phase 6 acceptance
work and must not be represented as delivered by this verifier.
