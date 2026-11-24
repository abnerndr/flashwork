#!/usr/bin/env bash
# Launch Tauri in the same way as `pnpm run app`, with optional WSL display tweaks.
set -euo pipefail

# WSLg: leave GDK on the system default (usually Wayland). Forcing x11 used to
# show the window when Wayland failed to map, but broke maximize/restore.
# Opt in only when the window never appears:
#   FLASHWORK_FORCE_X11=1 pnpm run dev
if [[ -r /proc/version ]] && grep -qi microsoft /proc/version; then
  if [[ "${FLASHWORK_FORCE_X11:-}" == "1" ]]; then
    export GDK_BACKEND=x11
    export WEBKIT_DISABLE_COMPOSITING_MODE="${WEBKIT_DISABLE_COMPOSITING_MODE:-1}"
    echo "[flashwork] WSL: FLASHWORK_FORCE_X11=1 → GDK_BACKEND=x11"
  fi
fi

exec tauri dev --config src-tauri/tauri.dev.json "$@"
