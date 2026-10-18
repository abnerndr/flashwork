# ADR 013 — Simplify to a SPEC orchestrator

- Status: accepted
- Date: 2026-10-17
- Tags: product, agents, graphify, wsl

## Context

Flashwork accumulated peripheral features (Spotify, Discord, remote control, Flows, canvas, browser
pane, todos, sandbox…). The owner wants one job: orchestrate agent CLIs on a project from a SPEC,
with agents sharing context so they do not duplicate work.

## Decision

- A project is a folder with `.flashwork/` and a Graphify graph; Graphify MCP is always wired.
- Run SPEC replaces Task Board and the Auto bar as the single entry point. The free Gemini CLI plans
  lanes and picks a CLI per lane among installed ones; heuristic fallback offline.
- The shared board lives in the project (`.flashwork/runs/<runId>/board.md`) so every CLI, including
  ones running inside WSL, can read it.
- Windows spawns WSL projects through `wsl.exe -d <distro> --cd <path>`.
- Kept: MCP + Skills, Git, Token HUD/usage. Everything else peripheral is removed (see P15).

## Consequences

- Persisted panes of removed kinds (web, video, flows, canvas, sandbox…) are dropped on load.
- Supersedes ADR 007 (Flows) and the Task Board surface of ADR 008.
