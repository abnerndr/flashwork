# Contexto de continuação — Flashwork PRD

**Última atualização:** 2026-08-15 (coordenador)  
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
- Conteúdo atual: `.cursor/mcp.json` + `docs/STATUS-flashwork.md` + este arquivo
- **Git ainda NÃO inicializado** no momento desta escrita (workspace greenfield)
- Worktree/branch: a criar (`feat/prd-mvp` em `.worktrees/feat-prd-mvp`)

## Premissas (revisão crítica)

Ver tabela completa em `docs/STATUS-flashwork.md`. Resumo:

1. SO alvo primario: Windows + WSL Linux
2. OmniRoute: bundled no app
3. Licença projeto: MIT provisória
4. Isolamento Floor: git worktree (não clone físico) em V1
5. Visual: placeholder até Abner definir

## Ordem de execução (não pular fases)

1. **0.0** monorepo + electron-vite blank window + CI
2. **1.0** canvas + pty-bridge + TerminalNode + PTY sobrevive ao fechar janela
3. **2.0** worktree-manager + FloorContainer + floorsStore
4. **3.0** ide-sidecar + IdeNode + Monaco leve
5. **4.0** omniroute-sidecar + RouterStatusNode
6. **5.0** persistence SQLite + electron-builder + audit 127.0.0.1
7. **6.0** Portal/Sticky/visual/E2E/licenças

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

1. Aguardar/concluir subagente monorepo (`cf054e43-a7fb-457e-bb65-ddec4480d077`) — Task 0.0
2. Spec review + quality review da 0.0
3. Implementar task **1.0** (brief em `docs/briefs/task-1.0.md`)
4. Manter STATUS/CONTEXT atualizados a cada fatia

## Subagentes ativos / recentes

| ID | Papel | Status |
|----|-------|--------|
| `7f629497` | shell bootstrap git | instável / incompleto |
| `cf054e43` | generalPurpose: git + 0.0 monorepo | em andamento |

## Notas de ambiente (host)

- Cursor no Windows; código em WSL Ubuntu-24.04
- Shell do agente pode falhar no PowerShell com `&&`; preferir `wsl -d Ubuntu-24.04 -- bash -lc '...'`
- Se sandbox bloquear: `required_permissions: ["all"]`

## Commits

Plano do usuário: **não commitar proativamente** salvo necessidade de worktree/seed ou pedido explícito. Deixar working tree pronto e reportar. Exceção: commit seed mínimo para habilitar worktrees.

## Checklist rápido ao retomar

```
[ ] Ler STATUS-flashwork.md
[ ] Verificar branch/worktree path
[ ] Ver qual task está in_progress
[ ] Rodar pnpm test/lint no escopo da última mudança
[ ] Continuar com próximo subagente implementer
```
