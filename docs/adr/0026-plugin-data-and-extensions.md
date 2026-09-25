---
status: accepted
---

# Plugin data and extensions

Issue #66. Reference: Super Productivity 19.1.0 (`src/app/plugins`,
`plugin-persistence.model.ts`, `util/plugin-persistence-key.util.ts`,
`util/plugin-data-codec.ts`, `plugin.service.ts`,
`packages/plugin-api/src/types.ts`, the bundled plugins in
`packages/plugin-dev`).

The importer blocked every export that contained `pluginUserData` and
reported `pluginMetadata` as configuration. This decision keeps both as inert
records, inventories what Super Productivity plugins can do, and records that
Tadooer does not run imported plugins.

## Source inventory

**Plugin API.** A plugin is a manifest plus JavaScript, run in the renderer or
an iframe. It declares `hooks` and `permissions`. Its capabilities:

| Capability                   | Source API                                                                                                                                                                                                 |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Event hooks                  | `taskCreated`, `taskComplete`, `taskUpdate`, `taskDelete`, `anyTaskUpdate`, `currentTaskChange`, `finishDay`, `projectListUpdate`, `workContextChange`, `languageChange`, `persistedDataChanged`, `action` |
| Data access                  | Read, create, update, delete and reorder tasks; archived tasks; projects and tags; batch project updates; app state; counters; `dispatchAction` sends any store action                                     |
| UI injection                 | Header, menu, side panel and work-context buttons; shortcuts; a full-page or side-panel iframe view; dialogs, snack messages and notifications; a configuration handler                                    |
| Synced data                  | `persistDataSynced(data, key?)` and `loadSyncedData(key?)`: the `pluginUserData` section, synced and exported                                                                                              |
| Secrets                      | `setSecret`/`getSecret`: stored per device, never synced, exported or backed up                                                                                                                            |
| OAuth and network            | `startOAuthFlow`; `request` needs the `http` permission and an `allowedHosts` list                                                                                                                         |
| Node execution               | `executeNodeScript`: desktop only, `nodeExecution` permission, built-in plugins after user consent                                                                                                         |
| Issue and calendar providers | `registerIssueProvider`; manifest type `issueProvider`. GitHub, Gitea, ClickUp, Linear, Trello, Azure DevOps, Google Calendar and CalDAV are bundled plugins of this type                                  |
| Files                        | `downloadFile`                                                                                                                                                                                             |

**Export sections.** `pluginUserData` is an array of `{ id, data }`. `id` is
the plugin ID, or `pluginId:key` for a keyed entry; plugin IDs cannot contain
`:`, keys are at most 256 characters, and an empty key means the unkeyed entry.
`data` is the plugin's string, capped at 256 KiB per write before compression.
Values of 1,024 characters or more are normally stored as `GZ1:` followed by
base64 gzip; the reader accepts a stored value of up to 1 MiB characters. `pluginMetadata` is an array of
`{ id, isEnabled }`. Plugin code, manifests and uploaded plugin archives live in
the browser's `SUPPluginCache` IndexedDB and are not in the export. Neither are
secrets.

**September 24 backup (read-only, identity and size only).**
`2026-09-24_224532.json` has six `pluginMetadata` entries, all enabled:
`google-calendar-provider`, `brain-dump`, `caldav-calendar-provider`,
`super-productivity-mcp`, `gitea-issue-provider` and `github-issue-provider`.
It has one `pluginUserData` entry: `brain-dump`, unkeyed, 61 bytes,
uncompressed. No plugin data was copied into this repository.

## What Tadooer already covers

