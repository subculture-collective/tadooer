#!/bin/sh
set -eu

project_name="suite-verify-$$"
suite_port="${SUITE_VERIFY_PORT:-18180}"
baikal_port="${BAIKAL_VERIFY_PORT:-18186}"

cleanup() {
  SUITE_PORT="$suite_port" BAIKAL_PORT="$baikal_port" \
    docker compose --project-name "$project_name" down --volumes --remove-orphans
}
trap cleanup EXIT INT TERM

SUITE_PORT="$suite_port" BAIKAL_PORT="$baikal_port" \
  docker compose --project-name "$project_name" up --detach --build --wait

first_ready="$(SUITE_PORT="$suite_port" ./deploy/smoke.sh)"
first_instance="$(node -e 'console.log(JSON.parse(process.argv[1]).instanceId)' "$first_ready")"

SUITE_PORT="$suite_port" BAIKAL_PORT="$baikal_port" \
  docker compose --project-name "$project_name" restart suite
SUITE_PORT="$suite_port" BAIKAL_PORT="$baikal_port" \
  docker compose --project-name "$project_name" up --detach --wait suite

second_ready="$(SUITE_PORT="$suite_port" ./deploy/smoke.sh)"
second_instance="$(node -e 'console.log(JSON.parse(process.argv[1]).instanceId)' "$second_ready")"

test "$first_instance" = "$second_instance"

backup_output="$(
  COMPOSE_PROJECT_NAME="$project_name" SUITE_PORT="$suite_port" BAIKAL_PORT="$baikal_port" \
    ./deploy/backup.sh
)"
backup_name="$(printf '%s\n' "$backup_output" | sed -n 's|.*at /data/backups/||p')"
test -n "$backup_name"

SUITE_PORT="$suite_port" BAIKAL_PORT="$baikal_port" \
  docker compose --project-name "$project_name" stop suite
SUITE_PORT="$suite_port" BAIKAL_PORT="$baikal_port" \
  docker compose --project-name "$project_name" run --rm --no-deps --entrypoint sh suite \
  -eu -c 'rm -f /data/suite.sqlite /data/suite.sqlite-shm /data/suite.sqlite-wal'
SUITE_PORT="$suite_port" BAIKAL_PORT="$baikal_port" \
  docker compose --project-name "$project_name" up --detach --wait suite

fresh_ready="$(SUITE_PORT="$suite_port" ./deploy/smoke.sh)"
fresh_instance="$(node -e 'console.log(JSON.parse(process.argv[1]).instanceId)' "$fresh_ready")"
test "$first_instance" != "$fresh_instance"

COMPOSE_PROJECT_NAME="$project_name" SUITE_PORT="$suite_port" BAIKAL_PORT="$baikal_port" \
  ./deploy/restore.sh "$backup_name"
restored_ready="$(SUITE_PORT="$suite_port" ./deploy/smoke.sh)"
restored_instance="$(node -e 'console.log(JSON.parse(process.argv[1]).instanceId)' "$restored_ready")"
test "$first_instance" = "$restored_instance"

echo "Compose readiness, restart persistence, SQLite backup, and restore verified"
