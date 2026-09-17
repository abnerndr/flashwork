# ADR 002 — Pointer context hub

- Status: accepted
- Date: 2026-08-24 (implemented); recorded 2026-09-17
- Tags: agents, tokens, handoff

## Context

Pasting a full Claude/Codex transcript into the next CLI wastes tokens and leaks noise. Flashwork already redacts and materializes handoff packets.

## Decision

Auto and handoff share a local chunk index (`runs/<id>/context`) instead of dumping the source transcript. Bootstrap prompts are pointer-sized. A project-scoped hub is specified in `apps/orchestrator/docs/superpowers/specs/2026-09-04-project-scoped-context-hub-design.md` and should be finished as part of ADR 005, not replaced.

## Consequences

- Cross-project isolation is absolute.
- OpenCode is not yet a first-class capsule provider (known gap in that spec).
- New Task Board attachments (ADR 008) are extra files in the same spirit: pointers + on-disk markdown, not prompt stuffing of whole repos.