| Plugin use                                   | Tadooer equivalent                                                                                                                                         |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Assistant and automation access to tasks     | The automation catalog over HTTP and MCP stdio, with scoped tokens and preview/confirmation (ADR 0011); `super-productivity-mcp` is the source counterpart |
| Issue provider plugins (Gitea, GitHub, …)    | Imported issue links, read-only until a fresh provider authorization exists (ADR 0021, #30)                                                                |
| Calendar provider plugins (Google, CalDAV)   | Google and Baïkal federation (ADR 0005, ADR 0017); plugin calendar parity is #50                                                                           |
| Counters written by plugins                  | Counter and metric parity is #64                                                                                                                           |
| Notes such as `brain-dump`                   | Owner notes (ADR 0019); the plugin's own data is kept below                                                                                                |
| Hooks, UI injection, node execution, network | None. No plugin runtime                                                                                                                                    |

## Decision

### Tadooer does not run imported plugins

Tadooer imports no plugin code and never executes, evaluates, decodes, parses
or renders plugin data. An imported enabled flag does not install, load or
enable anything. Plugin hooks, UI injection, network access and node execution
have no Tadooer equivalent.

### Records

- **Plugin data entry.** Owner-scoped: plugin ID, key (null for the unkeyed
  entry), the value as opaque text up to 1 MiB of UTF-8, byte length, format
  (`text`, or `gzip_base64` when the value starts with `GZ1:`; only the prefix
  is read), source `super_productivity`, revision and import time. The value is
  stored as a JSON string literal, so every UTF-16 code unit survives,
  including lone surrogates and NUL. One entry per owner, plugin and key.
- **Plugin metadata record.** Owner-scoped: plugin ID, enabled flag, source,
  revision and import time. One per owner and plugin.
- Migration `0030_plugin_data` adds `plugin_data_entries` and
  `plugin_metadata_records`. Both are online-only: outside the sync change feed
  and the offline cache.

### Owner operations

- `GET /api/plugin-data` lists metadata and entries: IDs, keys, sizes, formats
  and flags, never values.
- `GET /api/plugin-data/entries/{id}` returns one entry with its value, for
  download. The browser saves it as `{ "id": "<pluginId[:key]>", "data":
"<value>" }`, the source entry shape, in a `.json` file. JSON escapes keep
  every code unit. The page never displays the value.
- `DELETE /api/plugin-data/entries/{id}` and
  `DELETE /api/plugin-data/plugins/{id}` delete permanently. They need the
  session, CSRF token and `If-Match` revision; the page asks for confirmation.
- There is no create or edit route. Records come only from an import.
- The view is **Imported plugin data** under Connections.

### Import

- `pluginUserData` and `pluginMetadata` apply. Their fields (`id`, `data`,
  `isEnabled`) are classified in `super-productivity-plugins.ts` and the parity
  manifest.
- These block apply with `plugin_data_invalid`: a section that is not a list,
  an entry that is not an object, an invalid plugin ID or key, a non-text value,
  a value over 1 MiB, a non-Boolean `isEnabled`, a repeated ID and an
  unreviewed field.
- A valid section adds a non-blocking `plugin_data_preserved` summary with
  counts and total size.
- Provenance is a `task_import_sources` row per entry (`plugin_user_data`) or
  plugin (`plugin_metadata`) holding the source ID, byte count and a SHA-256
  fingerprint of the stored value, never the value. A repeated import counts
  those records as existing, including records the owner has deleted, so
  deleted data is not restored. A changed value fails the whole import with
  the existing `IMPORT_SOURCE_CHANGED` rule.
- The apply response reports `pluginData: { created, existing }` when the
  export has plugin records.

### Content safety

Import findings, HTTP errors, audit rows, import provenance and server logs
never contain plugin values or keys. Findings name the plugin ID and entry
position. The listing API and the assistant listing carry sizes, not values.
Tests assert this with a marker value.

### Assistant

A new `plugin_data:read` scope grants `plugin_data.list` (MCP
`suite.plugin_data.list`), which returns the same listing as the browser.
There is no assistant read of values and no assistant delete. Existing tokens
do not gain the scope.

## Future option: a permissioned extension contract

This is a proposal, not a decision; the owner decision is tracked in #102.
Tadooer could later accept extensions under a contract such as:

- A manifest naming the extension, its version and each capability it needs:
  catalog operations and scopes, event subscriptions, a storage quota and any
  network hosts.
- Execution outside the web origin and server process, for example in a
  sandboxed worker or a separate process that holds only an automation token
  with the granted scopes. Mutations go through the existing preview and
  confirmation path and are audited like any automation actor.
- Server-side, owner-scoped extension storage with revisions, which the
  imported plugin data entries could seed.
- No arbitrary store actions, no node execution, no HTML injection into the
  application, and no network access beyond declared hosts.

Implementing any plugin runtime, including this contract, needs a separate
owner decision with its own threat model. Imported Super Productivity plugin
code would still not run unchanged: its API assumes the source application's
store and UI.

## Deferred

- Any plugin or extension runtime (above).
- Assistant reads of plugin values; export of plugin data in a Tadooer data
  export (#93).
- Mapping specific plugin data into Tadooer records, for example `brain-dump`
  text into notes. That needs a reviewed decoder per plugin.
