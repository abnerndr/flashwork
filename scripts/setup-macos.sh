#!/usr/bin/env bash
# Flashwork — macOS entry (delegates to the cross-platform setup.mjs).
set -euo pipefail
cd "$(dirname "$0")/.."
exec node scripts/setup.mjs "$@"
