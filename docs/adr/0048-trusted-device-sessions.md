---
status: accepted
---

# A trusted device keeps a rotating, revocable session for 30 days

Roadmap #112, wave 7C (#115). Changes the session lifetime of ADR 0007 for
devices the owner marks as trusted. Builds on ADR 0045 (live sync never counts
as owner activity) and ADR 0047 (the desktop shell keeps the web app's cookie
in its own persistent partition). Decided 2026-10-02.

## Context

A session ends after 30 idle minutes and after 12 hours at most (ADR 0007).
That suits a browser tab. A desktop app or a phone that should stay connected
for days cannot depend on it, and live sync deliberately does not extend a
session (ADR 0045).

## Owner decision, assumptions and defaults

Decided by the owner on 2026-10-02:

- A trusted device stays signed in for **30 days**.

The rest was proposed in issue #115. The owner did not contradict it and did
not confirm it either. All of it is implemented and can be changed in one
file, `apps/server/src/session-policy.ts`:

| Value                       | Setting                       | Status                                                                                   |
| --------------------------- | ----------------------------- | ---------------------------------------------------------------------------------------- |
| 30 days, sliding            | `trustedDevice.idleMs`        | Owner decision. Read as a sliding window: owner activity extends it.                     |
| 180 days, absolute          | `trustedDevice.absoluteMs`    | **Assumption.** The owner answered only "30 days". Remove or change the cap if unwanted. |
| 15 minutes, recent password | `recentPasswordMs`            | Default awaiting confirmation.                                                           |
| 30 minutes idle, 12 hours   | `browser`                     | Default awaiting confirmation: a browser keeps ADR 0007 unless marked as trusted.        |
| 24 hours, rotation interval | `tokenRotationIntervalMs`     | Implementation choice.                                                                   |
| 60 seconds, overlap         | `tokenRotationOverlapMs`      | Implementation choice, explained below.                                                  |
| 1 hour, reissue             | `tokenReissueAfterMs`         | Implementation choice, explained below.                                                  |
| 30 days, reuse record kept  | `tokenReuseRecordRetentionMs` | Implementation choice.                                                                   |

The 30-day figure is `trustedDeviceSessionDays` in
`packages/contracts/src/device-sessions.ts`, so the sign-in text and the
server read the same number.

## Decision

### Trust is chosen at sign-in, per device

The sign-in form has "Keep me signed in on this device for 30 days". It is off
by default in a browser and on by default inside the desktop shell. The choice
is sent as `trustDevice` with `POST /api/auth/login`.

- Without it the session is the browser session of ADR 0007, unchanged:
  30 minutes idle, 12 hours absolute, a token that never changes, a cookie
  with `Max-Age=43200`.
- With it the session is a **trusted-device session**: 30 days sliding,
  180 days absolute, a token that rotates.

A session cannot be upgraded later. To change the choice the owner signs out
and signs in again, which is a password entry in both directions. Signing in
again from a device that already holds a valid trusted session replaces that
session.

The cookie is the same `suite_session` cookie with `HttpOnly`,
`SameSite=Strict`, `Path=/` and `Secure` when `SUITE_SECURE_COOKIES` is set.
Its `Max-Age` is the time left until the session's absolute expiry (180 days
at sign-in), so it survives a browser or app restart. ADR 0007 already set
`Max-Age` to the absolute lifetime; the cookie was never a session cookie.
The server enforces the idle window; the cookie only has to outlive it.

### What extends the 30 days

Only owner activity: a request on which the route refreshes the session
(writes, `GET /api/auth/session` on app start) and which does not carry
`x-suite-sync-trigger: push`. Reads, the hint stream and requests started by
a hint or a background timer never extend it (ADR 0045). A device that is
left open but unused is signed out 30 days after its last use. No activity
extends the 180-day cap.

### Rotation and replay detection

A trusted device's token is replaced at most once every 24 hours, on an API
request that is not marked as hint-triggered and is not the hint stream. The
server sends the successor as a `Set-Cookie` on that response.

Three kinds of token can name a device session:

1. the **current** token, which the device is known to hold;
2. an **outstanding successor**, sent but not yet presented;
3. **retired** tokens, each with the time it was replaced.

Rules:

- The current token stays valid until the device presents the successor. A
  response that never arrives therefore cannot sign the device out. When a
  successor has been outstanding for an hour, the next request gets a new one
  and the old successor is retired.
- When the successor is presented it becomes the current token and the
  previous token is retired at that moment.
- A retired token is accepted for 60 seconds after it was retired, as the
  same session.
