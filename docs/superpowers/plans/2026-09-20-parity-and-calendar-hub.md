# Super Productivity parity, assistant access, and calendar hub

Status: executing after the September 20 requirements interview. Product decisions
are in [the interview record](../../discovery/2026-09-20-parity-assistants-calendar-hub.md).
Development remains isolated from the active production soak.

## Ordered units

1. Finish [Sprint 14 reliability](2026-09-20-sprint-14-daily-use-reliability.md):
   shared session recovery, queued work, acknowledged-write visibility, Planner
   range/races/DST, and calendar freshness. Verify server failures and real browser
   journeys; run `pnpm verify` and commit each cohesive slice.
2. Pin the Super Productivity source and inventory parity. Start from local fork
   `a4d74ea32` and MCP checkout `6dde7f75f1f79a064b7d59346259d55076a35eb4`;
   these are implementation references, not a claim about the user's deployed
   version. Preserve unrelated changes in those checkouts.
3. Deliver a bounded Super Productivity export preview, retaining provenance and
   reporting missing capabilities before mutation. Cover live tasks and both
   archive stores, projects/tags, hierarchical tasks, notes, scheduled dates,
   deadlines, repeat configurations, and time tracking. Test malformed exports,
   duplicate IDs, missing references, counts, units, and explicit unsupported data.
4. Add durable import mappings and transactional application for qualified fields;
   build a browser preview/apply/reconciliation flow. Preserve original data,
   avoid duplicate writes on replay, and never silently flatten recurrence,
   hierarchy, or time history. Qualify a representative real export separately.
5. Close functional parity gaps in vertical slices: task hierarchy and estimates;
   archived/completed history; time-entry editing/reporting; repeat scheduling;
   project notes/backlog and remaining feature-matrix rows. Each slice needs
   shared contracts, persistence, sync, browser behavior, and assistant coverage.
6. Package Tadooer MCP and workflow skills for the target client families. Audit
   every user action against the shared automation catalog. Add missing operations
   through existing domain boundaries, concrete previews, revisions, idempotency,
   and confirmations. Test rejection/replay/stale approval and client journeys.
7. Hosted MCP: implement scoped OAuth authorization and transport only after the
   local catalog and confirmation contracts are qualified. Test exact-client auth,
   consent/revocation, and cross-client isolation; do not publish an unauthenticated
   or shared-owner-token endpoint.
8. Google/Baikal hub: explicit calendar mapping, external Baikal endpoint support,
   durable IDs/cursors/outbox/deletions, background scheduling and bounded retries,
   recurring exceptions, conflict resolution, provider permissions, and invitation
   side effects. Verify against disposable real providers before production opt-in.
   New Google write consent is a live qualification requirement, not implied by
   the existing read-only grant.
9. Optional embedded subscription runtimes: qualify Codex App Server and Claude
   Agent SDK account flows, isolated credentials, usage exhaustion, and the same
   MCP permissions. No implicit paid API fallback.

## Compatibility and release

Schema changes require forward migrations, paired database/key backups, recovery
verification, and explicit old-version compatibility. Additive preview-only work
does not need a database migration. Never change the current soak candidate for
routine roadmap work. A later candidate receives its own deployment and evidence.

## Initial parity findings

| Source capability | Tadooer baseline | Required next proof/work |
| --- | --- | --- |
| Tasks, projects, tags, notes | Present | Export mapping and functional import |
| Structured capture and deadlines | Present | Preserve source scheduling/deadline distinction |
| Subtasks | Checklist-style records | Preserve full source child-task metadata and hierarchy |
| Focus/break timer | Present | Time-history import and manual correction/reporting |
| Completed tasks | Present | Both archive stores, original timestamps, retention |
| Repeat tasks | Habits/templates are separate concepts | Implement task recurrence; do not substitute habits |
| Project notes/backlog/folders | Not established as parity | Inventory and map explicitly |
| Calendar context | Google/Baikal federation | Qualified two-way Google bridge |
| Assistant workflows | Shared catalog and local stdio | Full UI capability coverage, packaging, hosted auth |

Source evidence: Super Productivity `packages/plugin-api/src/types.ts`,
`src/app/features/tasks/task.model.ts`,
`src/app/features/task-repeat-cfg/task-repeat-cfg.model.ts`, and
`src/app/op-log/model/model-config.ts`. Reconcile the installed/exported version
before declaring migration complete. Source inspection and a synthetic fixture
are not evidence that the user's real history was migrated.

## Execution evidence

- Reliability slices committed and verified; see Sprint 14 for exact checks.
- Super Productivity preview delivered in Connections and the authenticated
  `/api/imports/super-productivity/preview` endpoint. It explicitly cannot apply
  data yet. Initial upload limit is 4 MiB; larger exports must be retained intact.
- Parser inventories live/young/old tasks, projects, tags, repeat configurations,
  dates, and leaf-task time. Reports duplicate IDs, broken references, invalid
  dates, mismatched time totals, and known parity gaps. Source configuration and
  credentials are not echoed.
- Verification: 203 tests, four builds, owner/CSRF rejection, no task writes, and
  browser upload of the pinned upstream overdue fixture (one project, one tag,
  five repeat configurations). Synthetic tests cover hierarchical and archived
  tasks. The owner actual export has not been imported or qualified.
- Live Super Productivity MCP health and capabilities responded successfully;
  plugin 0.1.0/protocol 2.0 includes recurrence, archive, worklog, bulk scheduling,
  project/tag mutations, and counters. These extend the initial parity inventory.
