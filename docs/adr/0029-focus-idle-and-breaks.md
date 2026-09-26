---
status: accepted
---

# Focus presets, idle handling and break reminders

Issue #65. Tadooer has a server-authoritative focus/break session (ADR 0010)
but no presets, no elapsed or remaining time, no idle handling and no break
reminders. Super Productivity 19.1.0 has three focus modes, desktop idle
detection with a disposition dialog, a take-a-break reminder and a tracking
reminder, all driven by `globalConfig`. This decision maps those behaviours
onto the lease without a second timer authority, and settles what the browser
can and cannot detect.

## Source semantics (Super Productivity 19.1.0)

Read from `src/app/features/focus-mode`, `features/idle`,
`features/take-a-break`, `features/tracking-reminder` and
`features/config/global-config.model.ts`:

- **Modes.** `Pomodoro` runs `pomodoro.duration` of work, then a break of
  `breakDuration`, or `longerBreakDuration` when the completed cycle is a
  multiple of `cyclesBeforeLongerBreak`; the next session starts after the
  break. `Flowtime` has no fixed length; when `flowtime.isBreakEnabled` it
  proposes a break of `breakPercentage` of the stretch (`ratio`, at least one
  minute) or the first matching `breakRules` entry (`rule`, half-open ranges).
  `Countdown` runs the last countdown length kept in local storage and has no
  automatic break. The timer completes a work session when elapsed reaches
  the duration unless Pomodoro overtime (`isManualBreakStart`) is on; a break
  that runs out only notifies. The looping break-end alarm is a per-device
  setting, not exported.
- **Idle.** Electron (or the browser extension) reports the operating
  system's idle time. Past `idle.minIdleTime`, and unless
  `isSuppressIdleDuringFocusMode` holds during a focus session or
  `isOnlyOpenIdleWhenCurrentTask` holds without a current task, the app
  removes the idle time from the current task, stops it, and opens a dialog.
  The owner assigns the time to that or another task, splits it, counts it as
  a break, or discards it; a checkbox resets the take-a-break counter.
- **Take a break.** A counter of tracked time without a break; over
  `takeABreakMinWorkingTime` it shows a banner with the owner's
  `takeABreakMessage` (`${duration}` substituted), a desktop notification and
  optional sound, lock screen or full-screen blocker on the desktop. Snooze
  waits `takeABreakSnoozeTime`.
- **Tracking reminder.** When nothing is tracked for
  `timeTracking.trackingReminderMinTime` while the app is open, a banner (and
  optionally a desktop notification) asks to track something.

## Decision

### One authority, derived timers

The active session stays the only authority for time (ADR 0010): the lease,
the intervals and their instants do not change. Everything this decision adds
is derived from the session or stored beside it:

- A **focus preset** (`pomodoro`, `flowtime`, `countdown`) is chosen per
  session. Setting it freezes the owner's current preference values into a
  **plan** of millisecond targets (`active_session_focus_plans`), so a later
  preference edit never changes a running session. Clearing the plan leaves
  the session running without a timer.
- Elapsed time in the current phase is the sum of the trailing intervals of
  that phase, so pauses do not count and a resumed stretch continues. The
  **cycle** is one plus the number of `break-ended` events. A Pomodoro break
  is long when the cycle is a multiple of the cycles-before-long-break
  setting; a Flowtime break length follows the ratio or rules over the focus
  stretch just ended; a countdown has no break target. Durations are
  differences of server instants, so a change of clocks in the owner's zone
  does not lengthen or shorten a stretch.
- `GET /api/focus/timer` returns the observed session, its plan, the
  countdown (elapsed, target, remaining, done, cycle, long break, and the
  instant the target was reached) and the reminder states. The browser counts
  down from the instant it received; it never computes a boundary itself.
- On the controlling device, a finished Pomodoro focus stretch sends
  `start_break`; a finished break or countdown only alerts, and the owner
  ends the break or completes the session. The optional break-end tone is a
  short synthesized sound played only when the owner enabled it.

### Focus preferences

`owner_focus_preferences` (migration `0033_focus_preferences_idle`) holds one
revisioned JSON record per owner: default preset; Pomodoro focus, short and
long break minutes and cycles; Flowtime break enabled, mode, percentage and
rules; countdown minutes; apply the default preset when focus starts from a
task; break-end tone; idle detection (enabled, minutes without input, only
while a session runs, not during a Pomodoro or countdown); take-a-break
(enabled, minutes of work, snooze minutes, message); tracking reminder
(enabled, minutes). The revision is 0 until the first save. Browser writes
send `If-Match`; a stale revision is `412 FOCUS_PREFERENCES_CONFLICT`.

The source's "keep tracking during a break" has no equivalent: a Tadooer
break interval never counts as task time (ADR 0010). Pomodoro overtime,
preparation screens, ambient sounds, lock screen, full-screen blocker and
motivational images are not ported.

