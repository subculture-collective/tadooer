# Tadooer

Here is the day. Your tasks sit beside the calendar, and you pick the one
thing you are doing now.

Tadooer is a self-hosted task and calendar planner for one owner. You run the
server, create the single owner account on first load and connect your own
calendars. There is no hosted service and no sign-up. It is in active
development: releases are `0.x` release candidates, and there is no stable
`1.0` yet.

The workspace packages and the container image still use the older name
`productivity-suite`.

![Today view with sample tasks](docs/design/screenshots/today-desktop.png)

More screenshots of the Planner, Tasks, Boards and phone layouts are in
[`docs/design/screenshots/`](docs/design/screenshots/).

## Features

- **Tasks:** capture, edit, complete, archive, soft-delete and restore tasks.
  Tasks have projects, tags, notes, estimates, deadlines, child tasks and
  checklists. Projects can keep a backlog.
- **Quick capture syntax:** `+project`, `#tag`, `@date`, `@every …`,
  `!deadline` and estimates such as `30m` are read from the task title. A
  pasted Markdown list becomes a previewed batch of tasks.
- **Views:** Today, Inbox, Tasks, Planner, Boards, Worklog, History, Habits
  and Counters, plus a phone layout.
- **Recurring tasks:** daily, weekly, monthly, yearly and interval rules that
  can be paused or ended.
- **Templates and choice pools:** reusable task templates and template sets,
  and pools of options Tadooer can pick from when you plan.
