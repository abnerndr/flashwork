#!/usr/bin/env bash
# Flashwork — Vite UI only (browser, no PTY / native APIs).
set -euo pipefail
cd "$(dirname "$0")"
# shellcheck disable=SC1091
. ./lib.sh
ROOT="$(flashwork_root)"
ORCH="$ROOT/apps/orchestrator"
flashwork_env
flashwork_require_node
flashwork_npm_install "$ORCH"

echo "==> Flashwork UI (http://localhost:1422) — no native PTY"
cd "$ROOT"
npm run dev:ui
