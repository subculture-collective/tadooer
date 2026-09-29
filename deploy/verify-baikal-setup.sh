#!/bin/sh
# Disposable qualification for bundled and existing-instance Baikal setup
# (ADR 0039). Everything this script creates is removed on exit. It never
# prints a password: credentials are generated into a mode-0700 work
# directory as mode-0600 files and passed to the tools by path.
set -eu

project_name="suite-baikal-setup-$$"
suite_port="${SUITE_BAIKAL_SETUP_PORT:-18780}"
baikal_port="${BAIKAL_BAIKAL_SETUP_PORT:-18786}"
existing_port="${BAIKAL_EXISTING_SETUP_PORT:-18787}"
existing_container="${project_name}-existing"
baikal_image="$(sed -n 's/^    image: \(ckulka\/baikal:[^ ]*\)$/\1/p' compose.yaml)"
production_image="$(sed -n 's/^    image: \(ckulka\/baikal:[^ ]*\)$/\1/p' deploy/production/compose.yaml)"
work_directory="$(mktemp -d)"
chmod 700 "$work_directory"
suite_url="http://127.0.0.1:${suite_port}"
bundled_url="http://127.0.0.1:${baikal_port}"
existing_url="http://127.0.0.1:${existing_port}"
results="$work_directory/results.jsonl"

compose() {
 SUITE_PORT="$suite_port" BAIKAL_PORT="$baikal_port" \
    docker compose --project-name "$project_name" "$@"
}

cleanup() {
  status="$?"
  trap - 0 1 2 15
  docker rm --force --volumes "$existing_container" >/dev/null 2>&1 || true
  compose down --volumes --remove-orphans >/dev/null 2>&1 || status=1
  rm -rf -- "$work_directory" || status=1
  exit "$status"
}
trap cleanup 0 1 2 15

record() {
  printf '{"check":"%s","result":%s}\n' "$1" "$2" >> "$results"
  printf '%s: %s\n' "$1" "$2"
}

# check NAME COMMAND...: run a command, fail the gate if it fails, record output.
check() {
  name="$1"
  shift
  output="$("$@")"
  record "$name" "$output"
}

setup() {
  node deploy/baikal-setup.mjs "$@"
}

# Static checks: both Compose files pin one image digest; the production
# bundled profile renders and the default production render has no Baikal.
test -n "$baikal_image"
test "$baikal_image" = "$production_image"
case "$baikal_image" in *@sha256:*) ;; *) exit 1 ;; esac
digest_suite="registry.subcult.tv/productivity-suite/suite@sha256:$(printf 'a%.0s' $(seq 1 64))"
SUITE_IMAGE="$digest_suite" docker compose -f deploy/production/compose.yaml config --quiet
test "$(SUITE_IMAGE="$digest_suite" docker compose -f deploy/production/compose.yaml config --services | sort | tr '\n' ' ')" = "suite "
test "$(SUITE_IMAGE="$digest_suite" BAIKAL_ENDPOINT=http://baikal-bundled/dav.php/ \
  docker compose -f deploy/production/compose.yaml --profile bundled-baikal config --services | sort | tr '\n' ' ')" = "baikal-bundled suite "
record production-compose-render '"default: suite only; bundled-baikal profile: suite + baikal-bundled; one pinned digest"'

for name in admin dav wrong owner existing-admin existing-dav; do
  setup generate-password "$work_directory/$name.pw" >/dev/null
done

export SUITE_OWNER_USERNAME="baikal-setup-owner"
export SUITE_OWNER_PASSWORD_FILE="$work_directory/owner.pw"
export BAIKAL_DAV_USERNAME="tadooer"

# (a) Bundled service.
compose up --detach --build --wait
test "$(docker inspect --format '{{.State.Health.Status}}' "$(compose ps -q baikal)")" = "healthy"
check bundled-health-before-bootstrap setup health "$bundled_url"
grep -q '"initialized":false' "$results"

BAIKAL_ADMIN_PASSWORD_FILE="$work_directory/admin.pw" \
  BAIKAL_DAV_PASSWORD_FILE="$work_directory/dav.pw" \
  setup bootstrap "$bundled_url" > "$work_directory/bootstrap.json"
grep -q '"installed":true' "$work_directory/bootstrap.json"
grep -q '"userCreated":true' "$work_directory/bootstrap.json"
check bundled-bootstrap cat "$work_directory/bootstrap.json"
BAIKAL_ADMIN_PASSWORD_FILE="$work_directory/admin.pw" \
  BAIKAL_DAV_PASSWORD_FILE="$work_directory/dav.pw" \
  setup bootstrap "$bundled_url" > "$work_directory/bootstrap-again.json"
grep -q '"installed":false' "$work_directory/bootstrap-again.json"
grep -q '"userCreated":false' "$work_directory/bootstrap-again.json"
check bundled-bootstrap-rerun cat "$work_directory/bootstrap-again.json"
check bundled-health-after-bootstrap setup health "$bundled_url"
grep -q '"initialized":true' "$results"

