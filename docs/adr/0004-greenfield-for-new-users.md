---
status: amended
---

# Optimize the Greenfield product for new users instead of Super Productivity parity

September 20 amendment: full Super Productivity **feature parity** is now an
explicit product goal. The [interview](../discovery/2026-09-20-parity-assistants-calendar-hub.md)
and [pinned parity matrix](../product/super-productivity-parity.md) supersede the
original feature-scope exclusion below. The React application, independent
contracts, owner-scoped authority and provenance-aware migration remain. Feature
parity does not require copying Angular, NgRx, source credentials or storage.

The following paragraph records the original August decision, not current parity
scope.

The React product is a new-user product, not a drop-in implementation of Super
Productivity. It may reuse proven domain ideas, tests, and selected services, but
does not inherit the Angular storage model, NgRx actions, current synchronization
operations, plugin API, or full feature set as permanent constraints. Existing
Baikal calendars and an early hosted-calendar connector take priority; imports
from Super Productivity, Apple Reminders, Google Tasks, and other task products
belong to an extensible, provenance-aware migration framework delivered as
demand justifies each source.
