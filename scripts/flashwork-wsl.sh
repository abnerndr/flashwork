#!/usr/bin/env bash
# Flashwork — launch the desktop app from inside a WSL distro.
# Safe for non-interactive shells (Windows shortcuts via wsl.exe).
#
# Usage:
#   ./scripts/flashwork-wsl.sh
#   ./scripts/flashwork-wsl.sh --setup-only
#   FLASHWORK_FORCE_X11=1 ./scripts/flashwork-wsl.sh
set -euo pipefail

cd "$(dirname "$0")"
# shellcheck disable=SC1091
. ./lib.sh

ROOT="$(flashwork_root)"
cd "$ROOT"

flashwork_env
flashwork_load_dotenv
flashwork_require_node
flashwork_require_rust

SETUP_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --setup-only) SETUP_ONLY=1 ;;
  esac
done

flashwork_npm_install "$ROOT"

if [[ "$SETUP_ONLY" -eq 1 ]]; then
  echo "==> Flashwork WSL setup OK (node=$(node -v), pnpm=$(pnpm -v), cargo=$(cargo -V 2>/dev/null | awk '{print $2}'))"
  exit 0
fi

# WSLg / display: prefer Wayland + D3D12 (see tauri-dev.mjs). Opt into X11 only when needed.
if [[ -r /proc/version ]] && grep -qi microsoft /proc/version; then
  if [[ "${FLASHWORK_FORCE_X11:-}" == "1" ]]; then
    export GDK_BACKEND=x11
    export WEBKIT_DISABLE_COMPOSITING_MODE="${WEBKIT_DISABLE_COMPOSITING_MODE:-1}"
    echo "[flashwork] WSL: FLASHWORK_FORCE_X11=1 → GDK_BACKEND=x11"
  else
    unset GDK_BACKEND WEBKIT_DISABLE_COMPOSITING_MODE WEBKIT_DISABLE_DMABUF_RENDERER LIBGL_ALWAYS_SOFTWARE || true
    export GALLIUM_DRIVER="${GALLIUM_DRIVER:-d3d12}"
    echo "[flashwork] WSL: Wayland + GALLIUM_DRIVER=${GALLIUM_DRIVER}"
  fi
fi

echo "==> Flashwork desktop via WSL ($(uname -n))"
exec pnpm run app
