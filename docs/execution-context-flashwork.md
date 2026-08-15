# Contexto de continuação — Flashwork PRD

**Última atualização:** 2026-08-15 (task 1.0 concluída)  
**Objetivo:** outro agente deve poder retomar daqui sem reler o chat.

## Skills em uso

- `executing-plans` + `subagent-driven-development`
- `using-git-worktrees` (isolamento obrigatório; nunca implementar em main sem consentimento)
- Ao final: `finishing-a-development-branch`

## Fontes canônicas

- PRD: `c:\Users\abner\Downloads\PRD-flashwork.md`
- Tasks: `c:\Users\abner\Downloads\tasks-PRD-flashwork.md`
- STATUS vivo: `docs/STATUS-flashwork.md` (este repo)
- Este arquivo: `docs/execution-context-flashwork.md`

## Estado do repositório

- Path: `/home/abner/www/ruperth/flashwork`
- Branch atual: `feat/prd-mvp`
- Task group **1.0** implementado (canvas + pty-bridge + TerminalNode + IPC Zod)
- Worktree: execução in-place na branch feature (`.worktrees/` no `.gitignore`)

## Premissas (revisão crítica)

Ver tabela completa em `docs/STATUS-flashwork.md`. Resumo:

1. SO alvo primario: Windows + WSL Linux
2. OmniRoute: bundled no app
3. Licença projeto: MIT provisória
4. Isolamento Floor: git worktree (não clone físico) em V1
5. Visual: placeholder até Abner definir

## Ordem de execução (não pular fases)

1. **0.0** monorepo + electron-vite blank window + CI — **FEITO**
2. **1.0** canvas + pty-bridge + TerminalNode + PTY sobrevive ao fechar janela — **FEITO**
3. **2.0** worktree-manager + FloorContainer + floorsStore ← **PRÓXIMO**
4. **3.0** ide-sidecar + IdeNode + Monaco leve
5. **4.0** omniroute-sidecar + RouterStatusNode
6. **5.0** persistence SQLite + electron-builder + audit 127.0.0.1
7. **6.0** Portal/Sticky/visual/E2E/licenças

## O que entrou em 1.0

- `packages/pty-bridge` — `PtySessionManager` (spawn/write/resize/kill, scrollback, subscribe)
- Native: `@homebridge/node-pty-prebuilt-multiarch` (MIT; sem `make` no WSL)
- IPC: `apps/desktop/src/main/ipc/pty.ts` + preload `flashwork.pty.*` + Zod `PTYMessageSchema`
- UI: `CanvasRoot` (@xyflow/react), `TerminalNode` (xterm + WebGL opcional), zustand `canvasStore`
- Keep-alive: main não dá `app.quit()` em `window-all-closed`; reattach via `pty:list` + scrollback

## Workflow por task (obrigatório)

1. Subagente implementer (1 task por vez; **não** paralelizar implementers)
2. Spec compliance review
3. Code quality review
4. Atualizar STATUS + este CONTEXT
5. Só então próxima task

## Guardrails do PRD

- Bind localhost only (`127.0.0.1`)
- Sem secrets no repo
- Sem dependências AGPL/GPL por código literal
- Testes: vitest, `*.test.ts` ao lado do código
- Packages testáveis isolados: `pnpm --filter <pkg> test`

## Próxima ação imediata

1. Implementar task group **2.0** (Floors / worktrees) na branch `feat/prd-mvp`
2. Ver `docs/briefs/task-2.0.md` se existir

## Notas de ambiente (host)

- Cursor no Windows; código em WSL Ubuntu-24.04
- Shell do agente: preferir `working_directory` Windows (`C:\Users\abner`) + `wsl.exe -d Ubuntu-24.04 -- bash -lc '...'`
- Evitar `$HOME`/`$?` no comando (PowerShell expande); usar paths absolutos `/home/abner/...`
- Node via nvm: `/home/abner/.nvm` (usar Node 22)
- Se sandbox bloquear: `required_permissions: ["all"]`
- Sem `make`/`build-essential` (sudo pede senha) — por isso prebuilt PTY

## Commits

Plano do usuário: commitar quando pedido / ao fechar task group. Não push sem pedido.

## Checklist rápido ao retomar

```
[x] Ler STATUS-flashwork.md
[x] Verificar branch/worktree path → feat/prd-mvp
[x] Task 1.0 FEITO
[ ] Continuar com próximo subagente implementer (2.0)
```
