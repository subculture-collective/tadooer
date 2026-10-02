---
status: accepted
---

# The phone app is the same shell: a WebView around the owner's origin

Roadmap #112, wave 7E (#117), resolving #24. Builds on ADR 0015 (a client is a
constrained shell around the deployed origin), ADR 0047 (what a shell may add)
and ADR 0045 (live sync is a hint stream held by the web app). Decided
2026-10-02. The owner chose Capacitor shells around the web app, Android
first.

This ADR records what was built and what was checked. Nothing in it has run on
a phone or an emulator: the machine it was written on has no Android SDK. The
section "What has not run" lists what that leaves open.

## Context

ADR 0015 left Android and iOS out because no decision existed on background
behaviour, offline storage and credential storage. Issue #24 asked for that
decision; issue #117 put three options to the owner:

1. Capacitor shells around the web app.
2. The installed PWA only.
3. Native or React Native apps.

The owner chose the first. The web app already has what a phone client needs:
an IndexedDB cache and outbox (ADR 0010, ADR 0033), the live hint stream (ADR
0045) and a cookie session. A second implementation of sync and of every view
(option 3) would be a second authority in practice. The installed PWA
(option 2) stays available and needs no shell, but it cannot register
`tadooer://`, it needs a secure context and so cannot serve an owner whose
server has only a private plaintext address, and its share target and storage
persistence depend on the browser that installed it.

The product rule is the one the desktop has. The shell has no private task
database, no alternate mutation path and no credentials of its own. The web
app runs inside the WebView unchanged.

## Decision

### How the shell reaches the owner's instance

Capacitor's usual arrangement is a web app bundled into the APK, or a
`server.url` fixed when the APK is built. Neither fits: the server address is
chosen per installation, as on the desktop. Three arrangements were
considered.

| Arrangement                                                                 | Result                                                                                                                                                                                                                                                                                 |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Build-time `server.url`                                                     | Rejected. One APK per server, and Capacitor gives its whole plugin bridge to that origin.                                                                                                                                                                                              |
| Run-time `server.url` or `allowNavigation` (a `CapConfig` built on start)   | Rejected. It works, but every origin in those lists receives Capacitor's bridge, and with it the built-in cookie, HTTP and WebView plugins. That is the privileged bridge ADR 0015 rules out.                                                                                          |
| Bundled setup page, then the origin loaded as an ordinary page (**chosen**) | The bundled page is the only content on Capacitor's own origin and the only caller of plugins. The Suite origin is in neither list, so Capacitor injects nothing into it. A plugin's `shouldOverrideLoad` lets the WebView load that one origin and refuses or redirects all the rest. |

So the WebView shows two things:

- **The setup page**, served by Capacitor from the APK at `https://localhost`.
  It is the desktop setup page: `setup.js` and `setup.css` are copied from
  `apps/desktop/src/setup` at build time, and the markup keeps their element
  ids. Its content security policy is `default-src 'none'` plus its own script
  and stylesheet.
- **The Suite origin**, loaded with `WebView.loadUrl` once an address is
  stored. Capacitor's bridge (`androidBridge`) and its document-start script
  are bound to `https://localhost` by origin rules, so the Suite page has
  neither.

### Server address

The rules are those of ADR 0047, from the same code
(`classifyServerAddress`, `checkServer` and `suiteBuildResponse` through
`@suite/shell-policy`):

1. an origin without credentials, path, query or fragment;
2. HTTPS, or HTTP to loopback, or HTTP to an IP literal in 10/8, 172.16/12,
   192.168/16 or 100.64/10 after the owner ticks the checkbox under the
   warning;
3. `GET /api/build` answers `service: "productivity-suite"`. The request is
   made by Capacitor's native HTTP client, because the setup page is on
   another origin and may be HTTPS while the server is not. It follows no
   redirect and sends no cookie: the shell removes the process-wide cookie
   handler that Capacitor installs.

The origin and the consent flag are then stored in app-private
`SharedPreferences` (`tadooer-shell`). Before storing, and again on every
start, the native side checks the origin with `ShellPolicy.classifyOrigin`.
That class accepts only the canonical form `URL.origin` produces and refuses
everything else, so a damaged preference file leads to the setup page.

Three differences from the desktop, all narrower:

- The host name `localhost` is refused. Capacitor serves the setup page under
  that name; `127.0.0.1` reaches the phone's own loopback.
- The only IPv6 literal accepted is `[::1]`. The network security
  configuration cannot name an IPv6 host, and the Java check keeps to
  addresses whose canonical form it can verify.
- There is no `SUITE_SERVER_URL`. A phone app has no environment.

The setup page opens on first start, from the launcher shortcut "Change
server", and when the stored server fails to load (Capacitor's `errorPath`).
In the last case it says so and offers "Try again".

### Navigation

