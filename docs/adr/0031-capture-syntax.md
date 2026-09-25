# ADR 0031: Capture syntax

- Status: accepted
- Date: 2026-09-25
- Issue: #90 (parent #31)
- Relates to: ADR 0018 (child tasks), 0019 (organization), 0020 (planned day),
  0021 (link attachments), 0023 (recurring series), 0011 (automation
  preview/confirm)

## Context

Structured capture (`structured: true` on `tasks.create`) read `+project`,
`#tag`, `@date time` and `!deadline` against existing names only. Super
Productivity 19.1.0 (`src/app/features/tasks/short-syntax.ts`) also reads an
estimate word, creates unknown tags, accepts `@date` without a time, maps
`@every …` to a repeat configuration, handles URLs per a `shortSyntax.urlBehavior`
setting, and creates several tasks from a pasted Markdown list or a dropped
`.eml` file. The parity row `capture` needed one grammar shared by the browser,
the quick-add CLI and the assistant, with the same consent rules everywhere.

## Decision

### Grammar

A title is tokenized once. Markers start a segment when they follow whitespace
or open the input: `+` project, `#` tag, `@` planned time or repeat, `!`
deadline. A segment's value runs to the next marker. Double or single quotes
protect their contents; a backslash escapes the next character. Quoted and
escaped characters are literal: no marker, estimate word or address is read
from them.

| Token                          | Result                                                                                                                 |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `+Name`, `+"Two words"`        | Project by case-folded title. At most one. Unknown, archived or ambiguous names fail.                                  |
| `#name`                        | Tag by case-folded title. Unknown names are reported as `newTags` (see consent). Archived or ambiguous names fail.     |
| `30m`, `1h`, `1h30m`, `1.5h`   | `estimateMinutes`. Read as a standalone word in the title or at the end of a `+`/`#` value; not inside `@`/`!` values. |
| `@tomorrow`, `@friday`         | Planned day (ADR 0020) when the phrase has no time of day.                                                             |
| `@tomorrow 09:00`              | Planned start; the planning time zone applies and skipped or repeated local times fail unless an offset is given.      |
| `@every …`, `@daily`, …        | A recurring series (ADR 0023) started from the task. At most one `@` marker per capture.                               |
| `!friday`, `!2026-12-01 17:00` | Deadline date or instant, unchanged.                                                                                   |
| `https://…`, `www.…`, `[t](u)` | Links read from the title segment only (before the first marker), handled per `urlBehavior`.                           |

Precedence: the estimate word is removed first, then links, then markers in
input order. Explicit request fields and markers for the same property are
rejected together ("Use either capture markers or explicit fields"); a `null`
field from a blank form input is not a conflict.

Estimates keep the editor bounds: whole minutes from 1 to 720. `0m`, `13h`,
`721m` and `1.333h` fail with a message naming the word; nothing is rounded.
`30min`, `t30m` and the source's `/` time-spent syntax are not read.

### `@every` mapping

| Phrase                                              | Rule                                            | Start date                               |
| --------------------------------------------------- | ----------------------------------------------- | ---------------------------------------- |
| `daily`, `every day`, `every N days`                | daily, interval N                               | capture date (planning zone)             |
| `weekly`, `every week`, `every N weeks`             | weekly, interval N, weekday of the capture date | capture date                             |
| `every monday`, `every 2 fridays`                   | weekly, interval N, that weekday                | next such weekday on or after today      |
| `every weekday`, `every workday`                    | weekly, Monday to Friday                        | today, or the next Monday from a weekend |
| `monthly`, `every month`, `every N months`          | monthly by day of month, interval N             | capture date                             |
| `every 15th`                                        | monthly by day of month                         | next date with that day of month         |
| `yearly`, `annually`, `every year`, `every N years` | yearly, interval N                              | capture date                             |

A trailing time (`09:00`, `9am`, `at 17:30`) becomes the series start time and
the task's planned start on the start date; without it the task gets the start
date as its planned day. Every other phrase (`every other day`, `every 2nd
tuesday`, intervals outside 1 to 366) fails as unsupported and names the
supported forms. The series copies the task's title, notes, project, tags and
estimate, uses the default reminder, schedule anchoring and `latest` missed
policy, and links the task as its first occurrence (`sourceTaskId`), so no
second instance is generated for that date.

