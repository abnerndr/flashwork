#!/usr/bin/env bash
# Flashwork — install host deps on macOS.
set -euo pipefail
cd "$(dirname "$0")"
# shellcheck disable=SC1091
. ./lib.sh
ROOT="$(flashwork_root)"
flashwork_env

echo "==> Flashwork setup (macOS)"
echo "    repo: $ROOT"

if ! xcode-select -p >/dev/null 2>&1; then
  echo "Installing Xcode Command Line Tools (a GUI dialog may appear)…"
  xcode-select --install || true
  echo "Finish the Xcode tools installer, then re-run this script."
  exit 1
fi

if ! command -v rustup >/dev/null 2>&1 && [ ! -f "$HOME/.cargo/env" ]; then
  echo "==> Installing Rust (rustup)"
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
  # shellcheck disable=SC1091
  . "$HOME/.cargo/env"
fi

if ! command -v node >/dev/null 2>&1; then
  if command -v brew >/dev/null 2>&1; then
    brew install node@22
  else
    echo "Install Node.js >= 22 from https://nodejs.org or Homebrew." >&2
    exit 1
  fi
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
