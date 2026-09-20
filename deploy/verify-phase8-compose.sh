#!/bin/sh
set -eu
project_name="suite-phase8-verify-$$"
suite_port="${SUITE_PHASE8_VERIFY_PORT:-18480}"
baikal_port="${BAIKAL_PHASE8_VERIFY_PORT:-18486}"
work_directory="$(mktemp -d)"
revision="$(git rev-parse --short=12 HEAD)"
version="0.1.0-phase8"
built_at="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
compose() { SUITE_PORT="$suite_port" BAIKAL_PORT="$baikal_port" SUITE_VERSION="$version" SUITE_REVISION="$revision" SUITE_BUILD_DATE="$built_at" docker compose --project-name "$project_name" "$@"; }
cleanup() { status="$?"; trap - 0 1 2 15; compose down --volumes --remove-orphans >/dev/null 2>&1 || status=1; rm -rf -- "$work_directory" || status=1; exit "$status"; }
trap cleanup 0 1 2 15
compose up -d --build --wait
base_url="http://127.0.0.1:${suite_port}"
build="$(curl --fail --silent "$base_url/api/build")"
test "$(node -e 'console.log(JSON.parse(process.argv[1]).version)' "$build")" = "$version"
test "$(node -e 'console.log(JSON.parse(process.argv[1]).revision)' "$build")" = "$revision"
ready="$(curl --fail --silent "$base_url/api/ready")"
test "$(node -e 'console.log(JSON.parse(process.argv[1]).migrationCount)' "$ready")" = "19"
metrics="$(curl --fail --silent "$base_url/api/metrics")"
printf '%s\n' "$metrics" | grep -q '^suite_uptime_seconds '
printf '%s\n' "$metrics" | grep -q '^suite_database_migrations 19$'
task_state="$(node deploy/phase0-task-smoke.mjs create "$base_url")"
compose restart suite >/dev/null
compose up -d --wait suite >/dev/null
printf '%s' "$task_state" | node deploy/phase0-task-smoke.mjs verify "$base_url"
backup_output="$(COMPOSE_PROJECT_NAME="$project_name" SUITE_PORT="$suite_port" BAIKAL_PORT="$baikal_port" ./deploy/backup.sh)"
backup_name="$(printf '%s\n' "$backup_output" | sed -n 's|.*at /data/backups/\([^ ]*\.sqlite\).*|\1|p')"
test -n "$backup_name"
COMPOSE_PROJECT_NAME="$project_name" SUITE_PORT="$suite_port" BAIKAL_PORT="$baikal_port" ./deploy/restore.sh "$backup_name" >/dev/null
printf '%s' "$task_state" | node deploy/phase0-task-smoke.mjs verify "$base_url"
image_id="$(compose images --quiet suite | xargs docker image inspect --format '{{.Id}}')"
case "$image_id" in sha256:????????????????????????????????????????????????????????????????) ;; *) echo "Invalid image digest" >&2; exit 1;; esac
candidate="$work_directory/candidate.json"
node -e 'const fs=require("node:fs");fs.writeFileSync(process.argv[1],JSON.stringify({schemaVersion:1,version:process.argv[2],revision:process.argv[3],imageDigest:process.argv[4],desktopArtifact:"Productivity Suite-linux-x64",qualifiedAt:new Date().toISOString()}))' "$candidate" "$version" "$revision" "$image_id"
node deploy/release-channel.mjs promote "$candidate" "$work_directory/channels" >/dev/null
test "$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).imageDigest)' "$work_directory/channels/stable.json")" = "$image_id"
echo "Phase 8 versioned production image, metrics, restart, restore, and candidate promotion verified"
