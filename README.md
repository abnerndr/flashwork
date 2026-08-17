# Flashwork

Orquestrador local de agentes de IA (terminais PTY reais, projetos, panes, Floors/worktrees).

O app é **Tauri + React** em `apps/orchestrator`, baseado em [Flashwork Agents](https://github.com/abnerndr/flashwork-agents) (AGPL-3.0), com marca **Flashwork**. IDE tipo VS Code fica para depois.

## Rodar (npm)

Na raiz do repo. Detalhes: [`docs/run-flashwork.md`](docs/run-flashwork.md).

```bash
npm run setup          # instala deps do app
npm run test:local     # lint + testes + build do frontend
npm run dev            # abre o app (Tauri) — teste local
npm run dev:ui         # só o visual no browser (sem PTY)
```

### Instalador (rode no SO correspondente)

```bash
npm run installer:linux      # AppImage + .deb
npm run installer:macos      # .dmg + .app
npm run installer:windows    # NSIS + MSI
npm run installer            # bundle do SO atual
```

Artefatos: `apps/orchestrator/src-tauri/target/release/bundle/`

Primeira vez no host: `./scripts/setup-linux.sh`, `./scripts/setup-macos.sh` ou `.\scripts\setup-windows.ps1`.

## Estrutura

```
apps/orchestrator/   # único app — Tauri 2 + React + Rust
scripts/             # setup / dev / build por SO
docs/                # run, design, licença
```

## Licença

O produto desktop (`apps/orchestrator` e binários gerados dele) é **AGPL-3.0-or-later**.  
Ver `LICENSE`, `docs/license-audit.md`, `apps/orchestrator/NOTICE`.
