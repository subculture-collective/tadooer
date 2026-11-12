# Super Productivity v20 parity roadmap

Planned November 9, 2026, from the
[v16–v20 comparison](super-productivity-v16-v20-comparison.md), a read of the
current source and the upstream v20 tree at `4db0e11`. Dependency order is not
a calendar commitment.

**Tracker:** [#217](https://github.com/subculture-collective/tadooer/issues/119)
holds 17 epics and 79 work issues, each one reviewable PR, with native
dependencies. This file records scope and reasoning; the tracker holds the
current order and state.

## Scope

The roadmap covers every Partial or Gap row in the comparison, minus the owner's
exclusions. Most interface work has shipped, so the issues add behaviour to the
current workspace and do not restyle it.

| Comparison row                                        | Status  | Epic                                                                                   |
| ----------------------------------------------------- | ------- | -------------------------------------------------------------------------------------- |
| Child tasks and parent time totals                    | Partial | [C: task model](https://github.com/subculture-collective/tadooer/issues/122)           |
| “Won't do” completion                                 | Gap     | C                                                                                      |
| Numeric priority and p1/p2/p3 capture                 | Gap     | C                                                                                      |
| Duplicate task                                        | Gap     | C, with file retention in E                                                            |
| Full-text task and note search                        | Partial | [P: find and capture](https://github.com/subculture-collective/tadooer/issues/135)     |
| Bulk paste and email capture                          | Partial | P                                                                                      |
| Newer repeat controls (English only)                  | Partial | P                                                                                      |
| Link, image, file, note and app-link attachments      | Partial | [E: files and app links](https://github.com/subculture-collective/tadooer/issues/124)  |
| Nested folders in navigation                          | Partial | [J: organization](https://github.com/subculture-collective/tadooer/issues/129)         |
| Project backlog                                       | Partial | J                                                                                      |
| Named sections in Today                               | Partial | J                                                                                      |
| v20 Smart Lists                                       | Partial | [G: Smart Lists](https://github.com/subculture-collective/tadooer/issues/126)          |
| Daily overview of tracked work                        | Partial | [M: daily review](https://github.com/subculture-collective/tadooer/issues/132)         |
| Finish-day ritual and weekly wrap-up                  | Partial | M                                                                                      |
| Month grid and day side panel                         | Partial | [N: calendar interaction](https://github.com/subculture-collective/tadooer/issues/133) |
| Drag tasks, blocks and cards                          | Partial | N                                                                                      |
| Board and Planner keyboard multiselect                | Partial | N                                                                                      |
| Auto-plan                                             | Gap     | [D: auto-plan](https://github.com/subculture-collective/tadooer/issues/123)            |
| Google multiple accounts                              | Partial | [H: Google accounts](https://github.com/subculture-collective/tadooer/issues/127)      |
| Idle review on the desktop                            | Partial | [Q: time and focus](https://github.com/subculture-collective/tadooer/issues/136)       |
| Work-start and work-end editing                       | Partial | Q                                                                                      |
| Looping alarms and web focus notifications            | Partial | Q                                                                                      |
| Fullscreen document editor, file tree and note spaces | Gap     | [L: notes workspace](https://github.com/subculture-collective/tadooer/issues/131)      |
| Trigger/action automations                            | Gap     | [A: automations](https://github.com/subculture-collective/tadooer/issues/120)          |
| Executable plugins, catalog, UI, hooks and guidance   | Gap     | [B: extensions](https://github.com/subculture-collective/tadooer/issues/121)           |
| Export/restore and migration (v20 backups)            | Partial | [I: v20 import](https://github.com/subculture-collective/tadooer/issues/128)           |
| Windows distribution                                  | Partial | [F: Windows](https://github.com/subculture-collective/tadooer/issues/125)              |
| iOS sharing, shortcuts and notifications              | Partial | [O: iOS](https://github.com/subculture-collective/tadooer/issues/134)                  |
| Theme catalog, density, typography, CSS and wallpaper | Partial | [K: appearance](https://github.com/subculture-collective/tadooer/issues/130)           |

### Excluded by the owner

- Logging tracked work sessions as calendar events
- Fullscreen focus and native blockers
- Upstream worklog export options, including rounding
- Other issue tracking: Gitea pull requests, Jira, GitLab, Linear, Trello, Azure
  DevOps, ClickUp, OpenProject and the rest
- Plainspace collaboration
- The AI Command or assistant plugin
- Client E2EE, along with the SuperSync, Dropbox, WebDAV, file and OneDrive sync
  providers in the same row
- Todoist, TickTick and other plugin importers
- Everything Android
- Localization and natural-language parsing in other locales

Work-start and work-end editing shares a row with export options. Only the
export half was excluded, so editing stays in scope. Header counter buttons are
noted on an Implemented row and are not included.

Real-data cutover stays with #47 and #49, and iOS store release with #153.

## What the source review changed

- **Automations and Doc Mode are plugins upstream.** Tadooer builds them
  first-party. Rules run on the server, because a change made offline only
  reaches the server when it syncs. No domain event log exists today, and
  `sync_changes` carries no transition data, so
  [the first automation slice](https://github.com/subculture-collective/tadooer/issues/141)
  adds one.
- **Task depth stays at two levels.** The comparison lists deeper imports as a
  limit, but v20's `canConvertTaskToSubTask` still refuses to nest a subtask. The
  remaining work on that row is showing parent totals outside Worklog.
- **Repeat controls are mostly done.** The contract already has nth-weekday,
  last-day and end-date rules. The gap is English capture phrases. Upstream v20
  has no occurrence count, so none is planned.
- **Web focus notifications do not exist yet.** The comparison implies partial
  coverage, but reminders are ntfy-only and the web app never raises a
  notification.
- **Won't do needs no status rebuild.** Upstream records it beside completion
  (`wontDoOn`), and Tadooer can do the same with an outcome column.
- **Importing v20 may fail outright.** The importer has no version gate and
  blocks unknown sections and task fields.

## Order of work

Risky and undecided items come first. The tracker's five waves show what can run
in parallel; the first has 31 ready issues. Suggested starting points:

1. **Task model** ([#237](https://github.com/subculture-collective/tadooer/issues/139)):
   one migration unblocks priority and won't do, and they feed Smart Lists,
   auto-plan and the v20 import.
2. **Smart Lists** ([#242](https://github.com/subculture-collective/tadooer/issues/144))
   and **busy data** ([#238](https://github.com/subculture-collective/tadooer/issues/140)):
   two of the comparison's largest gaps.
3. **Drag primitive** ([#257](https://github.com/subculture-collective/tadooer/issues/159)):
   grid, board and backlog drag all build on it.
4. **Automations decision** ([#235](https://github.com/subculture-collective/tadooer/issues/137)):
   the head of the critical path, #235 → #239 → #259 → #273 → #308.

## Decisions and checks that need the owner

These issues are marked `hitl`. Everything else can be finished by an agent.

| Issue                                                               | Needed from the owner                                             |
| ------------------------------------------------------------------- | ----------------------------------------------------------------- |
| [#235](https://github.com/subculture-collective/tadooer/issues/137) | Accept which actions a rule may run unattended                    |
| [#236](https://github.com/subculture-collective/tadooer/issues/138) | Accept the extension threat model, which also closes #102         |
| [#240](https://github.com/subculture-collective/tadooer/issues/142) | Accept file storage limits and the app-link boundary              |
| [#241](https://github.com/subculture-collective/tadooer/issues/143) | Choose a Windows runner, a signing option and an update path      |
| [#244](https://github.com/subculture-collective/tadooer/issues/146) | Provide a real v20 backup for an identity-and-size diff           |
| [#261](https://github.com/subculture-collective/tadooer/issues/163) | Enter the admin password for Xcode's first launch on Soyuz        |
| [#262](https://github.com/subculture-collective/tadooer/issues/164) | Choose local scheduling or APNs, which needs a paid Apple account |
| [#297](https://github.com/subculture-collective/tadooer/issues/199) | Test reminder delivery on a real iPhone                           |
| [#307](https://github.com/subculture-collective/tadooer/issues/209) | Connect two real Google accounts for qualification                |
| [#310](https://github.com/subculture-collective/tadooer/issues/212) | Test on a real Windows machine                                    |

The extension epic reverses ADR 0026's default, so it stays gated on #236.
Imported Super Productivity plugin code never runs under any outcome.

## Delivery rules

The [roadmap issue](https://github.com/subculture-collective/tadooer/issues/119)
lists the shared rules. The PR that finishes a comparison row updates that row.
The roadmap closes when every in-scope row reads Implemented or cites a recorded
decision. Production rollout stays with tagged releases.
