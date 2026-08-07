#!/bin/sh
set -eu

compose_file="${TADOOER_COMPOSE_FILE:-/srv/apps/productivity/tadooer-compose.yaml}"
compose_env_file="${TADOOER_COMPOSE_ENV_FILE:-/srv/apps/productivity/tadooer.env}"
data_root="${TADOOER_DATA_ROOT:-/srv/apps/productivity/data/tadooer}"
metric_file="${TADOOER_BACKUP_METRIC_FILE:-/srv/server/monitoring/data/node-exporter-textfile/tadooer_backup.prom}"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup_relative="backups/${timestamp}"
backup_root="${data_root}/${backup_relative}"

fail_metric() {
  status="$?"
  trap - 0 1 2 3 15
  mkdir -p "$(dirname "$metric_file")"
  temporary_metric="${metric_file}.tmp.$$"
  {
    echo "# HELP tadooer_backup_success Whether the latest backup completed successfully."
    echo "# TYPE tadooer_backup_success gauge"
    echo "tadooer_backup_success 0"
  } > "$temporary_metric"
  chmod 644 "$temporary_metric"
  mv "$temporary_metric" "$metric_file"
  exit "$status"
}
trap fail_metric 0 1 2 3 15

test -f "$compose_file"
test -f "$compose_env_file"
case "$backup_root" in "${data_root}/backups/"*) ;; *) exit 93 ;; esac
test ! -e "$backup_root"

docker compose --env-file "$compose_env_file" -f "$compose_file" exec -T suite \
  node /app/server/cli.mjs backup "/data/${backup_relative}/suite.sqlite" >/dev/null
docker compose --env-file "$compose_env_file" -f "$compose_file" exec -T suite sh -eu -c '
  destination="$1"
  cp /data/credential.key "$destination/credential.key"
  if [ -f /data/google-oauth.json ]; then
    cp /data/google-oauth.json "$destination/google-oauth.json"
  fi
  chmod 600 "$destination"/*
' sh "/data/${backup_relative}"

(
  cd "$backup_root"
  find . -maxdepth 1 -type f ! -name SHA256SUMS -print0 |
    sort -z |
    xargs -0 sha256sum > SHA256SUMS
)
chmod -R go-rwx "$backup_root"

temporary_metric="${metric_file}.tmp.$$"
epoch="$(date -u +%s)"
{
  echo "# HELP tadooer_backup_success Whether the latest backup completed successfully."
  echo "# TYPE tadooer_backup_success gauge"
  echo "tadooer_backup_success 1"
  echo "# HELP tadooer_last_successful_backup_timestamp_seconds Unix time of the latest successful backup."
  echo "# TYPE tadooer_last_successful_backup_timestamp_seconds gauge"
  echo "tadooer_last_successful_backup_timestamp_seconds ${epoch}"
} > "$temporary_metric"
chmod 644 "$temporary_metric"
mv "$temporary_metric" "$metric_file"
trap - 0 1 2 3 15
echo "Tadooer backup completed at ${backup_root}"
