# shellcheck shell=bash
# Shared helpers for Flashwork Unix scripts.
# Designed for non-interactive WSL launches (Windows shortcuts via wsl.exe).

flashwork_root() {
  local here
  here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  echo "$here"
}

# Load Node (nvm / fnm / asdf / volta) and Rust into PATH for non-login shells.
flashwork_env() {
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"

  if [ -s "$NVM_DIR/nvm.sh" ]; then
    # shellcheck disable=SC1091
    . "$NVM_DIR/nvm.sh"
    nvm use default >/dev/null 2>&1 || nvm use --lts >/dev/null 2>&1 || true
  fi

  if command -v fnm >/dev/null 2>&1; then
    eval "$(fnm env)" >/dev/null 2>&1 || true
  elif [ -x "$HOME/.local/share/fnm/fnm" ]; then
    eval "$("$HOME/.local/share/fnm/fnm" env)" >/dev/null 2>&1 || true
  fi

  if [ -f "$HOME/.asdf/asdf.sh" ]; then
    # shellcheck disable=SC1091
    . "$HOME/.asdf/asdf.sh"
  fi

  if [ -d "$HOME/.volta/bin" ]; then
    export PATH="$HOME/.volta/bin:$PATH"
  fi

  # Last-resort: put the newest nvm Node on PATH without sourcing nvm.
  if ! command -v node >/dev/null 2>&1 && [ -d "$NVM_DIR/versions/node" ]; then
    local latest=""
    # shellcheck disable=SC2012
    latest="$(ls -1 "$NVM_DIR/versions/node" 2>/dev/null | sort -V | tail -1 || true)"
    if [ -n "$latest" ] && [ -x "$NVM_DIR/versions/node/$latest/bin/node" ]; then
      export PATH="$NVM_DIR/versions/node/$latest/bin:$PATH"
    fi
  fi

  # shellcheck disable=SC1091
  [ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"
  export PATH="$HOME/.cargo/bin:$PATH"
}

# Export KEY=VALUE pairs from Flashwork dotenv files (no shell evaluation).
flashwork_load_dotenv() {
  local file
  for file in \
    "${XDG_CONFIG_HOME:-$HOME/.config}/flashwork/.env" \
    "$HOME/.config/flashwork/.env" \
    "$(flashwork_root)/.env"
  do
    [ -f "$file" ] || continue
    while IFS= read -r line || [ -n "$line" ]; do
      case "$line" in
        ''|\#*) continue ;;
      esac
      if [[ "$line" =~ ^([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]]; then
        local key="${BASH_REMATCH[1]}"
        local val="${BASH_REMATCH[2]}"
        # Strip matching single/double quotes.
        if [[ "$val" =~ ^\"(.*)\"$ ]]; then val="${BASH_REMATCH[1]}"
        elif [[ "$val" =~ ^\'(.*)\'$ ]]; then val="${BASH_REMATCH[1]}"
        fi
        # Do not override an already-exported value.
        if [ -z "${!key+x}" ]; then
          export "$key=$val"
        fi
      fi
    done <"$file"
  done
}

flashwork_require_node() {
  if ! command -v node >/dev/null 2>&1; then
    echo "Node.js >= 22 is required and was not found in this non-interactive shell." >&2
    echo "Install via nvm (https://github.com/nvm-sh/nvm) or Node 22+, then re-run." >&2
    echo "Tip: Windows shortcuts must call scripts/flashwork-wsl.sh (loads nvm), not bare 'node'." >&2
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

flashwork_ensure_pnpm() {
  if command -v pnpm >/dev/null 2>&1; then
    return 0
  fi
  if command -v corepack >/dev/null 2>&1; then
    corepack enable >/dev/null 2>&1 || true
    corepack prepare pnpm@10.12.1 --activate
  fi
  if ! command -v pnpm >/dev/null 2>&1; then
    npm install -g pnpm@10.12.1
  fi
  if ! command -v pnpm >/dev/null 2>&1; then
    echo "pnpm is required. Install: https://pnpm.io/installation" >&2
    exit 1
  fi
}

flashwork_npm_install() {
  local orch="$1"
  flashwork_ensure_pnpm
  if [ ! -d "$orch/node_modules" ]; then
    echo "Installing pnpm dependencies in .…"
    (cd "$orch" && pnpm install)
  fi
}