- A retired token presented later than that is a replay. The server cannot
  tell the device from a copy of its cookie, so it revokes the device session
  for both. The revoked device record is kept for 30 days with the reason
  `token-reuse`, Settings shows it as a warning, and the server logs
  `auth.device.token_reuse_detected` without identifiers.

**Why an overlap, and why 60 seconds.** A device sends requests in parallel:
several reads on start, a sync round, the stream. The one that carries the
successor back does not stop the others, which are already on their way with
the old token. Without an overlap, the first request with the new token would
make every such request a "replay" and sign the device out. The server
authenticates when the request headers arrive, so the window only has to
cover the time between the browser attaching a cookie and the server reading
it. Sixty seconds is far more than that on a slow connection and short
enough that a stolen old token is useless a minute after the device rotates.
The overlap starts when the device first presents the successor, not when the
successor was sent; counting from the send would turn a slow or lost response
into a false alarm.

The CSRF token is not rotated with the session token; it changes on
`GET /api/auth/session` as before.

### Device registry

A trusted-device session is its own device record: the `web_sessions` row
gets a `device_id`. Stored per device:

- a label, derived once from the `User-Agent` as "browser on system" (for
  example "Firefox on Linux", "Desktop app on Windows"); the owner can rename
  it. The user agent string itself is not stored;
- when it signed in, and when the owner last used it;
- the **family** of the last address it was used from, `ipv4` or `ipv6`. No
  address is stored: the code base stores none today (the login limiter keeps
  addresses in memory only), and the family is enough to notice an
  unfamiliar kind of network without keeping a location history;
- token digests (current, outstanding, retired), the CSRF digest, the
  expiries, the last password confirmation and, when revoked, the time and
  reason.

Every token is stored as a SHA-256 digest, as in ADR 0007.

The device record is separate from the sync client identity of ADR 0010.
That identity is created after sign-in and its credential lives in IndexedDB,
which page script can read, so it is not a basis for trust. Revoking a device
does not revoke its sync client; the client proof is useless without a
session.

Settings has a "Signed-in devices" card: the list, rename, "Sign out" per
device and "Sign out all other devices". Routes:

| Route                                    | Effect                                                         |
| ---------------------------------------- | -------------------------------------------------------------- |
| `GET /api/auth/devices`                  | Trusted devices and token-reuse records of the last 30 days    |
| `PATCH /api/auth/devices/{id}`           | Rename                                                         |
| `DELETE /api/auth/devices/{id}`          | Sign one device out; for the current device also clears cookie |
| `POST /api/auth/devices/sign-out-others` | Revoke every other session, ordinary browser sessions included |

The list shows trusted devices only. An ordinary browser session ends within
12 hours and has no record to name; "Sign out all other devices" still ends
it.

A revoked device fails authentication on its next request. Its live sync
stream ends with `bye: session-ended` at the hub's next check, which runs
after every mutating request and every two seconds (ADR 0045). The stream
looks its session up by device record, because the token it was opened with
may have rotated since.

### Recent password for sensitive actions

On a trusted-device session these routes need a password entry within the
last 15 minutes. Signing in counts.

| Area               | Routes                                                                                                                                           |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Baikal credentials | `PUT /api/connectors/baikal`                                                                                                                     |
| Google             | `POST /api/connectors/google/authorize` (read and write consent), `DELETE /api/connectors/google/write-consent`, `DELETE /api/connectors/google` |
| Assistant tokens   | `POST /api/automation/tokens`, `DELETE /api/automation/tokens/{id}`                                                                              |
| Calendar feeds     | `POST /api/calendar-feeds`                                                                                                                       |
| Data               | `GET /api/data/export`, `POST /api/data/restore/apply`                                                                                           |
| Device trust       | `DELETE /api/auth/devices/{id}` for another device, `POST /api/auth/devices/sign-out-others`                                                     |

Otherwise the route answers `403 REAUTHENTICATION_REQUIRED` before it reads
the body. `POST /api/auth/confirm-password` (session, same origin, CSRF token)
checks the password and stamps the session. The web app shows a password
dialog, confirms, and repeats the refused request once; concurrent refusals
share one dialog.

Not gated, on purpose:

- **Ordinary browser sessions.** They began with the password at most 12
  hours ago and end after 30 idle minutes, which is the exposure ADR 0007
  already accepted. The gate exists because a trusted device removes that
  limit.
- **Signing out the current device**, by either route. Ending access must
  never need a password.
- **Renaming a device**, the restore preview (it changes nothing), the Baikal
  credential probe (it stores nothing and uses no stored secret), revoking a
  calendar feed, and Google sync with the stored grant.
- **Password change and owner setup.** There is no password change route, and
  setup only works before an owner exists. A password change route must be
  gated when it is added, and should revoke all other sessions.

