#!/usr/bin/env bash
# Flashwork — production bundle (AppImage / .deb / .dmg depending on OS).
set -euo pipefail
cd "$(dirname "$0")"
# shellcheck disable=SC1091
. ./lib.sh
ROOT="$(flashwork_root)"
ORCH="$ROOT/apps/orchestrator"
flashwork_env
flashwork_require_node
flashwork_require_rust
flashwork_npm_install "$ORCH"

echo "==> Flashwork production build (instalador do SO atual)"
cd "$ROOT"
npm run installer
echo
echo "Artifacts: $ORCH/src-tauri/target/release/bundle/"
