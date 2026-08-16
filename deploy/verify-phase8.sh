#!/usr/bin/env bash
set -euo pipefail
project_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_directory"
pnpm verify
pnpm test:phase8
pnpm package:desktop
pnpm --filter @suite/desktop smoke:linux
./deploy/verify-phase8-compose.sh
echo "Phase 8 packaged Linux client, release channels, rollback primitives, observability, and production qualification verified"
