---
status: accepted
---

# Focus preferences are a read-only offline sync record

Issue #114, following ADR 0050. Decided 2026-10-05.

## Decision

The owner’s focus preferences join the sync feed as the singleton
`focus_preferences`, keyed by the owner UUID. Its snapshot is the existing
focus-preference response: the complete preferences, record revision and
optional import provenance. Revision 0 carries the defaults even when no row
has been saved, so a cold offline client behaves like an online client.

Every successful browser save, assistant confirmation and first applicable
Super Productivity import appends an upsert in the same SQLite transaction.
Rejected stale writes and skipped imports append nothing. The PUT route and
assistant operation are feed-only; the broader `focus` resource family stays
for plans, idle dispositions, reminders and session effects that are not this
record.

Focus preferences are read-only offline. Writes still require the existing
whole-record revision check through conditional HTTP or assistant
confirmation. No outbox operation is introduced because there is no field
merge rule; allowing an offline whole-record write would overwrite unrelated
changes from another device.

Migration `0052_sync_focus_preferences_epoch_reset` resets the feed epoch so
preferences saved before this change enter existing caches. IndexedDB remains
at version 2: the singleton uses the existing `entities` store, while the
existing outbox store and queued operations are unchanged and replay over the
replacement snapshot.

Focus plans, idle dispositions, reminder state and session control remain
online-only.
