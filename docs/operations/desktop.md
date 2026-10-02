# Desktop app

The desktop app is an Electron window around one Suite server (ADR 0015). ADR
0047 lists what it may do beyond a browser tab: server setup, a tray, a single
instance, start at login, `tadooer://` links and native notifications. It keeps
no tasks and no credentials of its own.

It is packaged for Linux (x64) and macOS (Apple silicon and Intel). The macOS
package is unsigned and has not been started on a Mac yet; see "macOS smoke
run".

## Build and check

```sh
pnpm package:desktop                               # Linux: bundle, archive, checksum
pnpm --filter @suite/desktop smoke:linux           # starts without a display
xvfb-run -a pnpm --filter @suite/desktop smoke:linux:shell
pnpm package:desktop:mac                           # macOS: two bundles, zips, checksums
pnpm desktop:artifact                              # every artifact: name, size, checksum
```

All of these run on the Linux build host. `package:desktop` writes three things
to `apps/desktop/dist-packages/`:

- `Productivity Suite-linux-x64/`, the directory `@electron/packager` creates;
- `productivity-suite-desktop-<version>-linux-x64.tar.gz`, that directory
  under a name without spaces;
- `productivity-suite-desktop-<version>-linux-x64.tar.gz.sha256`, in the
  format `sha256sum -c` reads.

`package:desktop:mac` writes, for `arm64` (Apple silicon) and `x64` (Intel):

- `Productivity Suite-darwin-<arch>/Productivity Suite.app`;
- `productivity-suite-desktop-<version>-darwin-<arch>.zip`, holding the `.app`
  with its symbolic links stored as links;
- the matching `.zip.sha256`.

There are two zips and no universal build, because joining the two
architectures needs `lipo`, which exists only on macOS. The first macOS build
downloads Electron's two macOS archives into `~/.cache/electron`. The packager
prints a warning that it found no `.icon` file; that is the newer Icon Composer
format, and the `.icns` file is the one in use.

Set `SOURCE_DATE_EPOCH` to fix the file times inside the archives. Nothing is
signed.

`smoke:linux` checks that the executable starts, the application code loads and
both preload bundles are inside the package. It opens no window.

`smoke:linux:shell` opens hidden windows in a temporary profile against a
throwaway loopback server. It runs the real setup page, stores the address,
exercises the preload bridge in both directions, and checks the navigation
guard, deep links and the permission policy. It needs a display: use
`xvfb-run -a` on a machine without one. `--ozone-platform=headless` does not
work, because Electron 43 crashes when it creates a window there. The check
creates no tray, autostart entry or protocol registration and removes its
profile afterwards.

`pnpm verify:phase8` runs the first two and runs the window check when
`xvfb-run` is installed; otherwise it prints that the check was skipped. It
qualifies the Linux package only.

### What the macOS build checks, and what it cannot

A Linux host cannot start a macOS program. After packaging, `package:mac`
reads each bundle back and fails unless:

- `Info.plist` has the bundle identifier `tv.subcult.tadooer`, the version,
  the productivity category, `LSUIElement` false, the local-network text and
  exactly one URL scheme, `tadooer`;
- the executable is a Mach-O file of the expected architecture and is marked
  executable, and the arm64 one carries a code signature of some kind;
- the bundle's icon parses as the generated `.icns`;
- `app.asar` holds the shell's files, including both preload bundles and the
  menu-bar images, and no build script or test.

`pnpm --filter @suite/desktop check:mac` repeats this on existing bundles.
Everything about the running app is the checklist under "macOS smoke run".

### macOS build inputs

`apps/desktop/mac/icon.icns`, `assets/trayTemplate.png`,
`assets/trayTemplate@2x.png` and the two entitlements files are generated and
committed. `pnpm --filter @suite/desktop assets:mac` regenerates them. It
renders `apps/web/public/suite-icon.svg` with `rsvg-convert` (librsvg) and
writes the `.icns` container itself; no macOS tool is needed. Run it when the
artwork or the entitlements change.

The bundle identifier `tv.subcult.tadooer` is a proposal. Confirm or change it
(`macBundleId` in `apps/desktop/scripts/mac.mjs`) before the first signed
release; after that, changing it makes macOS treat the app as a different one.

