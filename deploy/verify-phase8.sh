#!/usr/bin/env bash
set -euo pipefail
project_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_directory"
pnpm verify
pnpm test:phase8
pnpm package:desktop
pnpm --filter @suite/desktop smoke:linux
# The window self-check (setup page, preload bridge, navigation guard, deep
# links) needs a display. It runs on a private virtual one when xvfb-run is
# installed and is reported as skipped otherwise.
if command -v xvfb-run >/dev/null 2>&1; then
  xvfb-run -a pnpm --filter @suite/desktop smoke:linux:shell
else
  echo "xvfb-run is not installed: the desktop window self-check was skipped" >&2
fi
# This gate qualifies the Linux package, so it names that artifact even when
# macOS packages from `pnpm package:desktop:mac` are present as well.
pnpm --filter @suite/desktop artifact:info linux x64
SUITE_DESKTOP_ARTIFACT="$(node apps/desktop/scripts/artifact-info.mjs linux x64 --manifest-value)" ./deploy/verify-phase8-compose.sh
echo "Phase 8 packaged Linux client, release channels, rollback primitives, observability, and production qualification verified"
