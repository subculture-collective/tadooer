#!/bin/sh
set -eu

project_name="suite-phase2-verify-$$"
suite_port="${SUITE_PHASE2_VERIFY_PORT:-18480}"
baikal_port="${BAIKAL_PHASE2_VERIFY_PORT:-18486}"
work_directory="$(mktemp -d)"
base_url="http://127.0.0.1:${suite_port}"
state_path="$work_directory/phase2-state.json"

export PHASE2_OWNER_USERNAME="phase2-owner"
export PHASE2_OWNER_PASSWORD="synthetic phase two owner passphrase"
export BAIKAL_ADMIN_PASSWORD="synthetic-admin-passphrase"
export BAIKAL_DAV_USERNAME="phase2dav"
export BAIKAL_DAV_PASSWORD="synthetic-dav-passphrase"

compose() { SUITE_PORT="$suite_port" BAIKAL_PORT="$baikal_port" docker compose --project-name "$project_name" "$@"; }
cleanup() { status="$?"; trap - 0 1 2 15; compose down --volumes --remove-orphans || status=1; rm -rf -- "$work_directory" || status=1; exit "$status"; }
trap cleanup 0 1 2 15

compose up -d --build --wait
SUITE_PORT="$suite_port" ./deploy/smoke.sh >/dev/null
node deploy/baikal-disposable.mjs bootstrap "http://127.0.0.1:${baikal_port}" >/dev/null
node deploy/phase2-browser.mjs initial "$base_url" "$state_path"
compose restart suite
compose up -d --wait suite
SUITE_PORT="$suite_port" ./deploy/smoke.sh >/dev/null
node deploy/phase2-browser.mjs restart "$base_url" "$state_path"
echo "Phase 2 persistent-profile offline cache, reconnect, second-client takeover, and compose restart verified"
