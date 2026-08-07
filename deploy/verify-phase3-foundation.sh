#!/usr/bin/env bash
set -euo pipefail
project_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_directory"
pnpm verify
pnpm test:phase3
echo "Phase 3 credential-independent Google federation and calm-planning foundation verified; live Google OAuth qualification still requires installed credentials"
