---
status: accepted
---

# Application preferences and keyboard shortcuts

Issue #67. Reference: Super Productivity 19.1.0
(`src/app/features/config/global-config.model.ts`,
`default-global-config.const.ts`, `default-start-page.const.ts`,
`electron/shared-with-frontend/keyboard-config.model.ts`,
`src/app/core/locale.constants.ts`, `src/app/core/theme/global-theme.service.ts`).
Builds on the revisioned planning and notification preferences (ADR 0016,
ADR 0020, ADR 0027) and the task hierarchy rules of ADR 0018.

Before this change Tadooer had planning and notification preferences only.
The browser had one hard-coded shortcut (Ctrl/Cmd+K), a dark-only palette
with inert `dark:` classes, and no place for the settings Super Productivity
keeps in `globalConfig`. The importer reported that section as configuration
and never applied it.

## Source inventory

`GlobalConfigState` has 21 sections. Twelve hold ordinary user preferences;
the rest hold sync provider configuration with credentials (`sync`), desktop
window and tray state, sounds, a deprecated voice reminder, a device path and
feature toggles. The `keyboard` section has 60 bindable keys plus dynamic
`plugin_*` keys. Dark or light mode is not in the export: the source keeps it
in `localStorage` (`global-theme.service.ts`), while `misc.customTheme` names
a colour theme. The real September 24 backup has 22 `globalConfig` keys, one
of them unreviewed.

## Decision

### The record

An **application preferences** record per owner (`owner_application_preferences`,
migration `0034_application_preferences`) stores one validated JSON document
and a revision. Revision 0 means the defaults. The schema and defaults live
in `@suite/contracts` (`application-preferences.ts`):

