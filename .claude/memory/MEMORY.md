# Flashwork memory

Last updated: 2026-09-17 (addendum: token metrics for all agents, not only Claude)

## Product

- **Name:** Flashwork (`com.ruperth.flashwork`)
- **What it is:** Local-first desktop workspace for running coding agents and shells in parallel, with real PTYs (not fake terminals).
- **Stack:** Tauri 2, Rust, React 18, TypeScript, Vite, Zustand, xterm.js, CSS Modules + design tokens. No Tailwind.
- **App root:** `apps/orchestrator/`
- **Owner:** Abner Ananias / Ruperth
- **License of the desktop app:** AGPL-3.0-or-later

## Working rules the owner cares about

- Never restart `tauri dev` / Vite if already running.
- Never commit/push without an explicit ask in that moment.
- No AI co-author on commits.
- i18n: `en.ts` is source of truth; `pt-BR.ts` must match keys.
- User-facing work updates `apps/orchestrator/docs/CHANGELOG.md` `[Unreleased]`.

## Program started 2026-09-17

Turn Flashwork into an IDE **without throwing away** the orchestrator. **P13 (2026-09-20):** owner withdrew the in-app IDE workbench (Monaco / Open VSX). Flashwork stays the orchestrator; edit in VS Code. **P14 (2026-09-23):** live PTYs die on quit/crash; Auto/Task Board continuity is a 7-day PromptRun ledger + Resume in Auto (ADR 012).

Pointers:

- Spec: `docs/superpowers/specs/2026-09-17-flashwork-ide-program-design.md`
- Roadmap: `docs/superpowers/plans/2026-09-17-00-program-roadmap.md`
- ADRs: `.claude/adr/`
- Snapshot of shipped vs missing: `.claude/memory/CONTEXT.md`

## External references (not vendored)

- https://github.com/microsoft/vscode — UX, SCM, workbench, extensions model
- https://github.com/microsoft/vscode-docs — documented Git, editor, and marketplace behavior
- Do not clone these into this repo unless a later plan explicitly requires a local checkout for screenshots or API notes.
