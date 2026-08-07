#!/usr/bin/env bash
set -euo pipefail
project_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_directory"
pnpm verify
pnpm test:phase6
./deploy/verify-phase6-compose.sh
echo "Phase 6 logical policy, exact-once placeholder resolution, sync, backup/restore, and local MCP verified"
