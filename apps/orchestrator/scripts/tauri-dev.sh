#!/usr/bin/env bash
# Launch Tauri in the same way as `pnpm run app`, with WSL display fixes.
set -euo pipefail

# WSLg: GTK/WebKit prefer Wayland when WAYLAND_DISPLAY is set. Undecorated Tauri
# windows often never map on Weston; X11 through WSLg's Xwayland is reliable.
if [[ -r /proc/version ]] && grep -qi microsoft /proc/version; then
  export GDK_BACKEND="${GDK_BACKEND:-x11}"
  # Avoid blank/composited WebKit surfaces on some WSLg builds.
  export WEBKIT_DISABLE_COMPOSITING_MODE="${WEBKIT_DISABLE_COMPOSITING_MODE:-1}"
  echo "[flashwork] WSL: GDK_BACKEND=$GDK_BACKEND WEBKIT_DISABLE_COMPOSITING_MODE=$WEBKIT_DISABLE_COMPOSITING_MODE"
fi

exec tauri dev --config src-tauri/tauri.dev.json "$@"
