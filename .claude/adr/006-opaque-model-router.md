# ADR 006 — Opaque model and agent routing

- Status: accepted
- Date: 2026-09-17
- Updated: 2026-09-19 (P07 shipped: routeTask + first-party probe)
- Tags: models, auto, providers
- See also: ADR 009 (remove OmniRoute), ADR 010 (provider APIs)

## Context

The product already classifies tasks (`classifyTask`) and selects CLIs (`selectAgent`, Task Board `planner.ts`). The owner wants the developer to describe work, not pick models, tokens, or gateways. OmniRoute/9router is removed (ADR 009). Users run vendor CLIs **or** first-party APIs (ADR 010).

## Decision

1. **Default UX is Auto.** Task Board, Home quick launch, and canvas agent nodes do not require picking a model. Advanced users can still pin a CLI in a terminal pane, or pin a model in Preferences.
2. A **router pass** order:
   1. Cheap model on a configured provider API (Haiku / GPT-mini / Gemini Flash class from the catalog) — 2500 ms timeout
   2. Else regex `classifyTask` + `selectAgent` over **installed CLIs** (zero network)
3. Router output `{ kind, agent, reason }` stays compatible with `TaskSlicePlan`. `agent` may be a CLI id **or** `api:<provider>` when no suitable CLI is installed but a key exists.
4. UI kind still prefers Antigravity when that CLI is installed; otherwise a Gemini/Claude API with a UI-capable model.
5. Token HUD is opt-in, not required to start work.

## Consequences

- No OmniRoute, no OpenRouter, no Groq-as-default, no 9router health check in the probe chain.
- Planner JSON from the cheap model is schema-validated (`parsePlannerSlices`).
- If neither CLI nor API key exists, Auto explains how to install a CLI (P10) or paste a key (P11) instead of failing silently.
