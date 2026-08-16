#!/usr/bin/env bash
set -euo pipefail

project_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_directory"
project_name="suite-phase6-verify-${RANDOM}${RANDOM}"
export COMPOSE_PROJECT_NAME="$project_name"
export SUITE_PORT="${SUITE_VERIFY_PORT:-18460}"
export BAIKAL_PORT="${BAIKAL_VERIFY_PORT:-18466}"
cleanup() { docker compose down --volumes --remove-orphans >/dev/null 2>&1 || true; }
trap cleanup EXIT
docker compose up --detach --build --wait
node ./deploy/phase6-runtime.mjs "http://127.0.0.1:${SUITE_PORT}" "$project_name"
