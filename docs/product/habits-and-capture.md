# Habits and structured capture

The Habits workspace supports daily, selected-weekday, and every-N-days schedules.
New habits start today in the owner's planning timezone and retain that timezone.
Names can be edited; schedules stay fixed so previous completions keep their
meaning. Archive hides completion controls, and restore retains the same history.
Streaks are derived from immutable due-period completions. Repeating completion
from another client returns the same occurrence rather than incrementing a counter.

Habit changes require an online browser. A request interrupted after queueing stays
in the local outbox with its original operation ID; use **Sync now** to retry it.
The UI waits for canonical server data before showing a completion. Automation
uses `habits:read` for `habits.list`, and `habits:write` for `habits.mutate`. The
mutation input is a `habit.create`, `habit.patch`, `habit.archive`, `habit.restore`,
or `habit.complete` command. Preview and confirmation are required; edits capture
the habit ID and base revision, and confirmation rejects stale revisions.

To use structured task capture, check **Use capture markers (online)** in Today or
Inbox. Quick-add accepts `--structured`; HTTP and automation task creation accept
`structured: true`. Plain titles retain their existing behavior by default.

```text
Prepare review +"Work + Home" #urgent @tomorrow 09:00 !Friday
```

- `+` resolves an existing project by name.
- `#` resolves an existing tag; repeated tags are deduplicated.
- `@` supplies a planned start and must include a time of day.
- `!` supplies a date-only deadline, or an instant when a time is included.

Markers start at a whitespace boundary outside quotes. Single or double quotes
protect markers; a backslash escapes the next character. For example, `Discuss
\#1` keeps `#1` in the title, and `+"Work + Home"` references the entire project
name. Unclosed quotes, trailing escapes, duplicate project/time/deadline markers,
and partially parsed or ranged dates are rejected. Names are matched after Unicode
normalization, trimming, and case folding. Unknown, archived, or ambiguous names
are rejected; capture never creates projects or tags implicitly.

Natural dates use the owner's planning timezone. A date-only deadline remains a
civil date. An instant uses the offset on its target date, including daylight
saving changes. Skipped or repeated local times require an explicit UTC offset.
Automation resolves names and relative dates at preview time, then stores those
resolved values for confirmation. Explicit property fields and a capture marker
for the same property cannot be combined.

Reference resolution, task insertion, assignments, planned start, deadline, field
versions, idempotency record, and sync change are committed in one transaction.
A failed reference lookup leaves no task. HTTP retries with the same key and
request replay the original task before resolving relative dates or names again.
The web form retains a stable retry key in session storage until creation succeeds.
Structured capture requires connectivity; plain capture retains offline outbox
support. Planned starts remain excluded from queued sync mutations, and capture
does not create a calendar event.