The confirmation route uses the sign-in rate limiter with the same key
(address and username): five failures in 15 minutes lock both sign-in and
confirmation for that address and username, and a failed confirmation counts
towards the sign-in lockout. A wrong password answers `403
INVALID_CREDENTIALS`, not 401, because the session is still valid.

### Shells

The desktop shell (ADR 0047) and the future mobile shell load the web app in
a persistent web partition and use this same cookie session. Nothing is
shell-specific: the shell never reads the cookie, and page script cannot,
because the cookie is `HttpOnly`. The only difference is that the trust box
is ticked by default inside the desktop shell.

Issue #115 proposed storing the device credential in the operating system
keychain. This decision does not do that. The credential is the cookie in
the web partition's cookie store. How that store is protected at rest is up
to the platform: Chromium-based shells normally encrypt it with a key from
the operating system's secret store when one is available, which was not
verified for the packaged app. A shell-held keychain credential would need a
second authentication path into the server and remains open.

### Storage

Migration `0051_trusted_device_sessions` adds the device columns to
`web_sessions` and the table `web_session_retired_tokens`. Both tables are
excluded from the owner data export (ADR 0034). Sessions that existed before
the migration are ordinary sessions.

At each sign-in the server deletes sessions that can no longer authenticate:
past the absolute expiry, a trusted device past its idle expiry, and revoked
sessions, except a `token-reuse` record younger than 30 days. Retired tokens
go with their session.

## Threat model

| Threat                               | What the controls do                                                                                                                                                                                                                                                                                                                            | What they do not do                                                                                                                                                                                                                                                               |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Stolen unlocked device**           | The thief can read and change tasks, notes and plans. The recent-password gate stops them from adding credentials or assistant tokens, creating feed addresses, exporting or restoring data and signing out the owner's other devices, unless the owner entered the password in the last 15 minutes. The owner revokes the device from another. | Owner data that the app shows is exposed until the device is revoked. Data already cached in IndexedDB stays on the device after revocation. A password entered minutes before the theft still satisfies the gate.                                                                |
| **Stolen cookie** (copied, not held) | `HttpOnly` keeps it from page script; `SameSite=Strict` and the CSRF token keep other sites from using it. After the next rotation the copy and the device hold different tokens: whichever presents a replaced token after the overlap gets the device revoked and the owner warned. The gate limits what the copy can do meanwhile.           | Until the device next rotates (up to 24 hours of use, longer while the device is idle) the copy works for ordinary reads and writes. A thief who keeps using the copy while the real device stays unused is detected only when the device returns or the owner looks at the list. |
| **Shared computer**                  | Trust is off by default in a browser, so the session ends after 30 idle minutes and 12 hours. The form says to tick the box only on a device the owner alone uses. Signing out revokes the session on the server and clears the cookie.                                                                                                         | If the owner ticks the box on a shared computer, the next user has the owner's account for up to 30 days, short of the gated actions. The fix is "Sign out" for that device from any other session.                                                                               |
| **Lost phone**                       | From any other signed-in device or a new sign-in: "Sign out" for the phone or "Sign out all other devices". The phone fails on its next request and its stream closes within about two seconds. A phone that is never used again signs itself out after 30 days.                                                                                | Revocation needs the phone to contact the server; the copy of tasks and notes in its local cache stays readable to someone who unlocks the phone. Remote wipe is out of scope.                                                                                                    |

General limits:

- A stolen password defeats every control here. There is no second factor.
- The rate limiter is in memory and per process; a restart clears it.
- A malicious browser extension or a compromised device operates as the
  owner while the owner uses it.

## Consequences

- A desktop app or a phone signs in once and stays signed in while it is used
  at least every 30 days, for up to 180 days.
- Every API request that carries a session cookie costs one extra indexed
  lookup, to decide whether a rotation is due.
- A client that ignores `Set-Cookie` keeps working on its first token and is
  sent a new successor at most once an hour; each unused successor leaves one
  retired digest until the session ends.
- Session recovery after an expiry offers the same trust choice as the
  sign-in form.

## Alternatives considered

- **A separate refresh token and short access token.** The usual shape for
  native clients, but it needs token storage outside the cookie, a second
  authentication path for the stream and shell code on every platform. One
  rotating cookie gives the same replay detection with the paths that exist.
- **Count the overlap from when the successor was sent.** Simpler state, but
  a lost or slow response would sign the device out and raise a false
  security warning, which is likely on a phone.
- **Store the full last address.** More useful for spotting a foreign
  sign-in, but it is a location history the suite does not otherwise keep.
- **Gate ordinary sessions too.** Uniform, but it would prompt on a session
  that is at most 12 hours old and changes behaviour ADR 0007 settled.
