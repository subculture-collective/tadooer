# Baikal setup qualification — September 29, 2026

Issue [#35](https://git.subcult.tv/PatrickFanella/productivity-suite/issues/35),
[ADR 0039](../adr/0039-baikal-setup-qualification.md). Source: branch
`issue/35-wave6` on base `b22e3a6a2f5153c9067577720436e10b3d32f730`; the run
used the uncommitted change set that the issue #35 commit records. Upstream
image: `ckulka/baikal:0.10.1-nginx@sha256:434bdd162247cc6aa6f878c9b4dce6216e39e79526b980453b13812d5f8ebf4b`
for both bundled and existing instances.

## Environment

`deploy/verify-baikal-setup.sh` on Kvant, Docker 29.7.2. Compose project
`suite-baikal-setup-<pid>`: Suite on 127.0.0.1:18780, bundled Baikal on
127.0.0.1:18786, a separate "existing" Baikal container on 127.0.0.1:18787
joined to the project network as `existing-baikal`. Six credentials were
generated into a mode-0700 temporary directory as mode-0600 files; no
password appeared on a command line, in output or in Suite logs (the gate
checks both). All containers, volumes, the network and the credential
directory were removed on exit and confirmed absent afterwards. Production
(`nuc`) and its Baikal were not contacted.

Exploratory probes on September 25 against a separate disposable Baikal
(`127.0.0.1:18486`, since removed) recorded the response shapes the CalDAV
fake reproduces: the `DAV` header advertises `calendar-access`; the owner's
`current-user-privilege-set` has 12 privileges including `read`, `write`,
`write-content`, `bind` and `unbind`; the site root and `/admin/` answer
PROPFIND with 405; another user's calendar answers 404; a wrong password
answers 401.

## Results

Gate result: passed, 17 recorded checks, exit 0.

| Check                                  | Outcome                                                                                                                       |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Production Compose render              | Default: `suite` only. `bundled-baikal` profile: `suite` and `baikal-bundled`. Both Compose files pin the same digest.        |
| Bundled health, before bootstrap       | Compose health `healthy`; admin 302 to installer; `initialized: false`.                                                       |
| Bundled bootstrap                      | `installed: true`, `userCreated: true`; default calendar answered PROPFIND 207.                                               |
| Bundled bootstrap rerun                | `installed: false`, `userCreated: false`.                                                                                     |
| Bundled health, after bootstrap        | Admin 200; unauthenticated DAV 401.                                                                                           |
| Wrong DAV password via Suite probe     | HTTP 401 `BAIKAL_AUTHENTICATION_FAILED`; message without username.                                                            |
| Suite probe, connect, status           | `calendar-access` present; 1 calendar, 1 writable event calendar, privileges reported for 1; connected; 1 calendar in status. |
| Baikal restart                         | Saved connector status connected, 1 calendar.                                                                                 |
| Full-stack backup and restore          | Saved connector status connected, 1 calendar after restore.                                                                   |
| Existing instance bootstrap and health | `installed: true`, `userCreated: true`; admin 200, DAV 401.                                                                   |
| Endpoint changed to existing instance  | Saved connector: HTTP 409 `BAIKAL_RECONNECT_REQUIRED`.                                                                        |
| Existing, wrong DAV password           | HTTP 401 `BAIKAL_AUTHENTICATION_FAILED`.                                                                                      |
| Existing, probe, connect, status       | Same counts as bundled; connected.                                                                                            |
| Endpoint set to `/admin/`              | HTTP 502 `BAIKAL_NOT_CALDAV`.                                                                                                 |
| Endpoint on closed port 81             | HTTP 502 `BAIKAL_UNREACHABLE`.                                                                                                |
| Endpoint on unresolvable host          | HTTP 502 `BAIKAL_UNREACHABLE`.                                                                                                |

An earlier run of the gate on the same day stopped at the first health
check: a fresh Baikal redirects both `/admin/` and `/dav.php/` to its
installer, which the first `health` version treated as unhealthy. `health`
now reports that state as `initialized: false`, and the gate now fails
immediately when any recorded check fails.

## Automated tests with the CalDAV fake

`packages/test-support/src/caldav-fake.ts` reproduces the recorded Baikal
responses and checks Basic credentials on every request. With it:

- `packages/caldav/src/index.test.ts`: 6 probe tests covering per-calendar
  read/write/forbidden/unreported privileges, a WebDAV server without
  CalDAV, redirects on OPTIONS and PROPFIND, 401/405/transport failures, a
  cross-origin calendar href that is refused before any request leaves the
  origin, and RFC 3744 aggregate privileges.
- `apps/server/src/baikal-setup.test.ts`: 3 route tests covering the probe
  (CSRF required, nothing stored, password absent from responses and the
  database), one code and message per failure for probe and connect,
  revocation after connect (401), and an endpoint change (409) followed by a
  successful reconnect.
- `deploy/baikal-setup.test.mjs`: 2 tests for the 0600 secret-file guard and
  the bundled image digest parity.

## Not qualified here

- TLS, private certificate authorities, real redirects and cross-origin
  hrefs were exercised only with the fake; the live instances used plain
  HTTP on a Docker network.
- Live revocation (deleting the DAV user in Baikal) was not run; the fake
  covers the resulting 401.
- The production `bundled-baikal` profile was rendered, not started. Its
  bind-mount ownership and the documented production backup of
  `specific/` and `config/` are unverified.
- Conditional writes, sync-token support and recovery against both setups
  remain with #40 and #50 (ADR 0017). Explicit calendar selection for
  mappings remains with #40 and #48; the probe supplies per-calendar access.
- Only Baikal 0.10.1 was tested. No other CalDAV server is claimed.
