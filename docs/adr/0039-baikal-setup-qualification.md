---
status: accepted
---

# Bundled and existing-instance Baikal setup qualification

Issue #35 (roadmap #15, Google/Baikal calendar hub). Builds on ADR 0002
(Baikal behind the CalDAV contract), ADR 0007 (server-side sessions and
encrypted connectors), ADR 0009 (bounded CalDAV planning) and ADR 0017 (the
bridge treats bundled and existing Baikal as equivalent CalDAV endpoints).

Before this change the development Compose file bundled a pinned Baikal, but
the production Compose file assumed the pre-existing NUC Baikal service, the
only setup driver was a test-only disposable script, and every connection
failure surfaced as one generic "could not be verified" message. An owner
pointing the Suite at an existing Baikal had no way to learn whether the
endpoint spoke CalDAV, which calendars the DAV user could write, or why a
connection was refused.

## Decision

### Bundled service in production

`deploy/production/compose.yaml` gains a `baikal-bundled` service behind the
Compose profile `bundled-baikal`. It is opt-in: the default deployment keeps
the existing NUC Baikal as the authoritative service and `BAIKAL_ENDPOINT`
keeps its default. The bundled service:

- uses the same immutable image digest as the development Compose file
  (`ckulka/baikal:0.10.1-nginx@sha256:434bdd16…`), so both paths are qualified
  against one upstream version;
- has the same HTTP health check as the development file; the Suite does not
  depend on it in Compose because the default deployment has no such service;
- keeps `Specific/` (authoritative DAV SQLite and resources) and `config/` on
  bind mounts under `/srv/apps/productivity/data/tadooer-baikal`, beside the
  Suite data directory, so the NUC backup job can include both;
- publishes its admin interface only on the NUC loopback
  (`127.0.0.1:18086`); Caddy does not route it;
- shares a project-private `tadooer-baikal` network with the Suite. The
  service name is deliberately not `baikal`, because the Suite also joins the
  shared `productivity` network where that name belongs to the existing
  service. Operators choosing the bundled path set
  `BAIKAL_ENDPOINT=http://baikal-bundled/dav.php/`.

### Bootstrap that never prints a secret

`deploy/baikal-setup.mjs bootstrap <baikal-url>` runs Baikal's installer when
the instance is uninitialized, signs in as `admin`, and creates the Suite DAV
user when it does not exist, so a rerun changes nothing. Passwords come from
mode-0600 regular files named by `BAIKAL_ADMIN_PASSWORD_FILE` and
`BAIKAL_DAV_PASSWORD_FILE` (looser modes are refused), or from the matching
environment variables for disposable runs; `generate-password <new-file>`
creates such a file without printing it. Output is JSON with the username,
calendar href, endpoint, `installed` and `userCreated`; no password, cookie or
CSRF token is written to stdout or stderr. `health` distinguishes an
uninitialized instance (every route redirects to the installer) from a ready
one (admin page 200, unauthenticated DAV 401). `verify-suite` signs in to the
Suite and runs the probe, connect and status routes below. The admin driver
moves from `deploy/baikal-disposable.mjs` into `deploy/baikal-admin.mjs`; the
disposable script keeps its command surface and imports the shared driver.

### Capability probe and actionable failures

`POST /api/connectors/baikal/probe` accepts the same `{username, password}`
body as connect, requires the owner session, same origin and CSRF token, and
persists nothing. It performs, in order:

1. an `OPTIONS` request to the configured endpoint and checks that the `DAV`
   header advertises `calendar-access` (RFC 4791 §5.1);
2. the existing three-step discovery (principal, calendar home, collections);
3. a `PROPFIND` of `current-user-privilege-set` (RFC 3744 §5.4) on each
   discovered calendar, reduced to `read`, `write` (write, write-content,
   bind, unbind) and the raw privilege names.

