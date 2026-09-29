# Google Calendar operator setup

Phase 3 uses Google OAuth's web-server flow. The default connection requests
only calendar-list read access and event read access. Event write access
(`calendar.events`) is a separate, explicit owner step described in
[Optional write consent](#optional-write-consent) and
[ADR 0040](../adr/0040-google-write-consent.md); nothing requests it
implicitly. OAuth client configuration is operator-owned secret material; do not
commit it to this repository.

## Create the Google OAuth client

1. In a Google Cloud project, enable the Google Calendar API.
2. Configure the OAuth consent screen for the account(s) that will use this
   private Suite deployment. While the app remains in testing, add the owner as
   a test user.
3. Create a **Web application** OAuth client.
4. Add the exact redirect URI for the deployed Suite origin:

   - local Compose: `http://127.0.0.1:18080/api/connectors/google/callback`
   - production: `https://your-suite-origin.example/api/connectors/google/callback`

Google compares this URI exactly. Do not add a query, fragment, alternate path,
or trailing slash. Public deployments must use HTTPS; plaintext HTTP is accepted
by the Suite only for loopback hosts.

Create a local file outside the repository named `google-oauth.json`:

```json
{
  "clientId": "YOUR_CLIENT_ID.apps.googleusercontent.com",
  "clientSecret": "YOUR_CLIENT_SECRET",
  "redirectUri": "http://127.0.0.1:18080/api/connectors/google/callback"
}
```

Protect and install it without putting the secret in shell history:

```bash
chmod 600 /absolute/path/google-oauth.json
docker compose up --detach --build --wait
docker compose cp /absolute/path/google-oauth.json suite:/data/google-oauth.json
docker compose exec -u root suite sh -c \
  'chown node:node /data/google-oauth.json && chmod 600 /data/google-oauth.json'
docker compose restart suite
docker compose up --detach --wait
```

The server rejects symlinks, group/world-readable files, oversized files,
non-loopback HTTP redirect URIs, and redirect paths other than the callback
above. `GET /api/connectors/google` reports `configured: true` when the file is
accepted. It never returns the client secret or refresh grant.

## Authorize and qualify

Sign in to the Suite, open **Google Calendar and calm day**, and choose
**Connect Google Calendar**. The Suite first returns a short-lived, one-time
authorization link. Follow the second link in the system browser; this avoids
Google's embedded-user-agent restriction. The callback is bound to the owner by
a 256-bit state value whose digest, expiry, and consumed state are stored in
SQLite. It does not depend on the desktop browser sharing its session cookie
with the system browser.

After the callback:

1. Confirm the UI shows the expected Google account and calendars.
2. Confirm an existing Google event appears once in the Week plan beside a
   Baïkal event.
3. Add, change, and delete a harmless test Google event, choose **Sync Google
   now**, and confirm the projection changes without duplicates.
4. Confirm the per-calendar freshness label is current. Temporarily interrupt
   Google access and confirm the last safe projection becomes visibly stale.
5. Revoke the grant from the Google account, choose sync, and confirm the Suite
   asks to reconnect rather than silently treating the projection as current.
6. Reconnect, then choose **Disconnect Google**. Confirm Google calendars leave
   the planner while local tasks and Baïkal remain present.

These live checks are the credential-dependent evidence required before Phase 3
can be marked complete. `pnpm verify:phase3:foundation` proves the same protocol
and failure-state logic against deterministic provider responses, but does not
by itself claim a real Google grant or live provider compatibility.

## Live qualification record

Phase 3 completed its credential-dependent qualification on 2026-08-07 against
a real owner grant using the loopback Compose deployment and the scopes stated
above. The content-safe evidence was:

- OAuth state was consumed once; the connector identified the expected account,
  discovered 15 calendars, and reported every calendar projection current.
- The active seven-day window began with 25 Google events and 25 unique
  provider/calendar/event identities. A no-change incremental sync preserved
  those counts with zero duplicate identity groups.
- One temporary Baïkal event appeared beside the Google projection and was then
  removed; its event projection and task-block mapping both returned to zero.
- A disposable Google event moved the window to 26 events and 26 unique
  identities. Updating it retained the same one-way provider-identity digest
  and a single lifecycle row. Deleting it returned the window to 25 events and
  25 unique identities with no lifecycle row or duplicate group.
- Revoking the grant produced reconnect-required state and a visible last-safe,
  stale Week plan. Baïkal and a local task remained available.
- Reauthorization restored all 15 calendars to current. Suite-side disconnect
  then left zero active Google connectors, providers, and projections while the
  Baïkal provider and local task remained present.

This evidence qualifies the tested account, scopes, Google API behavior, pinned
Suite code, and loopback deployment at that date. It is not a claim of Google
write support, universal account compatibility, or a production-hosted OAuth
deployment.

## Optional write consent

Write access is opt-in per owner and is not needed for federation. To offer it,
add `https://www.googleapis.com/auth/calendar.events` to the OAuth consent
screen's scopes. Google classifies it as sensitive; a private deployment in
testing mode can use it for listed test users.

On Connections, a connected owner chooses **Allow event changes**. The Suite
states the effect, then returns a one-time link that asks Google for the read
scopes plus `calendar.events`. The requested access is stored with the state
digest, so the callback cannot be upgraded. Outcomes:

- Google grants the scope: write consent is recorded and the redirect is
  `/?google=write-granted`.
- The owner unticks the scope: the read connection is kept, no consent is
  recorded, and the redirect is `/?google=write-not-granted`.
- A later read-only **Reconnect** does not request or carry the write scope and
  clears recorded consent.

Each sync stores every calendar's Google `accessRole`. A calendar is writable
only with a live connection, recorded consent, the write scope in the current
grant and a `writer` or `owner` role. Connections shows **Writable** or **Read
only** with the reason. If Google narrows the grant or the role, the next sync
records it and consent shows as lost; `invalid_grant` still requires reconnect.

**Withdraw event changes** stops Suite writes immediately but leaves the scope
on Google's grant. Disconnect, or remove access in the Google account, to revoke
it at Google.

No Google write adapter is enabled yet. Time blocks aimed at a Google calendar
are refused: 403 `GOOGLE_CALENDAR_NOT_WRITABLE` when the gate fails, 409
`GOOGLE_WRITE_NOT_AVAILABLE` when it passes. Real-account qualification of the
consent screen, granular scope choices, refresh scopes, shared-calendar roles
and revocation is tracked in #50 and has not been performed.

## Secret lifecycle, backup, and revocation

The client secret stays in `/data/google-oauth.json`. The refresh grant is
AES-256-GCM encrypted in SQLite using `/data/credential.key`; access grants are
held only in memory. The normal `deploy/backup.sh` set includes the database,
credential key, and—when installed—the mode-0600 OAuth configuration. The full
stack-volume backup also includes all three. Protect these backups as secrets.

Disconnect attempts Google's revocation endpoint first, then removes local
Google provider state and encrypted credentials even if the remote request is
unavailable. Removing the OAuth configuration file disables authorization and
refresh, but it is not a substitute for revoking the grant or using the Suite's
disconnect control.

## Sync, resync, and session recovery

Connections provides **Sync Google now** for incremental updates and **Resync
Google Calendar** to reload calendars/events using the existing encrypted grant.
Resync sends `POST /api/connectors/google/sync` with `{ "full": true }` under the
same session, same-origin and CSRF protections. Existing clients may omit the
body for incremental sync. Each calendar replaces its projection transactionally
only after the complete fetch succeeds; a failed fetch retains the saved events.
Sync never writes to Google or requests new OAuth permissions.

Calendar actions first resume the current Tadooer session and use its current
CSRF token. If the session has expired, the UI returns to sign-in and explains
that the Google connection and saved work remain intact. The action is not
silently replayed after login. A revoked Google grant is a separate condition
and requires Google reconnection. Progress and completion appear on Connections;
disconnect updates the connector state before refreshing planner information.
If remote revocation fails, local disconnection still completes and the UI tells
the owner to remove access in their Google account if desired.

September 20 regression evidence: 186 tests and full repository verification
passed. An isolated server-backed browser with synthetic Google/CalDAV providers
verified full resync, session-expiry recovery without disconnection, login and
retry, and visible local disconnect when Google revocation returned 503.
