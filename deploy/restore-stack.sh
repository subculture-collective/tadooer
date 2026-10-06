#!/bin/sh
set -eu

if [ "$#" -ne 1 ]; then
  echo "Usage: $0 BACKUP-DIRECTORY" >&2
  exit 2
fi

source_directory="$1"
for required in SHA256SUMS suite-data baikal-specific baikal-config; do
  if [ ! -e "$source_directory/$required" ]; then
    echo "Stack backup is incomplete: missing $required" >&2
    exit 2
  fi
done
(
  cd "$source_directory"
  sha256sum -c SHA256SUMS
)

# This command intentionally replaces this Compose project's volumes. The
# caller selects the project and backup explicitly; checksum verification
# completes before any existing state is removed.
docker compose down --volumes --remove-orphans
docker compose create suite baikal >/dev/null
suite_container="$(docker compose ps -aq suite)"
baikal_container="$(docker compose ps -aq baikal)"
test -n "$suite_container"
test -n "$baikal_container"
docker cp -a "$source_directory/suite-data/." "$suite_container:/data"
docker cp -a "$source_directory/baikal-specific/." "$baikal_container:/var/www/baikal/Specific"
docker cp -a "$source_directory/baikal-config/." "$baikal_container:/var/www/baikal/config"
docker compose up -d --wait
echo "Full stack restore completed from $source_directory"
