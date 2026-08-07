---
status: accepted
---

# Import once, preserve source evidence, and publish read-only capabilities

Phase 7 implements the accepted federate-or-migrate decision without claiming
the deferred Phase 3 Google OAuth connector. Google-to-Baïkal migration accepts
an explicit Google Calendar ICS/Takeout export through the same source-adapter
contract as a generic ICS file. It is a one-time copy; no sync cursor, background
mirror, or competing write authority is created.

## Import uses a common preserved intermediate representation

An adapter turns a bounded source payload into items containing source kind,
external identity, UID, raw single-VEVENT iCalendar, and a reconciliation
analysis. Preview persists the input hash and report but performs no remote
write. It reports recurrence fields, attendees, alarms, unknown properties,
duplicates, malformed components, and unsupported source data. Raw VEVENT data
is retained so an accepted migration does not silently flatten recurrence or
discard invitation metadata.

Apply is owner-scoped, explicit, and idempotent. Each item receives a stable
destination href derived from the job and item identity. A durable item outcome
is recorded after a successful conditional CalDAV create. Retrying a completed
item or job never creates another destination resource. Partial remote
uncertainty is reported as reconciliation-required rather than success.

## Export and publication are different authorities

Authenticated export returns a point-in-time `text/calendar` file for one owned
calendar. Publication creates an opaque 256-bit capability whose secret is
returned once and stored only as a digest. The public URL supports GET/HEAD
only, emits `Cache-Control: private, no-store`, and always represents a
read-only subscription. Revocation is checked from SQLite on every request and
does not delete audit or calendar data.

The feed contains only the selected owner calendar and exposes no Suite session,
task, connector credential, or mutation route. It is never described as CalDAV
or writable synchronization.

## Mirror boundary

No one-way mirror is enabled in Phase 7. The documented decision remains
deferred until a specific client limitation is demonstrated and a separate
authority/reconciliation review is accepted.
