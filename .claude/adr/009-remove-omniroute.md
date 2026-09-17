# ADR 009 — Remove OmniRoute / 9router (no OpenRouter gateway)

- Status: accepted
- Date: 2026-09-17
- Supercedes: the OmniRoute parts of ADR 006
- Tags: omniroute, openrouter, cli

## Context

The owner asked to **remove OpenRouter**. This repository has **no OpenRouter integration**. The in-app gateway is **OmniRoute**: an optional [9router](https://www.npmjs.com/package/9router) sidecar on `127.0.0.1:20128` that rewrites `ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL` for Claude Code and Codex panes. Users already run agents through vendor CLIs (Claude Code, Codex, Copilot, Gemini CLI, …). A third hop (Flashwork → 9router → vendor) is extra failure surface and is what we delete.

## Decision

1. Remove OmniRoute/9router from the product: UI, preferences, sidecar install, spawn env rewrite, Tauri module, i18n, tests, FEATURES/CHANGELOG notes.
2. Coding work continues through **vendor CLIs** with the user's existing CLI login (Claude Max, ChatGPT/Codex, Copilot, Gemini, …).
3. Direct **vendor HTTP APIs** are a separate first-class path (ADR 010), not a 9router/OpenRouter proxy.
4. Do not add OpenRouter.com as a replacement gateway.

## Consequences

- `resolveOmniRouteSpawnEnv` call sites go back to passing through caller env only.
- Home OmniRoute wizard, `RouterStatus`, `sidecarInstall` for `9router`, and `omniroute.rs` are deleted.
- Opaque routing (ADR 006, revised) must not list OmniRoute in the probe chain.
- CLI install/update bugs (plan P10) become more important: they are the primary way to get a coding agent.
