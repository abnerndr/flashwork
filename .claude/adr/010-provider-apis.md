# ADR 010 — First-party provider APIs

- Status: proposed
- Date: 2026-09-17
- Tags: anthropic, openai, gemini, api-keys

## Context

Users will keep using CLIs. They also want to call **current** vendor APIs (Anthropic, OpenAI, Gemini, and later peers) with their own keys — without OmniRoute/OpenRouter in the middle.

## Decision

1. **v1 providers (locked):** Anthropic, OpenAI, Google Gemini. Keys live in the OS keyring (`flashwork.provider.<id>`), never in `projects.json` or git.
2. **v1.1 (not this slice):** xAI, DeepSeek, Mistral, Amazon Bedrock — same keyring shape, add later.
3. Two uses of a key:
   - **CLI spawn:** inject the matching env (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY` / `GOOGLE_API_KEY`) when the user enabled “use my API key with this CLI”.
   - **Direct API:** Flashwork HTTP client for Auto router, Task Board planner, Flows `agent` nodes, and a simple chat pane when no CLI is installed.
4. **Model catalog** is a dated snapshot in `src/lib/providers/modelCatalog.ts` plus an optional refresh from each vendor’s official models list. Routing (ADR 006) picks a cheap model from the catalog (e.g. Flash / mini / Haiku-class) without showing a picker by default. Advanced Preferences can pin a model.
5. Flashwork does **not** ship vendor keys. Empty key → that provider is unavailable; fall back to installed CLIs, then to `classifyTask`.

## Consequences

- Preferences gains a **Providers** page (keys + “use with CLI” toggles + last catalog refresh).
- Direct API must not log request bodies that contain secrets; redact `Authorization` in diagnostics.
- Latest-model claim is “catalog kept current”, not a hardcoded name in UI copy.
