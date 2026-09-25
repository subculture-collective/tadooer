---
status: accepted
---

# Linked issues and task attachments

Issue #30. Reference: Super Productivity 19.1.0 (`issue/issue.model.ts`,
`tasks/task.model.ts` `IssueFieldsForTask`,
`tasks/task-attachment/task-attachment.model.ts`,
`core/drop-paste-input/drop-paste.model.ts`, the Gitea plugin in
`packages/plugin-dev/gitea-issue-provider`).

## Source inventory

**Task issue fields.** `issueId`, `issueProviderId` and `issueType` identify
one external issue per task. `issueType` is a provider key: built-in `JIRA`,
`GITLAB`, `CALDAV`, `ICAL`, `OPEN_PROJECT`, `REDMINE`, `NEXTCLOUD_DECK`,
`PLAINSPACE`; migrated to plugins `GITHUB`, `CLICKUP`, `GITEA`, `LINEAR`,
`TRELLO`, `AZURE_DEVOPS`; or `plugin:<id>`. The source notes that `issueId` is
not unique across providers. Last-synced state: `issueWasUpdated`,
`issueLastUpdated` (epoch ms), `issueAttachmentNr`, `issueTimeTracked`,
`issuePoints`, `issueLastSyncedValues`.

**Provider instances.** `issueProvider` entities hold `id`,
`issueProviderKey`, polling and default-project settings, and provider
configuration: tokens, passwords, user names, CalDAV and iCal URLs, Gitea
`host`/`repoFullname`. Super Productivity builds a Gitea issue address as
`<host>/<repoFullname>/issues/<issueId>`. Other providers need live
configuration or an API call to produce an address.

**Attachments.** `task.attachments` is a list of `{ id, type, title, path,
icon, originalImgPath }`. Types: `LINK`, `IMG`, `FILE`, `COMMAND`, `NOTE`.
Pasted links without a scheme are stored as `//host/...`. `FILE` and local
`IMG` paths refer to the creating device. Super Productivity 19.1.0 no longer
runs `COMMAND` attachments. Note records (`note` section) and project `noteIds`
are covered by ADR 0019.

**September 24 backup (read-only, structure only).** 34 live tasks link an
issue: 29 `GITEA`, 5 `ICAL`. The archive stores hold 71 other linked tasks,
one of them a legacy link with an `issueId` and no type or provider. The export has 17 provider instances:
13 `GITEA`, 2 `ICAL`, 1 `CALDAV` and 1 `plugin:caldav-calendar-provider`.
Every provider ID referenced by a task was present. No task had attachments. No task text,
address or credential was copied.

## Decision

### Records

- A task has at most one **issue link**: source (`super_productivity`),
  provider key, provider instance source ID, `providerRecorded` (whether the
  export contained that provider), issue ID, optional display URL,
  last-updated time, and the last-synced fields as an opaque JSON object up to
  64 KiB. `connection` is always `authorization_required`.
- A task has up to 100 **attachments**, ordered. Kinds: `link`, `note`,
  `file`, `image`, `command`. Link and image attachments with an absolute
  http(s) address and no user name or password are openable (`url`). A note
  holds text. Every other attachment is kept as unavailable provenance with
  its original path or command in `sourcePath` and a reason:
  `device_local`, `command_not_run` or `unsupported_address`.
- Both are owner-scoped with their own revision. Migration
  `0025_linked_issues_attachments` adds `task_issue_links` and
  `task_attachments`. Links and attachments follow the task through delete
  and restore; writes need an active task.
- They are online-only, like notes: not in the sync change feed or the
  offline cache. The browser reads them over HTTP and writes with If-Match.

### Safety

- Tadooer never reads local files, never runs commands, and renders
  `sourcePath` as text. The web client opens only http(s) addresses, in a new
  tab with `rel="noopener noreferrer"`.
- Addresses containing a user name or password are rejected by the API and
  block import. Diagnostics, import findings, audit rows and preview summaries
  name hosts at most; they never repeat issue IDs, full addresses or provider
  configuration.

### Import

- `attachments`, `issueId`, `issueProviderId`, `issueType` and
  `issueLastUpdated` apply. The other last-synced fields are retained in
  provenance and copied into the link's opaque metadata. Fields are added to
  the provenance JSON only when populated, so tasks imported before #30 keep
  their source hash.
- `issueProvider` stays configuration. The importer reads each provider's
  `id` and `issueProviderKey`, and for `GITEA` also `pluginConfig.host` and
  `pluginConfig.repoFullname` to rebuild the issue address when the host is a
  plain http(s) URL, the repository is `owner/name` and the issue ID is
  numeric. No other provider field is read or stored. Calendar feed URLs can
  be capability secrets, so `ICAL` and `CALDAV` links get no address.
- A link to a provider missing from the export, or with no provider, is kept
  with `providerRecorded: false` and reported as `issue_provider_missing`,
  which does not block apply.
- These block apply: issue metadata without `issueId`; a non-text `issueId`;
  an invalid provider key or provider ID; `issueType` that disagrees with the
  provider's key; an invalid `issueLastUpdated`; last-synced values over
  64 KiB; unreviewed attachment fields or types; attachments with no path;
  credential-bearing addresses; more than 100 attachments.
- Protocol-relative `//host` links become `https://host`.

### Assistant operations

New scopes `task_links:read` and `task_links:write`. `task_links.get` reads one
task's links. `task_links.mutate` adds, edits or removes link and note
attachments and removes an issue link, through preview and confirmation with
frozen revisions. Existing tokens do not gain the new scopes.

## Boundary: no live provider access

This issue adds no polling, refresh, search, write-back or credential import.
Using a link against its provider again needs a new, explicit provider
authorization with its own connector contract (ADR 0007 for credential
storage). Until then an issue link is a read-only record that the owner can
open (Gitea) or remove.

## Deferred

- Attachment reordering and adding file or image uploads.
- Creating issue links by hand, provider search and issue-to-task import.
- Offline writes for links and attachments (#92).
- Archived tasks keep their links in the export until archive import (#38).
