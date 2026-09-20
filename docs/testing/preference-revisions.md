# Preference revision migration

Issue #59. Migration `0021_preference_revisions` adds an owner/kind revision
ledger and insert/update triggers for the existing planning and notification
preference tables. Existing stored values receive revision 1 unchanged. An owner
still using unstored defaults reads revision 0; the first stored write becomes 1.
Every write increments the counter, including equal-value writes and the current
browser PUT paths. Thus changing a value away and back still invalidates an old
assistant preview. Preference payloads and browser responses are unchanged.

Conditional persistence methods validate settings and compare the expected
revision inside a savepoint. They can join the existing assistant confirmation
transaction, so settings, revisions, preview consumption, audit and receipt can
roll back together. No worker, sync entity, notification delivery or assistant
write tool is enabled by this foundation alone.

Qualification covers a disposable pre-0021 database with existing planning and
notification values, default-only owners, restart without another backfill,
legacy/browser writes, invalid timezone/work/break bounds, stale revisions,
injected revision-write failure, and enclosing audit-failure rollback.

This is an additive source migration, not a production migration. Deployment
requires a coherent database/key backup and a separately qualified candidate.
Older binaries reject an unknown migration ledger; do not point an older binary
at this migrated database. Rollback uses the matching pre-migration database/key
backup and old application image. The test that removes migration 0021 constructs
a disposable historical fixture; it is not a rollback procedure.
