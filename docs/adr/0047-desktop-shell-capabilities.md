---
status: accepted
---

# The desktop shell gets host features, not data authority

Roadmap #112, wave 7D (#116). Builds on ADR 0015 (the desktop is a constrained
shell around the deployed origin) and ADR 0045 (the web app inside the shell
already holds the live sync stream). Decided 2026-10-02.

## Context

ADR 0015 shipped a window that loads one origin and nothing else. The origin
came from `SUITE_SERVER_URL` or a built-in loopback default, so an installed
copy could not be pointed at a real server without an environment variable.
The window also offered nothing a browser tab does not: no tray, no single
instance, no start at login, no links from other programs, no native
notifications.

ADR 0015 also says the desktop has "no private task database, CalDAV
credential, alternate mutation implementation, or privileged bridge". Tray
status and "Quick capture" need the page and the shell to exchange something,
so this ADR has to say what a bridge may carry without becoming the privileged
bridge that ADR 0015 rules out.

## Decision

The shell may add features of the host desktop. It may not hold owner data,
call the Suite API on the owner's behalf, or give the page access to the host.

### What the shell stores

One file, `shell-settings.json` in Electron's `userData` directory, written
through a temporary file and a rename with mode 0600:

| Field                 | Meaning                                                 |
| --------------------- | ------------------------------------------------------- |
| `serverOrigin`        | The origin to open, or `null` before setup              |
| `allowPrivateLanHttp` | The owner accepted plaintext HTTP for a private address |
| `closeToTray`         | Closing the window hides it instead of quitting         |
| `startAtLogin`        | The autostart entry is installed                        |

Unknown fields are dropped when the file is read or written, and the stored
origin is validated again on every start. The session cookie, IndexedDB and
the service worker cache stay where the web app put them, in Electron's
persisted partition `persist:suite-owner`. The shell never reads them.

### Server address

With no stored origin and no `SUITE_SERVER_URL`, the shell opens a bundled
setup page instead of the Suite. The page is three local files with a content
security policy of `default-src 'none'` plus its own script and stylesheet. It
runs in a separate in-memory session whose request filter cancels anything
outside its own directory.

An address is accepted when:

1. it is an origin without credentials, path, query or fragment;
2. it is HTTPS, or HTTP to loopback, or HTTP to an IP literal in a private
   range (10/8, 172.16/12, 192.168/16, 100.64/10, IPv6 fc00::/7) after the
   owner ticks a checkbox under a warning; and
3. `GET /api/build` on that origin, sent from the main process without
   cookies and without following redirects, returns `service:
"productivity-suite"`.

Plaintext HTTP to a host name is always refused, because the shell cannot tell
where a name resolves. 100.64/10 is included because Tailscale addresses live
there; the warning text is the same as for a LAN address. Sign-in over a
plaintext address also needs a server whose session cookie is not marked
`Secure` (`SUITE_SECURE_COOKIES`), so the choice has to be made on both
sides.

`SUITE_SERVER_URL` still takes precedence, accepts HTTPS and loopback HTTP
only, and disables the "Change server" menu item while set. The built-in
loopback default is gone.

### The bridge

A sandboxed preload script exposes `window.tadooerDesktop` in the Suite
window. Context isolation and the Chromium sandbox stay on and Node
integration stays off.

Page to shell:

| Call                                      | Effect in the shell     |
| ----------------------------------------- | ----------------------- |
| `reportStatus({ sync, live, conflicts })` | Tray status line        |
| `reportFocus({ state, phase, label })`    | Tray focus line         |
| `notify({ title, body?, tag?, path? })`   | One native notification |

`sync` is `signed-out`, `online`, `syncing` or `offline`; `live` is the ADR
0045 status; `conflicts` is an integer from 0 to 9999; `state` is `idle`,
`running` or `paused`; `phase` is `focus` or `break`; `label` is one line of at
most 120 characters. A notification has a title of at most 120 characters, a
body of at most 500, an optional tag and an optional application path that a
click opens. Each call returns `false` when its argument is rejected.

Shell to page: two DOM events on `window` with no payload,
`tadooer:quick-capture` and `tadooer:sync-now`. The page may ignore them.

Rules that keep this from being a privileged bridge:

- The channel names are constants in the preload. The page cannot name a
  channel, and there is no generic `send` or `invoke`.
- Each argument is validated in the preload and again in the main process
  with the same module (`apps/desktop/src/bridge.mjs`). Objects with unknown
  keys are rejected.
- The main process accepts a message only from the top frame of the Suite
  window while that frame is on the configured origin.
- Nothing the page sends is written to disk or logged. The status and the
  focus label are held in memory for the tray and dropped on navigation.
- Notifications are limited to six per minute. A notification path goes
  through the same check as a deep link before a click may navigate.
- No call reads a file, starts a process, opens a URL, returns host
  information or changes a setting.

The web app works without the bridge. `apps/web/src/desktop-shell.ts` detects
`window.tadooerDesktop` version 1 and otherwise attaches nothing.

### Host features

- **Single instance.** A second launch exits and the first window comes to
  the front. The self-check and the smoke mode do not take the lock.
