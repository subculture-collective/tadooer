#!/bin/sh
set -eu

if [ "$#" -ne 1 ]; then
  echo "Usage: $0 NEW-BACKUP-DIRECTORY" >&2
  exit 2
fi

destination="$1"
if [ -e "$destination" ]; then
  echo "Backup destination already exists: $destination" >&2
  exit 2
fi

suite_container="$(docker compose ps -q suite)"
baikal_container="$(docker compose ps -q baikal)"
if [ -z "$suite_container" ] || [ -z "$baikal_container" ]; then
  echo "Suite and Baikal containers must exist before backup" >&2
  exit 1
fi

resume() {
  docker compose up -d --wait suite baikal >/dev/null
}
trap resume 0 1 2 15

# Both SQLite writers are stopped for one coherent recovery point. This copies
# the complete named-volume contents, including the Suite credential key and
# Baikal's authoritative database/configuration.
docker compose stop suite baikal >/dev/null
mkdir -m 700 "$destination"
mkdir "$destination/suite-data" "$destination/baikal-specific" "$destination/baikal-config"
docker cp -a "$suite_container:/data/." "$destination/suite-data"
docker cp -a "$baikal_container:/var/www/baikal/Specific/." "$destination/baikal-specific"
docker cp -a "$baikal_container:/var/www/baikal/config/." "$destination/baikal-config"
(
  cd "$destination"
  find suite-data baikal-specific baikal-config -type f -print0 |
    sort -z |
    xargs -0 sha256sum > SHA256SUMS
)
chmod -R go-rwx "$destination"

resume
trap - 0 1 2 15
echo "Full stack backup stored at $destination"
