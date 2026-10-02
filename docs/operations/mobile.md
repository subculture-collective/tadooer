# Android app

The Android app is a Capacitor WebView around one Suite server (ADR 0049). It
adds a server setup page, `tadooer://` links, a share target and Back
handling. It keeps no tasks and no credentials of its own. Reminders reach
the phone through the ntfy app, as before.

No APK has been built from this project yet. The machine it was written on
has no Android SDK; see "What has not run" in
[ADR 0049](../adr/0049-mobile-shell.md). The first build on a machine with
the SDK is also the first time the Java sources are compiled.

## Versions

| Part                          | Version                                             |
| ----------------------------- | --------------------------------------------------- |
| Capacitor (core, CLI, android) | 8.5.2                                               |
| Minimum Android               | 7.0 (API 24)                                        |
| Target and compile SDK        | API 36                                              |
| Android Gradle plugin         | 8.13.0                                              |
| Gradle (wrapper)              | 8.14.3                                              |
| Java                          | 21                                                  |
| Application id                | `tv.subcult.tadooer` (owner choice; see below)      |

The SDK levels, the Gradle plugin and the wrapper are what the Capacitor
8.5.2 template sets (`apps/mobile/android/variables.gradle`).

## Prerequisites

- Node.js 24 and pnpm, as for the rest of the repository, and
  `pnpm install`.
- **JDK 21.** Capacitor 8 compiles for Java 21, and Gradle 8.14 does not run
  on a JDK newer than 24. Android Studio ships a suitable one. Set
  `JAVA_HOME` when the default `java` is another version.
- **Android SDK** with platform 36 and platform-tools: Android Studio
  2025.2.1 or newer, or the command-line tools with
  `sdkmanager "platform-tools" "platforms;android-36"`. Gradle fetches the
  build tools it needs once the SDK licences are accepted. Point the build at
  the SDK with `ANDROID_HOME`, or write `sdk.dir=<directory>` to
  `apps/mobile/android/local.properties` (not committed).
- Network access on the first build: the Gradle wrapper downloads Gradle
  8.14.3, and Gradle downloads the Android plugin and the AndroidX libraries.

`pnpm android:doctor` checks the SDK and the JDK and builds nothing. Every
build command runs the same check first and stops with the reason before
Gradle starts.

## Build

```sh
pnpm android:doctor     # SDK and JDK present?
pnpm android:debug      # debug APK
pnpm android:release    # release bundle (AAB) and release APK, unsigned
pnpm --filter @suite/mobile android:test   # Java unit tests
pnpm --filter @suite/mobile android:sync   # bundled pages only; needs no SDK
```

Each build command first runs `android:sync`: it builds the setup page and
the page bridge into `apps/mobile/www` and runs `cap sync android`, which
copies them into the Android project and rewrites
`android/capacitor.settings.gradle`. That file holds the path of
`@capacitor/android` inside `node_modules` and is the reason `pnpm install`
has to come first.

Outputs:

| Command           | File under `apps/mobile/android/app/build/outputs/` |
| ----------------- | --------------------------------------------------- |
| `android:debug`   | `apk/debug/app-debug.apk`                           |
| `android:release` | `bundle/release/app-release.aab`                    |
| `android:release` | `apk/release/app-release-unsigned.apk`              |

Install a debug APK on a connected phone with
`adb install -r apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk`.
A debug build is signed with the SDK's debug key and allows WebView
debugging from `chrome://inspect`. A release build does not.

## First run on a phone

1. Open the app and enter the server address. HTTPS works in every build.
2. Sign in. The session is the web app's cookie session.
3. To change the server later, long-press the launcher icon and choose
   "Change server". Android's "Clear storage" removes the address, the
   session and the offline cache.

To test against a development server on the build machine, forward its port
and use the phone's loopback address, which every build allows:

```sh
adb reverse tcp:8080 tcp:8080     # then connect to http://127.0.0.1:8080
```

Use `127.0.0.1`, not `localhost`; the app keeps that name for its setup page.

### A private address without HTTPS

Android fixes which hosts may be reached over plaintext HTTP when the APK is
built. The committed configuration allows `127.0.0.1` and nothing else. To
use a server at a private address (10/8, 172.16/12, 192.168/16, or a
Tailscale address in 100.64/10) without HTTPS:

```sh
pnpm --filter @suite/mobile android:cleartext 10.0.0.50   # one or more addresses
pnpm android:debug
pnpm --filter @suite/mobile android:cleartext             # show the current list
pnpm --filter @suite/mobile android:cleartext --reset     # back to the default
```

The script accepts private IPv4 addresses only and rewrites
`android/app/src/main/res/xml/network_security_config.xml`. Keep that change
out of commits; a repository test fails while the file differs from the
default. On the phone the setup page still asks for explicit consent, and the
server must set `SUITE_SECURE_COOKIES=false` for sign-in to work over HTTP.

For a server with HTTPS from a private certificate authority, install the CA
on the phone and build with
`pnpm --filter @suite/mobile android:cleartext --trust-user-ca`. Android apps
do not trust owner-installed authorities otherwise.

## Signing

The signing key is the owner's. It is never committed:
`apps/mobile/android/.gitignore` excludes `*.jks`, `*.keystore` and
`keystore.properties`, and no build file reads a password.

Create a key once and keep it, with its password, in the secret store used
for the rest of the deployment. Every later version must be signed with the
same key, or Android refuses the update and the owner has to uninstall, which
deletes the app's data.

```sh
keytool -genkeypair -v -keystore tadooer-release.jks -alias tadooer \
  -keyalg RSA -keysize 4096 -validity 10000
```