check bundled-wrong-password env SUITE_CREATE_OWNER=true BAIKAL_DAV_PASSWORD_FILE="$work_directory/wrong.pw" SUITE_EXPECT_FAILURE=BAIKAL_AUTHENTICATION_FAILED node deploy/baikal-setup.mjs verify-suite "$suite_url"
check bundled-connect env BAIKAL_DAV_PASSWORD_FILE="$work_directory/dav.pw" node deploy/baikal-setup.mjs verify-suite "$suite_url"

compose restart baikal >/dev/null
compose up --detach --wait baikal suite
check bundled-restart-persistence env BAIKAL_DAV_PASSWORD_FILE="$work_directory/dav.pw" SUITE_STATUS_ONLY=true node deploy/baikal-setup.mjs verify-suite "$suite_url"

COMPOSE_PROJECT_NAME="$project_name" SUITE_PORT="$suite_port" BAIKAL_PORT="$baikal_port" \
  ./deploy/backup-stack.sh "$work_directory/stack-backup" >/dev/null
COMPOSE_PROJECT_NAME="$project_name" SUITE_PORT="$suite_port" BAIKAL_PORT="$baikal_port" \
  ./deploy/restore-stack.sh "$work_directory/stack-backup" >/dev/null
check bundled-backup-restore env BAIKAL_DAV_PASSWORD_FILE="$work_directory/dav.pw" SUITE_STATUS_ONLY=true node deploy/baikal-setup.mjs verify-suite "$suite_url"

# (b) Existing instance: a separately started Baikal the Suite reaches by an
# operator-configured endpoint on the same Docker network.
docker run --detach --name "$existing_container" \
  --network "${project_name}_default" --network-alias existing-baikal \
  --publish "127.0.0.1:${existing_port}:80" "$baikal_image" >/dev/null
attempt=0
until setup health "$existing_url" >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  test "$attempt" -lt 60
  # The admin page answers only after nginx and PHP are ready.
  sleep 1
done
BAIKAL_ADMIN_PASSWORD_FILE="$work_directory/existing-admin.pw" \
  BAIKAL_DAV_PASSWORD_FILE="$work_directory/existing-dav.pw" \
  setup bootstrap "$existing_url" > "$work_directory/existing-bootstrap.json"
check existing-bootstrap cat "$work_directory/existing-bootstrap.json"
check existing-health-after-bootstrap setup health "$existing_url"

suite_with_endpoint() {
  BAIKAL_ENDPOINT="$1" compose up --detach --wait --no-deps --force-recreate suite >/dev/null
}

suite_with_endpoint http://existing-baikal/dav.php/
check existing-endpoint-change env BAIKAL_DAV_PASSWORD_FILE="$work_directory/existing-dav.pw" SUITE_STATUS_ONLY=true SUITE_EXPECT_FAILURE=BAIKAL_RECONNECT_REQUIRED node deploy/baikal-setup.mjs verify-suite "$suite_url"
check existing-wrong-password env BAIKAL_DAV_PASSWORD_FILE="$work_directory/wrong.pw" SUITE_EXPECT_FAILURE=BAIKAL_AUTHENTICATION_FAILED node deploy/baikal-setup.mjs verify-suite "$suite_url"
check existing-connect env BAIKAL_DAV_PASSWORD_FILE="$work_directory/existing-dav.pw" node deploy/baikal-setup.mjs verify-suite "$suite_url"

suite_with_endpoint http://existing-baikal/admin/
check existing-admin-path env BAIKAL_DAV_PASSWORD_FILE="$work_directory/existing-dav.pw" SUITE_EXPECT_FAILURE=BAIKAL_NOT_CALDAV node deploy/baikal-setup.mjs verify-suite "$suite_url"
suite_with_endpoint http://existing-baikal:81/dav.php/
check existing-unreachable-port env BAIKAL_DAV_PASSWORD_FILE="$work_directory/existing-dav.pw" SUITE_EXPECT_FAILURE=BAIKAL_UNREACHABLE node deploy/baikal-setup.mjs verify-suite "$suite_url"
suite_with_endpoint http://no-such-baikal.invalid/dav.php/
check existing-unresolvable-host env BAIKAL_DAV_PASSWORD_FILE="$work_directory/existing-dav.pw" SUITE_EXPECT_FAILURE=BAIKAL_UNREACHABLE node deploy/baikal-setup.mjs verify-suite "$suite_url"

if grep -F -f "$work_directory/dav.pw" "$results" >/dev/null ||
  grep -F -f "$work_directory/existing-dav.pw" "$results" >/dev/null ||
  grep -F -f "$work_directory/admin.pw" "$results" >/dev/null ||
  grep -F -f "$work_directory/owner.pw" "$results" >/dev/null; then
  echo "A generated secret appeared in qualification output" >&2
  exit 1
fi
suite_logs="$(compose logs --no-color suite 2>&1)"
if printf '%s' "$suite_logs" | grep -F -f "$work_directory/dav.pw" >/dev/null ||
  printf '%s' "$suite_logs" | grep -F -f "$work_directory/existing-dav.pw" >/dev/null; then
  echo "A generated secret appeared in Suite logs" >&2
  exit 1
fi

echo "Baikal setup qualification passed: $(wc -l < "$results") checks"