`allowNavigation` is static and would hand over the bridge, so it stays
empty. The restriction is enforced in `TadooerShellPlugin`:

- **`shouldOverrideLoad`.** Capacitor's `WebViewClient` asks every plugin
  before the WebView follows a link or a redirect. The plugin lets a URL on
  the configured origin load, leaves Capacitor's own origin to Capacitor, and
  drops everything else. A dropped URL is not handed to another app, with one
  exception below.
- **A second check after commit.** `shouldOverrideUrlLoading` is not called
  for every load (a form post, for one). When a main-frame document commits
  or finishes on any other origin, the plugin stops it and returns to the
  configured origin, and to the setup page after three such events in a row.
  A foreign page that slips through has no bridge and no message channel,
  because both are bound to the configured origin.
- **Google OAuth.** `allowedExternalOAuth` is the desktop rule: exactly
  `https://accounts.google.com/o/oauth2/v2/auth` with an authorization-code
  request. That URL opens in the system browser. The return path is the
  server's: Google redirects the browser to
  `/api/connectors/google/callback`, which completes the grant from the
  `state` value and needs no session cookie. The owner then switches back to
  the app, which refetches when it becomes visible (ADR 0045). The browser is
  left on the Suite origin, where the owner is not signed in.
- **Back.** Back walks the web app's history while the previous entry is on
  the configured origin. At the start of that history the app moves to the
  background; the page is kept. History is cleared when the origin first
  loads, so Back never returns to the setup page.

Links to other sites, including `target="_blank"` links in task notes and
linked issues, do nothing. The desktop shell behaves the same way.

### Cookies and stored data

- The session cookie lives in the WebView's cookie store, inside the app's
  private data directory. It is `HttpOnly`, so no script reads it: not the
  Suite page, and not the setup page, whose only cookie plugin call reads
  `document.cookie` of the page that is showing. It has a `Max-Age`, which
  matters because Capacitor deletes cookies without an expiry on every start.
- The web app's IndexedDB cache, outbox, client registration and service
  worker cache live in the same directory, under the Suite origin. The shell
  never reads them.
- The app is excluded from Android backup and from device-to-device transfer
  (`allowBackup="false"`, `dataExtractionRules`), because that directory
  holds the session.
