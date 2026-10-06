---
status: accepted
---

# Explicit Google write consent and writable-calendar capability

Issue #36 (roadmap #15). Builds on the read-only Google federation (phase 3,
migration `0012_phase_3_google_federation`), the encrypted connectors of ADR
0007 and the bridge contract of ADR 0017, which requires "fresh Google write consent
and permission-aware adapters" before any Google write. This ADR covers the
consent and capability gate. Conditional create/update/delete adapters, error
classification and quota handling were subsequently added with the outbox in
#40. Real account qualification belongs to #50.

## Scopes

The default connection stays read-only:
`calendar.calendarlist.readonly` and `calendar.events.readonly`. Nothing in the
read flow requests, implies or keeps a write scope.

Write access adds exactly one scope, `https://www.googleapis.com/auth/calendar.events`.
It covers event create/update/delete on calendars the account can already
write, and nothing about calendar settings, ACLs or calendar creation.
`calendar.events.owned` was considered: it excludes calendars shared with
`writer` access, which the bridge must support, so it is not used. The broad
`calendar` scope is never requested.

## Consent flow

- `POST /api/connectors/google/authorize` accepts an optional
  `{ "access": "read" | "write" }` body; the default is `read`. The OAuth state
  row records the requested access, so the callback cannot be upgraded by
  editing the URL. The state is still stored only as a SHA-256 digest.
- A read request sends only the read scopes and does not set
  `include_granted_scopes`. Reconnecting read-only therefore does not carry a
  previously granted write scope into the new grant.
- A write request sends read scopes plus `calendar.events`, with
  `include_granted_scopes=true` and `prompt=consent`, from a separate owner
  action that names the effect before the browser opens.
- Google lets the owner untick individual scopes. The callback requires the
  read scopes in every flow. In a write flow a missing write scope is not an
  error: the read grant is stored and the redirect reports
  `?google=write-not-granted`.
- Write consent is recorded as `google_connectors.write_consent_at` only when
  the flow was a write request **and** the returned grant contains the write
  scope. Any later read-only authorization clears it; consent belongs to the
  grant that carried it.
- The owner can withdraw consent locally
  (`DELETE /api/connectors/google/write-consent`). Tadooer stops writing at
  once. Google still holds the scope until the owner disconnects (which
  revokes the grant) or removes it in the Google account; the UI says so.

## Calendar capability

Every sync already reads `calendarList`, including `accessRole`. The role is now
stored per discovered calendar in `google_calendar_capabilities`
(`reader`, `writer`, `owner`; `freeBusyReader` calendars remain excluded) with
the observation time, and refreshed on every successful discovery. A calendar
that disappears from discovery is pruned with its capability row.

A Google calendar is writable only when all of these hold:

| Check                                                                            | Source                         |
| -------------------------------------------------------------------------------- | ------------------------------ |
| Connector is `connected` or `stale` (not `reconnect_required`, not disconnected) | `google_connectors.state`      |
| Owner write consent is recorded                                                  | `write_consent_at`             |
| The current grant contains `calendar.events`                                     | stored granted scopes          |
| The last observed `accessRole` is `writer` or `owner`                            | `google_calendar_capabilities` |

`evaluateGoogleWriteCapability` in `@suite/google-calendar` is the single pure
decision; `GoogleConnectorService.writeCapability` feeds it stored state. The
refusal reasons are `not-connected`, `reconnect-required`, `consent-required`,
`scope-missing`, `role-unknown` and `read-only-calendar`.

## Write paths

Every write path to a Google calendar calls the gate before reserving work:
the task time-block route and the assistant `schedule.create_time_block`
preview and apply. A refused write returns 403 `GOOGLE_CALENDAR_NOT_WRITABLE`
with the reason and no reservation or provider call. Direct task time blocks
still return 409 `GOOGLE_WRITE_NOT_AVAILABLE` when the gate passes. The bridge
uses the conditional adapters added by #40 and calls the same gate when a
mapping is created and before every pass. Permission changes therefore block
before provider work is read or dispatched; pending work stays visible and
accepted state is preserved.

## Downgrade

- Token refresh responses carry the granted scopes. When a refresh omits the
  scope field, only the read scopes are assumed, never write. A narrowed grant
  replaces the stored scopes, and the status reports write consent as `lost`
  while `write_consent_at` stays recorded, so the loss is visible rather than
  silently reverting to "never asked".
- `invalid_grant` keeps the existing `reconnect_required` state; the gate
  refuses writes with `reconnect-required`, and projections are kept.
- A role narrowed from `writer`/`owner` to `reader` is stored on the next
  discovery and the calendar becomes read-only immediately.
- Disconnect revokes the grant and deletes the connector row, consent and
  capability rows with it.

## Status contract

`GET /api/connectors/google` adds:

- `write`: `{ consent: "none" | "granted" | "lost", consentedAt, scopeGranted }`.
- `capabilities`: per calendar `{ calendarId, accessRole, writable, reason }`,
  where `reason` is the gate's refusal reason or `null`.

The Connections page shows the consent state, a separate "Allow event changes"
action with its effect, withdrawal, a lost-access warning and a per-calendar
"Writable" or "Read only" label with the reason.

## Persistence

Migration `0044_google_write_consent` adds `requested_access` to
`google_oauth_states`, `write_consent_at` to `google_connectors` and the
`google_calendar_capabilities` table. Existing connectors start with no write
consent and unknown roles until their next sync. Rollback to an older binary
keeps working: it ignores the new column and table and cannot write to Google.

## Evidence and open work

Package, persistence, server and web tests use the existing Google fetch fakes
only. No real Google account was available. #50 must still qualify, on a
disposable owner-controlled calendar: the real consent screen with granular
scope choices, the returned `scope` strings on exchange and refresh, role
changes by sharing a calendar as reader and writer, revocation from the Google
account, and `calendar.events` behavior on shared `writer` calendars. No
production Google write is enabled by this change.
