# Tadooer production deployment

The supported daily-driver placement is one Suite container on `nuc`, behind
Almaz Caddy and the existing Cloudflare wildcard tunnel. The existing NUC
Baïkal service remains authoritative. Super Productivity stays running during
the parallel soak.

## Fixed production boundary

- Public origin: `https://tadooer.subcult.tv`
- NUC listener: `10.0.0.56:18080`
- Trusted proxy: Almaz `10.0.0.200/32`
- Compose networks: existing `productivity` and `monitoring`
- Notification network: existing private `management`
- Suite data: `/srv/apps/productivity/data/tadooer`, owned by UID/GID 1000 and
  mode 0700
- Compose file: `/srv/apps/productivity/tadooer-compose.yaml`
- Image: registry reference with an immutable `sha256` digest

The Caddy route does not use Authelia. Suite authentication is the application
boundary, and the Google callback must reach Suite directly. Caddy replaces the
forwarded client address with its normalized `{client_ip}`; Suite trusts that
header only when the socket peer is Almaz.

## Secrets and first start

Install `/srv/apps/productivity/data/tadooer/google-oauth.json` as UID/GID 1000,
mode 0600, using the normalized Suite schema. The Google Web OAuth client must
contain this exact redirect URI:

`https://tadooer.subcult.tv/api/connectors/google/callback`

Do not copy the local Suite database or credential key. Let the production
container create both, create the owner through the public UI, and connect the
existing Baïkal and Google accounts explicitly.

Install `/srv/apps/productivity/data/tadooer/ntfy-publisher.json` as UID/GID
1000, mode 0600. It contains only `{baseUrl, topic, token}`. Use `http://ntfy`
on the private `management` network and a dedicated non-admin ntfy user with
write-only access to the selected topic. Never use the public anonymous route,
an admin token, or a browser-visible credential.

## Promotion and deployment

1. Run the complete repository and Phase 9 disposable gates.
2. Build and push the image, record its registry digest, and create the release
   manifest before changing production.
3. Set `SUITE_IMAGE` to the digest reference and run `docker compose pull` then
   `docker compose up -d --wait` from the production compose file.
4. Verify `/api/build`, `/api/ready`, `/api/metrics`, public login, connector
   projection, task placement/removal, focus transitions, and restart recovery.
5. Roll back by restoring the prior manifest's image digest. Restore data only
   after a separately selected, checksum-verified backup set is qualified in an
   isolated project.

## Backup and monitoring

Run `deploy/production/backup.sh` before the NUC Restic job and include only the
generated `/srv/apps/productivity/data/tadooer/backups` directory in Restic.
The script makes an online SQLite backup, copies the paired credential key and
optional OAuth and ntfy publisher configurations, creates `SHA256SUMS`, and
writes content-free node-exporter textfile metrics. Backup directories and secrets stay mode
0700/0600. The NUC Prometheus agent scrapes Suite over its private `monitoring` network
and remote-writes to Dozor; Dozor loads the supplied alert rules. A direct
Dozor-to-NUC application-port scrape is neither required nor opened. The secret-bearing coherent set is retained only
inside the encrypted Restic workflow.

An acceptance restore always uses an isolated Compose project, isolated ports,
a copied Baïkal backup, and no route to the production Baïkal service.

## Owner data export versus operator backups

Two copies exist, with different jobs (ADR 0034):

|          | Operator backup pair                                                                                                                     | Owner data export                                                                                                                                      |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Made by  | `deploy/backup.sh` or `deploy/production/backup.sh` (container access)                                                                   | The owner in Settings, or `GET /api/data/export` with the browser session                                                                              |
| Contents | The whole SQLite file: every owner, sessions, assistant tokens, encrypted connector credentials, iCal subscription addresses, sync state | The owner's rows of the included tables as one versioned JSON document; no secrets, sessions, connector or subscription credentials, sync state        |
| Needs    | The paired `credential.key` from the same backup set                                                                                     | Nothing; portable between instances and credential keys                                                                                                |
| Restores | The complete instance, by the operator, with the service stopped                                                                         | One owner's content through a preview and an explicit empty-account or replace choice; connectors, subscriptions and assistant tokens are set up again |

Use the operator pair for disaster recovery and acceptance restores. Use the
owner export to move data between instances, to keep a copy the owner
controls, or to reset an account to a known state. Restoring an owner export
starts a new sync epoch, so every signed-in device resynchronizes; unsynced
offline changes on a device are not in the export.
