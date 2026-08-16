---
status: accepted
---

# Package the stable web authority; do not fork it

Phase 8 ships a Linux Electron desktop client as a constrained shell around the
same deployed Suite origin and API. The desktop has no private task database,
CalDAV credential, alternate mutation implementation, or privileged bridge.
It accepts HTTPS origins, plus loopback HTTP for local development, blocks
navigation and popup escape, disables Node integration, enables Chromium
sandboxing and context isolation, and relies on the Suite's existing owner
session, CSRF, IndexedDB, sync, and automation boundaries.

Release manifests are immutable version/revision/image-digest records promoted
through explicit `candidate` and `stable` channels. Promotion records the prior
manifest in append-only history. Rollback means selecting a previously
qualified manifest and using the existing coherent backup/restore procedure
when data rollback is also required; it never silently rewrites owner data.

The server exposes content-free health, build, readiness, and Prometheus text
metrics. The Phase 8 qualification gate builds the production image, exercises
those endpoints and backup/restore, creates an actual Linux Electron bundle,
and starts that bundle in a non-graphical smoke mode.

Android and iOS are not enabled: no platform-specific background/offline and
credential-storage decision has been accepted. PostgreSQL is not enabled:
there is no measured SQLite concurrency or availability need. Multi-user mode
is not enabled: the one-owner authorization audit remains the prerequisite.
Those are deliberate roadmap decisions, not silently incomplete client claims.
