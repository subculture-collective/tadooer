---
status: accepted direction; implementation gated
---

# Explicit Google/Baikal mappings with accepted canonical state

Issue #20. Implements the September 20 interview direction and supersedes ADR
0005 only for an explicitly enabled, qualified mapping. Federation, one-time
imports and read-only feeds retain their existing behavior. No background worker,
new Google consent, persistent bridge schema or production write is enabled here.

## Authority and identity

One owner explicitly pairs one Google calendar with one Baikal calendar. Each
calendar may participate in at most one enabled two-way mapping. There is no
all-to-all replication and no implicit mapping from display-name similarity.
Bundled upstream Baikal and an existing supported Baikal are equivalent through
the CalDAV contract; this does not create a Baikal fork.

Baikal holds accepted canonical event state. Google edits are incoming proposals:
when uncontested and representable, a conditional Baikal write accepts them, then
the bridge acknowledges the resulting normalized state. Unresolved concurrent
versions remain visible and preserved; canonical does not mean blindly overwriting
Google or ignoring its edits. Tadooer tasks and focus history retain their own
existing authority and do not become calendar-owned data.

Every mapping needs owner identity, stable mapping identity/revision, both
provider/calendar identities, mode, approved capabilities and enablement state.
Each event link needs its own identity, both native event identities, Baikal href
and UID, Google event ID and iCalUID, origin, retained native versions, last
accepted semantic snapshot/digest and deletion history. Provider IDs, ETags, titles,
UIDs and recurring-instance identities are not interchangeable. Native versions
are opaque tokens, never timestamps to compare across systems.

Initial mapping is an explicit preview: propose separate creates or reviewed
matches of existing events, report duplicates/unsupported fields and target
permissions. Reserve stable destination identities before sending create work.
Never infer equality from title/time or silently adopt an existing matching UID.
New Google events are accepted into the paired Baikal calendar; new Baikal events
are published to the paired Google calendar, subject to field/permission checks.

## Event representation and field policy

Provider adapters retain original source representations alongside a versioned
normalized envelope. A semantic digest covers every supported meaningful field,
not transport revision, fetched time or provider serialization order. It must not
hide unknown-field loss. Never feed a bounded UI calendar projection into the
bridge as the complete source event.

| Field group | Contract |
| --- | --- |
| Summary, description, location | Preserve exact supported content and distinguish empty from absent. |
| Schedule | Start/end, timezone, all-day date boundaries form one semantic group; do not assign arbitrary times to date-only events. |
| Recurrence | Retain series identity, rules, exception identity and cancelled/moved instances together. Unsupported constructs block propagation pending #45. |
| Organizer/attendees/responses | Preserve provider ownership restrictions. Do not turn a copy into a new invitation or claim organizer rights. Changes with invitation effects require dedicated review/qualification. |
| Reminders/alarms | Translate only with an explicit, qualified equivalence; report unsupported alarm actions. |
| Conference links, attachments, vendor properties | Preserve native source data; block lossy writes until a round-trip policy is qualified. Source retention alone does not make a lossy destination write safe. |
| Cancelled/deleted state | Keep explicit tombstones and recurring-instance identity; absence from a bounded window is not deletion. |

The first automatic propagation subset is ordinary private events whose entire
representation is supported and whose destination is writable. This is an
implementation starting point, not a reduction of the agreed full calendar goal.
Unsupported cases remain visible and queued, not silently excluded or overwritten.

## Reconciliation decisions

`decideCalendarBridgeChange` is a pure policy for an **already-linked** event and
qualified observations, with executable fixtures. It performs no I/O or writes.
It is not the bridge, a parser, an authorization check, or a live provider adapter.

