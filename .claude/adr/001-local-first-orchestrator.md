# ADR 001 — Local-first Tauri orchestrator

- Status: accepted
- Date: 2026-09-17 (recorded; true since the current product)
- Tags: product, stack

## Context

Flashwork exists to run several coding CLIs and shells at once, with real PTYs, layouts, resume, and RAM control. The app already ships as Tauri 2 + React + Rust.

## Decision

Keep the current desktop stack and domain model (`Group → Project → Terminal → Sub-tab → PTY`). New IDE features extend `apps/orchestrator`. Do not add a second Electron app, a cloud control plane, or a rewrite of persistence.

## Consequences

- All new UI follows CSS Modules, tokens, i18n, and the no-restart / no-unsolicited-commit rules in `AGENTS.md`.
- Cloud sync stays out of scope unless a later ADR supersedes this.
- VS Code inspiration is UX and SCM, not a stack change (see ADR 004).
