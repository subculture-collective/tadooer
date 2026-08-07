#!/usr/bin/env bash
set -euo pipefail

project_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_directory"

project_name="suite-phase4-verify-${RANDOM}${RANDOM}"
suite_port="${SUITE_VERIFY_PORT:-18440}"
baikal_port="${BAIKAL_VERIFY_PORT:-18446}"

cleanup() {
  COMPOSE_PROJECT_NAME="$project_name" SUITE_PORT="$suite_port" BAIKAL_PORT="$baikal_port" \
    docker compose down --volumes --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT

COMPOSE_PROJECT_NAME="$project_name" SUITE_PORT="$suite_port" BAIKAL_PORT="$baikal_port" \
  docker compose up --detach --build --wait

node ./deploy/phase4-runtime.mjs "http://127.0.0.1:${suite_port}"
