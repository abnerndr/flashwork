#!/usr/bin/env bash
set -euo pipefail
OUT=/tmp/flashwork-verify.txt
exec > >(tee "$OUT") 2>&1
echo "=== flashwork verify $(date -Iseconds) ==="
cd /home/abner/www/ruperth/flashwork
pwd
ls -la
echo "--- git ---"
if [ ! -d .git ]; then
  git init -b main
fi
git status || true
git branch --show-current || true
echo "--- node ---"
command -v node || true
node -v || true
command -v corepack || true
command -v npm || true
# try enable corepack via node path
if command -v corepack >/dev/null 2>&1; then
  corepack enable || true
  corepack prepare pnpm@9.15.4 --activate
elif [ -x "$(dirname "$(command -v node)")/corepack" ]; then
  "$(dirname "$(command -v node)")/corepack" enable || true
  "$(dirname "$(command -v node)")/corepack" prepare pnpm@9.15.4 --activate
else
  echo "corepack missing; trying npm install -g pnpm@9.15.4"
  npm install -g pnpm@9.15.4 || true
fi
command -v pnpm
pnpm -v
echo "VERIFY_PROBE_OK"