| Observed state relative to the last accepted baseline | Decision |
| --- | --- |
| Both sides semantically equal | Accept observed state/revisions; do not echo-write. |
| Google changed, Baikal unchanged | Conditionally write Baikal using its observed revision; do not advance accepted state until acknowledged/read back. |
| Baikal changed, Google unchanged | Conditionally write Google using its observed revision. |
| Both changed incompatibly | Preserve both; create an explicit revision-bound conflict. Conservative whole-event conflict handling comes before any future field-level merge. |
| Delete versus edit | Conflict; do not let deletion win automatically. |
| One side deleted, other unchanged | Queue conditional deletion only with concrete deletion approval. No implicit mass deletion on first mapping or reset. |
| Both deleted | Retain accepted tombstone; no new delete request. |
| Event reappears after accepted deletion | Conflict/review, even if both copies reappear; never revive via ordinary replay. |
| Unavailable source, disabled mapping, unsupported field, invitation effect, lost write permission | Block work visibly and preserve accepted state/outbox. |

Deletion approval initially binds to concrete affected records/revisions. A future
mapping-wide automatic deletion policy is a separate explicit owner decision;
#33 and #48 own its approval UI, not an undocumented worker default. Likewise,
conflict resolution is a new reviewed operation, not changing a status flag to
force a failed old operation through.

## Durable work and retry boundaries

#40 implements mappings and the outbox; #46 implements scheduling. Persist work
intent, target, source observations, destination precondition, mapping revision,
normalized payload hash and stable operation identity before network I/O. Keep
per-event ordered work and serialize competing operations within the mapping.

Use conditional provider writes; a precondition failure requires re-read and
reconciliation. Never substitute an unconditional retry. After an ambiguous
response, inspect the reserved native identity and expected semantic result before
retrying. Persist acknowledgement/readback and advance accepted state in one local
transaction; a successful HTTP response alone is not proof that both sides have
converged. A new source edit during propagation remains new work, not an excuse to
drop the outstanding operation or overwrite a conflict. Test crashes before send,
after provider commit and before local receipt at each stage.

The Google sync guide requires processing all pages before saving the new token;
invalid tokens cause a new full read. The bridge must preserve its authoritative
mapping/outbox/tombstone/conflict state during that projection rebuild, then
reconcile against a complete new generation. A missing event from an incomplete
page, failed read or bounded planner window never proves deletion.
[Google incremental sync](https://developers.google.com/workspace/calendar/api/guides/sync).

Google conditional modifications use resource ETags to avoid replacing a newer
version. CalDAV supplies conditional resource operations and distinct calendar
resource identity. Adapter qualification must establish exact create/update/delete
and deletion-proof behavior against both bundled and existing Baikal.
[Google resource versions](https://developers.google.com/workspace/calendar/api/guides/version-resources),
[CalDAV specification](https://www.rfc-editor.org/rfc/rfc4791).

## Disable, disconnect, migration and rollback

Disabling a mapping stops new dispatch, retains accepted state, conflicts and
pending work, and shows any in-flight uncertainty. Removing a provider grant stops
access and marks reconnect-required; it does not delete either calendar. Unlinking
requires an explicit decision about retained copies and pending work; it is never
a delete-all operation. Full resync refreshes observations without erasing history
or importing duplicate identities. Publication feeds remain read-only.

Do not enroll calendars automatically because they were previously federated or
imported. Existing one-time migration provenance may inform preview, but cannot
be silently promoted into a writable event link. Deployment rollback first stops
new bridge work, reconciles in-flight outcomes and preserves a paired Suite
mapping/credential-key plus Baikal data/config backup. Restoring only Suite data
cannot roll back external Google writes: recovery must reconcile those effects,
never replay stale outbox work blindly. Older binaries must not dispatch bridge
work they do not understand.

## Exit evidence and downstream work

- This PR: domain vocabulary, authority/field/failure contract and pure decision
  fixtures for echoes, both directions, conflicts, deletion approval, tombstones,
  permission loss, unsupported fields and unavailable sources.
- #35: bundled/external Baikal connection, TLS and resource qualification.
- #36: fresh Google write consent and permission-aware adapters.
- #40: durable identity/outbox and conditional propagation, including initial creates.
- #45: recurring exceptions, field round trips and invitation side effects.
- #48: mapping, approval, conflicts, status and recovery UI plus assistant coverage.
- #46: browser-independent work, retry policy and content-safe telemetry.
- #50: disposable real-provider, restart, resync, restore and cleanup qualification.

The existing production candidate and soak remain pinned. No stable release or
Google/Baikal two-way behavior is claimed from pure policy tests.
