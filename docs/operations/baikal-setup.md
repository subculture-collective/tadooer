# Baikal setup for the calendar hub

The Suite reaches Baikal only through the CalDAV endpoint in its server
configuration (`BAIKAL_ENDPOINT`). An owner cannot enter a different origin in
the browser. Two setups are supported, and both are qualified against the
pinned upstream image `ckulka/baikal:0.10.1-nginx@sha256:434bdd16…`
([ADR 0039](../adr/0039-baikal-setup-qualification.md)):

- **Bundled**: the Suite's Compose file runs Baikal beside it.
- **Existing instance**: the Suite connects to a Baikal you already run.

Production on `nuc` currently uses the existing NUC Baikal
([tadooer-production.md](tadooer-production.md)). Nothing in this document
changes that deployment unless an operator chooses the bundled profile.

Every command below reads passwords from owner-only files and never prints
them. Keep those files outside the repository, mode 0600, and delete them
after use or move them into the existing secret store.

```sh
umask 077
node deploy/baikal-setup.mjs generate-password /secure/path/baikal-admin.pw
node deploy/baikal-setup.mjs generate-password /secure/path/baikal-dav.pw
```

## Bundled Baikal

### Local and development Compose

`compose.yaml` already bundles Baikal with a health check and the
`baikal-specific` and `baikal-config` named volumes. After
`docker compose up --detach --build --wait`:

```sh
node deploy/baikal-setup.mjs health http://127.0.0.1:18086
BAIKAL_ADMIN_PASSWORD_FILE=/secure/path/baikal-admin.pw \
BAIKAL_DAV_PASSWORD_FILE=/secure/path/baikal-dav.pw \
BAIKAL_DAV_USERNAME=tadooer \
  node deploy/baikal-setup.mjs bootstrap http://127.0.0.1:18086
```

`health` reports `"initialized":false` before the first bootstrap, because
Baikal redirects every route to its installer. `bootstrap` runs the
installer (SQLite, UTC, Basic DAV authentication), creates the DAV user, and
checks its default calendar through CalDAV. Running it again reports
`"installed":false,"userCreated":false` and changes nothing. If the DAV user
already exists with another password, it stops with a message telling you to
reset the password in Baikal's admin interface.

### Production Compose profile

`deploy/production/compose.yaml` has an opt-in `baikal-bundled` service in
the `bundled-baikal` profile. It keeps Baikal's authoritative data on bind
mounts under `TADOOER_BAIKAL_DATA_ROOT` (default
`/srv/apps/productivity/data/tadooer-baikal`, with `specific/` and `config/`)
and publishes the admin interface only on `127.0.0.1:18086`. The Suite
reaches it over the project-private `tadooer-baikal` network. The service is
not named `baikal`, so it cannot shadow the existing Baikal on the shared
`productivity` network.

To choose it, add to the Compose environment file:

```sh
BAIKAL_ENDPOINT=http://baikal-bundled/dav.php/
```

then start with `docker compose --profile bundled-baikal up -d --wait` and run
`health` and `bootstrap` against `http://127.0.0.1:18086` from the host. The
qualification rendered this profile but did not start it on `nuc`; check the
bind-mount directories' ownership on the first start.

## Existing Baikal instance

1. Create a dedicated DAV user in Baikal's admin interface (Users and
   resources), or run `bootstrap` against the instance with its admin
   password file. The Baikal admin account cannot sign in to CalDAV.
2. Set `BAIKAL_ENDPOINT` to the instance's `/dav.php/` address, exactly as the
   Suite reaches it: correct scheme, host and port, no credentials, query or
   fragment. The Suite never follows redirects, so use the final address
   (for example `https://` when Baikal redirects plain HTTP).
3. For TLS with a private certificate authority, mount the CA certificate
   into the Suite container and set `NODE_EXTRA_CA_CERTS` to its path.
   Certificate verification is never disabled.
