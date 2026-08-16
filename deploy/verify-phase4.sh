#!/usr/bin/env bash
set -euo pipefail

project_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_directory"

pnpm verify
pnpm test:phase4
./deploy/verify-phase4-compose.sh

echo "Phase 4 contracts, durable automation authority, deployed HTTP confirmation/replay/revocation, stdio MCP, and quick-add verified"
