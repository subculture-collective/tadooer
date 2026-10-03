#!/bin/sh
set -eu

suite_port="${SUITE_PORT:-18080}"
base_url="http://127.0.0.1:${suite_port}"

health="$(curl --fail --silent --show-error "${base_url}/api/health")"
ready="$(curl --fail --silent --show-error "${base_url}/api/ready")"
build="$(curl --fail --silent --show-error "${base_url}/api/build")"
shell="$(curl --fail --silent --show-error "${base_url}/")"

node -e '
  const [health, ready, build] = process.argv.slice(1).map(JSON.parse);
  if (health.status !== "ok") throw new Error("health is not ok");
  if (ready.status !== "ok" || ready.checks.database !== "ok") {
    throw new Error("readiness is not ok");
  }
  if (!ready.instanceId || ready.migrationCount < 1) {
    throw new Error("installation metadata is missing");
  }
  if (!build.version || !build.revision) throw new Error("build metadata is missing");
' "$health" "$ready" "$build"

case "$shell" in
  *"<title>Tadooer</title>"*) ;;
  *)
    echo "Web shell did not render the expected title" >&2
    exit 1
    ;;
esac

echo "$ready"
