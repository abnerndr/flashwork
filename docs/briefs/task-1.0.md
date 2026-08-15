# Brief — Task 1.0 (próxima após 0.0)

Executar somente depois que 0.0 estiver verde (install/lint/test/build).

## Objetivo
Shell Electron + canvas infinito + TerminalNode com PTY real.

## Subtasks
1.1 `@xyflow/react` no renderer — canvas vazio pan/zoom  
1.2 `packages/pty-bridge` — wrap node-pty (spawn/write/resize/kill) + vitest  
1.3 IPC main→preload→renderer com Zod  
1.4 `TerminalNode.tsx` + `@xterm/xterm` (+ WebGL addon)  
1.5 Drag novo TerminalNode + escolher comando (`claude`/`codex`/`bash`)  
1.6 PTY sobrevive ao fechar a janela (vive no main)  
1.7 Aceite Fase 1: criar terminal, rodar comando, fechar/reabrir sem perder processo  

## Critérios de aceite
- App abre com canvas
- TerminalNode executa shell real
- Scrollback/processo não morre ao fechar janela (main process)
- Testes do pty-bridge passam
- Sem bind fora de 127.0.0.1; sem AGPL

## Arquivos-alvo
Ver tasks-PRD-flashwork.md Relevant Files (pty-bridge, TerminalNode, canvasStore, ipc).

## Premissas
- Se Claude Code CLI ausente, validar com `bash` e documentar.
- Commits só se pedido pelo coordenador; preferir working tree limpo+testado.
