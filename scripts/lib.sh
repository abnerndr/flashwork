# shellcheck shell=bash
# Shared helpers for Flashwork Unix scripts.

flashwork_root() {
  local here
  here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  echo "$here"
}

flashwork_env() {
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  # shellcheck disable=SC1091
  [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
  # shellcheck disable=SC1091
  [ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"
  export PATH="$HOME/.cargo/bin:$PATH"
}

flashwork_require_node() {
  if ! command -v node >/dev/null 2>&1; then
    echo "Node.js >= 22 is required. Install from https://nodejs.org or nvm." >&2
    exit 1
  fi
  local major
  major="$(node -p "process.versions.node.split('.')[0]")"
  if [ "$major" -lt 22 ]; then
    echo "Node.js >= 22 required (found $(node -v))." >&2
    exit 1
  fi
}

flashwork_require_rust() {
  if ! command -v rustc >/dev/null 2>&1; then
    echo "Rust is required. Install: https://rustup.rs" >&2
    exit 1
  fi
}

flashwork_npm_install() {
  local orch="$1"
  if [ ! -d "$orch/node_modules" ]; then
    echo "Installing npm dependencies in apps/orchestrator…"
    npm --prefix "$orch" install
  fi
}