## Release manifest

Run `pnpm desktop:artifact` after packaging. It recomputes every checksum,
compares each with its `.sha256` file and prints:

```json
{
  "artifacts": [
    {
      "artifact": "productivity-suite-desktop-0.1.0-linux-x64.tar.gz",
      "sha256": "<64 hexadecimal digits>",
      "bytes": 127000000,
      "desktopArtifact": "productivity-suite-desktop-0.1.0-linux-x64.tar.gz@sha256:<64 hexadecimal digits>"
    },
    {
      "artifact": "productivity-suite-desktop-0.1.0-darwin-arm64.zip",
      "sha256": "<64 hexadecimal digits>",
      "bytes": 121000000,
      "desktopArtifact": "productivity-suite-desktop-0.1.0-darwin-arm64.zip@sha256:<64 hexadecimal digits>"
    },
    {
      "artifact": "productivity-suite-desktop-0.1.0-darwin-x64.zip",
      "sha256": "<64 hexadecimal digits>",
      "bytes": 123000000,
      "desktopArtifact": "productivity-suite-desktop-0.1.0-darwin-x64.zip@sha256:<64 hexadecimal digits>"
    }
  ],
  "index": "productivity-suite-desktop-0.1.0.sha256sums",
  "desktopArtifact": "productivity-suite-desktop-0.1.0.sha256sums@sha256:<64 hexadecimal digits>"
}
```

It lists the artifacts of the current version that exist in
`apps/desktop/dist-packages/`. Put the top-level `desktopArtifact` string into
the manifest field of the same name.

The schema in `release/manifest.schema.json` is unchanged: the field is one
non-empty string in the `name@sha256:hex` form of an image reference. How it
names several files is a convention, proposed here and open to the owner's
confirmation:

- **One artifact** (a Linux-only release): the string names that archive and
  its checksum, as before. `index` is `null`.
- **Several artifacts**: the command writes
  `productivity-suite-desktop-<version>.sha256sums` beside them, a
  `sha256sum -c` file with one line per artifact sorted by file name. The
  string names that index and the checksum of the index. Because the index
  holds every artifact's checksum, the one string pins all of them.

To check a download against a manifest: compare the index's SHA-256 with the
manifest value, then run `sha256sum -c productivity-suite-desktop-<version>.sha256sums`
(on macOS, `shasum -a 256 -c`) in the directory with the artifacts. Publish the
index together with the artifacts.

`node apps/desktop/scripts/artifact-info.mjs --manifest-value` prints only the
release string. With a platform and an architecture
(`artifact-info.mjs linux x64 --manifest-value`) it reports that one artifact,
which is how the Phase 8 gate fills its candidate manifest.

## Install on Linux

Unpack the archive anywhere and start `Productivity Suite` inside it.

On the first start the app asks for the server address. It accepts:

- `https://` addresses;
- `http://` on this computer (`127.0.0.1`, `localhost`, `[::1]`);
- `http://` on a private IP address (10.x, 172.16–31.x, 192.168.x, 100.64–127.x
  and IPv6 unique local addresses in `fc00::/7`), after you tick the checkbox
  under the warning. A host name over plain `http://` is refused.

It then requests `/api/build` from that address and continues only when a
Suite server answers. The address is stored in
`~/.config/Productivity Suite/shell-settings.json` (mode 0600). Change it later
with **App → Change server…**. Setting `SUITE_SERVER_URL` overrides the stored
address for that run and disables the menu item.

**App → Close to tray** and **App → Start at login** are off by default. Start
at login writes `~/.config/autostart/tadooer-desktop.desktop` and removes it
when turned off.

### Links

`tadooer://open/<path>` opens `<path>` on the configured server, for example
`tadooer://open/today`. The tar.gz does not register the scheme. To register
it, create `~/.local/share/applications/tadooer-desktop.desktop`:

```ini
[Desktop Entry]
Type=Application
Name=Productivity Suite
Exec="/path/to/Productivity Suite" %u
Terminal=false
MimeType=x-scheme-handler/tadooer;
```

then run:

```sh
update-desktop-database ~/.local/share/applications
xdg-mime default tadooer-desktop.desktop x-scheme-handler/tadooer
```

## Install on macOS

