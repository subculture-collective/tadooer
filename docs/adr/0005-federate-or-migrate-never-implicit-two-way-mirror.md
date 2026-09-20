---
status: accepted
---

# Federate live calendars or migrate ownership without implicit two-way mirrors

September 20, 2026 amendment: the owner explicitly requested a Baikal-centered,
opt-in bidirectional bridge, with Google first. See the
[interview decision record](../discovery/2026-09-20-parity-assistants-calendar-hub.md).
The authority and failure contract is in [ADR 0017](0017-opt-in-baikal-calendar-hub.md).
That direction supersedes the restriction on an explicitly enabled two-way bridge
below. Existing federation remains in effect until qualification; implicit
mirroring is still not a default.

Give every calendar exactly one authoritative provider and show Baikal, Google,
and later qualified providers together in the unified React interface. Offer an
explicit, verified one-time migration into Baikal for users who want self-hosted
ownership, plus revocable read-only iCalendar publication where an external
product supports URL subscriptions. Do not mirror calendars bidirectionally by
default. Any later one-way mirror remains visibly source-owned, provenance-aware,
and read-only at its destination so recurrence, deletion, invitation, and update
conflicts cannot create two competing authorities.
