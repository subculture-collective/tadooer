#!/bin/sh
set -eu
project_name="suite-phase7-verify-$$"
suite_port="${SUITE_PHASE7_VERIFY_PORT:-18470}"
baikal_port="${BAIKAL_PHASE7_VERIFY_PORT:-18476}"
work_directory="$(mktemp -d)"
base_url="http://127.0.0.1:${suite_port}"
baikal_url="http://127.0.0.1:${baikal_port}"
state_path="$work_directory/state.json"
export PHASE7_OWNER_PASSWORD="synthetic phase seven owner passphrase"
export BAIKAL_ADMIN_PASSWORD="synthetic-admin-passphrase"
export BAIKAL_DAV_USERNAME="phase7dav"
export BAIKAL_DAV_PASSWORD="synthetic-dav-passphrase"
compose() { SUITE_PORT="$suite_port" BAIKAL_PORT="$baikal_port" docker compose --project-name "$project_name" "$@"; }
cleanup() { status="$?"; trap - 0 1 2 15; compose down --volumes --remove-orphans >/dev/null 2>&1 || status=1; rm -rf -- "$work_directory" || status=1; exit "$status"; }
trap cleanup 0 1 2 15
event_count() {
  node -e 'process.stdout.write(JSON.stringify({username:process.env.BAIKAL_DAV_USERNAME,password:process.env.BAIKAL_DAV_PASSWORD,calendarHref:"/dav.php/calendars/"+process.env.BAIKAL_DAV_USERNAME+"/default/"}))' |
    node deploy/baikal-disposable.mjs list "$baikal_url" |
    node -e 'let v="";process.stdin.on("data",c=>v+=c).on("end",()=>console.log(JSON.parse(v).count))'
}
compose up -d --build --wait
node deploy/baikal-disposable.mjs bootstrap "$baikal_url" >/dev/null
node deploy/phase7-runtime.mjs initial "$base_url" "$state_path"
test "$(event_count)" = "1"
compose restart suite >/dev/null
compose up -d --wait suite >/dev/null
node deploy/phase7-runtime.mjs restart "$base_url" "$state_path"
test "$(event_count)" = "1"
COMPOSE_PROJECT_NAME="$project_name" SUITE_PORT="$suite_port" BAIKAL_PORT="$baikal_port" ./deploy/backup-stack.sh "$work_directory/backup" >/dev/null
COMPOSE_PROJECT_NAME="$project_name" SUITE_PORT="$suite_port" BAIKAL_PORT="$baikal_port" ./deploy/restore-stack.sh "$work_directory/backup" >/dev/null
node deploy/phase7-runtime.mjs restore "$base_url" "$state_path"
test "$(event_count)" = "1"
echo "Phase 7 real Baikal import, restart replay, full-stack restore, export, and feed revocation verified"
