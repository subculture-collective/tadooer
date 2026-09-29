---
status: accepted
---

# Assistant operations: import, publication and connector recovery

Issue #60 (parent #32, inventory #19, roadmap #15). Builds on the Phase 7
import and publication records of ADR 0014, the Google and Baikal connector
boundary of ADR 0007 and ADR 0017, and the preview/confirm protocol of
ADR 0011.

Before this change the assistant had no path to the owner's calendar import
jobs, read-only feed capabilities or connector state. Those actions existed
only in the browser: the owner uploaded an export, applied it, created and
revoked feeds, watched connector health and retried a Google sync by hand.
The inventory listed all of them as gaps under #60.

## Boundary

Anything that reveals or rotates a secret stays with the owner in the
browser:

- Entering Baikal credentials, authorizing Google and disconnecting a grant.
  A resync needs the stored refresh token, which the assistant never sees,
  and does not request new consent or broader scopes.
- Creating a read-only feed. Its address embeds the capability secret and is
  shown exactly once at creation; there is no way to create one without
  disclosing it. Revoking a feed discloses nothing and is a safety action.
- Uploading a Super Productivity export. The preview is stateless and the
  export is never stored, so there is no owner-prepared preview to bind to.
  The assistant reports what previous imports recorded, not the export.

The assistant may inspect status, apply a calendar import the owner already
previewed, revoke a feed, retry a Google sync with the existing grant and
report the recovery steps that remain owner-interactive.

## Decision

### Scopes

Six new token scopes, so an existing token gains nothing: `connectors:read`,
`connectors:recover`, `imports:read`, `imports:write`, `publication:read` and
`publication:write`. `automation.confirm` accepts the three write scopes;
confirmation still resolves the scope of the stored operation.

### Resources

- `connectors.status` (`connectors:read`): Baikal and Google state plus a
  list of recovery steps. Baikal is verified with the stored credential
  exactly as the owner's status request does; the response carries the
  endpoint host and username, never a credential. Google reports its state,
  account label, granted scopes and per-calendar freshness. Each recovery
  step names the connector, whether the assistant can perform it (and the
  catalog operation) or the owner must act, and why.
- `imports.list` (`imports:read`): calendar import jobs without candidate or
  item `rawIcs`; with `jobId`, one job with its candidates (minus `rawIcs`).
  Also a Super Productivity provenance summary per entity kind (count and
  last import time) from `task_import_sources`; the export itself is never
  echoed.
- `calendar_feeds.list` (`publication:read`): every feed capability (id,
  calendar, label, created and revoked times) and, per owned calendar, the
  published event count and active feed count. No response contains a
  capability secret, its hash or a feed address.

### Tools

- `imports.apply` (`imports:write`): input `jobId` and `expectedInputHash`.
  The preview binds the exact fingerprint of the owner's upload and the
  destination calendar; a job in another state, a different hash or a
  missing calendar is rejected. Confirmation repeats the check, writes the
  pending items through the Baikal connector exactly like the browser route
  (precondition failures count as applied; other failures mark
  `reconciliation_required`), finishes the job and returns it. An already
  applied job replays without writes. The connector writes are network
  calls, so they happen before the receipt commits, like a subscription
  refresh; each item mark is durable on its own and a retry resumes from the
  remaining pending items.
- `calendar_feeds.revoke` (`publication:write`): input `feedId`. A revoked
  feed is rejected at preview and confirmation. The revocation, receipt and
  audit commit in one transaction.
- `connectors.resync` (`connectors:recover`): input `connector: "google"` and
  `full`. Preview requires an installed OAuth configuration and an existing
  grant, and names a full re-projection's reset. Confirmation calls the same
  synchronize path as the browser; `grantedScopes` before and after are
  identical because no authorization request is made.

Affected entity kinds `calendar_import`, `calendar_feed` and `connector` are
added. None of the three records is revisioned, so each confirmation repeats
its state check instead of freezing a revision.

### No migration

`calendar_import_jobs`, `calendar_feed_capabilities`, `google_connectors`
and `task_import_sources` already hold what the assistant reads. Two store
methods are added: `listCalendarImportJobs` and `summarizeTaskImportSources`.
Migration 0042 is not used.

## Consequences

- The web scope picker lists the new scopes automatically; labels explain
  that connector and publication reads never include an address or secret.
- Baikal has no assistant recovery action: verification with the stored
  credential already happens on every status read, and every failure mode
  (credential key changed, endpoint moved, authentication rejected) needs
  the owner to enter the credential again. The status resource says so.
- Super Productivity import stays owner-only in the inventory with that
  reason; a stored, hash-bound preview would be the way to change this.
- Calendar ICS export remains a browser download; its metadata is in
  `calendar_feeds.list`.

## Verification

- `packages/contracts/src/index.test.ts`: catalog length, new scopes and
  operations.
- `packages/contracts/src/automation-coverage.test.ts`: inventory drift.
- `apps/server/src/assistant-recovery.test.ts`: status without secrets,
  import preview without writes, fingerprint mismatch, apply, repeat apply,
  feed listing without the secret, revoke and re-revoke, Google resync with
  unchanged scopes, revoked scope denial and audit entries.
