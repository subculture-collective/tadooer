# Super Productivity parity, assistant access, and calendar hub

Status: executing after the September 20 requirements interview. Product decisions
are in [the interview record](../../discovery/2026-09-20-parity-assistants-calendar-hub.md).
Development remains isolated from the active production soak.

## Current checkpoint

Use [STATUS.md](../../STATUS.md) for current implementation/publication/release
boundaries. Source and capability inventories are now explicit:
[Super Productivity parity](../../product/super-productivity-parity.md) and
[assistant capabilities](../../product/assistant-capabilities.md). The ordered
units below retain dependency intent; the execution evidence is chronological.

- #17 inventory is implemented in PR #69 with installed 18.16.0 version/hash;
  exact installed build commit remains unproven.
- #18 capacity is now 16 MiB, 50,000 records and 100,000 diagnostics (PR #54,
  carried to main through integration PR #68). Real preview still blocks apply
  on unsupported history; capacity is not migration qualification.
- #19 capability inventory and #20 calendar authority contract are implemented;
  neither proves full assistant parity or enables mirroring.
- #55 organization and #56 checklist assistant operations are implemented in
  PRs #70–#73 with 34 catalog tools and built-runtime checks. #57–#60 remain.
- All real-data cutover, live client/provider, candidate delivery and soak gates
  remain separate issues in [roadmap #15](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/15).

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

| Source capability                | Tadooer baseline                       | Required next proof/work                               |
| -------------------------------- | -------------------------------------- | ------------------------------------------------------ |
| Tasks, projects, tags, notes     | Present                                | Export mapping and functional import                   |
| Structured capture and deadlines | Present                                | Preserve source scheduling/deadline distinction        |
| Subtasks                         | Checklist-style records                | Preserve full source child-task metadata and hierarchy |
| Focus/break timer                | Present                                | Time-history import and manual correction/reporting    |
| Completed tasks                  | Present                                | Both archive stores, original timestamps, retention    |
| Repeat tasks                     | Habits/templates are separate concepts | Implement task recurrence; do not substitute habits    |
| Project notes/backlog/folders    | Not established as parity              | Inventory and map explicitly                           |
| Calendar context                 | Google/Baikal federation               | Qualified two-way Google bridge                        |
| Assistant workflows              | Shared catalog and local stdio         | Full UI capability coverage, packaging, hosted auth    |

Source evidence: Super Productivity `packages/plugin-api/src/types.ts`,
`src/app/features/tasks/task.model.ts`,
`src/app/features/task-repeat-cfg/task-repeat-cfg.model.ts`, and
`src/app/op-log/model/model-config.ts`. Reconcile the installed/exported version
before declaring migration complete. Source inspection and a synthetic fixture
are not evidence that the user's real history was migrated.

## Historical execution evidence

- Reliability slices committed and verified; see Sprint 14 for exact checks.
- Super Productivity preview delivered in Connections and the authenticated
  `/api/imports/super-productivity/preview` endpoint. At this initial checkpoint it could not apply
  data. The original 4 MiB limit is historical; current capacity is linked above.
- Parser inventories live/young/old tasks, projects, tags, repeat configurations,
  dates, and leaf-task time. Reports duplicate IDs, broken references, invalid
  dates, mismatched time totals, and known parity gaps. Source configuration and
  credentials are not echoed.
- Verification: 203 tests, four builds, owner/CSRF rejection, no task writes, and
  browser upload of the pinned upstream overdue fixture (one project, one tag,
  five repeat configurations). Synthetic tests cover hierarchical and archived
  tasks. At that checkpoint, the owner actual export had not been imported or qualified;
  see the later real-backup qualification below.
- Live Super Productivity MCP health and capabilities responded successfully;
  plugin 0.1.0/protocol 2.0 includes recurrence, archive, worklog, bulk scheduling,
  project/tag mutations, and counters. These extend the initial parity inventory.
- Local assistant package: dual Codex/Claude plugin manifests, one scoped stdio
  launcher, and a preview/confirmation workflow skill. Read resources are also
  available as tools. Installer tested under a temporary prefix; it does not
  change user client registration or credentials. Plugin and skill validators pass.
- Installed-runtime smoke against the disposable server: initialize, 23 tools,
  task reads, schedule query, preview with no write, confirmation plus replay
  producing exactly one task, and clean stderr. Full client installation,
  subscription runtime, and hosted OAuth remain unqualified.
- Assistant task editing/completion/reopening now use scoped preview tools and
  expected revisions. Their task mutation, sync change, preview consumption,
  audit record, and replay response share one transaction. An injected audit
  failure rolls everything back; stale confirmation is rejected and a successful
  response replays exactly after restart. Full verification: 205 tests and four
  builds. The installed stdio runtime now exposes 25 tools; edit and completion
  were also exercised against the disposable server.
- Client qualification blocker: the installed Claude 2.1.278 runtime reports
  `loggedIn: false`, `authMethod: none`. Its plugin validator passes. The default
  `~/.local/bin/claude` wrapper recursively resolves itself through mise; the
  installed binary at `~/.local/share/mise/installs/claude/2.1.278/claude` works.
  No desktop wrapper changes were made. Codex reports ChatGPT authentication,
  but that status alone is not a completed client workflow. Sign into Claude
  through its own terminal/browser flow before qualifying subscription-backed
  reads and writes. Never provide the credentials in chat.

## Client qualification deferred; continue independent implementation

The owner cannot access Claude on September 20 and explicitly deferred its client
qualification. This is not a blocker for import, parity, or MCP implementation.

1. When client access returns, rebuild/install the runtime into a disposable prefix and provision a short-lived
   scoped token on the disposable Tadooer instance.
2. Load the plugin in each target client and exercise read, preview, rejected
   approval, confirmed task edit, completion, and replay. Validate the skill's
   consequential-action confirmation behavior separately from server contracts.
3. Continue the remaining capability matrix and durable import/parity slices;
   these remain implementation work, not delivered features. Qualify a real
   Super Productivity export before migration. Google write consent and isolated
   mapped calendars are required before live two-way bridge qualification.
4. Keep production on its pinned soak candidate. This work has not been deployed
   or used as evidence to qualify that candidate.

- Import integrity checks now report malformed archive containers, broken child
  lists, parent cycles, missing tags, invalid daily time keys, and unsafe time
  totals. A 10,000-task chain is traversed iteratively. Preview remains read-only.
- MCP task deletion/restoration now share atomic confirmation with editing.
  Deleted tasks have a read-only recovery resource/tool. Deletion checks active
  focus and calendar links at preview and confirmation; old deletion replay does
  not delete a restored task again. Concrete previews name the affected task.
- Connections now provides assistant-token creation with explicit permissions and
  7/30/90-day expiry, one-time masked secret/copy/dismiss, metadata listing, and
  reviewed revocation. Default permission is task read only. Token contracts allow
  all currently defined scopes when individually selected; the obsolete limit of
  eight scopes prevented one assistant from using the whole supported catalog.
- Verification: 208 tests and four builds; installed stdio catalog has 28 tools
  and passes delete/recovery/restore/replay. Browser created an all-scope token,
  verified access, canceled revocation without effects, then confirmed revocation
  and verified HTTP 401. The secret remained inside the browser test process.
  Local visual evidence: `output/playwright/assistant-access/connections.png`.

## Core import apply path — September 20

- At this checkpoint Claude client access and a temporary Gitea outage were deferred
  by the owner. Current work uses stacked Gitea PRs; Claude qualification remains deferred.
- Core exports can now be reviewed and applied from Connections. Supported fields:
  task/project/tag identities and titles, task notes, exact scheduled instants,
  date/instant deadlines, whole-minute estimates within the existing task range,
  and original task creation/completion timestamps. Missing creation dates use the
  import time; missing completion dates block completed-task import.
- This is not full migration parity. Hierarchy, recurrence, archived tasks,
  tracked time, day-only scheduling, virtual Today views, project backlogs,
  completed projects, attachments, reminders, and project/tag notes
  remain blockers. Source settings/integrations are excluded. Keep the original
  export; the database retains an allowlist of source metadata, not the full file
  or provider credentials. No implicit partial import is offered.
- Migration 0020 adds owner-scoped source identities and metadata. Apply binds to
  the reviewed export fingerprint and commits entity creation, mappings, and sync
  changes together. Existing source identities are skipped, preserving local edits
  and deletions. Changed source metadata or destination conflicts reject the whole
  transaction. This is a one-time migration path, not ongoing task synchronization.
- Verification: parser qualification, HTTP preview/hash/unsupported/replay tests,
  persistence replay after restart, preservation of local edits/deletions, and
  rollback after an injected mapping-write failure. Browser preview/apply/replay
  created exactly two tasks, one project, and one tag; repeat apply created zero.
  Imported tasks appeared in the task view; database readback preserved notes,
  estimate, deadline, and original completion timestamp. Full verify: 213 tests,
  all four builds. Production remains unchanged.
- Compatibility: migration is additive, but a later deployment must back up the
  database and credential key together. Rollback uses the paired pre-migration
  backup with its matching application version; never delete migration history to
  force an older binary to accept the new database. The disposable browser DB/key
  checkpoint is `/tmp/tadooer-sprint14/before-import-migration`.

## Real backup qualification — September 20

- Located the running Super Productivity installation's local automatic backup
  and ran the current importer directly against it, read-only. See the
  [sanitized qualification report](../../discovery/2026-09-20-real-super-productivity-backup.md)
  for the exact fingerprint, inventory, issue counts, and next implementation work.
- Raw inventory: 4,827 tasks, including 4,721 archived records; 49 projects,
  21 tags, and 51 repeat configurations. Six blank-title old archive records are
  excluded from preview totals. All unresolved-reference findings are in the old
  archive; they do not establish a problem with active source data.
- Apply correctly remains blocked by parity and integrity findings. No actual
  owner records were imported, no source data was modified, and production was
  unchanged. Full migration and live client qualification remain outstanding.
- At this historical checkpoint the backup was only 2,447 bytes below the old
  4 MiB limit. #18 subsequently raised bounded capacity; preserve history intact
  and use the current capacity report rather than trimming the export.
