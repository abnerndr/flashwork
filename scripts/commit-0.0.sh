#!/usr/bin/env bash
set -euo pipefail
cd /home/abner/www/ruperth/flashwork
. /home/abner/.nvm/nvm.sh
nvm use 22
git checkout feat/prd-mvp
git add -A
git status
git commit --trailer "Co-authored-by: Cursor <cursoragent@cursor.com>" -m "$(cat <<'EOF'
chore: finalize Flashwork monorepo setup (task 0.0)

## O que foi feito
Monorepo pnpm/turbo com shared-types, desktop electron-vite, CI e docs 0.0 marcados como feitos.

## Por que
Fechar a Fase 0 com install/test/build/lint verdes e branch feat/prd-mvp pronta para 1.0.

## Onde revisar
packages/shared-types (Zod contracts + smoke tests), apps/desktop, .github/workflows/ci.yml

## Impacto
- [x] Nenhum runtime de produto ainda
- [ ] Backend
- [x] Frontend (shell Electron blank)
- [ ] DB
- [ ] Performance
- [ ] Segurança

## Risco / Atenção
Shell do agente deve usar CWD Windows + wsl.exe (UNC quebra PowerShell).

## Como validar
pnpm install && pnpm --filter @flashwork/shared-types test && pnpm --filter @flashwork/desktop build && pnpm lint
EOF
)"
echo "BRANCH=$(git branch --show-current)"
echo "SHA=$(git rev-parse HEAD)"
git status -sb
git log -2 --oneline