The app needs macOS 12 or later. Use the `arm64` zip on Apple silicon and the
`x64` zip on an Intel Mac (Apple menu → About This Mac shows the chip).

1. Check the download:
   `shasum -a 256 -c productivity-suite-desktop-<version>-darwin-<arch>.zip.sha256`.
2. Double-click the zip and move `Productivity Suite.app` to `/Applications`.
3. Open it. The first time, Gatekeeper stops it; see the next section.

The server address rules are the same as on Linux. The settings file is
`~/Library/Application Support/Productivity Suite/shell-settings.json`; the
web app's session and offline data are in the same directory. The settings
are in the application menu (**Productivity Suite → Change server…**,
**Close to menu bar**, **Start at login**). Closing the window does not quit
the app: it stays in the Dock and the menu bar, and a click on the Dock icon
opens the window again. **Productivity Suite → Quit** or Cmd+Q ends it.

`tadooer://` links need no registration; the bundle declares the scheme.

### What an unsigned app means

The app carries no Apple Developer ID signature and is not notarised. That has
five consequences.

**Gatekeeper blocks the first launch.** A copy that arrived through a browser,
AirDrop or a chat program is marked as quarantined, and macOS refuses to open
it from a double-click.

- macOS 15 and later: the dialog says Apple could not verify that the app is
  free of malware. Choose **Done**, not **Move to Trash**. Open System Settings
  → Privacy & Security, scroll to Security, choose **Open Anyway** next to the
  app's name, and confirm with your password or Touch ID. The button is there
  for about an hour after the blocked attempt.
- macOS 12 to 14: Control-click the app in Finder, choose **Open**, then
  **Open** in the dialog.
- If the dialog instead says the app is damaged and should be moved to the
  Trash, the app is not damaged; that is how macOS reports a quarantined app
  whose signature it rejects. Remove the quarantine mark and, if it still
  refuses, sign the copy for this Mac only:

  ```sh
  xattr -dr com.apple.quarantine "/Applications/Productivity Suite.app"
  codesign --force --deep --sign - "/Applications/Productivity Suite.app"
  ```

  `--sign -` makes an ad hoc signature. It identifies no one and does not make
  the app trusted on another Mac.

macOS asks once per copy. A copy fetched with `scp` or `curl` has no
quarantine mark and normally opens without the prompt. Only bypass the prompt
for a zip whose checksum you have compared with the release.

**The app cannot update itself.** It has no update code, and unsigned it could
not have any: Electron's updater on macOS replaces the app only when the
update's code signature satisfies the running app's own, and an unsigned app
has none. To update, quit, replace the app in `/Applications` with the new one
and go through Gatekeeper again. The settings and the signed-in session are
outside the app and stay.

**Notifications may not arrive.** Electron's documentation says the macOS
notification APIs need a code-signed app and that unsigned builds do not
deliver to Notification Center. Step 7 of the smoke run records what happens.

**macOS may ask again after every update.** It recognises an app by its
signature. Without one, a replaced copy can look like a new app, so the
prompts for the local network, notifications, the login item and the keychain
entry "Productivity Suite Safe Storage" (which protects the session cookies)
can come back.

**Other people's Macs will show the same block.** This build is for the
owner's own machines.

On macOS 15 and later, the first connection to a server on a private address
brings a prompt to let the app find devices on the local network. Allow it;
without it the server check fails as unreachable. The setting is under System
Settings → Privacy & Security → Local Network.

## macOS smoke run

Nothing below has been run yet. Do it on a Mac with the zip for its chip,
against a disposable Suite instance that the Mac and a second device can both
reach, not against production. A server on a plain `http://` private address
also needs `SUITE_SECURE_COOKIES` off on that instance, or sign-in fails.

Record at the top: the macOS version, the chip, the zip's name and SHA-256,
how the zip reached the Mac (browser, AirDrop, `scp`), and the server address
form (HTTPS or private HTTP).

