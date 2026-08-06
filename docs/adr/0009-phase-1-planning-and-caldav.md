---
status: accepted
---

# Bound Phase 1 planning to one conditional Baikal time block

Phase 1 delivers one owner-facing planning loop: read a bounded interval of
existing Baikal events, create or update one explicitly chosen time block for a
Suite task, and surface a conflict instead of overwriting an external calendar
change. Baikal remains authoritative for DAV resources, UIDs, hrefs, and ETags.
Suite SQLite stores only a bounded projection and the task-to-event mapping.

## Connector boundary

The bundled, server-configured Baikal endpoint is the sole Phase 1 write
connector. It remains automatic in the default Compose deployment and uses the
existing encrypted, server-side credential relationship. The "external
CalDAV" roadmap option is an opt-in server-administrator deployment setting,
not a browser-entered arbitrary URL. Browser-selectable origins remain deferred
until SSRF, DNS-rebinding, TLS, redirect, credential-isolation, and revocation
contracts have their own review and fixture corpus.

## Event projection boundary

The first projection reads a caller-supplied, bounded day/week window from an
event-capable discovered calendar. It accepts only a single, non-recurring,
UTC-timed VEVENT per DAV resource with a UID, href, ETag, DTSTART, and DTEND.
All-day events, TZID values, recurrence properties, multiple VEVENT resources,
VTODO, attendees, alarms, attachments, and unknown event content are not
silently normalized into Phase 1 planning data. Unsupported resources are
reported as unsupported or omitted with explicit projection freshness; they are
not rewritten.

An event is identified only by the qualified Suite provider UUID, calendar UUID,
and opaque provider-native event identifier. A href or UID alone is never a
Suite-wide identity. Raw ICS and provider response bodies are not returned by
the Suite API or written to logs.

## Task and planning boundary

Tasks gain title/notes editing, explicit complete/reopen, soft delete/recover,
an optional planned start, and an optional positive estimate in minutes. Each
successful Suite-owned task mutation increments its positive revision and
returns that revision as a quoted ETag.

Every update, lifecycle transition, delete, recovery, and time-block mutation
requires a quoted `If-Match` task revision. A missing precondition is a visible
precondition-required error; a stale revision is a visible precondition-failed
error. The browser refreshes rather than retrying an update blindly.

Phase 1 permits at most one active Suite-created time block per task and one
Suite task mapping per qualified provider event. The owner explicitly selects
the event-capable calendar, UTC start instant, and bounded positive duration.
The planner may warn about an overlap but does not auto-schedule or move work.

Creating a block is retriable only with a durable idempotency key. The Suite
creates a server-owned DAV resource with `If-None-Match: *`; updating or
deleting the mapped resource uses the stored DAV ETag in `If-Match`. A DAV
`412` never falls back to an unconditional write. It becomes a safe,
client-visible calendar conflict, and the mapping is marked for reconciliation
when necessary. A restart/retry must reconcile the stored operation/UID/href
before another event can be created.

## Recovery and backup boundary

Task deletion is soft deletion and has a dedicated recovery flow. It is never
implemented as completion. Deleting a mapped task may conditionally delete only
the Suite-created DAV event; it must not alter an existing foreign event. If
the DAV precondition fails, the user sees the conflict and no external event is
overwritten or silently removed.

Suite backup covers task state, projections, mappings, and operation recovery
state. It does not contain authoritative Baikal resources. The Phase 1 restore
drill therefore backs up and restores the Baikal volumes consistently with the
Suite database/key pair, then proves that the restored mapping refers to the
same single event.

## Explicit non-goals

Phase 1 does not add arbitrary browser-configured CalDAV origins, offline
multi-writer queues, Google Calendar, event recurrence, VTODO planning,
availability optimization, automatic scheduling, multi-block tasks, or a
general CalDAV server implementation.
