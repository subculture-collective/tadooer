#!/usr/bin/env bash
set -euo pipefail
project_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_directory"

pnpm verify
pnpm test:phase10
./deploy/verify-phase8-compose.sh
echo "Phase 10 routed workspace, IANA/DST planning, source labels, offline boundaries, and disposable recovery verified"
