# Phase 10 verification

Phase 10 qualifies the calm daily workspace without weakening the existing
single-owner, local-first, or calendar-authority boundaries.

## Automated evidence

`pnpm verify:phase10` runs the complete format, lint, typecheck, unit/integration,
and production build suite; focused Phase 10 contract/domain/persistence/server/
web tests; then the disposable production Compose restart, backup/restore, and
image-promotion gate.

The focused evidence covers:

- supported IANA identifiers and invalid-zone rejection;
- Chicago spring-forward and fall-back civil-day windows;
- safe migration of the planning-preference table with a 13-migration ledger;
- provider kind, provider display label, and calendar-name projection metadata;
- direct `/today`, `/tasks`, `/reuse`, `/connections`, and `/settings` rendering;
- task search/filter controls and source-visible calendar filters;
- visible disabled calendar/focus controls while IndexedDB tasks remain usable;
- PWA launch at `/today`, responsive layout, and keyboard focus visibility.

## Evidence boundary

This gate proves implementation and disposable runtime recovery. Production
promotion is a separate Phase 9/12 operation and uses a newly built immutable
digest only after the interactive production owner and connector checks pass.