- **Tray.** Show or hide, the status line, the focus line when a session is
  active, "Quick capture", "Sync now", Quit. Close-to-tray is off by default
  and is ignored on a desktop without a tray host.
- **Native notifications.** The origin is granted the `notifications`
  permission, and `notify` exists for the notification wave. The web app does
  not call either yet.
- **Permissions.** The Suite origin gets `notifications` and
  `clipboard-sanitized-write` (the existing "Copy" button). Every other
  permission request and check is denied, for every origin.
- **Start at login.** Opt-in. Linux writes
  `$XDG_CONFIG_HOME/autostart/tadooer-desktop.desktop` with a quoted `Exec`
  line and removes it when turned off. It is available in a packaged build
  only.
- **Deep links.** `tadooer://open/<path>` navigates the window to `<path>` on
  the configured origin. The link cannot carry a host, a scheme, credentials
  or a port; paths under `/api` are refused, so a link cannot replay an OAuth
  callback or fetch an export. Anything else is ignored and the window is
  only brought to the front.

### Why each one keeps ADR 0015

| Capability     | No private database | No credential                                | No alternate mutation path                  |
| -------------- | ------------------- | -------------------------------------------- | ------------------------------------------- |
| Server setup   | Stores one origin   | `/api/build` is public, sent without cookies | A read of build metadata only               |
| Bridge status  | Memory only         | Carries none                                 | Display only                                |
| Shell commands | None                | None                                         | The page runs its own capture and sync code |
| Notifications  | None                | None                                         | Display only; a click navigates             |
| Tray, instance | None                | None                                         | None                                        |
| Start at login | One desktop entry   | None                                         | None                                        |
| Deep links     | None                | None                                         | A page navigation, never an API route       |

Every write to owner data still goes through the web app's sync rounds and
HTTP calls, with the session, CSRF and client proof it already uses.

## Not decided here

These are owner decisions and are not implemented:

- **Auto-update.** No download or install code exists. An update check against
  the instance's release channel can be added in `createShell().start()`; it
  needs a decision on where artifacts are hosted and how they are verified.
- **Code signing and notarisation**, for any platform. The macOS section below
  records what is prepared for it.
- **The Windows package.** `setLoginItemSettings` and
  `setAsDefaultProtocolClient` are called outside Linux, but nothing has run on
  Windows.
- **AppImage or deb.** The Linux artifact is a tar.gz of the packaged
  directory, which the existing `@electron/packager` produces without new
  tooling.

## Consequences

- A fresh install asks for its server once and remembers it. Changing it later
  is a menu item.
- `ELECTRON_RUN_AS_NODE` and similar fuses are not hardened; that belongs
  with signing.
- The tray only shows live state while the window's page is loaded. With the
  window closed to the tray the page keeps running, so the stream of ADR 0045
  stays open; after Quit nothing is delivered.
- Deep links need the desktop entry registered by hand on Linux until an
  installable package format is chosen (`docs/operations/desktop.md`).
- The window self-check needs a display. Electron 43 crashes when it creates a
  window on Chromium's headless Ozone platform, so the check uses a real or
  virtual X or Wayland display.

## macOS (added 2026-10-02)

The owner decided on 2026-10-02 to package for macOS as well as Linux. Code
signing and notarisation were not decided, so the macOS package is unsigned and
signing is a separate later step. The capability boundary above is unchanged:
the same shell code runs, with the platform differences listed here.

Nothing in this section has run on a Mac. The bundles are built and inspected
on Linux, the platform decisions are unit-tested as data
(`apps/desktop/src/platform.mjs`), and the first launch is the manual checklist
in `docs/operations/desktop.md`.

### Package

- **Two artifacts, one per architecture**:
  `productivity-suite-desktop-<version>-darwin-arm64.zip` and `-darwin-x64.zip`,
  each a zip of `Productivity Suite.app` with a `.sha256` file, written by the
  same artifact script as the Linux tar.gz. A universal build was rejected for
  now: it needs `lipo`, and `@electron/universal` refuses to run on any host
  but macOS, while the build host is Linux. A Mac build step can add it later
  without changing the two existing names.
- **Bundle identifier `tv.subcult.tadooer`.** This is a proposal that the owner
  should confirm before the first signed release. macOS keys the login item,
  the notification and local-network permissions, the keychain entry and the
  notarisation record to it, so changing it later makes macOS treat the app as
  a new one.
- **Category** `public.app-category.productivity`. **Minimum system** macOS
  12.0, which Electron 43 sets.
- **`Info.plist` additions**: `CFBundleURLTypes` for the `tadooer` scheme;
  `LSUIElement` false, so the app has a Dock icon and a menu bar and the status
  item is an addition; `NSLocalNetworkUsageDescription`, the text macOS 15
  shows before it lets an app connect to a private address.
- **Icon.** `mac/icon.icns` is generated from `apps/web/public/suite-icon.svg`
  with `rsvg-convert` and a container writer in the repository
  (`scripts/icns.mjs`), because no `.icns` tool is installed on the build host
  and none was to be added. The artwork is drawn at 824 of 1024 pixels, the
  proportion of Apple's icon grid. The menu-bar item uses
  `assets/trayTemplate.png` and `@2x`, the glyph in black with transparency.

