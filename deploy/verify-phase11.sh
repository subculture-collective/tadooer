#!/usr/bin/env bash
set -euo pipefail
project_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_directory"

pnpm verify
pnpm test:phase11
bash -n deploy/production/backup.sh
if command -v shellcheck >/dev/null 2>&1; then
  shellcheck deploy/production/backup.sh
fi
./deploy/verify-phase8-compose.sh
echo "Phase 11 durable ntfy ledger, calm suppression, redacted health, restart replay, and disposable recovery verified"