- **Calendars:** a bundled or existing [Baïkal](https://sabre.io/baikal/)
  CalDAV server holds calendar events. Tasks can be placed into calendar
  blocks; a block that changed elsewhere shows a conflict instead of being
  overwritten.
- **Google Calendar:** read calendar lists and events, with explicit write
  consent per calendar and an optional mapping between one Google calendar
  and one Baïkal calendar. Connected calendars show how fresh their data is.
- **Calendar import and feeds:** import ICS files or a Google Takeout export
  with a preview first. Publish revocable read-only ICS feeds, with a
  busy-only option that hides event details.
- **Focus sessions:** one server-side focus and break timer. Another device
  can follow it or explicitly take over.
- **Sync across devices:** the web app keeps a local cache in the browser.
  Core task edits can queue while a browser is briefly offline; calendar and
  focus commands need a connection. Open clients get live updates; a closed
  app catches up the next time it opens.
- **Issue import:** connect GitHub or Gitea repositories, import selected
  issues as tasks, refresh them and optionally write close or reopen back.
  See [`docs/operations/issue-sync.md`](docs/operations/issue-sync.md).
- **Super Productivity import:** preview and apply a Super Productivity
  backup.
- **Automation API:** separately scoped tokens, a preview-then-confirm API,
  an audit log, a local MCP (Model Context Protocol) stdio adapter and a
  quick-add command line tool.
- **Your data:** download everything as one JSON file from Settings and
  restore it after a preview. Connector credentials are encrypted at rest.
- **Clients:** the web app, a desktop app for Linux and macOS (Electron), and
  Android and iPhone shells (Capacitor) that open your own server.

Not included: multi-user accounts, PostgreSQL, background updates while the
app is closed, and offline calendar or focus changes.

## Quick start

You need Docker with Compose.

```bash
cp .env.example .env
docker compose up --detach --build --wait
./deploy/smoke.sh
```

Open `http://127.0.0.1:18080`, create the owner account and sign in. Baïkal's
admin page is at `http://127.0.0.1:18086/admin/`; create a Baïkal user there,
then enter its credentials in Tadooer. The full Baïkal setup is in
[`docs/operations/baikal-setup.md`](docs/operations/baikal-setup.md).

### Develop

You need Node.js 24 or later and pnpm 11.15.1.

```bash
pnpm install --frozen-lockfile
pnpm dev          # web app and server with reload
pnpm verify       # format check, lint, typecheck, tests and build
pnpm test         # Vitest only
./deploy/verify-compose.sh   # disposable Compose deployment check
```

Desktop and phone builds:

```bash
pnpm package:desktop          # Linux
pnpm package:desktop:mac      # macOS
pnpm android:doctor           # check the Android toolchain (JDK 21)
pnpm android:debug
```

[DEVELOPMENT.md](DEVELOPMENT.md) covers sync behavior, the browser test
suites and every verification script in detail.

## Configuration

With Docker Compose, `.env` sets only `SUITE_PORT`, `BAIKAL_PORT`,
`BAIKAL_ENDPOINT` and `SUITE_SECURE_COOKIES`, because `compose.yaml` passes
just those to the containers. Add any other server setting below to the
`environment` block of the `suite` service, for example in a
`compose.override.yaml`. Outside Compose, the server reads them from its
environment. The main settings:

| Variable                                      | Purpose                                                                             |
| --------------------------------------------- | ----------------------------------------------------------------------------------- |
| `SUITE_PORT`, `BAIKAL_PORT`                   | Loopback ports for Tadooer (default `18080`) and Baïkal (`18086`).                  |
| `BAIKAL_ENDPOINT`                             | CalDAV root Tadooer connects to. Defaults to the bundled Baïkal.                    |
| `SUITE_SECURE_COOKIES`                        | Set to `true` when Tadooer is served over HTTPS.                                    |
| `SUITE_PUBLIC_ORIGIN`                         | The public HTTPS origin of your deployment.                                         |
| `SUITE_TRUSTED_PROXY_CIDRS`                   | Reverse proxy host addresses (`/32` or `/128`) whose forwarded headers are trusted. |
| `SUITE_GITEA_ISSUE_ORIGINS`                   | Comma-separated HTTPS origins of Gitea servers allowed for issue import.            |
| `SUITE_DATABASE_PATH`                         | SQLite database path (in the image: `/data/suite.sqlite`).                          |
| `SUITE_CREDENTIAL_KEY_PATH`                   | Key file used to encrypt connector credentials.                                     |
| `GOOGLE_OAUTH_CONFIG_PATH`                    | Google OAuth client file. See `docs/operations/google-calendar.md`.                 |
| `SUITE_CALENDAR_BRIDGE_*`                     | Interval, concurrency and backoff for the Google–Baïkal bridge.                     |
| `SUITE_HOSTED_OAUTH_ENABLED` and related keys | Hosted MCP OAuth. Off by default; needs an HTTPS public origin.                     |

## Deploy

Tadooer runs as two containers: the app (Node.js, SQLite) and Baïkal. The
Compose file binds both to loopback, so put an HTTPS reverse proxy in front,
keep the original `Host` header and set `SUITE_SECURE_COOKIES=true`.

Data lives in three named volumes: `suite-data`, `baikal-specific` and
`baikal-config`. Back up and restore with:

```bash
./deploy/backup.sh                                     # Tadooer database and key
./deploy/restore.sh <database-backup-basename>
./deploy/backup-stack.sh /absolute/new/backup-directory  # all three volumes
./deploy/restore-stack.sh /absolute/backup-directory
```

Treat the backup directory as a secret: it holds the credential key, encrypted
connector data and Baïkal users. Release and rollback steps are in
[`docs/operations/release-and-rollback.md`](docs/operations/release-and-rollback.md).

## Project layout

```text
apps/server      HTTP API, auth, sync, calendar bridge (Node.js, SQLite)
apps/web         React planner
apps/desktop     Electron desktop app
apps/mobile      Android and iPhone shells (Capacitor)
apps/mcp-stdio   local MCP adapter
apps/quick-add   command line capture
apps/landing     static landing page
packages/        domain model, persistence, CalDAV, Google Calendar,
                 import/export and shared contracts
deploy/          smoke, backup, restore and verification scripts
docs/            ADRs, design rules and operations guides
```

## Contributing

- Report bugs and request features in [GitHub issues](https://github.com/subculture-collective/tadooer/issues).
- Ask questions and share ideas in [GitHub Discussions](https://github.com/subculture-collective/tadooer/discussions).
- Send code as a pull request on GitHub against `main`. CI runs `pnpm verify`
  (format check, lint, typecheck, tests and build) on every pull request, and
  it must pass before the pull request can merge.

## License

Original contributions are licensed under the GNU General Public License,
version 3 or later (`GPL-3.0-or-later`). See [LICENSE](LICENSE).
Third-party code, fonts and other assets keep their own licenses.
