#!/bin/sh
set -eu

project_name="suite-phase1-verify-$$"
suite_port="${SUITE_PHASE1_VERIFY_PORT:-18380}"
baikal_port="${BAIKAL_PHASE1_VERIFY_PORT:-18386}"
work_directory="$(mktemp -d)"
base_url="http://127.0.0.1:${suite_port}"
baikal_url="http://127.0.0.1:${baikal_port}"
state_path="$work_directory/browser-state.json"

export PHASE1_OWNER_USERNAME="phase1-owner"
export PHASE1_OWNER_PASSWORD="synthetic phase one owner passphrase"
export BAIKAL_ADMIN_PASSWORD="synthetic-admin-passphrase"
export BAIKAL_DAV_USERNAME="phase1dav"
export BAIKAL_DAV_PASSWORD="synthetic-dav-passphrase"
export PHASE1_BAIKAL_URL="$baikal_url"
export PHASE1_SEED_SUMMARY="Existing disposable Baikal event"

compose() {
  SUITE_PORT="$suite_port" BAIKAL_PORT="$baikal_port" \
    docker compose --project-name "$project_name" "$@"
}

cleanup() {
  compose down --volumes --remove-orphans
}
trap cleanup 0 1 2 15

dav_input() {
  node -e 'process.stdout.write(JSON.stringify({username:process.env.BAIKAL_DAV_USERNAME,password:process.env.BAIKAL_DAV_PASSWORD,calendarHref:"/dav.php/calendars/"+process.env.BAIKAL_DAV_USERNAME+"/default/"}))'
}

event_count() {
  dav_input |
    node deploy/baikal-disposable.mjs list "$baikal_url" |
    node -e 'let value="";process.stdin.on("data",chunk=>value+=chunk).on("end",()=>console.log(JSON.parse(value).count))'
}

compose up -d --build --wait
SUITE_PORT="$suite_port" ./deploy/smoke.sh >/dev/null
node deploy/baikal-disposable.mjs bootstrap "$baikal_url" > "$work_directory/bootstrap.json"

seed_start="$(node -e 'const d=new Date(Date.now()+6*60*60*1000);console.log(d.toISOString().replace(/[-:]/g,"").replace(/\.\d{3}Z$/,"Z"))')"
seed_end="$(node -e 'const d=new Date(Date.now()+7*60*60*1000);console.log(d.toISOString().replace(/[-:]/g,"").replace(/\.\d{3}Z$/,"Z"))')"
PHASE1_SEED_START="$seed_start" PHASE1_SEED_END="$seed_end" node -e '
  process.stdout.write(JSON.stringify({
    username: process.env.BAIKAL_DAV_USERNAME,
    password: process.env.BAIKAL_DAV_PASSWORD,
    calendarHref: "/dav.php/calendars/" + process.env.BAIKAL_DAV_USERNAME + "/default/",
    summary: process.env.PHASE1_SEED_SUMMARY,
    start: process.env.PHASE1_SEED_START,
    end: process.env.PHASE1_SEED_END
  }))
' | node deploy/baikal-disposable.mjs seed "$baikal_url" > "$work_directory/seed.json"

node deploy/phase1-browser.mjs initial "$base_url" "$state_path"
test "$(event_count)" = "2"

compose restart suite
compose up -d --wait suite
SUITE_PORT="$suite_port" ./deploy/smoke.sh >/dev/null
node deploy/phase1-browser.mjs restart "$base_url" "$state_path"
test "$(event_count)" = "2"

COMPOSE_PROJECT_NAME="$project_name" SUITE_PORT="$suite_port" BAIKAL_PORT="$baikal_port" \
  ./deploy/backup-stack.sh "$work_directory/backup"
COMPOSE_PROJECT_NAME="$project_name" SUITE_PORT="$suite_port" BAIKAL_PORT="$baikal_port" \
  ./deploy/restore-stack.sh "$work_directory/backup"
SUITE_PORT="$suite_port" ./deploy/smoke.sh >/dev/null
test "$(event_count)" = "2"

node deploy/phase1-browser.mjs restore "$base_url" "$state_path"
test "$(event_count)" = "3"

node -e '
  const fs=require("node:fs");
  const seed=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
  process.stdout.write(JSON.stringify({
    username: process.env.BAIKAL_DAV_USERNAME,
    password: process.env.BAIKAL_DAV_PASSWORD,
    calendarHref: "/dav.php/calendars/" + process.env.BAIKAL_DAV_USERNAME + "/default/",
    href: seed.href,
    ifMatch: seed.etag
  }));
' "$work_directory/seed.json" | node deploy/baikal-disposable.mjs delete "$baikal_url" >/dev/null
test "$(event_count)" = "2"

echo "Phase 1 browser journey, real Baikal CRUD/conflict, restart identity, and fresh-volume full-stack restore verified"
