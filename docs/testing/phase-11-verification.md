# Phase 11 verification

`pnpm verify:phase11` is the source and disposable-deployment gate. It runs the
canonical format, lint, type, unit, integration, and build checks; focused ntfy
contract/domain/persistence/server/web tests; backup script validation; and the
existing fresh Compose restart, backup/restore, and image qualification gate.

The focused server test uses a private mock CalDAV connector and an authenticated
ntfy transport boundary. It proves a lead and at-start reminder are each
published once across repeated scheduler ticks and a process restart, an
explicit 503 is retried with bounded delay, completion cancels the obsolete
start reminder, and status contains neither the publisher token nor task notes.

Production acceptance is separate evidence. On NUC, install an ACL-limited
publisher token on the private `management` network, deploy by immutable image
digest, enable preferences through the owner UI, send a test, then observe one
real lead and one real at-start notification. Confirm Prometheus health, run the
coherent backup into encrypted Restic, and retain Super Productivity unchanged.
