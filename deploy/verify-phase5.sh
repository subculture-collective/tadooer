#!/usr/bin/env bash
set -euo pipefail

project_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_directory"

pnpm verify
pnpm test:phase5
./deploy/verify-phase5-compose.sh

echo "Phase 5 inert templates, exact-once instantiation, backup/restore, and local MCP confirmation verified"
