# ADR 0016: durable notification authority

Status: accepted

## Decision

Suite owns reminder intent and delivery history. ntfy is a private-network,
write-only delivery adapter and is never a task, calendar, or retry authority.
The operator installs one mode-0600 publisher file containing an internal ntfy
origin, a dedicated topic, and an ACL-limited bearer token. Browser APIs expose
only preferences and content-free delivery health.

Each planned occurrence has at most one lead and one at-start ledger row. The
durable identity is owner, task, occurrence start, and reminder kind. A process
must atomically claim a pending row before publication. An explicit transient
HTTP rejection can be retried with bounded backoff; a lost response is marked
failed and is not retried automatically because delivery may have succeeded.
This favors a visible missed reminder over an unbounded duplicate.

Completion, deletion, rescheduling, or disabling a reminder cancels obsolete
pending rows. Delivered history remains immutable. Calendar unavailability or
staleness suppresses delivery. Working hours, configured breaks, and busy time
defer a lead only while an eligible minute remains before start, and otherwise
suppress it. At-start delivery is suppressed for completed work and when that
task already owns the running focus session. A Suite-managed calendar block is
excluded from its own task's busy check.

Detailed notifications may contain only the task title, localized planned time,
and a Suite deep link. Notes, calendar-event titles, provider/account details,
connector credentials, automation tokens, and the ntfy token never enter the
ledger, browser response, metrics, or diagnostics.

## Recovery boundary

The notification ledger is part of the normal SQLite backup. The publisher file
is copied only into the owner-only coherent secret backup that is subsequently
stored in encrypted Restic. It is never included in public diagnostics or image
layers. Restoring a `sending` row converts it to a terminal uncertain failure;
operators may inspect health and send a new test, but Suite does not replay an
ambiguous publish.
