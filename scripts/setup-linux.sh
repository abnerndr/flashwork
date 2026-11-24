#!/usr/bin/env bash
# Flashwork — Linux / WSL entry (delegates to the cross-platform setup.mjs).
# Loads nvm/fnm/cargo first so non-interactive WSL shells find Node.
set -euo pipefail
cd "$(dirname "$0")"
# shellcheck disable=SC1091
. ./lib.sh
ROOT="$(flashwork_root)"
cd "$ROOT"
flashwork_env
flashwork_require_node
exec node scripts/setup.mjs "$@"