| Field                                                        | Behaviour                                                                                                                                                                                                                  |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `theme` (dark, light, system)                                | Applied on `<html>` as `data-theme` and `color-scheme`; `system` follows `prefers-color-scheme` and re-applies on change. Mirrored in `localStorage` so the first paint after a reload uses it before the record loads.    |
| `language`                                                   | Lower-case code as the source stores it. Only English is rendered; the Settings page shows an imported code next to "English".                                                                                             |
| `dateTimeLocale`, `firstDayOfWeek`                           | Canonical BCP 47 tag and 0–6. Stored for formatting; the current views still format with `en-US`, so these are inert until a formatting pass uses them.                                                                    |
| `defaultStartPage`                                           | Opened when the app loads at `/`. Every value is a workspace route (checked by a test).                                                                                                                                    |
| `defaultProjectId`, `defaultEstimateMinutes`, child estimate | Capture defaults. The project must be an active project of the owner; the capture form pre-fills the estimate.                                                                                                             |
| `confirmBeforeDelete`                                        | The browser asks before queuing a delete. Deleted tasks stay recoverable either way.                                                                                                                                       |
| `markdownInNotes`                                            | Task notes render through the same safe Markdown subset as notes (ADR 0019); off renders plain text.                                                                                                                       |
| `autoMarkParentDone`                                         | ADR 0018 exception, off by default: completing the last open child completes its parent through the same conditional update, on the HTTP, assistant and sync completion paths. Reopening a child never reopens the parent. |
| `autoAddWorkedOnToToday`                                     | Starting focus on an open, untimed task not planned for today sets its planned day to the owner's planning date (ADR 0027 day start); tasks with a calendar block are left alone.                                          |
| `notifyWhenEstimateExceeded`                                 | The focus panel shows a notice when the session has run longer than the task estimate (session time, breaks included).                                                                                                     |
| `defaultTaskReminder`                                        | What a task's `default` start reminder means (ADR 0020). `default` keeps the ADR 0016 lead and at-start toggles; `none` or an offset replaces them for every task that keeps `default`. Explicit per-task settings win.    |
| `notifyOnDueDate`, `dueDateNotificationHour`                 | Stored and imported; delivery of date-only reminders is not built (ADR 0020 gives date-only plans no reminder time). The Settings page says so.                                                                            |
| `dailySummaryNote`                                           | Free text shown on Today as a Markdown card; the finish-day ritual (#52) will reuse it.                                                                                                                                    |
| `shortcuts`                                                  | Owner overrides per registered action (below).                                                                                                                                                                             |

Writes carry the revision that was read and fail with `412 REVISION_CONFLICT`
when it moved; the browser reloads the record and asks the owner to apply the
change again. Validation rejects unknown keys, an archived or foreign default
project and two actions on one binding. The record is online-only, outside
the sync feed and the offline cache; offline the browser keeps the defaults
(and the mirrored theme) and disables the form.

### Shortcut registry

`shortcutActions` in `@suite/contracts` lists every bindable action with its
group, default binding and, where one exists, the Super Productivity
`keyboard` key with the same meaning: navigation to each workspace route
(Today `W`, Inbox `Shift+I`, Planner `Shift+T`, Tasks `Shift+L`), add a task
(`Shift+A`), complete or reopen the selected task (`D`), start focus on the
selected task or finish the running session (`Y`), open the command bar
(`Ctrl+K`), show the shortcut help (`?`) and sync now (unbound). A binding is
modifiers in Ctrl, Alt, Shift, Meta order plus one key, normalized by
`normalizeShortcutBinding`; `Ctrl` also matches Command on Apple devices.
Bindings without a modifier are ignored while an input, textarea, select or
editable element has focus. The selected task is the focused task row
(`data-task-id`) or, failing that, the task of the running focus session.
The help dialog lists effective bindings; the Settings section edits them
with conflict validation before a save.

### API and assistant

- `GET` and `PUT /api/application/preferences` read and replace the record;
  `PUT` needs the session CSRF token and `{ expectedRevision, preferences }`.
- `application.preferences` (`application:read`) and
  `application.update_preferences` (`application:write`) follow
  `planning.update_preferences`: the preview validates the record, names the
  changed keys and freezes the revision; confirmation applies the whole record
  inside its transaction with the same revision check, so a browser save in
  between makes the preview stale. Both scopes are new and must be issued
  explicitly.

### Theme

A light palette (Catppuccin Latte surfaces, accents darkened for at least
4.5:1 text contrast) overrides the root variables under
`html[data-theme="light"]`. Dark stays the default. `main.tsx` applies the
stored theme before React renders; the preferences controller re-applies the
server value once loaded.

### Super Productivity import

`super-productivity-config.ts` classifies every `globalConfig` section and
field (a drift test keeps the table complete and the parity manifest maps
each `section.field` to one workflow row):

| Disposition | Sections and fields                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| applied     | `localization.lng`, `localization.firstDayOfWeek`, `tasks.isAutoMarkParentAsDone`, `tasks.isAutoAddWorkedOnToToday`, `tasks.isConfirmBeforeDelete`, `tasks.isMarkdownFormattingInNotesEnabled`, `timeTracking.isNotifyWhenTimeEstimateExceeded`, `reminder.notifyOnDueDate`, `reminder.dueDateNotificationHour`, `dailySummaryNote.txt`                                                               |
| transform   | `localization.dateTimeLocale` (canonical tag), `misc.startOfNextDayTime` (exact H:mm to planning `dayStartsAt`), `misc.defaultStartPage` (0 Today, 1 Inbox, 2 and 3 Planner), `tasks.defaultProjectId` (imported project), `timeTracking.defaultEstimate*` (whole minutes 1–720), `reminder.defaultTaskRemindOption`, `schedule.*` (planning working hours and break), `keyboard` keys with an action |
| excluded    | all of `sync`, `localBackup`, `sound`, `dominaMode`, `clipboardImages`; `misc` desktop, wallpaper, `unsplashApiKey`, `customTheme` and deprecated copies; `tasks.isTrayShowCurrent`; `reminder` banner, focus-window, Android and `disableReminders` (enabling Tadooer reminders starts server delivery); `dailySummaryNote.lastUpdateDayStr`; desktop and zoom keyboard keys; `plugin_*` keys        |
| deferred    | `appFeatures` (feature toggles), `shortSyntax` and `tasks.notesTemplate` (#90), `evaluation` (#52), `idle`, `takeABreak`, `pomodoro`, `flowtime`, `focusMode` and the tracking-reminder and auto-start fields of `timeTracking` (#65), keyboard keys without a Tadooer action                                                                                                                         |

Values of excluded fields are never read. Findings carry section names and
counts only: `config_applied`, `config_field_excluded` and
`config_field_retained` (deferred, unreviewed and unusable fields). None
blocks. Mapped application settings apply once, while the owner has never
saved application preferences; mapped planning settings apply once while
planning preferences were never saved. Imported bindings that collide with
each other or with defaults are reported and left out. Unknown sections and
fields are reported and kept in the export.

## Consequences

- Tests cover schema and binding normalization, conflict detection, the
  revision protocol across browser and assistant writes (stale, replay,
  restart), auto-complete-parent on the HTTP and sync paths, the owner default
  reminder, import-once behaviour, a credential marker never reaching the
  prepared import or the SQLite file, backup and restore, theme resolution
  and the settings render.
- `dateTimeLocale` and `firstDayOfWeek` have no consumer yet; a formatting
  pass over the planner and worklog is the follow-up. Date-only reminder
  delivery, an i18n layer, per-view keyboard navigation and onboarding stay
  open under #67.
- The next planned-day change from `autoAddWorkedOnToToday` reaches the
  browser on the following sync round, not in the focus command response.
