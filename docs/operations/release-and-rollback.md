# Release and rollback runbook

1. Run `pnpm verify:phase8` from a clean revision. This creates and starts an
   actual Linux Electron bundle and qualifies a versioned production Compose
   image against health, readiness, metrics, restart, backup, and restore.
2. Record the exact semantic version, full Git revision, registry OCI digest,
   desktop artifact name/checksum, and qualification timestamp in a manifest
   matching `release/manifest.schema.json`. For `desktopArtifact`, use the
   string that `pnpm desktop:artifact` prints under the same name
   (`<file>.tar.gz@sha256:<checksum>`; see [desktop.md](desktop.md)). A local
   Docker image ID from the disposable gate is not a substitute for the
   registry digest in production.
3. Promote the candidate with `node deploy/release-channel.mjs promote ...`.
   Deploy that immutable digest, never a mutable tag. Confirm `/api/build`,
   `/api/ready`, `/api/metrics`, login, task read/write, and the configured
   Baïkal route through the public TLS origin.
4. Before a schema-affecting deployment, create a coherent full-stack backup
   with `deploy/backup-stack.sh` and retain the previous application manifest.
5. For application rollback, select the previous qualified manifest with
   `release-channel.mjs rollback` and redeploy its immutable image/artifact.
   Restore data only when the release notes require it, using
   `deploy/restore-stack.sh` and the matching backup after maintenance-mode
   coordination. Never point older code at an unreviewed newer schema.

Alert when readiness is non-200, `suite_database_migrations` differs from
`suite_database_migrations_expected`, restarts recur, backup qualification fails, or HTTP 5xx
counters increase. Metrics contain status counts and process/database state,
not task content, owner identity, credentials, capability URLs, or request
bodies.
