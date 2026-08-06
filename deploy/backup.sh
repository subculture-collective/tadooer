#!/bin/sh
set -eu

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup_name="suite-${timestamp}.sqlite"

docker compose exec -T suite node /app/server/cli.mjs backup "/data/backups/${backup_name}"
docker compose exec -T suite sh -eu -c '
  test -f /data/credential.key
  cp /data/credential.key "/data/backups/$1"
  chmod 600 "/data/backups/$1"
' sh "${backup_name%.sqlite}.key"
echo "Backup pair stored in the suite-data volume at /data/backups/${backup_name} and ${backup_name%.sqlite}.key"
