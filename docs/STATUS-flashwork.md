# STATUS — Flashwork (execução do PRD)

**Atualizado:** 2026-08-15  
**Coordenador:** agente COORDINATOR (subagent-driven-development + executing-plans)

## Ambiente

| Item | Valor |
|------|--------|
| Workspace raiz | `/home/abner/www/ruperth/flashwork` |
| Worktree isolado | *em-place* (branch `feat/prd-mvp` no root; `.worktrees/` reservado) |
| Branch feature | `feat/prd-mvp` |
| Branch base | `main` |
| Isolamento | Branch feature; execução no path raiz |

## O que foi entendido do PRD

Produto desktop **local-first** (Electron + TS + React) com três pilares:

1. **Canvas infinito** (`@xyflow/react`) para orquestrar agentes de IA (PTY reais via `node-pty` + xterm)
2. **IDE embutido** (`openvscode-server` em webview; Monaco como preview leve)
3. **Gateway multi-modelo** (OmniRoute como sidecar, bind `127.0.0.1`)

Isolamento por **Floor** = 1 `git worktree`. Persistência SQLite. Empacotamento via electron-builder. Sem fork do VS Code; sem copiar AGPL.

## Revisão crítica (Step 1)

### Premissas adotadas (não bloqueiam Fases 0–2)

| Pergunta aberta (PRD §8) | Premissa provisória | Impacto se mudar |
|--------------------------|---------------------|------------------|
| SO principal | **Windows + WSL Linux** (ambiente atual do autor); QA/packaging prioriza Linux (WSL) e Windows | Fase 5 (instaladores) |
| Identidade visual / nome | Placeholder `flashwork` + tokens light/azul corporativo (PRD §4.4) | Fase 6.3 |
| OmniRoute embutido vs externo | **Embutido/bundled** pelo app (alinhado a local-first) | Fase 4 |
| Licença OSS do projeto | **MIT provisória** até decisão; zero AGPL/GPL literal | Dependências futuras |
| Worktree vs clone APFS | **Worktree em V1** (já escolhido no PRD) | Fase 2 |

### Lacunas não bloqueantes

- Critério 1.7 pede Claude Code real — ambiente pode não ter CLIs instalados; validar com `bash`/`node` e documentar gap de agente real.
- OmniRoute e openvscode-server são artefatos externos a baixar/pin — versão exata a definir nas tasks 3.x/4.x.
- Sticky Note MCP (6.2) e E2E completo (6.4) dependem de Fases 1–4 estáveis.

### Bloqueios críticos

**Nenhum bloqueio que impeça iniciar a Fase 1.** Fase 0 verificada (install/test/build/lint).

## Checklist de tasks (tasks-PRD-flashwork.md)

### 0.0 Setup monorepo — FEITO
- [x] 0.1 pnpm + turborepo, `apps/` + `packages/`
- [x] 0.2 TypeScript base + ESLint/Prettier
- [x] 0.3 `packages/shared-types`
- [x] 0.4 `apps/desktop` electron-vite (janela em branco)
- [x] 0.5 CI básico (lint + test + build)

### 1.0 Shell + Canvas + Terminal — PENDENTE (próximo)
- [ ] 1.1–1.7 (canvas, pty-bridge, IPC Zod, TerminalNode, spawn UI, PTY background, aceite Fase 1)

### 2.0 Floors / worktrees — PENDENTE
- [ ] 2.1–2.6

### 3.0 IDE sidecar — PENDENTE
- [ ] 3.1–3.6

### 4.0 OmniRoute — PENDENTE
- [ ] 4.1–4.5

### 5.0 Persistência + packaging — PENDENTE
- [ ] 5.1–5.6

### 6.0 Polish — PENDENTE
- [ ] 6.1–6.5

## Progresso

1. ✅ PRD + tasks lidos por completo
2. ✅ Workspace explorado
3. ✅ Revisão crítica — sem bloqueio hard para Fase 0
4. ✅ Git init + branch `feat/prd-mvp` + monorepo 0.0
5. ✅ Verificação: `pnpm install`, shared-types test, desktop build, lint
6. ⏳ Executar tasks via subagentes (próximo: **1.0**)

## Como validar (quando houver código)

```bash
cd /home/abner/www/ruperth/flashwork   # ou path do worktree
pnpm install
pnpm lint && pnpm test && pnpm build
pnpm --filter @flashwork/desktop dev
```
