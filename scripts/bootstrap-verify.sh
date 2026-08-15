#!/usr/bin/env bash
set -uo pipefail
OUT=/tmp/fw-out.txt
exec > >(tee "$OUT") 2>&1
set -x
echo "START $(date -Iseconds)"
cd /home/abner/www/ruperth/flashwork
pwd
ls -la

if [ ! -d .git ]; then
  git init -b main
fi

# Seed commit on main if no commits yet
if ! git rev-parse --verify HEAD >/dev/null 2>&1; then
  git add -A
  git commit --trailer "Co-authored-by: Cursor <cursoragent@cursor.com>" -m "chore: seed Flashwork docs and gitignore"
fi

# Feature branch (in-place if worktree unavailable)
git checkout -B feat/prd-mvp

git add -A
if git diff --cached --quiet && git diff --quiet && [ -z "$(git ls-files --others --exclude-standard)" ]; then
  echo "NOTHING_TO_COMMIT"
else
  git commit --trailer "Co-authored-by: Cursor <cursoragent@cursor.com>" -m "chore: bootstrap Flashwork monorepo (task 0.0)"
fi

echo "BRANCH=$(git branch --show-current)"
echo "SHA=$(git rev-parse HEAD)"

# Node / pnpm
export NVM_DIR="$HOME/.nvm"
# shellcheck disable=SC1091
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

echo "NODE=$(node -v 2>/dev/null || echo MISSING)"
echo "which_node=$(command -v node || true)"
echo "which_corepack=$(command -v corepack || true)"
echo "which_npm=$(command -v npm || true)"

# Prefer Node 22 if nvm available
if command -v nvm >/dev/null 2>&1; then
  nvm install 22 || true
  nvm use 22 || true
fi

if command -v corepack >/dev/null 2>&1; then
  corepack enable || true
  corepack prepare pnpm@9.15.4 --activate
elif command -v npm >/dev/null 2>&1; then
  npm install -g pnpm@9.15.4
else
  echo "FATAL: no corepack/npm"
  exit 127
fi

pnpm -v

set +e
pnpm install
echo "INSTALL_EXIT=$?"
pnpm --filter @flashwork/shared-types test
echo "TEST_EXIT=$?"
pnpm --filter @flashwork/desktop build
echo "BUILD_EXIT=$?"
pnpm lint
echo "LINT_EXIT=$?"
set -e

echo "BRANCH=$(git branch --show-current)"
echo "SHA=$(git rev-parse HEAD)"
git status -sb
echo "END $(date -Iseconds)"
echo "BOOTSTRAP_DONE"