4. Restart the Suite, then check the connection before saving it: in the
   first-run form, enter the DAV username and password and choose **Check
   connection**. The probe lists every calendar with its supported items and
   whether the user can read and write it; only event calendars with write
   access can receive task blocks. It stores nothing.
5. Choose **Verify and connect** to save the encrypted credential.

Baikal must advertise calendar addresses on the same origin as
`BAIKAL_ENDPOINT`. If it reports another host (a misconfigured base URI or a
proxy that rewrites hosts), the Suite refuses the address rather than
contacting that host.

## Verify from the command line

`verify-suite` signs in as the owner and calls the same probe, connect and
status routes as the browser:

```sh
SUITE_OWNER_USERNAME=owner \
SUITE_OWNER_PASSWORD_FILE=/secure/path/suite-owner.pw \
BAIKAL_DAV_USERNAME=tadooer \
BAIKAL_DAV_PASSWORD_FILE=/secure/path/baikal-dav.pw \
  node deploy/baikal-setup.mjs verify-suite https://tadooer.subcult.tv
```

Set `SUITE_PROBE_ONLY=true` to check without saving, or
`SUITE_STATUS_ONLY=true` to read the saved connector. Output contains counts
only: CalDAV support, calendars, writable event calendars and connection
state.

## Setup failures

Each failure has one code and one message that names the next step. No
message contains the username, password or a response body.

| Code                           | Meaning and next step                                                                                                          |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `BAIKAL_AUTHENTICATION_FAILED` | Wrong DAV username or password, or the user was deleted or its password changed in Baikal. Check the user, then connect again. |
| `BAIKAL_PERMISSION_DENIED`     | Signed in, but Baikal denied access to the account's calendars. Check its permissions.                                         |
| `BAIKAL_ENDPOINT_NOT_FOUND`    | No CalDAV principal at the endpoint. Point `BAIKAL_ENDPOINT` at `/dav.php/`.                                                   |
| `BAIKAL_NOT_CALDAV`            | The endpoint did not answer as CalDAV, typically the admin path or site root.                                                  |
| `BAIKAL_CALDAV_DISABLED`       | WebDAV answered without CalDAV calendar access. Enable CalDAV in Baikal's settings.                                            |
| `BAIKAL_REDIRECTED`            | The endpoint redirected. Configure the final address.                                                                          |
| `BAIKAL_UNSAFE_URL`            | Baikal advertised an address on another origin. Fix its public host and port.                                                  |
| `BAIKAL_UNREACHABLE`           | Connection, DNS or TLS failure. Check host, port, network and certificate authority.                                           |
| `BAIKAL_SERVER_ERROR`          | Baikal returned a server error. Check the service health.                                                                      |
| `BAIKAL_RECONNECT_REQUIRED`    | The saved credential no longer matches the configured endpoint or credential key. Connect again.                               |

## Backup and restore

Baikal's `Specific/` directory (DAV SQLite database and resources) and
`config/` are authoritative. Back them up together with the Suite database
and its credential key: the Suite's calendar mappings and encrypted DAV
credential are useless without the matching Baikal data and key.

- Development Compose: `deploy/backup-stack.sh` and `deploy/restore-stack.sh`
  stop both services, copy all three volumes with SHA-256 checksums, and
  restore them into the selected project. The qualification gate reads the
  connector status back after a restore.
- Production bundled profile: after `deploy/production/backup.sh`, stop
  `baikal-bundled`, copy `specific/` and `config/` from
  `TADOOER_BAIKAL_DATA_ROOT` into the same backup set with checksums, and
  start it again. This procedure is documented, not scripted, and has not
  been run on `nuc`.
- Existing instance: keep using that instance's own backup, and record which
  Suite backup set pairs with it.

## Qualification

`pnpm verify:baikal-setup` runs `deploy/verify-baikal-setup.sh` against
disposable containers on loopback ports and removes them on exit. The dated
record is
[baikal-setup-qualification-2026-09-29.md](../testing/baikal-setup-qualification-2026-09-29.md).
