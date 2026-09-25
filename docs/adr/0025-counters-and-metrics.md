---
status: accepted
---

# Simple counters and daily evaluations

Issue #64. Super Productivity 19.1.0 has simple counters (clicks, stopwatch
time and repeated countdowns per day, with streaks) and a per-day metric
record (the evaluation sheet and focus session durations). Tadooer had
neither, so the importer blocked both sections. Habits (#39) are a different
concept: a habit completes scheduled periods, a counter records an amount. Counters are not stored as habits, and no streak is
imported or stored.

## Source semantics (Super Productivity 19.1.0)

Read from `src/app/features/simple-counter`, `src/app/features/metric`,
`pages/metric-page` and `pages/habit-page`:

- **Counter definition** (`SimpleCounterCfgFields`): `id`, `title`,
  `isEnabled`, `isHideButton`, `icon` (a Material icon name), `type`
  (`ClickCounter`, `StopWatch`, `RepeatedCountdownReminder`),
  `isTrackStreaks`, `streakMinValue`, `streakMode` (`specific-days` or
  `weekly-frequency`), `streakWeekDays` (weekday 0 = Sunday to boolean),
  `streakWeeklyFrequency` and `countdownDuration` (milliseconds).
- **Recorded values.** `countOnDay` maps the device's local date string
  (`todayStr()`, no zone recorded) to a whole number. For `ClickCounter` it
  is a count. For `StopWatch` it is milliseconds: each tracking tick adds its
  duration to the tick's date, so a run across midnight is already split by
  day. For `RepeatedCountdownReminder` it counts completed countdowns; the
  countdown timer and its banner are client state. Values never go below zero.
- **`isOn`** is running state. The source turns every counter off when it
  loads data, so it is not user history.
- **Streaks** are computed on display
  (`get-simple-counter-streak-duration.ts`) from `countOnDay`; nothing is
  stored.
- **Metric day** (`MetricCopy`), keyed by the local date: `focusSessions`
  (list of focus session durations in milliseconds, appended when a focus
  mode session ends), `notes`, `remindTomorrow`, `reflections` (the UI keeps
  one entry, `{ text, created }`), `impactOfWork` (1 to 4) and `energyCheckin`
  (1 to 3). `totalWorkMinutes`, `completedTasks` and `plannedTasks` are marked
  for removal in the source.

## Decision

### Counters

A **counter** is an owner-scoped definition: title (1 to 200 characters),
kind (`click`, `stopwatch` or `repeated_countdown`), icon (the organization
icon pattern), enabled, hidden, display position, streak settings and, for a
repeated countdown only, its length. Hidden counters stay out of the daily
controls but keep their history. Disabled counters accept no new values.

A **counter day value** is one whole number per counter and owner-zone
calendar day:

- click and countdown counters: a count from 0 to 1,000,000;
- stopwatch counters: milliseconds, at most the length of that day in the
  owner's zone (23, 24 or 25 hours in America/Chicago).

Writes set a value or add a signed increment. A decrement stops at zero, as
in the source. Every write names the day revision it read (0 for an empty
day); a stale revision is `412 COUNTER_REVISION_CONFLICT`. Increments are
therefore not blind: a retried or concurrent increment fails instead of
counting twice, and the client reloads.

A stopwatch is started and stopped on the server. Start records the server
instant; stop splits the run at the owner's midnights and adds each part to
its day. A day that would exceed its length is clamped and the dropped
milliseconds are returned as `clampedMs`; this only happens after an explicit
set. Start and stop use `If-Match` with the counter revision. A running
stopwatch cannot be disabled, and a running period is not counted in a day
value or a streak until it stops.

Deleting a counter removes all its day values. The definition row stays as a
tombstone with `deletedAt`, hidden from every list, so replaying an import
does not bring the counter back.

### Streaks

The current streak is derived on read from the day values and the owner's
today, using the source's rules:

- `weekdays`: consecutive selected weekdays whose value reaches the minimum,
  counted back from the latest selected weekday. Today does not break the
  streak until it is over.
- `weekly_frequency`: qualifying days across consecutive Monday weeks that
  each reached the frequency, plus this week's days while it is open. With no
  complete week, this week's qualifying days, as in the source.

The minimum is a count, or milliseconds for a stopwatch. Streaks are never
stored or imported.

### Daily evaluations

A **daily evaluation** is one record per owner and calendar day: notes and a
reflection (up to 5,000 characters each), impact 1 to 4, energy 1 to 3 (1
exhausted, 3 good) and a remind-tomorrow flag. A write names the revision it
read (0 for a new day) and changes only the fields it sends. Remind-tomorrow
is stored and shown; it does not create a notification, and the source does
not act on it either.

Imported `focusSessions` stay on the evaluation as a read-only list of
durations. They are not time entries: Super Productivity's worklog already
records the same work in `timeSpentOnDay`, which ADR 0024 imports, so adding
the sessions to the worklog would count the time twice. For Tadooer's own
work, the evaluation view derives focus time and interval count per day from
active-session intervals, the only authority for focus (ADR 0010, ADR 0024).
The productivity and sustainability scores are not ported.

Migration `0029_counters_metrics` adds `counters`, `counter_day_values` and
`daily_evaluations`. A trigger rejects a day value whose counter belongs to
another owner or is deleted.

### Sync and offline policy

Counters, day values and evaluations are online HTTP records with revisions.
They are not in the sync change feed or the offline cache, and the browser
does not queue them. The Counters view disables writes offline. Two devices
editing the same day or evaluation get a revision conflict rather than a
merge.

### HTTP

- `GET /api/counters?from=&to=`: definitions with their current streak, the
  owner's today and zone, and day values in the range (at most 366 days).
- `POST /api/counters` (client UUID; a replay with the same content returns
  the counter, different content is `409 COUNTER_EXISTS`),
  `PATCH` and `DELETE /api/counters/:id` with `If-Match`.
- `POST /api/counters/:id/days/:date` with `set` or `increment` and the day
  revision.
- `POST /api/counters/:id/stopwatch` with `start` or `stop` and `If-Match`.
- `GET /api/evaluations?from=&to=`: evaluations and derived focus per day.
- `PUT /api/evaluations/:date` with the evaluation revision.

### Assistant

New scopes `metrics:read` and `metrics:write`. Resources
`counters.history` and `evaluations.list` take the same range. Tools, all
previewed and confirmed:

- `counters.mutate`: create, update or delete a definition. Update and delete
  freeze the counter revision.
- `counters.record`: set or increment a day with the day revision it read,
  and start or stop a stopwatch with the counter revision. The preview states
  the value before and after.
- `evaluations.write`: create or edit a day's evaluation with its revision.

Confirmation repeats the preview's checks, including the value bounds.

### Super Productivity import

`simpleCounter` and `metric` apply. Each field of both sections is classified
in `super-productivity-counters.ts`:

- Counter definitions map field by field. A missing title imports as
  "Untitled counter"; an icon that is not an icon name or emoji is dropped;
  a tracked streak without a minimum uses 1; missing weekdays use Monday to
  Friday, the source default. Each is reported as `counter_notice`, as are a
  repeated countdown (its timer is not ported) and a counter exported while
  running.
- Positive `countOnDay` values import as day values with the source value
  kept as `importedValue`. Zero and null days are skipped. Date keys are read
  as owner-zone dates, as in ADR 0024. A value over the day's bound, a
  malformed key or value (`invalid_counter_value`), an unknown type
  (`invalid_counter`) or an unreviewed field (`unknown_counter_field`) blocks.
- Metric days with any recorded field import as evaluations with their focus
  session durations. Empty days are skipped. `reflections[0]` becomes the
  reflection; more than one entry blocks (`metric_reflections_multiple`)
  because 19.1.0 keeps one. Out-of-range scales and malformed values block
  (`invalid_metric`), as do unreviewed fields (`unknown_metric_field`).
  `totalWorkMinutes`, `completedTasks` and `plannedTasks` are kept in the
  evaluation's import provenance and reported (`metric_field_retained`).
- `counter_reconciliation` states the counts: definitions, day values, the
  count total, stopwatch milliseconds, evaluations and focus sessions.

Imports are repeat-safe. A counter is identified by its source ID and a hash
of its definition (without values and running state); an evaluation by its
day and a hash of the source record. A replay adds nothing and keeps later
Tadooer edits. A later export may add days. A changed definition, a changed
source value for a day already imported, a changed metric day, or a source
day that meets a value first recorded in Tadooer aborts the import, as a
changed task does. A deleted imported counter stays deleted. Counters and
evaluations are written in the import transaction.

## Evidence

A read-only run of the importer on the newest backup
(`2026-09-24_231032.json`, 4,092,223 bytes) in America/Chicago:

- 12 counters: 10 click counters, 1 stopwatch and 1 repeated countdown, all
  with streak tracking on. 8 have values: 140 day values with a count total
  of 209. The stopwatch has no recorded values.
- 80 metric days become 80 evaluations: 29 with impact, 31 with energy, 2
  with a reflection and 65 with focus sessions (283 sessions,
  983,691,885 ms). None of that time enters the worklog.
- One `counter_notice` (the repeated countdown) and no blocking counter or
  metric finding. The export still cannot be applied for the reasons listed in
  the parity inventory (`pluginUserData`, duplicate copies, unsupported task
  data).

## Consequences

- Counters and evaluations are unavailable offline and are not in the sync
  feed; a queued offline counter would need idempotent operations that do not
  exist yet.
- A running stopwatch's elapsed time shows only as its start time until it
  stops.
- The countdown timer and reminder banner, header quick buttons, counter
  reordering, the productivity and sustainability scores and the source's
  charts are not ported. The Counters view shows a weekly grid with bars.
- Date keys recorded on a device in another zone are read as owner-zone
  dates; the source kept no zone.
- Counters and evaluations are not in a self-service data export yet (#93).
