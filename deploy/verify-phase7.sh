#!/usr/bin/env bash
set -euo pipefail
project_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_directory"
pnpm verify
pnpm test:phase7
./deploy/verify-phase7-compose.sh
echo "Phase 7 preserved imports, idempotent apply, read-only publication, and recovery verified"