| #   | Do                                                                                                                                                                          | Expect                                                                                                                                                                                  | Record                                                                       |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 1   | `shasum -a 256 -c <zip>.sha256`, unzip, move the app to `/Applications`.                                                                                                    | `OK`; the app shows the Suite icon in Finder.                                                                                                                                           | Icon correct or generic.                                                     |
| 2   | Double-click the app, then follow "What an unsigned app means".                                                                                                             | A Gatekeeper block, then the app opens after **Open Anyway**.                                                                                                                           | The exact dialog text; which path opened it; whether `codesign` was used.    |
| 3   | In Terminal: `"/Applications/Productivity Suite.app/Contents/MacOS/Productivity Suite" --suite-smoke`                                                                       | One JSON line with `"preloads":true`, exit status 0.                                                                                                                                    | The line.                                                                    |
| 4   | First run: enter the instance's address in the setup window.                                                                                                                | A local-network prompt for a private address (macOS 15+); a refused address shows a reason; an accepted one opens the Suite. Sign in.                                                   | Prompts shown; the stored file's path and mode (`ls -l`), expected 0600.     |
| 5   | Menu bar and window: check the menus; copy and paste text with Cmd+C and Cmd+V; close the window with Cmd+W; click the Dock icon; press Cmd+Q and start again.              | Menus: Productivity Suite, File, Edit, View, Window. The app stays running without a window, the Dock click reopens it still signed in, Cmd+Q quits.                                    | Anything missing or misplaced.                                               |
| 6   | Status item: find it in the menu bar in light and dark appearance; open its menu; use **Hide window**, **Show window**, **Quick capture**, **Sync now**.                    | A monochrome glyph that follows the menu bar's colour. The status line reads `Synced · live` once signed in. Quick capture brings the window forward with the task title field focused. | A screenshot in each appearance; the status line.                            |
| 7   | Quit. Run `open -a "Productivity Suite" --args --suite-test-notification`.                                                                                                  | macOS may ask for permission first; then one notification titled Productivity Suite. A click on it brings the window forward.                                                           | Shown or not; whether System Settings → Notifications lists the app.         |
| 8   | Links: with the app running, `open "tadooer://open/today"`. Quit, then run the same command again. Then `open "tadooer://open/api/build"`.                                  | The window goes to Today both times, the second time from a cold start. The `/api` link only brings the window forward.                                                                 | Each result; whether macOS asked which app opens the link.                   |
| 9   | Turn on **Start at login**. Look at System Settings → General → Login Items & Extensions. Log out and in. Turn it off again.                                                | The app is listed and starts after login; the checkbox matches the list. macOS may ask for approval first, and the app then says so.                                                    | The list entry's label; any approval prompt; whether it started.             |
| 10  | Turn on **Close to menu bar**, close the window, wait a minute, reopen it from the status item. Repeat once from full screen.                                               | The window hides and returns without reloading; the status item kept its status line meanwhile.                                                                                         | Reload or not; any empty full-screen space left behind.                      |
| 11  | Live sync: sign in on a second device. Add a task on the Mac, then one on the other device. Complete one on each. Then turn the Mac's network off for a minute and back on. | Each change appears on the other device within a few seconds without a reload. Offline, the status line says so; afterwards it returns to `Synced · live` unaided.                      | Seconds per direction; the status lines seen; anything that needed a reload. |
| 12  | Optional, from a checkout on the Mac after `pnpm package:desktop:mac`: `pnpm --filter @suite/desktop smoke:mac:shell`.                                                      | `"selfcheck":"passed"` with twenty `ok` lines. The Dock shows the app briefly; no window appears.                                                                                       | The output line.                                                             |

Step 12 uses a temporary profile and removes it. It is the same window check
as on Linux and has not been run on macOS either.

When the run is done, quit the app, remove the login item if it is still
listed, and note any step whose result differed, with the dialog text. A step
that fails because the app is unsigned (2, 7, 9) is a finding for the signing
decision, not a defect to work around in the shell.

## Signing and notarising later

Not decided and not implemented. `apps/desktop/scripts/mac-sign.mjs` is the
hook: it runs for each bundle before the zip is made. Today, with
`SUITE_MAC_SIGN=1`, it stops the build with the names of the missing variables,
or with the statement that the step is not written.

### What Apple requires first

1. Membership in the Apple Developer Program (individual or organisation, a
   yearly fee). The free account cannot create a Developer ID certificate.
