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
first_migrations="$(node -e 'console.log(JSON.parse(process.argv[1]).migrationCount)' "$first_ready")"
test "$first_migrations" = "8"
task_state="$(node ./deploy/phase0-task-smoke.mjs create "http://127.0.0.1:${suite_port}")"

SUITE_PORT="$suite_port" BAIKAL_PORT="$baikal_port" \
  docker compose --project-name "$project_name" restart suite
SUITE_PORT="$suite_port" BAIKAL_PORT="$baikal_port" \
  docker compose --project-name "$project_name" up --detach --wait suite

second_ready="$(SUITE_PORT="$suite_port" ./deploy/smoke.sh)"
second_instance="$(node -e 'console.log(JSON.parse(process.argv[1]).instanceId)' "$second_ready")"
second_migrations="$(node -e 'console.log(JSON.parse(process.argv[1]).migrationCount)' "$second_ready")"

test "$first_instance" = "$second_instance"
test "$first_migrations" = "$second_migrations"
printf '%s' "$task_state" | \
  node ./deploy/phase0-task-smoke.mjs verify "http://127.0.0.1:${suite_port}"

backup_output="$(
  COMPOSE_PROJECT_NAME="$project_name" SUITE_PORT="$suite_port" BAIKAL_PORT="$baikal_port" \
    ./deploy/backup.sh
)"
backup_name="$(printf '%s\n' "$backup_output" | sed -n 's|.*at /data/backups/\([^ ]*\.sqlite\).*|\1|p')"
test -n "$backup_name"

SUITE_PORT="$suite_port" BAIKAL_PORT="$baikal_port" \
  docker compose --project-name "$project_name" stop suite
SUITE_PORT="$suite_port" BAIKAL_PORT="$baikal_port" \
  docker compose --project-name "$project_name" run --rm --no-deps --entrypoint sh suite \
  -eu -c 'rm -f /data/suite.sqlite /data/suite.sqlite-shm /data/suite.sqlite-wal /data/credential.key'
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
printf '%s' "$task_state" | \
  node ./deploy/phase0-task-smoke.mjs verify "http://127.0.0.1:${suite_port}"

echo "Compose readiness, migration/task restart persistence, paired database/key backup, and restore verified"