The response lists the endpoint, the DAV compliance classes, the principal and
calendar-home hrefs, each calendar with its privileges and a count of
writable event calendars. Explicit calendar selection for mappings remains
#40/#48; the probe supplies the evidence for it.

Connect, status and probe failures map one CalDAV reason to one error code
and one actionable message (`describeConnectorFailure` in
`apps/server/src/routes/shared.ts`): `BAIKAL_AUTHENTICATION_FAILED`,
`BAIKAL_PERMISSION_DENIED`, `BAIKAL_ENDPOINT_NOT_FOUND`, `BAIKAL_SERVER_ERROR`,
`BAIKAL_NOT_CALDAV`, `BAIKAL_CALDAV_DISABLED`, `BAIKAL_UNSAFE_URL`,
`BAIKAL_REDIRECTED`, `BAIKAL_UNREACHABLE` and `BAIKAL_RECONNECT_REQUIRED`.
These replace the generic `BAIKAL_VERIFICATION_FAILED` and
`BAIKAL_UNAVAILABLE` codes; HTTP statuses are unchanged. Messages name the next step (check the
DAV user, fix `BAIKAL_ENDPOINT`, install the CA certificate, fix Baikal's
base URI) and never include the username, password, request body or a remote
response body. The CalDAV package gains a distinct `redirected` reason so a
3xx answer is reported as a redirect instead of an unspecified protocol
error, and a `caldav-unsupported` reason for an endpoint whose `DAV` header
lacks `calendar-access`. The Suite still never follows redirects. Connect
remains discovery-only, so the capability check runs in the probe.

### Trust boundary

The endpoint stays a server configuration value (ADR 0009); browser-entered
origins remain unsupported. Every href Baikal advertises must stay on the
configured origin with no credentials, query or fragment, which bounds DNS
rebinding and SSRF to the operator's chosen host. TLS uses Node's default
certificate verification; a private certificate authority is installed with
`NODE_EXTRA_CA_CERTS` rather than by disabling verification. Credentials are
verified by Baikal on every request; revoking the DAV user in Baikal takes
effect on the next Suite request, which then reports
`BAIKAL_AUTHENTICATION_FAILED`. Changing `BAIKAL_ENDPOINT` or the credential
key makes the saved connector report `BAIKAL_RECONNECT_REQUIRED` until the
owner connects again.

### Qualification gate

`deploy/verify-baikal-setup.sh` (`pnpm verify:baikal-setup`) first renders
the production Compose file with and without the bundled profile and checks
that both Compose files pin the same image digest. It then starts the
development stack on disposable ports, asserts the bundled health check,
bootstraps twice through the new script with generated 0600 password files,
verifies the connector through the Suite API (wrong password, probe, connect,
status), restarts Baikal and reads the status back, and runs the full-stack
backup and restore before reading it back again. For the existing-instance
path it starts a separate Baikal container, bootstraps it, recreates the
Suite with `BAIKAL_ENDPOINT` pointing at it, and checks the endpoint-change,
wrong-password, connect, admin-path, unreachable-port and unresolvable-host
outcomes. It fails if a generated secret appears in its output or in the
Suite logs. Everything it creates is removed on exit. Results are recorded as counts and outcomes in
`docs/testing/baikal-setup-qualification-2026-09-25.md`.

## Consequences

- No persistence migration; the probe result is not stored.
- The web connect form shows the server's actionable message, the configured
  endpoint host instead of a fixed "Bundled Baikal" label, and a "Check
  connection" button that lists each calendar's supported items and access.
- Backup of the bundled production instance is documented in
  `docs/operations/baikal-setup.md` as a stop-copy-checksum procedure beside
  `deploy/production/backup.sh`; it is not yet scripted or live-qualified.
- Existing-instance qualification covers Baikal 0.10.1 (sabre/dav) over
  plain HTTP on a Docker network. TLS, private certificate authorities, real
  redirects, cross-origin hrefs and revocation are covered by the CalDAV fake
  and unit tests, not by a live instance. Other CalDAV servers are not
  claimed.
