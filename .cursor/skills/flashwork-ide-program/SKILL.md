---
name: flashwork-ide-program
description: Load Flashwork IDE-program specs, ADRs, and implementation plans. Use when planning or implementing Task Board handoffs, MCP/skills marketplace, visual refresh, per-project harness/RAG, GitHub/SCM, IDE workbench, opaque routing, OmniRoute removal, CLI install/update, provider APIs, token metrics for all agents, or the N8N-like canvas beta.
---

# Flashwork IDE program

Read these before writing code:

1. `.claude/memory/MEMORY.md`
2. `.claude/memory/CONTEXT.md`
3. `docs/superpowers/specs/2026-09-17-flashwork-ide-program-design.md`
4. `docs/superpowers/plans/2026-09-17-00-program-roadmap.md`
5. The numbered plan for the slice you were asked to implement
6. Relevant ADRs in `.claude/adr/`

Existing app conventions live in `apps/orchestrator/AGENTS.md`.

Do not fork VS Code. Do not add OpenRouter or OmniRoute. Do not add an in-app Monaco IDE (ADR 011). Do not implement until the owner names a plan. Prefer extending `apps/orchestrator` over adding a second app.
