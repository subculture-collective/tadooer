# Desktop app

The desktop app is an Electron window around one Suite server (ADR 0015). ADR
0047 lists what it may do beyond a browser tab: server setup, a tray, a single
instance, start at login, `tadooer://` links and native notifications. It keeps
no tasks and no credentials of its own.

## Build and check

```sh
pnpm package:desktop                               # bundle, archive, checksum
pnpm --filter @suite/desktop smoke:linux           # starts without a display
xvfb-run -a pnpm --filter @suite/desktop smoke:linux:shell
pnpm desktop:artifact                              # name, size, checksum
```

`package:desktop` writes three things to `apps/desktop/dist-packages/`:

- `Productivity Suite-linux-x64/`, the directory `@electron/packager` creates;
- `productivity-suite-desktop-<version>-linux-x64.tar.gz`, that directory
  under a name without spaces;
- `productivity-suite-desktop-<version>-linux-x64.tar.gz.sha256`, in the
  format `sha256sum -c` reads.

Set `SOURCE_DATE_EPOCH` to fix the file times inside the archive. Nothing is
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
`xvfb-run` is installed; otherwise it prints that the check was skipped.

## Release manifest

Run `pnpm desktop:artifact` after packaging. It recomputes the checksum,
compares it with the `.sha256` file and prints:

```json
{
  "artifact": "productivity-suite-desktop-0.1.0-linux-x64.tar.gz",
  "sha256": "<64 hexadecimal digits>",
  "bytes": 127000000,
  "desktopArtifact": "productivity-suite-desktop-0.1.0-linux-x64.tar.gz@sha256:<64 hexadecimal digits>"
}
```

Put the `desktopArtifact` string into the manifest field of the same name.
The schema in `release/manifest.schema.json` is unchanged: the field is still
one non-empty string, now holding the file name and its checksum in the same
`name@sha256:hex` form as an image reference.
`node apps/desktop/scripts/artifact-info.mjs --manifest-value` prints only that
string, which is how the Phase 8 gate fills its candidate manifest.

A release with packages for several platforms needs a decision on the manifest
(one string cannot name three files); that is part of the macOS and Windows
work below.

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

## Not done yet

- **macOS and Windows.** No packages, and none of the code has run there.
  Remaining work: packager targets and icons (`.icns`, `.ico`), a macOS menu in
  the platform layout, checking the `open-url` and second-instance paths for
  links, checking `setLoginItemSettings`, a tray icon in each platform's
  format, a self-check run per platform, and the manifest decision above.
- **Signing and notarisation.** Owner decision. Windows SmartScreen and macOS
  Gatekeeper will block or warn about unsigned builds.
- **Updates.** The app does not check for or download updates.
- **AppImage or deb.** Would also register the `tadooer://` scheme and an
  application menu entry at install time.
- **Reminder and focus notifications.** The shell can show a notification the
  page asks for (`window.tadooerDesktop.notify`), but the web app does not ask
  yet; that belongs to the notification wave.
- **Live-sync check against a disposable instance.** The window check uses a
  stand-in server. Issue #116 asks for a run against a real disposable Suite
  instance per platform.
