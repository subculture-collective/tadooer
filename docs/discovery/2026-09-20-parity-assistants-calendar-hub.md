# Interview outcome: parity, assistants, and a Baikal calendar hub

Date: September 20, 2026. Status: product direction agreed; implementation and
provider qualification remain pending. This records the owner's interview answers,
not a claim that the capabilities are shipped.

## Goal

Make Tadooer a reliable replacement for Super Productivity, with equivalent user
capabilities available to connected assistants and self-hosted calendar ownership.

## In scope

- Sprint 14 session recovery, Planner range/loading correctness, and explicit
  calendar freshness feedback.
- Super Productivity migration and working feature parity: projects, tasks,
  subtasks, dates, recurrence, notes, completed history, and time tracking. Build
  a versioned feature matrix to identify the remaining parity work beyond these
  named requirements; parity is now a goal, not merely an optional import.
- A Tadooer plugin, MCP tools, and workflow skills analogous to
  superproductivity-mcp, targeting OpenAI/Codex and Claude clients. Cover every
  user-facing capability, respecting the same permissions and validations.
- Ask before bulk actions, deletions, and comparably consequential operations.
  Ordinary explicitly requested individual edits should not require repetitive
  confirmation. Skills guide workflows; the application enforces permissions.
- Google as the first external provider for explicit bidirectional synchronization
  with Baikal. Offer a bundled upstream Baikal deployment and existing-instance
  configuration. Baikal holds the accepted canonical calendar state.
- Optional AI inside Tadooer if supported subscription authentication can be used
  without a separate model API bill. Qualify official agent-runtime integrations
  first; never silently fall back to paid API credentials.

## Constraints and proposed implementation defaults

- Preserve the active production candidate and soak. Develop against disposable
  environments; existing release gates still apply.
- Keep mapped calendars separate. A Google calendar maps to its corresponding
  Baikal calendar; do not broadcast events to unrelated connected calendars.
- Preserve origin IDs, mappings, revisions, and deletion records. New events and
  edits travel both ways where provider permissions allow. Read-only calendars
  and organizer-controlled fields retain their restrictions.
- Concurrent incompatible edits preserve both versions for explicit resolution.
  Do not use blind last-write-wins. Handle recurring exceptions, all-day dates,
  time zones, cancellations, and invitation side effects deliberately.
- Scheduled synchronization runs without an open browser. Surface last successful
  sync, pending writes, failures, conflicts, and reconnect requirements. Exact
  cadence and retry policy are engineering decisions to verify against quotas.
- Import previews and repeatable imports must report unsupported data and avoid
  duplicates. Import success alone is not evidence of functional feature parity.
- Hosted MCP requires scoped, revocable authorization. Confirmations must bind to
  the concrete operation and affected records; changes invalidate stale previews.
  Retry safety and revision checks apply equally to UI and assistant writes.
- Retain current session-expiry policy while improving recovery; preserve drafts,
  offline queues, navigation context, and uncertain mutation outcomes.

## Subscription feasibility evidence

Checked official sources September 20, 2026:

- [Codex App Server](https://learn.chatgpt.com/docs/app-server) documents an
  integration surface and ChatGPT authentication. Investigate a user-owned runtime
  for embedded assistance; this does not make a subscription a generic model API.
- [Claude Agent SDK with a Claude plan](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)
  currently states in its June 15 update that SDK, claude -p, and third-party app
  usage still draw from subscription limits. The older credit policy below that
  update is explicitly paused. Validate the actual deployment and account flow
  before promising embedded support.

The plugin/MCP route is the primary deliverable regardless of embedded feasibility.
Credentials remain with supported authentication flows; no generic subscription
token proxy or shared account pool is part of this design.

## Out of scope for the first integration release

Additional calendar providers, all-to-all calendar replication, a Baikal fork,
ongoing two-way Super Productivity task sync, API-billed embedded AI, and changing
the production soak candidate merely to ship roadmap work. These exclusions do
not reduce the agreed long-term Super Productivity parity goal.

## Acceptance criteria and verification

1. Expired sessions recover without lost queued work or duplicate writes; verify
   in two browser profiles, including stale CSRF and failure after a committed write.
2. Planner day/three-day/week results match their range, including DST and racing
   requests. Freshness labels distinguish cached data from a successful sync.
3. A supported Super Productivity export imports named data with provenance and
   counts; rerunning it creates no duplicates. Exercise imported workflows and
   reconcile time/history totals, rather than checking only record creation.
4. Maintain a UI-to-MCP capability matrix. Both target client families perform
   representative read/write journeys; bulk/delete previews require approval,
   rejection has no effects, and stale/replayed approvals do not mutate data.
5. Google and bundled/existing Baikal exchange creates, edits, and deletions on
   mapped writable calendars without duplicates or loops. Verify recurrence,
   conflicts, outages, restart recovery, grant revocation, and permission changes
   in isolated accounts before production qualification.
6. Embedded AI, if qualified, signs in through an official runtime, shows the
   active provider, handles exhausted limits, and does not switch to paid API use.

## Recommended route and remaining engineering work

Full staged plan: finish Sprint 14 reliability; inventory Super Productivity and
existing plugin capabilities; deliver import/parity slices and MCP coverage;
design and qualify the Google/Baikal bridge; qualify optional embedded runtimes.
Each slice gets contract tests, appropriate browser/client checks, repository
verification, and its own release evidence. No fixed completion date is implied.

Open engineering questions: pin the source Super Productivity version and export
schema; define the full parity matrix, client packaging/authentication matrix,
confirmation categories, calendar field/conflict contract, and supported runtime
deployment for subscription access. No further product interview is needed to
begin this work.

This direction supersedes the earlier optional-only parity position and the
prohibition on an explicitly enabled two-way bridge in ADR 0005. Federation stays
the existing behavior until the new bridge is implemented and qualified.