Sign the release APK with the SDK's `apksigner`, which asks for the password
instead of taking it on the command line:

```sh
cd apps/mobile/android/app/build/outputs/apk/release
"$ANDROID_HOME"/build-tools/<version>/zipalign -p 4 app-release-unsigned.apk tadooer-aligned.apk
"$ANDROID_HOME"/build-tools/<version>/apksigner sign --ks /path/to/tadooer-release.jks \
  --out tadooer-<version>.apk tadooer-aligned.apk
"$ANDROID_HOME"/build-tools/<version>/apksigner verify --print-certs tadooer-<version>.apk
```

A bundle for Play is signed with `jarsigner`; under Play App Signing that
signature is an upload key's and Google holds the app key. Capacitor's own `cap build android`
can build and sign in one step, but it takes the passwords as command-line
arguments or from `capacitor.config.json`; prefer the commands above.

Before a release, raise `versionCode` (an integer that must increase) and
`versionName` in `apps/mobile/android/app/build.gradle`.

## Distribution

These are owner choices; none is set up.

| Route    | What it needs                                                                                                                                                          | Notes                                                                                                         |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Sideload | The signed APK, copied to the phone or served from a private address; "Install unknown apps" allowed for the installing app                                            | Fits one owner. Updates are manual: install the newer APK over the old one.                                   |
| F-Droid  | Either a self-hosted F-Droid repository holding the signed APK, or inclusion in the main repository, which builds from source with their key and needs a public source | The app uses no Google service, which F-Droid requires. A build with a plaintext address cannot be published. |
| Play     | A developer account, an AAB, Play App Signing, a privacy declaration and a listing                                                                                     | HTTPS-only build. The application id is permanent once published.                                             |

The application id `tv.subcult.tadooer` is a default. Changing it means
changing `capacitor.config.json`, `android/app/build.gradle` (`namespace` and
`applicationId`), `strings.xml`, `shortcuts.xml`, the `CHANGE_SERVER` action
in the manifest and in `TadooerShellPlugin.java`, and the Java package. Decide
before the first APK leaves the build machine: a different id is a different
app with separate data.

## Updates

The web app updates with the server. A new APK is needed only when the shell
itself changes: its rules, the Capacitor version or the target SDK. The app
has no update check.

To update Capacitor, change the three exact versions in
`apps/mobile/package.json` together, run `pnpm install` and
`pnpm --filter @suite/mobile android:sync`, and review the diff of
`apps/mobile/android` against Capacitor's upgrade guide. `TadooerShellPlugin`
depends on three Capacitor internals that an upgrade can change: which
origins receive the bridge (`Bridge.setAllowedOriginRules`), the two
JavaScript interfaces it removes, and the plugin hook `shouldOverrideLoad`.

## Notifications and background

Reminders are delivered by the server through ntfy to the ntfy Android app
([`tadooer-production.md`](tadooer-production.md)). This app shows no
notifications of its own; ADR 0049 has the design for later.

The app syncs while it is open. Android suspends it in the background, and
nothing syncs until it is opened again.

## Icons

The launcher icons are rendered from `apps/web/public/suite-icon.svg` and
committed. After changing that icon, run
`pnpm --filter @suite/mobile icons` (needs `rsvg-convert`).

## What was generated and what was written

Generated by `cap add android` (Capacitor CLI 8.5.2) and committed as the
template leaves them: the Gradle wrapper, `gradle.properties`,
`settings.gradle`, `variables.gradle`, `capacitor.settings.gradle`,
`app/capacitor.build.gradle`, `app/proguard-rules.pro`,
`res/layout/activity_main.xml`, `res/xml/file_paths.xml`, the adaptive icon
XML and both `.gitignore` files (the keystore lines were enabled).

Generated, then edited by hand: `build.gradle` and `app/build.gradle` (Google
services plugin removed, `androidx.webkit` added, version name),
`AndroidManifest.xml`, `res/values/strings.xml`, `res/values/styles.xml`,
`res/values/ic_launcher_background.xml`.

Written by hand: the four Java sources under
`app/src/main/java/tv/subcult/tadooer`, the two under `app/src/test`,
`res/xml/shortcuts.xml`, `res/xml/data_extraction_rules.xml`,
`res/values/colors.xml`, `res/drawable/splash.xml` (replacing the template's
splash images). `res/xml/network_security_config.xml` is written by
`scripts/cleartext.mjs` and the launcher PNG files by
`scripts/generate-icons.mjs`.

## First-build checklist

On a machine with the SDK, in this order, and record the results on #117:

1. `pnpm install`, `pnpm android:doctor`.
2. `pnpm --filter @suite/mobile android:test`: compiles the Java sources and
   runs `ShellPolicyTest`.
3. `pnpm android:debug`, then install on a phone or an emulator.
4. Connect to the deployed instance, sign in, and check: Today, capture,
   focus and planner at the phone's width; Back; rotating the phone; the
   keyboard over the capture field and the time-block form.
5. With the desktop app or a browser open on the same instance, change a task
   there and time how long the phone takes to show it (the acceptance
   criterion of #117).
6. Share a page from the phone's browser to Tadooer; open
   `adb shell am start -a android.intent.action.VIEW -d "tadooer://open/today"`;
   try `tadooer://open/api/build`, which must do nothing.
7. Connect Google Calendar from Settings: the consent page must open in the
   browser, and the app must show the connection after switching back.
8. Turn on aeroplane mode, capture a task, turn it off, and check the task
   reaches the server.
9. Enter a wrong address and an unreachable one on the setup page; stop the
   server and reopen the app.
