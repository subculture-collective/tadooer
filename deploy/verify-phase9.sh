#!/usr/bin/env bash
set -euo pipefail
project_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_directory"

pnpm verify
pnpm test:phase9
bash -n deploy/production/backup.sh
if command -v shellcheck >/dev/null 2>&1; then
  shellcheck deploy/production/backup.sh
fi
SUITE_IMAGE="registry.subcult.tv/productivity-suite/suite@sha256:$(printf 'a%.0s' {1..64})" \
  docker compose -f deploy/production/compose.yaml config --quiet
grep -q 'http://tadooer.subcult.tv' deploy/production/Caddyfile.tadooer
grep -q '10.0.0.56:18080' deploy/production/Caddyfile.tadooer
echo "Phase 9 production trust, digest-only deployment, backup, and monitoring assets verified"