Electron's own `Info.plist` also carries usage texts for the camera, the
microphone, audio capture and Bluetooth. They grant nothing: the permission
policy above denies those requests before Chromium asks the system, and the
prepared entitlements do not include them.

### Behaviour that differs from Linux

| Area               | macOS behaviour                                                                                                                                                                                                                                                                                |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Last window closes | The app keeps running. A Dock click (`activate`) shows the hidden window, or opens the Suite window, or the setup window when no server is stored.                                                                                                                                             |
| Menu bar           | The platform layout: application menu (About, Change server…, Close to menu bar, Start at login, Services, Hide, Quit), File (Quick capture, Sync now, Close Window), Edit, View, Window. Shortcuts come from Electron's roles and use Cmd. The shell defines no shortcut of its own on macOS. |
| Status item        | A template image. A click opens its menu; it does not toggle the window.                                                                                                                                                                                                                       |
| Links              | Declared in `Info.plist` and delivered through `open-url`. A link that starts the app arrives before `ready` and is held for the first window. A link that cannot be opened still brings the window forward.                                                                                   |
| Start at login     | `app.setLoginItemSettings`. The stored setting follows what `getLoginItemSettings` reports afterwards, because macOS may hold the request for approval.                                                                                                                                        |
| Single instance    | Launch Services already keeps one instance for Finder, Dock and link launches; the lock covers a start from a terminal.                                                                                                                                                                        |
| Settings file      | `~/Library/Application Support/Productivity Suite/shell-settings.json`, from Electron's `userData`.                                                                                                                                                                                            |
| Close to menu bar  | Hides the window, leaving full screen first.                                                                                                                                                                                                                                                   |

### What unsigned means

- **Gatekeeper** stops the first launch of a downloaded copy until the owner
  allows it by hand. The steps are in the operations document.
- **No automatic update.** Electron's macOS updater installs an update only
  when its code signature satisfies the running app's own, and an unsigned app
  has none to compare. Updating means replacing the app by hand.
- **Notifications may not appear.** Electron's documentation states that the
  macOS notification APIs need a code-signed app and that unsigned builds do
  not deliver to Notification Center. Whether the ad hoc signature described
  below is enough is not known; the checklist records the result.
- **Permissions do not carry over between builds.** Without a signing
  identity macOS has no stable way to recognise the next build as the same
  app, so it can ask again for the local network, notifications, the login
  item and the keychain entry that protects the session cookies.

In the 0.1.0 build with Electron 43.3.0, every arm64 executable carries the ad
hoc signature the linker adds (it covers the code, names no one, and seals
neither `Info.plist` nor the resources), and the x64 executables carry no
signature. Apple silicon refuses arm64 code with no signature at all, so the
packaging step fails if a later Electron ships arm64 without one.

### Prepared for signing

- `mac/entitlements.mac.plist` for the application: `cs.allow-jit`, which V8
  needs under the hardened runtime, and `network.client`. The second one only
  has an effect inside the App Sandbox, which a Developer ID build does not
  use; it is listed so that a later sandbox decision starts from the one
  resource the shell uses. `mac/entitlements.mac.helper.plist` for the helper
  processes: `cs.allow-jit` only. A test fails if either file gains a device,
  file, personal-information, Apple Events or library-validation entitlement.
- `scripts/mac-sign.mjs` is the hook where signing and notarisation go. It is
  not implemented. With `SUITE_MAC_SIGN` set it stops the build and names the
  missing variables, or says that signing needs macOS, or says that the step
  is not written. It never falls back to an unsigned artifact.
- No certificate, key, password or team identifier is in the repository.

### Release manifest

The schema is unchanged; `desktopArtifact` stays one string. Proposed
convention, to be confirmed by the owner: a release with one desktop artifact
records it as before (`<file>@sha256:<hex>`); a release with several records
the checksum index, `productivity-suite-desktop-<version>.sha256sums@sha256:<hex>`.
The index is a `sha256sum -c` file listing every artifact, sorted by name, so
its checksum pins all of them. `pnpm desktop:artifact` writes the index and
prints each artifact's own value beside the release value.

## Name (added 2026-10-02)

The product is called Tadooer (`docs/design/README.md`). Electron's
`productName` is `Tadooer`, so the packaged directory, the executable, the
`.app` bundle, `CFBundleName`, the application menu, the tray tooltip, the
notification title and the autostart `Name=` all say Tadooer, and the release
archives are `tadooer-desktop-<version>-<platform>-<arch>`; the checksum index
is `tadooer-desktop-<version>.sha256sums`. The bundle identifier
`tv.subcult.tadooer`, the `tadooer://` scheme, the settings file's
`application: "productivity-suite-desktop"` and the `service:
"productivity-suite"` check are identifiers and did not change. Because
Electron's `userData` path and the Safe Storage keychain entry follow the
name, a copy installed under the earlier name does not share settings or
session cookies with the renamed app. Earlier text in this document that
names `Productivity Suite.app` or `productivity-suite-desktop-…` describes the
packages before this date.
