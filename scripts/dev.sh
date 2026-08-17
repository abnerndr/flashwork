#!/usr/bin/env bash
# Flashwork — open the desktop app (Tauri + Vite).
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

echo "==> Flashwork desktop (dev)"
cd "$ROOT"
npm run dev
