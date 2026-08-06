# Google Calendar OAuth and synchronization feasibility spike

**Status:** Research complete — implementation deferred to the Phase 3 Google
Calendar connector slice.  
**Research date:** 2026-08-05  
**Evidence policy:** Google first-party documentation only; links below were
checked on the research date.

## Decision

Google Calendar is feasible as a **server-managed, one-authority-per-calendar**
connector. The Phase 3 implementation should register a Google Cloud **Web
application** OAuth client and use the authorization-code flow at the Suite
server. The Suite backend receives the redirect, exchanges the code, and keeps
the resulting credentials out of browser storage. This matches Google’s flow
for applications that can protect confidential information and maintain server
state. [Google: OAuth 2.0 for web-server applications](https://developers.google.com/identity/protocols/oauth2/web-server)

This is not a request to implement Google OAuth in Phase 0. Phase 0 establishes
generic provider identity and API conventions; this spike records the future
Google credential-at-rest, projection/revision, and fixture requirements that
Phase 3 must implement. Until then, no production OAuth client, public redirect
URL, token, webhook, or Google calendar data is required.

## OAuth client and callback contract

- **Client type:** Google Cloud OAuth 2.0 *Web application*, with its client
  secret available only to the server. A SPA/browser-only token flow is not an
  acceptable replacement because this product needs a long-lived server-side
  connection.
- **Flow:** send the owner, in a normal full-featured browser, to Google’s
  authorization endpoint with `response_type=code`; use a high-entropy,
  one-time `state` value bound to the authenticated owner and pending connection;
  verify it before accepting the callback; exchange the code at the server.
  Google requires the redirect URI to exactly match the registered URI,
  including scheme, case, and trailing slash. [Google: web-server flow](https://developers.google.com/identity/protocols/oauth2/web-server)
- **Deployment:** production callbacks require an HTTPS, owner-controlled
  public origin registered in the OAuth client. The local Compose topology has
  no public TLS or routing and therefore is suitable only when its actual
  callback origin is registered for development; it must not invent a loopback
  callback for a hosted server. Google’s OAuth policy requires compliant web
  redirect URIs and JavaScript origins, including HTTPS, and forbids an
  embedded user-agent under the application’s control. [Google: OAuth policies](https://developers.google.com/identity/protocols/oauth2/policies)
- **Provider selection:** the callback must bind an authorization result to the
  pending Suite `ownerId` and a newly created stable Google `calendarProviderId`;
  it must not infer ownership from a process-global current user or merge it
  with Baïkal. Each discovered Google calendar remains Google-authoritative.

## Scopes and consent

Start read-only. The minimal initial projection needs
`https://www.googleapis.com/auth/calendar.calendarlist.readonly` to enumerate
subscribed calendars and
`https://www.googleapis.com/auth/calendar.events.readonly` to read events.
If Phase 3 needs only availability rather than event detail for a particular
operation, prefer `https://www.googleapis.com/auth/calendar.freebusy` or
`https://www.googleapis.com/auth/calendar.events.freebusy` as applicable.
Do not request broad `calendar` scope or write-capable `calendar.events` until a
later accepted task-to-event write contract specifically needs it. Google
recommends the narrowest scope possible; public applications using scopes that
access certain user data can require OAuth verification. [Google: Calendar API
scopes](https://developers.google.com/workspace/calendar/api/auth)

Request scopes in context and use `include_granted_scopes=true` only for a
subsequent, separately justified scope increase. The consent/result record must
persist the granted scopes, not merely the requested ones.

## Credential lifecycle and revocation

- Request `access_type=offline` because the server needs to update a projection
  while the owner is absent. Google returns a refresh token during the initial
  code exchange for offline access; use it to obtain short-lived access tokens
  at the token endpoint. [Google: offline access and refresh](https://developers.google.com/identity/protocols/oauth2/web-server)
- Store the refresh token, token metadata, granted scopes, Google subject/account
  identifier when available, and connector status encrypted at rest in the
  owner-scoped Suite database. The existing mode-0600 key/AEAD boundary is the
  design baseline. Do not return refresh tokens to the browser, logs, backups
  without the paired secret, or webhooks. Google explicitly recommends encrypted
  at-rest server token storage and a non-public datastore. [Google: OAuth best
  practices](https://developers.google.com/identity/protocols/oauth2/resources/best-practices)
- Treat `invalid_grant`, refresh-token expiry, and token revocation as a
  disconnected/re-authentication-required connector state. Preserve local
  task data; stop API calls and watches; surface the state and ask the owner to
  reconnect. Google notes that refresh tokens can be invalidated or expire and
  recommends handling revocation/expiration; its web-server flow identifies
  `invalid_grant` as requiring reauthentication. [Google: OAuth best
  practices](https://developers.google.com/identity/protocols/oauth2/resources/best-practices)
- An owner-initiated disconnect must revoke the Google grant with the OAuth
  revocation endpoint when possible, delete the encrypted token material,
  invalidate outstanding watches, and retain only a non-secret audit/status
  record needed to explain the disconnection. The operation must be idempotent:
  a failed remote revocation still removes Suite credentials and tells the owner
  what could not be confirmed.

## Calendar projection, revisions, and synchronization

The connector is a projection client, not a second calendar authority. Persist
provider/calendar/event external identities separately from Suite IDs; include
Google event `etag`, event status/deletion state, and a sync cursor in the
projection contract. The UI must display freshness and connector failure rather
than presenting stale projection data as live Google state.

Use Calendar API incremental synchronization as follows:

1. Run an initial, paginated `events.list` per selected calendar, using a fixed
   query shape, and persist `nextSyncToken` only after the final page.
2. For incremental runs, repeat the same query shape with the stored
   `syncToken`, process deleted entries, paginate with the same token, then
   atomically advance to the final `nextSyncToken`.
3. On HTTP `410 Gone`, discard that calendar’s projection and cursor and perform
   a new full synchronization. A `410` is expected token invalidation, not a
   reason to retry the old cursor indefinitely.

Google documents this full-then-incremental model, requires persistent sync
tokens, includes deletions in incremental results, restricts query parameters
when using a sync token, and directs clients to wipe/re-sync after `410`.
[Google: incremental synchronization](https://developers.google.com/workspace/calendar/api/guides/sync)

For live freshness, push notifications are an optimization that trigger a
follow-up incremental sync; they are not event payloads and cannot replace the
cursor. Each watch is tied to a user and resource, needs an HTTPS webhook with a
valid public certificate, has an expiry, and must be explicitly replaced before
expiry—there is no automatic renewal. Persist `channelId`, `resourceId`,
resource URI, expiry, and a non-secret routing/verification token. Validate the
incoming channel/resource headers before queuing a sync; never put OAuth tokens
in the channel token. [Google: push notifications](https://developers.google.com/workspace/calendar/api/guides/push)

Quota handling is part of the connector contract: Google currently enforces
per-minute project and per-user-per-project quotas, may impose operational
calendar limits, and recommends truncated exponential backoff with randomized
traffic. Notifications reduce polling but do not eliminate a periodic recovery
sync. Exact quota values are provider-controlled and must be rechecked before
production qualification. [Google: Calendar API usage limits](https://developers.google.com/workspace/calendar/api/guides/quota)

## Required Phase 3 acceptance evidence

- A real HTTPS deployment completes the browser-to-server callback with an
  exact registered redirect URI and rejects absent, expired, reused, or
  owner-mismatched `state`.
- The smallest read-only scope set discovers only the owner-authorized calendar
  list and projects selected calendars without credentials reaching browser
  responses or logs.
- A refresh succeeds after restart; simulated `invalid_grant`/revocation fails
  closed into visible reconnect-required status without deleting tasks.
- Fixture and disposable-account tests cover initial pagination, incremental
  updates/deletions, `410` full-resync, duplicate/out-of-order webhook delivery,
  channel renewal, quota backoff, and stale freshness.
- A connector disconnect stops watches, attempts grant revocation, removes local
  secret material even if the remote call fails, and preserves the audit result.

## Explicit deferrals

- Production Google OAuth registration, consent-screen publication, domain
  verification, and OAuth verification review.
- Google event writes, task-to-event mappings, recurrence mutation, or
  bidirectional mirroring. They need a separate authority, ETag/conflict, and
  safe external-write contract.
- Browser-only OAuth, service-account substitution for personal calendars, and
  native/mobile callback design.
- Watch/webhook operation in local-only Compose; it depends on public HTTPS
  ingress and a verified externally reachable receiver.

## Phase boundary

This spike resolves feasibility, not delivery. It supports Phase 0C by fixing
the future connector’s identity, credential, revision, and failure requirements
without opening a provider connection. Phase 3 may start its Google work only
after the stable provider/task contracts exist and an owner-controlled HTTPS
deployment origin is chosen. Phase 3 completion still requires an independent
live-account/disposable-calendar qualification against then-current Google
documentation and quota settings.