- The shell does not move the device credential into the Android Keystore.
  #117 listed that as an advantage of this option. It would need a bridge
  call that returns a secret to the page, which is the privileged bridge. The
  credential stays where the web app keeps it, protected by the app sandbox
  and the device's storage encryption. This is an owner decision to revisit
  with device sessions (#115).
- Changing the server does not clear the previous origin's data. Android's
  "Clear storage" for the app removes everything, including the stored
  address.
- Sign-in over a consented plaintext address needs a server whose session
  cookie is not `Secure` (`SUITE_SECURE_COOKIES=false`), as on the desktop.

### Plaintext HTTP

Android decides plaintext per host in the network security configuration,
which is fixed when the APK is built and has no address ranges. A run-time
consent box alone cannot open an address the build does not list. Two ways
were possible:

- permit plaintext for every host in the platform configuration and enforce
  the address rule in the app; or
- keep the platform default at "refused" and list the exact host at build
  time (**chosen**).

The committed `network_security_config.xml` refuses plaintext everywhere
except `127.0.0.1`. An owner whose server has a private address and no HTTPS
runs `pnpm --filter @suite/mobile android:cleartext <address>`, which accepts
only a private IPv4 literal, rebuilds, and still has to tick the consent box.
The setup page asks the platform (`NetworkSecurityPolicy`) before it contacts
a plaintext address and says when the build does not allow it. A published
build (F-Droid, Play) is therefore HTTPS only.

The cost is a rebuild when a plaintext server changes address. The gain is
that the operating system, not this app's code, refuses plaintext to every
other host, for the page, its subresources and the native check alike.

The same script can add owner-installed certificate authorities to the trust
anchors (`--trust-user-ca`), for a server behind a private CA. That is off by
default.

### The bridge

The web app's shell hook (`apps/web/src/desktop-shell.ts`) is the one ADR
0047 added. It now looks for `window.tadooerDesktop` or `window.tadooerMobile`
and treats them alike.

The Android shell injects `page-bridge.js` at document start, into the
configured origin only, in the top frame only. It defines
`window.tadooerMobile` with the desktop calls and one more:

| Call                                      | Effect on Android                                                          |
| ----------------------------------------- | -------------------------------------------------------------------------- |
| `reportStatus({ sync, live, conflicts })` | Validated and dropped. A phone has no tray.                                |
| `reportFocus({ state, phase, label })`    | Validated and dropped.                                                     |
| `notify({ title, body?, tag?, path? })`   | Validated; returns `false`, because nothing is shown (see Notifications).  |
| `ready()`                                 | Sends the string `ready` to the shell. The web app calls it once signed in. |

The validators are the desktop ones, bundled into the script.

Page to shell there is one message, the string `ready`, over a WebView
message channel (`tadooerShellNative`) that the platform binds to the
configured origin. Shell to page there is one message, a share (below). The
rules of ADR 0047 hold: no channel name chosen by the page, no generic send,
nothing written to disk or logged, and no call that reads a file, starts a
process, opens a URL, returns host information or changes a setting.

Capacitor's cookie and HTTP plugins each register a JavaScript interface that
every origin and frame could call. The shell removes both before any page
loads. On a WebView without origin-bound message listeners and document-start
scripts, Capacitor falls back to a bridge object visible to every origin; the
shell detects that, never opens a server and tells the owner to update
Android System WebView.

### Deep links

`tadooer://open/<path>` opens `<path>` on the configured origin, as on the
desktop. `ShellPolicy.deepLinkTarget` accepts a path, a query and a fragment
made of unreserved URL characters and refuses a host, credentials, a port,
`/api`, dot segments, encoded separators and any character a URL parser would
rewrite. It is stricter than the JavaScript `deepLinkTarget` and never looser
(see Shared policy). A link replayed from the recents list is ignored.

### Share target

The app accepts `text/plain` shares. The shell keeps the subject and the text
in memory, each cut to 8192 characters, for at most ten minutes. When the
page says `ready` it sends them over the channel. The injected script turns
them into one capture line (`shareCaptureText`: one line, the page title
before the address, at most 240 characters) and raises the desktop's
`tadooer:quick-capture` DOM event with the line in `detail.text`. The web
app's quick capture opens with the line in the title field, after anything
the owner had typed. Nothing submits it. The capture syntax of ADR 0031
applies to the line like to typed text, which is why the owner reviews it
first.

Shared text is never written to disk and is dropped if the app is not signed
in within the ten minutes.

### Notifications

How a reminder reaches the phone today: the server publishes to ntfy (ADR 0016) and the ntfy Android app shows it. That works with this app
installed, without it, and with it closed. Tapping the notification opens the
`Click` address, which is the Suite's web address, in the browser.

Native delivery is designed here and not built. `notify` exists in the bridge
and returns `false`.

- **While the app is in the foreground.** `notify` would send a second
  message type over the channel. The native side would validate it again with
  the limits of `parseNotificationRequest`, ask for `POST_NOTIFICATIONS` on
  Android 13 and later, post to one channel ("Reminders"), keep the desktop
  limit of six a minute, and attach a `PendingIntent` whose path goes through
  the deep-link check. This only covers what the page itself knows while it
  runs, such as a focus session ending. It adds one permission and nothing
  else.
- **While the app is in the background or closed.** Android suspends the
  WebView, so the page cannot notify. Something outside the page has to wake
  the phone. The candidates:

| Path                                    | Needs                                                                                                                                                                            | Cost                                                                                                                                               |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| The ntfy app (today)                    | Nothing new                                                                                                                                                                      | A second app; the notification carries ntfy's name; a tap opens the browser                                                                        |
| UnifiedPush, ntfy app as distributor    | A UnifiedPush receiver in the shell; a per-device endpoint registered with the server; the server publishing to that endpoint                                                    | New persistence and an API for device endpoints; the ntfy app is still installed, now as transport; the notification is Tadooer's and opens the app |
| Firebase Cloud Messaging                | A Firebase project, `google-services.json`, Play services on the phone, a Google credential on the server                                                                        | Reminder traffic depends on Google; no F-Droid build; a credential the self-hosted server does not have today                                      |
| A foreground service with its own socket | A permanent notification and a kept-alive connection                                                                                                                             | Battery, and it repeats what the ntfy app already does                                                                                             |

**Recommendation for the owner:** stay on the ntfy app, and do not add FCM.
ntfy already delivers, is self-hosted, and the reminder ledger of ADR 0016
depends on nothing else. Two later steps are worth their cost, in this order:
make the notification's `Click` address a `tadooer://open/...` link when the
owner wants a tap to open the app (a server setting, because desktop and
browser clients receive the same notification), and build the foreground
`notify` path with the notification wave. Move to UnifiedPush only if the
owner wants reminders to appear under Tadooer's own name; it keeps the ntfy
app as transport and needs the device-endpoint work above.

### Background behaviour

Stated plainly, per ADR 0045:

- The app syncs while it is in the foreground. The web app holds the hint
  stream and runs sync rounds exactly as in a browser tab.
- Android pauses the WebView's timers and network when the app goes to the
  background and may kill the process at any time. The stream closes. Nothing
  syncs while suspended, and nothing in this app claims to.
- When the app returns, the web app's visibility and focus triggers run a
  round and the stream reconnects; `hello` carries the feed head, so the
  client catches up at once.
- Changes made offline wait in the outbox, as in a browser.
- There is no background service, no periodic work and no boot receiver. The
  only permission is `INTERNET`.

### Phone layout

The web app's four daily screens (capture, Today, focus, planner) were
adjusted for widths of 360 to 430 px: long titles wrap instead of widening
the page, controls are at least 44 px on a coarse pointer, form text is 16 px
there so the page does not zoom on focus, the shell and overlays pad with
`env(safe-area-inset-*)` under `viewport-fit=cover`, and full-height layout
follows `100dvh` with `interactive-widget=resizes-content` so it shrinks when
the keyboard opens. The rules are described in
`docs/product/design-system.md`.

This was measured in headless Chromium with touch emulation at 360, 390 and
430 px, with emulated insets and a shortened viewport standing in for the
keyboard: no horizontal overflow, no control under 44 px and no input under
16 px on those screens. It has not been checked in an Android WebView. Inside
the shell, Capacitor passes the system insets to the page on WebView 140 and
later, and pads the WebView itself on older versions, where the page's insets
are 0.

### Updates

The web app updates with the server: a new server release is a new page and
service worker, with no new APK. The shell changes only when its own
capabilities change (the rules above, the Capacitor version, the target SDK).
There is no update check or download code in the shell. Capacitor's live
update storage is not used.

### Shared policy

`@suite/shell-policy` re-exports the pure validators of `apps/desktop/src`
(`policy.mjs`, `bridge.mjs`, `server-check.mjs`) and adds `shareCaptureText`.
The functions stay in the desktop package because the Electron bundle is
packaged from that directory alone; the package is the one place a second
shell imports them from. Desktop behaviour and the desktop tests are
unchanged. The mobile bundles alias `node:url` to the WebView's global `URL`.

The native side needs the rules where no JavaScript runs. `ShellPolicy.java`
is a second, stricter reading with no Android import.
`apps/mobile/src/android-policy.test.mjs` compiles it with a plain JDK and
runs it and the JavaScript over the same inputs. It fails when the Java
accepts something the JavaScript refuses or returns a different result. The
test is skipped where no JDK is installed, which includes the repository's
container check.

### Why each part keeps ADR 0015

| Capability    | No private database       | No credential                                | No alternate mutation path                  |
| ------------- | ------------------------- | -------------------------------------------- | ------------------------------------------- |
| Server setup  | Stores one origin, a flag | `/api/build` is public, sent without cookies | A read of build metadata only               |
| Bridge        | Nothing stored            | Carries none                                 | `ready` only                                |
| Share target  | Memory, ten minutes       | None                                         | The page fills its own capture field        |
| Deep links    | None                      | None                                         | A page navigation, never an API route       |
| OAuth handoff | None                      | None                                         | Opens Google's consent page in the browser  |

## Owner choices recorded as defaults

- **Application id `tv.subcult.tadooer`** and the name "Tadooer". The id is
  permanent once an APK is distributed: a different id is a different app
  with separate data. It appears in `capacitor.config.json`,
  `android/app/build.gradle`, `strings.xml`, `shortcuts.xml`, the manifest
  action and the Java package; a test checks they agree.
- **Signing key.** Owner-held, never committed.
- **Distribution**: sideload, F-Droid or Play (`docs/operations/mobile.md`).
- **iOS.** Not started. The policy package, the setup adapter and the page
  bridge are written to be reused; the native half is not.

## What has not run

Checked on the authoring machine, without an Android SDK: the Capacitor CLI
generated the Android project and `cap sync` copies the bundled pages into
it; the JavaScript tests; and the Java policy class, compiled and compared
with the JavaScript by the test above (JDK 26).

Not checked, because each needs the SDK or a device:

- `MainActivity.java`, `TadooerShellPlugin.java` and `ShellStore.java` have
  never been compiled. No Gradle task has run and no APK exists.
- Everything observable on a phone: the setup flow, sign-in, the navigation
  guard, Back, deep links, the share target, the OAuth handoff, the launcher
  shortcut, safe-area and keyboard behaviour, and live sync between a desktop
  and the phone (the acceptance criterion of #117).
- The qualification #24 asks for before a release: offline and reconnect,
  session expiry, notification delivery, upgrade and accessibility on a real
  device.

## Consequences

- One web app serves the browser, the desktop and the phone. A view fixed for
  phone widths is fixed in all three.
- The Suite page inside the app has less reach than Capacitor gives by
  default: no plugin, no native HTTP, no cookie interface.
- An instance behind a sign-on proxy on another origin does not work in the
  shell, because the redirect leaves the configured origin. The desktop has
  the same limit.
- Downloads started by the page (a data export) and file pickers are not
  handled by the shell and are untested.
- The status bar uses light icons. A light web theme would need the page to
  tell the shell, which the bridge does not carry.
- A plaintext private address needs a build that names it.
