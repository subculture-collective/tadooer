# Persistence authority

`SuiteDatabase.open()` owns SQLite initialization, migrations and the shared connection. Server routes use `SuiteDatabase` through `RouteContext.stores`; they do not instantiate an aggregate of independent stores.

The retained adapters have live callers:

| Adapter                          | Caller and responsibility                                                                         |
| -------------------------------- | ------------------------------------------------------------------------------------------------- |
| `SqliteHabitStore`               | `SuiteDatabase.habits`; habit routes and automation, with sync callback using the same connection |
| `SqliteCredentialStore`          | `SuiteDatabase.credentials`; connector credential and Google cursor methods                       |
| `SqliteCalendarProjectionStore`  | `SuiteDatabase.calendarProjections`; calendar projection and write-reservation methods            |
| `SqlitePlanningPreferencesStore` | `SuiteDatabase.planningPreferences`; planning preference reads and writes                         |

Issue #74 removed the uninstantiated automation, notification, task, organization, checklist, reuse, sync, import, feed, owner, session and metadata store copies. Their unused interfaces and the unconstructed `ServerStores` aggregate were also removed. In particular there is no alternate metadata path with a hard-coded migration count, or alternate task path that can omit newer deadline and field-version semantics.

This is source cleanup with no schema or production changes. Live task edits, deletion/recovery, sync publication, conditional preferences, and confirmation mutation/audit/receipt transactions remain on the existing authority. Future extraction must migrate real callers and preserve shared transaction ownership before deleting the prior implementation. `stores.ts` describes only retained adapter contracts; it is not a claim that all workflows have been decomposed.

Verification uses existing persistence and server regressions for migrations/restart, deadlines/recovery, organization/checklist rollback, preference revisions and atomic automation receipts, followed by full workspace verification.
