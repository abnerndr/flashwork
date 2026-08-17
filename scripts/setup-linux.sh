#!/usr/bin/env bash
# Flashwork — install host deps on Ubuntu/Debian (incl. WSL).
set -euo pipefail
cd "$(dirname "$0")"
# shellcheck disable=SC1091
. ./lib.sh
ROOT="$(flashwork_root)"
flashwork_env

echo "==> Flashwork setup (Linux / WSL)"
echo "    repo: $ROOT"

if command -v apt-get >/dev/null 2>&1; then
  sudo apt-get update
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y \
    build-essential curl wget file pkg-config \
    libssl-dev libgtk-3-dev libwebkit2gtk-4.1-dev \
    libayatana-appindicator3-dev librsvg2-dev patchelf \
    libdbus-1-dev
else
  echo "apt-get not found. Install Tauri Linux deps manually:"
  echo "  https://v2.tauri.app/start/prerequisites/"
fi

if ! command -v rustup >/dev/null 2>&1 && [ ! -f "$HOME/.cargo/env" ]; then
  echo "==> Installing Rust (rustup)"
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
  # shellcheck disable=SC1091
  . "$HOME/.cargo/env"
fi

flashwork_env
flashwork_require_node
flashwork_require_rust

echo "==> npm install (apps/orchestrator)"
npm --prefix "$ROOT/apps/orchestrator" install

echo
echo "OK. Next:"
echo "  $ROOT/scripts/dev.sh"
echo "  or:  npm run dev"
