#!/bin/sh
set -eu

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup_name="suite-${timestamp}.sqlite"

docker compose exec -T suite node /app/server/cli.mjs backup "/data/backups/${backup_name}"
echo "Backup stored in the suite-data volume at /data/backups/${backup_name}"
