---
status: accepted
---

# Assistant confirmation policy: ordinary edits, bulk actions and deletions

Issue #33 (roadmap #15, assistant access). Builds on the preview/confirm
authority of ADR 0011 and the client qualification recorded in
`docs/testing/assistant-client-qualification-2026-09-25.md`. The owner wants
explicit approval for bulk, deletion and similar consequential actions without
a repeated prompt for an ordinary edit that was explicitly requested.

## The policy is declared in the catalog

`@suite/contracts` declares one confirmation rule per catalog entry alongside
its scopes and schemas. HTTP handlers, the stdio MCP adapter and the plugin
skill read that declaration; none keeps a second list.

- `none`: read resources and `automation.confirm`.
- `ordinary`: a revision-bound edit of one explicitly identified record, a
  single creation, a reversible archive or restore, a reorder that supplies
  the complete set, a preference update, or a focus command on the caller's
  own session.
- `consequential` with a category: `deletion` (`tasks.delete`), `bulk`
  (`tasks.create_many`, `template_sets.instantiate`),
  `destructive_replacement` (`tasks.set_tags`), `takeover`
  (`focus.takeover`), `external_effect` (`notifications.send_test`).
- `by_action`: mixed operations whose `action` (or checklist `command.action`)
  decides. `delete`, `delete_instance`, `remove_attachment` and
  `remove_issue_link` are deletions; ending a recurring series is
  `irreversible`. Every other action of those operations is ordinary.

`classifyAutomationCommand(command)` evaluates the rule against the exact
command and is the only classifier. A contract test checks every operation and
every declared action.

Bounds and expiry are declared with the rules: `tasks.create_many` accepts at
most 100 tasks, a preview lists at most 201 affected records, and approval
(a preview) expires five minutes after it is issued. The preview summary and
its `affected` list remain the affected-record summary a client shows before
asking for approval.

## The owner sets the token-level policy

A token has a `confirmationPolicy` chosen at issuance and immutable
afterwards, like its scopes: `confirm_all` (default) or `execute_ordinary`.
Changing it is revoke-and-reissue. The policy is stored on the token row
(migration `0039_automation_token_confirmation_policy`), returned in token
inventories, and shown in Assistant access.

## Enforcement: one code path, one extra request field

A preview request may carry `execute: { idempotencyKey }`. The server builds
and stores the preview exactly as before, then:

- if the command classifies as consequential, or the token policy is
  `confirm_all`, it answers `409 AUTOMATION_CONFIRMATION_REQUIRED`, performs
  no mutation, records a denied `confirm` audit row, and leaves the preview
  valid for `automation.confirm`;
- otherwise it runs the same confirmation function as
  `POST /previews/{id}/confirm` with the supplied idempotency key and returns
  `201 { preview, executed }` where `preview.requiresConfirmation` is `false`.

The confirmation function is shared, so scope, owner/token binding, expiry,
input-hash, base-revision, idempotency replay and conflict checks are
identical in both paths. The `execute` field is not a confirmation boundary
for consequential operations; ADR 0011's rule that a Boolean cannot replace
confirmation still holds for them. Idempotency keys stay under the same
`(owner, token, operation, key)` outcome ledger, so a retried execute request
replays and a reused key with another command conflicts.

Every preview response now states `confirmation: { policy, category,
tokenPolicy }` so a client can decide before it calls confirm whether the
owner's approval is needed. The audit ledger records preview, execute and
denied rows for both paths with the same phases and codes; a denial never
produces an execute row.

## Client alignment

MCP tool descriptions carry the declared rule ("ordinary edit" or
"consequential: deletion" and so on) and the batch and expiry bounds, so an
assistant reads the policy from the live catalog rather than from prose. The
plugin skill instructs: an explicit request authorizes an ordinary edit and
the assistant confirms it without a second prompt (or executes in the preview
call when the token allows); every consequential preview is shown to the user
with its affected records and confirmed only after their approval; a refusal
leaves the preview to expire. Skill text cannot weaken the server rule.

## Consequences

- Existing clients and tokens behave exactly as before: no `execute` field,
  default `confirm_all`, unchanged error codes for stale, replayed, expired,
  mismatched-key, scope-denied and revoked cases.
- Per-input classification means a mixed tool such as `subtasks.mutate` is
  ordinary for `update` and consequential for `delete`; the preview says which.
- Reorders are ordinary because they are revision-bound and require the
  complete set; a future partial reorder would need a new rule.
- Live client behaviour (whether a model actually prompts) remains a
  qualification activity, not something the server can prove.