### Idle disposition without duplicate intervals

The web has no operating-system idle API. The browser treats the absence of
pointer, keyboard, wheel and touch input in its window, or a hidden tab, for
the configured minutes as idle. On return it asks the owner what the span
was, only when a session that this device controls is running; the session
keeps running meanwhile, and the lease expiry stays the liveness guard when
the device slept or the tab closed. The desktop shell (ADR 0015) may later
supply a system idle signal through the same disposition; nothing here
depends on it.

`POST /api/focus/idle` applies the choice as an explicit correction of the
running session, with the session revision and an idempotency key:

- `assign` keeps the span as task time and records the decision;
- `break` closes the focus interval at the idle start, inserts a break
  interval for the span and reopens focus now (no cycle advances);
- `discard` closes the open interval at the idle start and reopens the same
  phase now, so the span belongs to no interval.

The idle start is clamped to the open interval's start, so a takeover or
resume inside the span is never rewritten. Time is only trimmed or
relabelled, never added: the source's "assign to another task" and "split"
would invent intervals and are not offered. Each correction is written in
the session transaction as an `active_session_idle_dispositions` row (span,
trimmed milliseconds, actor) and a session event, and the intervals carry
`closedBy = idle`. Work history (ADR 0024) reads the corrected intervals, so
no millisecond is counted twice and the 24-hour day cap applies unchanged.

### Break and tracking reminders

- **Take a break.** The working stretch is the focus time, across sessions,
  since the last break interval or a gap of five minutes without focus. When
  it reaches the minimum working time during a running focus session the
  reminder is due. Snooze (`POST /api/focus/break-reminder/snooze`) stores a
  time until which it is not due.
- **Tracking reminder.** Time since the later of the last closed focus
  interval and the start of the owner's day. It is due when that reaches the
  minimum while nothing is tracked and the calm-day rules allow it: not
  outside working hours, not in the scheduled break, not while a stored
  calendar event is busy, and not when the day is finished or no open task
  remains. Calendar staleness does not suppress it.

Both banners come from the timer endpoint. The ntfy copies go through the
notification ledger (ADR 0016) with four new kinds: `focus_countdown`,
`focus_break_end`, `focus_break_reminder` and `focus_tracking_reminder`. A
row carries no task ID and is unique on owner, kind and occurrence instant,
which is derived from the intervals, so repeated ticks queue it once and a
delivered or suppressed reminder is never recreated. Before publication a
claimed row is re-evaluated: a countdown whose phase changed, a break that
was taken or snoozed, or tracking that resumed is suppressed with its reason.
Rows are queued only while notifications are enabled and a publisher is
configured; the in-app banners do not depend on the ledger.

### Sync and offline policy

Focus preferences, plans, idle dispositions and reminder state are online
HTTP records outside the sync change feed and the offline cache. Idle
detection needs a connection to apply its disposition; offline focus control
remains unsupported (ADR 0010).

### Assistant operations

`focus.preferences` (`focus:read`) returns the preference fields with their
revision. `focus.update_preferences` (`focus:write`) is revision-bound like
`planning.update_preferences`. `focus.idle_disposition` (`focus:write`)
previews the span, the disposition and the focus time it removes, freezes the
session revision, and applies the correction for the owner at confirmation:
the controlling device remains the interval's actor and the automation audit
records the token. Presets, snooze and the timer stay browser operations.

### Super Productivity import

The focus sections of `globalConfig` (`pomodoro`, `flowtime`, `focusMode`,
`idle`, `takeABreak`, the `trackingReminder*` keys of `timeTracking`, and
`sound`) are classified in `super-productivity-focus.ts`. Applied values
overlay the defaults once, while the owner has never saved focus
preferences; the record then carries the export hash, the import instant and
the applied key names. A later import never overwrites an edit. Retained
values are reported by name with `focus_preference_notice` (non-blocking) and
stay in the export. Other `globalConfig` sections remain configuration (#67).

## Consequences

- The focus panel shows elapsed or remaining time and the cycle; the Settings
  page gains a focus section; an idle-return dialog and reminder banners are
  new. No sound plays without the preference.
- The notification ledger is rebuilt once to widen its kind check; existing
  rows and indexes are preserved.
- Idle detection is bounded by what a browser window can observe: work in
  another application looks idle, and the owner's "keep" answer is the
  correction. System idle detection is a desktop-shell follow-up.
- Tests cover cycle math and Flowtime rules, pause-aware elapsed time across
  the America/Chicago daylight-saving change, every disposition against the
  worklog, stale revisions, replay and restart, ledger dedup and suppression,
  owner isolation and backup/restore. A real-backup import of the focus
  settings remains #47.
