# ADR 014 — DeepSeek API as Run SPEC planner

- Status: accepted
- Date: 2026-10-19
- Tags: deepseek, planner, run-spec, provider-apis
- Related: [ADR 006](006-opaque-model-router.md), [ADR 009](009-remove-omniroute.md),
  [ADR 010](010-provider-apis.md), [ADR 013](013-spec-orchestrator.md)

## Context

Run SPEC (ADR 013) uses a free **Gemini CLI** pre-pass to split a SPEC into tasks and pick an
installed coding CLI per lane. Gemini stays planner-only (never a task worker). In practice the
Gemini free tier is often the bottleneck: planning a long SPEC burns quota that the owner would
rather keep for other work, and the heuristic fallback is too coarse when Gemini is exhausted.

ADR 010 already listed DeepSeek as a **v1.1** first-party provider (keyring shape, not yet wired).
DeepSeek’s OpenAI-compatible HTTP API (`deepseek-chat`, `deepseek-coder` / current coder-class ids)
is cheap, has a large context window, and is strong enough for structured “split SPEC → JSON tasks”
output. Flashwork already has a direct `provider_chat` path for Anthropic / OpenAI / Gemini; DeepSeek
fits that shape without adding a gateway (ADR 009 forbids OpenRouter-style middlemen).

## Decision

1. **Promote DeepSeek from “later peer” to a first-class planner candidate** for Run SPEC.
   - Key: OS keyring `flashwork.provider.deepseek` (same pattern as ADR 010).
   - Env when the keyring entry is empty, and when used with a CLI (if ever): `DEEPSEEK_API_KEY`.
     The desktop process loads `.env` at startup. A saved keyring secret wins over the env var.
   - Direct API base: DeepSeek’s official OpenAI-compatible endpoint (no third-party proxy).

2. **Models (opaque default, ADR 006):**
   - Default planner model: **`deepseek-flash`** (general reasoning / JSON plan).
   - Prefer **`deepseek-v4-pro`** (current coder-class catalog id) when the SPEC is clearly
     implementation-heavy and the catalog marks a coder role — still chosen by the router, not a
     developer-facing model picker.
   - The names in the original proposal (`deepseek-chat`, `deepseek-coder`) were retired by
     DeepSeek on 2026-07-24. The catalog stores the live official ids above.
   - Catalog entry lives in `modelCatalog.ts` (+ optional refresh), same as other providers.
   - The planner request disables DeepSeek thinking mode and asks for a JSON object, so the
     reply stays in `content` for `parseSpecPlan`.

3. **Planner selection order for Run SPEC** (when implemented):
   1. DeepSeek direct API, if a key is present and the call succeeds.
   2. Else Gemini CLI pre-pass (current behaviour).
   3. Else local heuristic (current behaviour).
   - DeepSeek is **planner-only** for this ADR: do not assign `deepseek` as a Run SPEC task worker
     CLI. Task panes stay installed coding CLIs (Claude, Codex, OpenCode, …).

4. **Contract unchanged:** planner output must still parse through the existing SPEC plan JSON
   shape (`parseSpecPlan` / task list + agent per lane). Same prompt constraints: never assign
   Gemini (or DeepSeek) as a worker; only installed worker CLIs.

5. **Out of scope for this ADR:** Ollama/local planner, making DeepSeek a PTY agent type, or
   replacing Gemini for interactive panes. Those need separate decisions.

## Consequences

- Preferences **Providers** page gains a DeepSeek key field (and optional “use with CLI” later).
- `planSpec` / `runPlannerCli` path gains a DeepSeek HTTP branch before Gemini; failures mark the
  provider unavailable for the session and fall through (same spirit as `markAgentAuthFailed` for
  Gemini).
- Changelog + i18n shipped with the Providers key field and the Run SPEC source label.
- Amends ADR 010 §2: DeepSeek is no longer deferred as a vague v1.1 peer for the **planner** role;
  other v1.1 peers (xAI, Mistral, Bedrock) stay deferred.
- Does not change ADR 013’s product shape (Run SPEC + board + Graphify); only who may produce the
  plan when a cheap API key is available.
