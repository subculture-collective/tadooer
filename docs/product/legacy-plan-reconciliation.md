# Architecture and frontend plan reconciliation

Issue #22. Source inspected at `cc1babd` on September 20, 2026. The old plans are
historical design/execution proposals, not runnable queues of unfinished work.
Their unchecked shell/test/commit steps do not prove features are missing.
Current work is tracked by [roadmap #15](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/15)
and the issues below. This audit changes documentation, not application behavior.

## August architecture plan

| Original unit                       | Current evidence                                                                                                                                                                                                                              | Disposition                                                                                            |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 1.1 glossary/context map            | `CONTEXT.md` records bounded contexts and authority; ADRs retain decisions and ADR 0017 adds bridge terms.                                                                                                                                    | Implemented and extended.                                                                              |
| 1.2 HTTP plumbing                   | `apps/server/src/http-utils.ts` owns JSON, errors, origin checks, preconditions and headers; server/routes import it.                                                                                                                         | Implemented.                                                                                           |
| 1.3 store interfaces                | `packages/persistence/src/stores.ts` exists, but `RouteContext.stores` remains `SuiteDatabase`. Interface existence is not caller migration.                                                                                                  | Partial; #74.                                                                                          |
| 2.1–2.7 store extraction            | The live database instantiates habit, credential, projection and planning-preference adapters. Unused parallel SQL stores and their unused interfaces were removed under #74. `SuiteDatabase` remains the authoritative transaction boundary. | Reconciled by removal; future extraction must preserve live transaction semantics.                     |
| 2.8 narrow server/connector callers | Route context still uses `SuiteDatabase`; current atomic operations and confirmation transactions live there.                                                                                                                                 | Partial; #74 preserves transaction ownership during any extraction.                                    |
| 2.9 common automation client        | `packages/contracts/src/http-client.ts`, catalog helpers, quick-add and MCP share the automation boundary. Browser `api.ts` retains cookie/CSRF/session-recovery wrappers.                                                                    | Automation portion implemented. Forcing browser sessions through a bearer client is not a requirement. |
| 3 route modules/dispatcher          | `apps/server/src/routes/` and server dispatch exist; route integration tests exercise them. Some modules are large.                                                                                                                           | Module split implemented. A <300-line target alone does not justify another rewrite.                   |
| 4 page components                   | Today, Tasks, Reuse, Connections, Settings and later Inbox/Planner/Habits are separate pages; route and shell modules exist.                                                                                                                  | Implemented.                                                                                           |
| 4 shared hooks/thin controller      | `app.tsx` still owns state, sync subscriptions, auth recovery, loading and many callbacks.                                                                                                                                                    | Partial; #75 sequences cohesive controller extraction with behavior regressions.                       |

Do not replace the current mutation path with an older unused store to satisfy a
checkbox. Source replay, deadline fields, owner checks, sync publication and
confirmation rollback are required behavior. The old approximate file lengths
and example method signatures are superseded by current contracts.

## August frontend foundation plan

| Original unit                                   | Current evidence                                                                                                                                  | Disposition                                                                                            |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 1 semantic UI foundation                        | `apps/web/components.json`, aliases, `lib/utils.ts`, token definitions and `@theme inline` exist. CSS remains consolidated in `styles.css`.       | Product foundation implemented. Proposed CSS filenames were organizational suggestions.                |
| 2 accessible primitives                         | `components/ui/` has the listed primitives and `ui.test.tsx`.                                                                                     | Implemented; maintain consumer accessibility tests.                                                    |
| 3 route/shell extraction                        | `app/routes.ts`, `AppShell`, `SidebarNav`, `TopBar` exist.                                                                                        | Implemented.                                                                                           |
| 4 task presentation                             | `TaskCaptureForm` and `TaskListItem` are extracted and consumed.                                                                                  | Implemented; tests live at consuming surfaces rather than every proposed filename.                     |
| 5 Inbox                                         | `pages/InboxPage.tsx` derives unscheduled open work and route wiring exists.                                                                      | Implemented.                                                                                           |
| 6 range model                                   | `components/calendar/calendar-range.ts` and tests cover civil-time ranges.                                                                        | Implemented; later reliability fixes supersede original sketches.                                      |
| 7 visual Planner                                | `PlannerPage` and calendar components support bounded day/3-day/week views. App loading uses request sequencing and explicit loading/error state. | Implemented in source; current release/browser acceptance stays #14/#16.                               |
| 8 command bar                                   | `CommandBar.tsx` and injected app callbacks exist.                                                                                                | Implemented in source; keyboard/focus browser qualification remains #14.                               |
| 9 primitive migration/legacy removal            | Tokens/primitives coexist with live `btn-primary`, `btn-ghost`, `page-header` and `filter-bar` consumers.                                         | Partial; #76 migrates one surface and removes only unused selectors.                                   |
| Follow-on structured capture, deadlines, habits | Contracts, parser, migration/sync and Habits page were added after the original plan.                                                             | Implemented baseline, not missing merely because excluded by the August slice.                         |
| Follow-on drag/drop planning                    | No implicit authorization arises from the historical suggestion.                                                                                  | Keep outside the current visual-planner claim; sequence a concrete user outcome before implementation. |

Representative remaining legacy consumers include `time-block-form.tsx`,
`focus-panel.tsx`, `template-library.tsx`, task/settings/planner pages,
`notification-settings.tsx`, `google-planning.tsx`, `TopBar.tsx` and `app.tsx`.
#76 must repeat the search against its implementation branch before deleting CSS.

## Verification and evidence limits

The immediately preceding implementation stack passed 234 tests/72 files and
all four builds. This audit compared actual imports, constructors, exports and
consumer searches with the original units; it did not rerun old proposed command
sequences or claim their originally proposed tests ran. No production interaction,
new visual acceptance, client installation or stable release is established here.

Residual issue links:
[#74](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/74),
[#75](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/75),
[#76](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/76).
