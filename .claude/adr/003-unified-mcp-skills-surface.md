# ADR 003 — Unified MCP and skills surface

- Status: accepted
- Date: recorded 2026-09-17 (feature already in CHANGELOG Unreleased / recent)
- Tags: mcp, skills

## Context

Each coding CLI stores MCP servers and skills in different files (`~/.claude.json`, `.mcp.json`, `~/.codex/config.toml`, OpenCode JSON, Antigravity Gemini config; skills under `~/.claude/skills`, `~/.codex/skills`, `~/.agents/skills`).

## Decision

Flashwork owns a unified read/write panel: one row per server or skill, showing which agents have it, Global vs Project scope, registry search for MCP, copy between agents, health check, atomic writes.

Skills today are scan + detail + uninstall + install (folder or git into the shared store, optional agent links). There is no official skills registry in v1.

## Consequences

- The marketplace (install skills from folder/git; MCP registry add) lives on this same panel; it did not create a second catalog UI.
- Per-task MCP/skill selection (ADR 008) reads the same scan APIs and writes a **task-scoped allowlist**, not a new global config format.
