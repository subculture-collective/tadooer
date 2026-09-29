---
status: accepted
---

# Bridge event semantics: series, time zones, all-day dates and invitations

Issue #45 (roadmap #15). Extends the normalized envelope from ADR 0041 so a
mapping carries recurring series, modified and cancelled instances, all-day
dates and time zones in both directions, and defines how events with
attendees or a foreign organizer are handled. Store schema, routes and the
outbox are unchanged; no migration is needed.

## Unit of bridging: the series

A recurring event is one bridged item. On Baikal it is one resource holding a
master `VEVENT` and zero or more `RECURRENCE-ID` overrides with the same UID.
On Google it is a master event (`recurrence`) and its exception events
(`recurringEventId` + `originalStartTime`). The Google side groups them under
the master's event ID, so one event link covers the series and the digest
covers every instance together. An instance is never linked on its own.

- Google listing: any changed master or exception causes a read of the whole
  series (`GET` master, then `events.list?iCalUID=…&showDeleted=true`). A
  cancelled master is a deletion of the series.
- Google revision: the master ETag for an event without exceptions (unchanged
  from ADR 0041), otherwise a JSON array of the master ETag and each
  exception's ID and ETag. It stays opaque to the engine.
- An exception whose master is not in the calendar (for example an invitation
  to one instance of someone else's series) is blocked as unsupported with
  the field `recurring-instance`.

## Envelope version 2

Fields added to version 1, each part of the digest:

| Field                           | Meaning                                                                                                                                         |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `startZone`, `endZone`          | IANA zone of a zoned time. `start`/`end` are then local wall times (`YYYY-MM-DDTHH:MM:SS`), not UTC. `null` for UTC instants and all-day dates. |
| `recurrence.rules`              | `RRULE` values, `FREQ` first and other parts sorted.                                                                                            |
| `recurrence.rdates`, `.exdates` | Instance keys, sorted and unique. `exdates` is the union of `EXDATE`, Google cancelled exceptions and Baikal overrides with `STATUS:CANCELLED`. |
| `recurrence.overrides`          | Modified instances by instance key: summary, description, location and schedule.                                                                |
| `invitation`                    | Organizer and attendees per instance (`""` is the master). Never written.                                                                       |

An **instance key** is the original start in the master's form: a date for
an all-day series, a UTC instant for a UTC series, and the wall time in the
master's zone for a zoned series. Keys therefore stay stable across DST
changes: the 10:00 Chicago instance is `2026-11-05T10:00:00` before and after
the switch, although its UTC instant moves by an hour.

Normalization rules:

- **All-day** dates stay `YYYY-MM-DD` on both sides and are never converted
  through an instant. A Baikal all-day event without `DTEND` ends the next day.
- **Zoned times** keep the zone. Google's `dateTime` is converted to the wall
  time in its `timeZone`; Baikal's `TZID` value is used as written. A zone
  name must be accepted by the runtime's IANA database (`Intl`); otherwise
  the event is blocked as unsupported with the field `timezone`. `UTC`, `Etc/UTC`, `GMT` and `Z` are
  treated as UTC so events written by version 1 keep their digest.
- Floating times, `DURATION`, `EXRULE`, `RDATE` periods, `RANGE=THISANDFUTURE`,
  more than one `RRULE`, and overrides without a master stay unsupported.
- An override identical to the generated instance (same content, same start
  and same duration as the master) is dropped, so a provider that
  materializes an unchanged exception does not create a difference.
- An envelope with no zone, recurrence or invitation hashes exactly as
  version 1. Stored accepted digests from ADR 0041 stay valid. The exception
  is a Google event with a non-UTC `timeZone`: version 1 dropped the zone, so
  after the upgrade Google differs from the accepted state once, and the pass
  writes the zone to the Baikal copy. That is a single ordinary update.

## Writing

- **Baikal:** one conditional `PUT` of the whole resource, with `RRULE`,
  `RDATE`, `EXDATE` and one `VEVENT` per override, using `TZID=<IANA name>`
  on zoned values. No `VTIMEZONE` is generated. Baikal's sabre/vobject
  resolves IANA names without one; #50 qualifies other clients reading the
  copy.
- **Google:** the master body carries `recurrence` (rules, then `RDATE` and
  `EXDATE` lines). Each override is written to the instance ID
  (`<master>_<YYYYMMDD>` or `<master>_<YYYYMMDDTHHMMSSZ>`) with `If-Match` on
  its current ETag. An exception that should no longer differ gets the
  generated values. A cancelled key with a live exception is deleted. Every
  Google write sends `sendUpdates=none`.
- A Google series update first rereads the series and fails the precondition
  if its revision differs from the expected one, so a concurrent change to
  any instance is detected, not only a master change.
- A Google series write takes several requests. If one fails after an
  earlier one committed, the result is `uncertain`: the next pass reads before
  anything is resent, and a partial result becomes a conflict for the owner,
  not a silent overwrite. A create whose master already exists with the
  desired master content completes the overrides, so a retried create
  converges. If the master content differs, the create reports `exists`.
- Deleting one instance is a series update (an added `EXDATE` or cancelled
  exception) and needs no deletion approval. It is an explicit cancellation,
  not an absence. Deleting the whole series still requires approval as in
  ADR 0041.

## Invitations: read-only mirror

An event with attendees, or a Google event whose organizer is not the
calendar owner (`organizer.self !== true`), or a Baikal event with `ORGANIZER`
or `ATTENDEE`, is an **invitation event**. Decision: it is mirrored read-only
rather than blocked.

- The copy on the other side contains the event content without organizer or
  attendees, so writing it cannot schedule, notify or claim organizer rights.
  Neither writer ever emits organizer or attendee data.
- The bridge digest excludes the invitation, so attendee or response changes
  alone cause no write. The full envelope, including the invitation, stays in
  the side snapshot.
- The invitation side is never written. When the copy is edited or deleted,
  the link is blocked with `invitation` and nothing is sent. Content changes
  from the organizer still reach the copy. A cancellation by the organizer
  still needs deletion approval before the copy is removed.
- Before dispatch, an update or delete whose target was last observed as an
  invitation event fails with `invitation-read-only`. This covers conflict
  resolution that would otherwise write the copy's content back.
- `decideCalendarBridgeChange` takes `invitation: { google, baikal }` instead
  of a single flag. `decideCalendarBridgeNewEvent` no longer blocks
  invitations.

## Still blocked

Alarms and non-default Google reminders, vendor properties (`X-…`, Google
`extendedProperties`, `colorId`, conference data, attachments), status other
than confirmed, transparency and class other than the defaults, and the
recurrence and time forms listed above. Such an event is blocked with the
reason `unsupported`. The field names (for example `alarms`, `X-…`,
`timezone`, `recurrence`, or `override:<key>:<field>` inside one instance)
are the keys of `unsupported` in the retained side snapshot, which #48 can
show. Content on the other side
is never overwritten while either side has unsupported data.

## Limits

Tested against in-process fakes only. The Google behaviors relied on (reading
a generated instance by instance ID, `iCalUID` listing returning exceptions,
normalization of written `recurrence` lines and time zones) need live
qualification in #50. A provider that rewrites an `RRULE` or zone name on
save will show as a readback mismatch (`uncertain`), not a loop, until
qualified.