2. A **Developer ID Application** certificate. On an organisation account the
   Account Holder creates it, or an Admin the holder has allowed to: make a certificate signing request in Keychain Access on the
   Mac, upload it under Certificates, IDs & Profiles on developer.apple.com,
   and install the result so that the private key is in the login keychain.
   `security find-identity -v -p codesigning` then lists
   `Developer ID Application: <name> (<team id>)`.
3. The ten-character Team ID.
4. A credential for the notary service, one of:
   - an App Store Connect API key (Users and Access → Integrations): the `.p8`
     file, which can be downloaded once, its Key ID and the Issuer ID;
   - the Apple ID with an app-specific password from account.apple.com.
5. A Mac with the Xcode command line tools (`xcode-select --install`).
   `codesign`, `notarytool` and `stapler` do not exist on Linux, so the signed
   build runs on the Mac, not on the Linux build host.
6. The final bundle identifier.

Keep all of it out of the repository. The hook reads names only:
`SUITE_MAC_SIGN_IDENTITY`, `APPLE_TEAM_ID`, and either `APPLE_API_KEY` (the
path of the `.p8` file), `APPLE_API_KEY_ID` and `APPLE_API_ISSUER`, or
`APPLE_ID` and `APPLE_APP_SPECIFIC_PASSWORD`. Prefer
`xcrun notarytool store-credentials`, which puts the notary credential in the
keychain, over variables in a shell profile.

### Steps

1. On the Mac: `pnpm install`, then `pnpm package:desktop:mac`. The packager
   builds the same bundles there.
2. Implement `afterPackage` in `mac-sign.mjs`: sign every helper, framework
   and the app with the hardened runtime and the prepared entitlements, then
   notarise and staple. `@electron/osx-sign` and `@electron/notarize` do this
   and are already installed as dependencies of the packager; add them as
   direct development dependencies to import them. `macSignOptionsForFile` in
   `scripts/mac.mjs` is the per-file option set: `hardenedRuntime: true`,
   `mac/entitlements.mac.plist` for the app and
   `mac/entitlements.mac.helper.plist` for everything inside it.
3. Check the signature before notarising:

   ```sh
   codesign --verify --deep --strict --verbose=2 "Productivity Suite.app"
   codesign --display --entitlements - "Productivity Suite.app"
   ```

4. Zip with `ditto -c -k --keepParent "Productivity Suite.app" <name>.zip`,
   submit with `xcrun notarytool submit <name>.zip --keychain-profile <profile> --wait`,
   then `xcrun stapler staple "Productivity Suite.app"` and make the zip again
   with `ditto`, so the released zip holds the stapled app. `package-artifact.mjs`
   uses `zip`, which is right for an unsigned bundle only; give it a `ditto`
   branch for macOS hosts.
5. Check the result as Gatekeeper will:
   `spctl --assess --type execute --verbose=4 "Productivity Suite.app"` should
   answer `accepted` with `source=Notarized Developer ID`.
6. Write the `.sha256` file for the new zip, run `pnpm desktop:artifact`, and
   repeat the smoke run. Steps 2, 7 and 9 are the ones signing should change.

Two decisions belong with this one: hardening Electron's fuses (ADR 0047,
Consequences), and whether to add an update check now that a signature would
let the app replace itself.

## Not done yet

- **A run on a Mac.** The macOS package is built and inspected on Linux. No
  part of it has been launched; the smoke run above is open.
- **Signing and notarisation.** Owner decision, for macOS and Windows.
- **A universal macOS build and a `.dmg`.** Both need a Mac.
- **Windows.** No package, and none of the code has run there. Remaining work:
  a packager target and an `.ico` icon, checking the second-instance path for
  links and `setLoginItemSettings`, a tray icon in the platform's format and a
  self-check run.
- **Updates.** The app does not check for or download updates.
- **AppImage or deb.** Would also register the `tadooer://` scheme and an
  application menu entry at install time.
- **Reminder and focus notifications.** The shell can show a notification the
  page asks for (`window.tadooerDesktop.notify`), but the web app does not ask
  yet; that belongs to the notification wave. `--suite-test-notification`
  shows one fixed notification at start, for checking delivery by hand.
- **Live-sync check against a disposable instance.** The window check uses a
  stand-in server. Issue #116 asks for a run against a real disposable Suite
  instance per platform; for macOS it is step 11 of the smoke run.