### Unknown tags

The parser reports `newTags` (case-folded unique, first spelling kept). Creation
is always in the same transaction as the task, through the organization store,
so the tag's case-folded uniqueness holds and a later failure (for example 26
tags) rolls the tags back with the task. Consent differs by channel:

- Browser: the capture form has a "Create unknown #tags with this task" box.
  Without it the server answers 400 naming the tag and the phrase "confirm
  tag creation"; with it the request carries `createTags: true`.
- Assistant: the preview resolves the capture, lists each new tag as an
  affected `tag` object with the id it will receive and names it in the
  summary; confirmation is the consent. The stored command already carries
  `newTags`, `attachments` and `recurrence`, so confirmation re-parses nothing.
- Quick-add: the CLI reads the preview's affected tags and stops before
  confirmation unless `--create-tags` was given.

### URLs

`urlBehavior` is an owner setting stored with its own revision (migration
`0035_capture_preferences`): `keep` (title unchanged, nothing attached),
`extract` (addresses removed from the title; a title that becomes empty is the
host and last path segment) or `keep_and_attach` (default). Attached links follow
ADR 0021: only absolute http(s) addresses without a user name or password;
`www.` gains `https://`; `file:`, `ftp:` and other schemes stay as text. An
address with credentials fails the capture in the two attaching modes rather
than being attached or silently dropped. Links are created with the task in the
same transaction, deduplicated by normalized address. Super Productivity's
`keep-and-attach` maps to `keep_and_attach`; the import preview reports
`globalConfig.shortSyntax` and does not apply it (the section stays
`configuration`; application preferences are #67).

### Paste

`POST /api/tasks/capture-preview` parses text without side effects and
`POST /api/tasks/batch` (Idempotency-Key) creates the result; the assistant
uses `tasks.create_many` with the same preview/confirm protocol. A batch creates
at most 100 tasks in one transaction; item keys derive from the batch key so a
retry replays every task.

- Markdown: lines starting with `-`, `*`, `+` or `1.` are items; `- [ ]` is an
  open item and `- [x]` is skipped and counted. Indented items (2 spaces or a
  tab per level) become child tasks of the preceding top-level item; deeper
  nesting is flattened to one child level (ADR 0018). Other lines after an
  item are its notes; `#` headings are ignored. Each item may carry capture
  syntax when the paste is submitted as structured.
- Email: when the text starts with a header block that contains `Subject:`,
  the subject (whitespace collapsed, clipped to 240 characters) is the title
  and the body after the first blank line is the notes, prefixed with the
  `From:` line when present. Markers in the subject are never read. Raw MIME
  messages (`multipart/`, base64 parts, attachment dispositions) are refused
  with a message asking for the message text; binary `.eml` attachments are
  out of scope.
- Anything else is one task from the first line.

The browser shows every task, its resolved fields and the tags the batch would
create, and requires the consent box before creating.

### Offline

Structured capture, paste batches and the URL setting are online-only: tag
creation, attachments and series are server-side records outside the sync feed.
Plain capture (no markers) keeps queueing in the offline outbox as before.

## Consequences

- `createTaskRequestSchema` gains `createTags`, `newTags`, `attachments` and
  `recurrence`; `taskChildCreateRequestSchema` inherits them. The automation
  catalog gains `tasks.create_many` (scope `tasks:write`).
- `SuiteDatabase.capture` provides the settings and an `atomically` savepoint
  that nests inside confirmation transactions; capture writes use it.
- The parity row stays `partial`: time-spent syntax, per-marker switches,
  `.eml` file drop and headings-as-tasks are not mapped, and no real-data
  workflow has been recorded.
- Tests: `packages/domain/src/structured-capture.test.ts` (grammar table,
  bounds, URL safety, `@every`), `capture-paste.test.ts`,
  `apps/server/src/task-capture.test.ts` (atomicity, case folding, replay),
  `apps/server/src/capture.test.ts` (HTTP and assistant paths), quick-add
  `client.test.ts` and `config.test.ts`.
